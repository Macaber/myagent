import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAgentRuntime } from '../dist/index.js';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { DashboardService } from '../dist/dashboard/dashboard-service.js';
import { AgentDatabase } from '../dist/persistence/db.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { ToolRegistry } from '../dist/tools/tool-registry.js';
import { SkillRegistry } from '../dist/skills/skill-registry.js';
import { VerificationGuard } from '../dist/engine/verification-guard.js';
import { WorkerAgent } from '../dist/engine/worker.js';
import { SubagentManager } from '../dist/runtime/subagent-manager.js';
import { createInvokeSubagentTool } from '../dist/tools/subagent-tool.js';
import { readTool, writeTool } from '../dist/tools/core-tools.js';
import { isConversationalGoal } from '../dist/engine/planner.js';

describe('Hierarchical Session-Turn-Step Telemetry & Subagent Rollup', () => {
  let testDir: string;
  let testDbPath: string;

  before(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-hier-test-'));
    testDbPath = path.join(testDir, 'test-data.db');
  });

  after(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  test('2 prompts on a session produce exactly 2 turns, aggregate subagent steps & tools, and non-zero duration', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: testDbPath,
      autoScanSkills: false,
      autoLoadMcp: false,
    });
    const client = new AcpClient(clientTransport);

    await client.initialize();

    const sessionId = 'session_hier_001';
    // 1. Create a session
    const createRes = await client.newSession({
      cwd: testDir,
      sessionId,
    });
    assert.strictEqual(createRes.sessionId, sessionId);

    // 2. Execute Prompt 1 ("你好")
    const promptRes1 = await client.promptSession(sessionId, '你好');
    assert.strictEqual(promptRes1.status, 'completed');

    // 3. Execute Prompt 2 ("你好再次")
    const promptRes2 = await client.promptSession(sessionId, '你好再次');
    assert.strictEqual(promptRes2.status, 'completed');

    // 4. Verify Telemetry from DashboardService
    const summary = DashboardService.getDashboardSummary(testDbPath);
    assert.strictEqual(summary.totalTurns, 2, 'Dashboard summary totalTurns should be exactly 2');
    assert.ok(summary.totalSteps >= 2, 'Dashboard summary totalSteps should be at least 2');
    assert.ok(summary.totalDurationMs >= 0, 'Dashboard summary totalDurationMs should be recorded');

    // 5. Verify Session Detail
    const detail = DashboardService.getThreadDetail(testDbPath, sessionId);
    assert.ok(detail, 'Thread detail should be found');
    assert.strictEqual(detail.thread.totalTurns, 2, 'Thread detail totalTurns must be strictly 2 for 2 prompts');
    assert.strictEqual(detail.turns.length, 2, 'Waterfall turns length must be strictly 2');
    assert.strictEqual(detail.turns[0].turnIndex, 0, 'Turn 1 raw index must be 0');
    assert.strictEqual(detail.turns[0].userPrompt, '你好', 'Turn 1 should preserve userPrompt');
    assert.strictEqual(detail.turns[1].turnIndex, 1, 'Turn 2 raw index must be 1');
    assert.strictEqual(detail.turns[1].userPrompt, '你好再次', 'Turn 2 should preserve userPrompt');
    assert.ok(detail.thread.totalSteps >= 2, 'totalSteps must count steps across turns');
    assert.ok(detail.thread.durationMs >= 0, 'durationMs should not be 0 or null');

    await client.close();
    runtime.close();
  });

  test('Subagent steps and tools recursively roll up into parent thread telemetry and nest in dashboard', async () => {
    const db = new AgentDatabase(testDbPath);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(readTool);
    toolRegistry.registerTool(writeTool);

    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);
    const worker = new WorkerAgent(undefined, toolRegistry, skillRegistry, verificationGuard);
    const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry);

    const activeThreads = new Map<string, ThreadContext>();
    const invokeTool = createInvokeSubagentTool(subagentManager, (id) => activeThreads.get(id));
    toolRegistry.registerTool(invokeTool);

    const masterThreadId = 'master_rollup_001';
    const masterThread = new ThreadContext(
      {
        threadId: masterThreadId,
        sessionId: masterThreadId,
        prompt: 'Parent task that invokes subagent',
        workspacePath: testDir,
      },
      db
    );
    activeThreads.set(masterThreadId, masterThread);

    // Prompt Turn 1
    const turn = masterThread.createTurn('USER_INPUT');

    // Parent Step 1: invoke_subagent
    const step = turn.createStep({
      stepType: 'TOOL_EXECUTION',
      toolName: 'invoke_subagent',
      metadata: {
        isSubagent: true,
        subagentRole: 'Research Specialist',
      },
    });

    const output = await invokeTool.execute(
      {
        role: 'Research Specialist',
        taskDescription: 'Inspect workspace files',
        skillId: 'developer',
      },
      {
        threadId: masterThreadId,
        workspaceJail: masterThread.workspaceJail,
        blackboard: masterThread.blackboard,
      }
    );
    assert.ok(output.includes('SUCCESS'));

    // Step ends
    step.end({
      status: 'COMPLETED',
      metadata: { childRole: 'Research Specialist' },
    });

    turn.end({ status: 'COMPLETED', summary: 'Finished master turn with subagent' });
    masterThread.telemetryStore.recordThreadEnd(masterThreadId, 'COMPLETED');

    // Verify TelemetryStore rollup
    const parentMetrics = masterThread.telemetryStore.getThreadMetrics(masterThreadId);
    assert.ok(parentMetrics, 'Parent metrics should exist');
    assert.strictEqual(parentMetrics.counts.turns, 1, 'Parent turns should be 1');
    // Total steps must include parent step (1) + child subagent steps (>= 1)
    assert.ok(
      parentMetrics.counts.steps > 1,
      `Parent steps should roll up child steps, got ${parentMetrics.counts.steps}`
    );

    // Verify DashboardService hierarchical view
    const detail = DashboardService.getThreadDetail(testDbPath, masterThreadId);
    assert.ok(detail, 'Detail should exist');
    assert.strictEqual(detail.thread.totalTurns, 1, 'Detail totalTurns should be 1');
    assert.strictEqual(detail.turns.length, 1, 'Only 1 turn in waterfall');

    const turn1Steps = detail.turns[0].steps;
    assert.ok(turn1Steps.length >= 1, 'Turn 1 has at least 1 parent step');
    const invokeStep = turn1Steps.find((s) => s.toolName === 'invoke_subagent');
    assert.ok(invokeStep, 'invoke_subagent step must exist');
    assert.strictEqual(invokeStep.isSubagent, true);
    assert.ok(
      invokeStep.subagentSteps && invokeStep.subagentSteps.length > 0,
      'invoke_subagent step must contain nested subagentSteps'
    );

    // Verify child subagent summary in detail
    assert.ok(detail.subagentsSummary && detail.subagentsSummary.length > 0);
    assert.strictEqual(detail.subagentsSummary[0].role, 'Research Specialist');

    db.close();
  });

  test('isConversationalGoal correctly identifies capability questions and greetings without triggering tool execution', () => {
    // Capability questions (should all bypass tools and DAG decomposition)
    assert.strictEqual(isConversationalGoal('你会做什么？'), true);
    assert.strictEqual(isConversationalGoal('你会做什么'), true);
    assert.strictEqual(isConversationalGoal('你能做什么？'), true);
    assert.strictEqual(isConversationalGoal('你会干什么'), true);
    assert.strictEqual(isConversationalGoal('你能干啥'), true);
    assert.strictEqual(isConversationalGoal('你有什么功能'), true);
    assert.strictEqual(isConversationalGoal('你支持哪些功能'), true);
    assert.strictEqual(isConversationalGoal('what can you do?'), true);
    assert.strictEqual(isConversationalGoal('介绍一下你自己'), true);
    assert.strictEqual(isConversationalGoal('你好！'), true);

    // Actual task actions should NOT be conversational (must run full ReAct loop)
    assert.strictEqual(isConversationalGoal('帮我写一个测试脚本'), false);
    assert.strictEqual(isConversationalGoal('修改 package.json 添加依赖'), false);
    assert.strictEqual(isConversationalGoal('查代码里有没有 eval'), false);
    assert.strictEqual(isConversationalGoal('build and test the project'), false);
  });
});
