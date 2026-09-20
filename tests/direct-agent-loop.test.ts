import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentDatabase } from '../dist/persistence/db.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { ToolRegistry } from '../dist/tools/tool-registry.js';
import { ToolRouter } from '../dist/engine/tool-router.js';
import { SkillRegistry } from '../dist/skills/skill-registry.js';
import { DynamicContextAssembler } from '../dist/context/dynamic-context-assembler.js';
import { DirectAgentLoop } from '../dist/engine/direct-agent-loop.js';
import { OpenAIProvider } from '../dist/provider/openai-provider.js';
import type { StreamDeltaChunk } from '../dist/provider/types.js';
import { planTaskTool } from '../dist/tools/plan-tool.js';
import {
  extractFileOperations,
  shouldCompact,
  compactHistory,
} from '../dist/engine/compaction.js';
import {
  convertToChatMessages,
} from '../dist/engine/agent-message.js';
import type {
  AgentMessage,
  CompactionSummaryMessage,
} from '../dist/engine/agent-message.js';

class MockOpenAIProvider extends OpenAIProvider {
  public callHistory: any[] = [];
  public responses: StreamDeltaChunk[][] = [];

  constructor(responses: StreamDeltaChunk[][] = []) {
    super({ apiKey: 'mock-key', model: 'mock-gpt-4o' });
    this.responses = responses;
  }

  public override async *chatStream(params: any): AsyncGenerator<StreamDeltaChunk> {
    this.callHistory.push(params);
    const nextResponse = this.responses.shift() || [
      { type: 'content', deltaText: 'Default mock response' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
      { type: 'done' },
    ];
    for (const chunk of nextResponse) {
      yield chunk;
    }
  }
}

describe('Direct Agent Loop, Dynamic Planning, and Compaction', () => {
  let testDir: string;
  let testDbPath: string;
  let db: AgentDatabase;

  before(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-direct-loop-'));
    testDbPath = path.join(testDir, 'test-data.db');
    db = new AgentDatabase(testDbPath);
  });

  after(() => {
    try {
      db.close();
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('1. Conversational fast path executes in 1 model step with 0 tools', async () => {
    const mockProvider = new MockOpenAIProvider([
      [
        { type: 'content', deltaText: '你好！我是你的智能编程助手。' },
        { type: 'usage', usage: { promptTokens: 25, completionTokens: 15, totalTokens: 40 } },
        { type: 'done' },
      ],
    ]);

    const toolRegistry = new ToolRegistry();
    const toolRouter = new ToolRouter(toolRegistry);
    const skillRegistry = new SkillRegistry();
    const contextAssembler = new DynamicContextAssembler();

    const threadContext = new ThreadContext(
      {
        threadId: 'thread_conv_1',
        sessionId: 'session_conv_1',
        prompt: '你好，你会做什么？',
        workspacePath: testDir,
      },
      db
    );

    const promptTurn = threadContext.createTurn('USER_INPUT', '你好，你会做什么？');

    const loop = new DirectAgentLoop(
      mockProvider,
      toolRegistry,
      toolRouter,
      skillRegistry,
      contextAssembler
    );

    const result = await loop.run({
      threadContext,
      turnContext: promptTurn,
      toolContext: {
        threadId: threadContext.threadId,
        prompt: threadContext.prompt,
        workspaceJail: threadContext.workspaceJail,
        blackboard: threadContext.blackboard,
      },
    });

    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.summary, '你好！我是你的智能编程助手。');
    assert.strictEqual(result.totalSteps, 1);
    assert.strictEqual(mockProvider.callHistory.length, 1);

    // Turn telemetry verification
    promptTurn.end({ status: 'COMPLETED', summary: result.summary });
    const metrics = threadContext.telemetryStore.getThreadMetrics(threadContext.threadId);
    const turnBreakdown = metrics.turnsBreakdown.find((t) => t.turnId === promptTurn.turnId);
    assert.strictEqual(turnBreakdown?.stepCount, 1);
  });

  test('2. Tool execution flow pairs tool calls and updates blackboard via plan_task', async () => {
    const mockProvider = new MockOpenAIProvider([
      // Iteration 1: model calls plan_task
      [
        {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: 0,
            id: 'call_plan_1',
            name: 'plan_task',
            argumentsChunk: JSON.stringify({
              title: 'Refactor Authentication',
              todos: [
                { title: 'Audit token validation', status: 'completed' },
                { title: 'Implement refresh tokens', status: 'in_progress' },
              ],
            }),
          },
        },
        { type: 'usage', usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 } },
        { type: 'done' },
      ],
      // Iteration 2: model completes after seeing tool output
      [
        { type: 'content', deltaText: 'Execution plan created and stored.' },
        { type: 'usage', usage: { promptTokens: 140, completionTokens: 10, totalTokens: 150 } },
        { type: 'done' },
      ],
    ]);

    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(planTaskTool);
    const toolRouter = new ToolRouter(toolRegistry);
    const skillRegistry = new SkillRegistry();
    const contextAssembler = new DynamicContextAssembler();

    const threadContext = new ThreadContext(
      {
        threadId: 'thread_tool_1',
        sessionId: 'session_tool_1',
        prompt: 'Plan authentication refactor',
        workspacePath: testDir,
      },
      db
    );

    const promptTurn = threadContext.createTurn('USER_INPUT', 'Plan authentication refactor');

    const loop = new DirectAgentLoop(
      mockProvider,
      toolRegistry,
      toolRouter,
      skillRegistry,
      contextAssembler
    );

    const result = await loop.run({
      threadContext,
      turnContext: promptTurn,
      toolContext: {
        threadId: threadContext.threadId,
        prompt: threadContext.prompt,
        workspaceJail: threadContext.workspaceJail,
        blackboard: threadContext.blackboard,
      },
    });

    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.summary, 'Execution plan created and stored.');
    assert.strictEqual(result.totalSteps, 3);

    // Verify blackboard todos were updated
    const todos = threadContext.blackboard.getTodos();
    assert.strictEqual(todos.length, 2);
    assert.strictEqual(todos[0].content, 'Audit token validation');
    assert.strictEqual(todos[0].status, 'completed');
    assert.strictEqual(todos[1].content, 'Implement refresh tokens');
    assert.strictEqual(todos[1].status, 'in_progress');
  });

  test('3. In-turn steering directive is injected into active turn context before next iteration', async () => {
    const threadContext = new ThreadContext(
      {
        threadId: 'thread_steer_1',
        sessionId: 'session_steer_1',
        prompt: 'Write tests',
        workspacePath: testDir,
      },
      db
    );

    const mockProvider = new MockOpenAIProvider([
      // Iteration 1: Calls a plan tool, during which user injects steering
      [
        {
          type: 'tool_call_delta',
          toolCallDelta: {
            index: 0,
            id: 'call_plan_2',
            name: 'plan_task',
            argumentsChunk: JSON.stringify({
              title: 'Test Plan',
              todos: [{ title: 'Write unit tests', status: 'pending' }],
            }),
          },
        },
        { type: 'usage', usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 } },
        { type: 'done' },
      ],
      // Iteration 2: Model finishes with final text
      [
        { type: 'content', deltaText: 'Test plan updated with user directive.' },
        { type: 'usage', usage: { promptTokens: 80, completionTokens: 10, totalTokens: 90 } },
        { type: 'done' },
      ],
    ]);

    const toolRegistry = new ToolRegistry();
    // Intercept plan_task execution to simulate user typing steering in-flight
    toolRegistry.registerTool({
      ...planTaskTool,
      async execute(params, ctx) {
        // User sends steering while agent is executing tool!
        threadContext.pushSteering('Remember to include integration tests as well');
        return planTaskTool.execute(params, ctx);
      },
    });

    const toolRouter = new ToolRouter(toolRegistry);
    const skillRegistry = new SkillRegistry();
    const contextAssembler = new DynamicContextAssembler();

    const promptTurn = threadContext.createTurn('USER_INPUT', 'Write tests');

    const loop = new DirectAgentLoop(
      mockProvider,
      toolRegistry,
      toolRouter,
      skillRegistry,
      contextAssembler
    );

    const result = await loop.run({
      threadContext,
      turnContext: promptTurn,
      toolContext: {
        threadId: threadContext.threadId,
        prompt: threadContext.prompt,
        workspaceJail: threadContext.workspaceJail,
        blackboard: threadContext.blackboard,
      },
      steeringQueue: threadContext.steeringQueue,
    });

    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(mockProvider.callHistory.length, 2);

    // Inspect messages sent to LLM in iteration 2
    const iter2Messages = mockProvider.callHistory[1].messages;
    const steeringMsg = iter2Messages.find(
      (m: any) =>
        m.role === 'user' &&
        m.content.includes('[USER STEERING INTERVENTION]: Remember to include integration tests as well')
    );
    assert.ok(steeringMsg, 'Steering message should be present in iteration 2 prompt');
  });

  test('4. extractFileOperations, shouldCompact, and compactHistory preserve file operations ledger', async () => {
    // 4.1 Test extractFileOperations
    const sampleHistory: AgentMessage[] = [
      { role: 'user', content: 'Read file and update it' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ filePath: 'src/main.ts' }) },
          },
          {
            id: 'c2',
            type: 'function',
            function: { name: 'write_to_file', arguments: JSON.stringify({ targetFile: 'dist/output.js' }) },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', toolName: 'read_file', content: 'file data' },
      { role: 'tool', tool_call_id: 'c2', toolName: 'write_to_file', content: 'written successfully' },
    ];

    const ledger = extractFileOperations(sampleHistory);
    assert.ok(ledger.readFiles.has('src/main.ts'));
    assert.ok(ledger.modifiedFiles.has('dist/output.js'));

    // 4.2 Test shouldCompact
    assert.strictEqual(shouldCompact(96000, 128000, 0.75), true);
    assert.strictEqual(shouldCompact(50000, 128000, 0.75), false);

    // 4.3 Test compactHistory
    const longHistory: AgentMessage[] = [
      ...sampleHistory,
      { role: 'user', content: 'Now do next step' },
      { role: 'assistant', content: 'Doing next step' },
      { role: 'user', content: 'Final question' },
      { role: 'assistant', content: 'Final answer' },
    ];

    const compactionResult = await compactHistory(longHistory, {
      preserveRecentCount: 2,
      currentTokens: 98000,
    });

    assert.strictEqual(compactionResult.compactedMessages.length, 3);
    const summaryMsg = compactionResult.compactedMessages[0] as CompactionSummaryMessage;
    assert.strictEqual(summaryMsg.isCompaction, true);
    assert.ok(summaryMsg.readFiles.includes('src/main.ts'));
    assert.ok(summaryMsg.modifiedFiles.includes('dist/output.js'));

    // 4.4 Test convertToChatMessages with CompactionSummaryMessage
    const chatMsgs = convertToChatMessages(compactionResult.compactedMessages);
    assert.strictEqual(chatMsgs.length, 3);
    const firstChatMsg = chatMsgs[0];
    assert.strictEqual(firstChatMsg.role, 'user');
    assert.ok(firstChatMsg.content?.includes('[PRIOR CONVERSATION SUMMARY - COMPACTED CONTEXT]'));
    assert.ok(firstChatMsg.content?.includes('[FILE OPERATIONS LEDGER]'));
    assert.ok(firstChatMsg.content?.includes('src/main.ts'));
    assert.ok(firstChatMsg.content?.includes('dist/output.js'));
  });
});
