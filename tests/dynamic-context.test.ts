import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { ToolRegistry } from '../dist/tools/tool-registry.js';
import type { AgentTool } from '../src/tools/tool-registry.js';
import { ToolRouter } from '../dist/engine/tool-router.js';
import { SkillRegistry } from '../dist/skills/skill-registry.js';
import { Blackboard } from '../dist/context/blackboard.js';
import { DynamicContextAssembler } from '../dist/context/dynamic-context-assembler.js';
import { MemoryCompactor } from '../dist/context/memory-compactor.js';
import {
  bashTool,
  editTool,
  writeTool,
  readTool,
  grepTool,
  globTool,
} from '../dist/tools/core-tools.js';
import { todoWriteTool, questionTool, patchTool, skillTool } from '../dist/tools/extended-tools.js';
import { OpenAIProvider } from '../dist/provider/openai-provider.js';
import { WorkspaceJail } from '../dist/security/workspace-jail.js';

describe('Dynamic Context & On-Demand Capabilities Engine', () => {
  function setupRegistry() {
    const registry = new ToolRegistry();
    registry.registerTool(bashTool);
    registry.registerTool(editTool);
    registry.registerTool(writeTool);
    registry.registerTool(readTool);
    registry.registerTool(grepTool);
    registry.registerTool(globTool);
    registry.registerTool(todoWriteTool);
    registry.registerTool(skillTool);
    registry.registerTool(questionTool);
    registry.registerTool(patchTool);
    return registry;
  }

  test('1. ToolRouter: Stage-based preloading, deferred tools hiding, and meta-tool activation', async () => {
    const registry = setupRegistry();
    const router = new ToolRouter(registry);

    // Register a mock external MCP tool
    const mcpTool: AgentTool = {
      name: 'mcp__database__query',
      description: 'Execute SQL query on internal database',
      riskLevel: 'HIGH_RISK_EXEC',
      parameters: { type: 'object', properties: { sql: { type: 'string' } } },
      execute: async () => 'Query results: [row 1, row 2]',
    };
    registry.registerTool(mcpTool);

    // (A) Planning stage only receives read/exploration tools
    const planTools = router.getActiveToolSchemas('turn_plan', 'planning').map((t) => t.function.name);
    assert.ok(planTools.includes('read'));
    assert.ok(planTools.includes('glob'));
    assert.ok(!planTools.includes('edit')); // Edit is not loaded in planning stage
    assert.ok(!planTools.includes('write')); // Write is not loaded in planning stage
    assert.ok(!planTools.includes('mcp__database__query')); // MCP tool is deferred

    // (B) Worker stage receives write tools, but MCP tool remains deferred
    const workerTools = router.getActiveToolSchemas('turn_work', 'worker').map((t) => t.function.name);
    assert.ok(workerTools.includes('edit'));
    assert.ok(workerTools.includes('write'));
    assert.ok(!workerTools.includes('mcp__database__query')); // Deferred by default!
    assert.ok(workerTools.includes('search_tools')); // Meta-tools present because deferred tools exist
    assert.ok(workerTools.includes('activate_tool'));

    // (C) Model calls search_tools
    const searchTool = registry.getTool('search_tools')!;
    const searchResult = await searchTool.execute({}, { threadId: 't1', turnId: 'turn_work' } as any);
    assert.ok(searchResult.includes('mcp__database__query'));
    assert.ok(searchResult.includes('Execute SQL query'));

    // (D) Model calls activate_tool to dynamically mount the deferred tool for this turn
    const activateTool = registry.getTool('activate_tool')!;
    const activateResult = await activateTool.execute(
      { toolName: 'mcp__database__query' },
      { threadId: 't1', turnId: 'turn_work' } as any
    );
    assert.ok(activateResult.includes('activated successfully for turn \'turn_work\''));

    // (E) The tool now appears in the active set for this turn
    const updatedTools = router.getActiveToolSchemas('turn_work', 'worker').map((t) => t.function.name);
    assert.ok(updatedTools.includes('mcp__database__query'));

    // (F) On turn completion, clearing turn tools automatically unmounts the tool
    router.clearTurnTools('turn_work');
    const cleanedTools = router.getActiveToolSchemas('turn_work', 'worker').map((t) => t.function.name);
    assert.ok(!cleanedTools.includes('mcp__database__query'));
  });

  test('2. Two-Tier Skill Loading: L1 compact index vs L2 turn-scoped full guidelines', () => {
    const skillRegistry = new SkillRegistry();
    const assembler = new DynamicContextAssembler();
    const blackboard = new Blackboard('thread_skills');

    // (A) Verify L1 Compact Index is brief and structured
    const compactIndex = skillRegistry.getCompactIndex();
    assert.ok(compactIndex.includes('- [analyst]'));
    assert.ok(compactIndex.includes('- [developer]'));
    assert.ok(compactIndex.includes('- [qa]'));
    assert.ok(compactIndex.length < 500); // lightweight string (<100 tokens)

    // (B) Assemble context before activating L2 skill
    const baseContext = assembler.assemble({
      threadPrompt: 'Refactor database connection pool',
      turnId: 'turn_1',
      stage: 'worker',
      blackboard,
      skillRegistry,
    });

    const basePrompt = baseContext[0].content as string;
    assert.ok(basePrompt.includes('=== AVAILABLE SKILLS (L1 Index) ==='));
    assert.ok(!basePrompt.includes('=== ACTIVE SKILL DIRECTIVES (L2) ==='));

    // (C) Activate L2 skill for turn_1
    skillRegistry.activateSkillForTurn('turn_1', 'analyst');
    const turnSkills = skillRegistry.getActiveSkillsForTurn('turn_1');
    assert.strictEqual(turnSkills.length, 1);
    assert.strictEqual(turnSkills[0].id, 'analyst');

    // (D) Re-assemble context: verify L2 directives now dynamically appear in prompt
    const enrichedContext = assembler.assemble({
      threadPrompt: 'Refactor database connection pool',
      turnId: 'turn_1',
      stage: 'worker',
      blackboard,
      skillRegistry,
    });

    const enrichedPrompt = enrichedContext[0].content as string;
    assert.ok(enrichedPrompt.includes('=== ACTIVE SKILL DIRECTIVES (L2) ==='));
    assert.ok(enrichedPrompt.includes('Codebase Analyst'));
    assert.ok(enrichedPrompt.includes('Analyze codebase structure'));

    // (E) Turn finished: unload L2 skills automatically
    skillRegistry.clearTurnSkills('turn_1');
    const clearedSkills = skillRegistry.getActiveSkillsForTurn('turn_1');
    assert.strictEqual(clearedSkills.length, 0);

    const postClearContext = assembler.assemble({
      threadPrompt: 'Refactor database connection pool',
      turnId: 'turn_1',
      stage: 'worker',
      blackboard,
      skillRegistry,
    });
    const postClearPrompt = postClearContext[0].content as string;
    assert.ok(!postClearPrompt.includes('=== ACTIVE SKILL DIRECTIVES (L2) ==='));
  });

  test('3. Milestone Folding & Context Compaction: Structured history summarization', () => {
    const compactor = new MemoryCompactor();
    const blackboard = new Blackboard('thread_compaction');
    const skillRegistry = new SkillRegistry();
    const assembler = new DynamicContextAssembler(compactor);

    // (A) Simulate completing a 15-step milestone
    const intermediateSteps = Array.from({ length: 15 }).map((_, i) => ({
      stepId: `step_${i}`,
      toolName: i % 2 === 0 ? 'read' : 'edit',
      output: `Output of step ${i} containing lengthy diagnostics...`,
      status: 'SUCCESS',
    }));

    const milestoneSummary = compactor.compactStepHistory(intermediateSteps);
    assert.ok(milestoneSummary.includes('Completed 15 steps:'));

    // Record completed milestone in blackboard
    blackboard.recordMilestoneCompletion(
      'ms_1',
      'Architecture Inspection',
      milestoneSummary,
      ['src/config.ts']
    );

    // (B) Assemble context for next milestone: verify folded summary is included
    const context = assembler.assemble({
      threadPrompt: 'Build microservice gateway',
      turnId: 'turn_ms_2',
      stage: 'worker',
      currentMilestoneTitle: 'Implementation',
      currentMilestoneDescription: 'Implement router and auth middleware',
      blackboard,
      skillRegistry,
    });

    const prompt = context[0].content as string;
    assert.ok(prompt.includes('=== COMPLETED MILESTONE SUMMARIES (Compacted History) ==='));
    assert.ok(prompt.includes('Architecture Inspection'));
    assert.ok(prompt.includes('Completed 15 steps:'));

    // (C) Test watermark folding when message sequence exceeds budget
    const excessiveMessages = Array.from({ length: 20 }).map((_, i) => ({
      role: i % 2 === 0 ? 'assistant' : 'tool',
      content: 'A'.repeat(2000), // 20 * 2000 = 40,000 characters
    }));

    const { messages: folded, wasFolded } = compactor.checkWatermarkAndFold(excessiveMessages, 10000, 4);
    assert.strictEqual(wasFolded, true);
    assert.strictEqual(folded.length, 6); // First message + Compacted Notice + 4 recent messages
    assert.ok((folded[1].content as string).includes('[CONTEXT COMPACTED: Folded 15 earlier intermediate'));
  });

  test('4. Workspace Delta Ledger & Goal Invariant Anchor', () => {
    const blackboard = new Blackboard('thread_delta');
    const skillRegistry = new SkillRegistry();
    const assembler = new DynamicContextAssembler();

    // Set budget
    blackboard.setTokenBudget(100000);
    blackboard.recordTokenUsage(12500);

    // Record file operations
    blackboard.appendArtifact({
      artifactId: 'a_1',
      filePath: 'src/gateway.ts',
      action: 'CREATE',
      diffContent: '+class Gateway {}',
    });
    blackboard.appendArtifact({
      artifactId: 'a_2',
      filePath: 'package.json',
      action: 'MODIFY',
      diffContent: '+"express": "^4.19.0"',
    });

    // Update TODOs
    blackboard.updateTodos([
      { id: '1', content: 'Create gateway class', status: 'completed' },
      { id: '2', content: 'Write integration test', status: 'in_progress' },
    ]);

    const context = assembler.assemble({
      threadPrompt: 'Design resilient gateway',
      turnId: 'turn_active',
      stage: 'worker',
      currentMilestoneTitle: 'Unit Testing',
      currentMilestoneDescription: 'Verify gateway handles timeouts gracefully',
      blackboard,
      skillRegistry,
    });

    const prompt = context[0].content as string;

    // (A) Verify Goal & Milestone Invariant Anchor
    assert.ok(prompt.includes('=== GOAL & MILESTONE ==='));
    assert.ok(prompt.includes('Global Task Goal: Design resilient gateway'));
    assert.ok(prompt.includes('Current Active Milestone: [Unit Testing]'));

    // (B) Verify Workspace Delta Ledger (Ground Truth)
    assert.ok(prompt.includes('=== WORKSPACE DELTA (Modified Files) ==='));
    assert.ok(prompt.includes('- src/gateway.ts (CREATE)'));
    assert.ok(prompt.includes('- package.json (MODIFY)'));
    assert.ok(prompt.includes("call 'read' with specific line ranges"));

    // (C) Verify TODO Checklist
    assert.ok(prompt.includes('=== CURRENT TODO CHECKLIST ==='));
    assert.ok(prompt.includes('[COMPLETED] Create gateway class'));
    assert.ok(prompt.includes('[IN_PROGRESS] Write integration test'));
  });

  test('5. ReAct-Aware Watermark Folding preserves atomic tool call transactions', () => {
    const compactor = new MemoryCompactor();

    // Construct a realistic conversation with parallel tool calls:
    // Turn 1: 1 assistant with 3 tool calls + 3 tool responses
    // Turn 2: 1 assistant with 2 tool calls + 2 tool responses
    const messages = [
      { role: 'user', content: 'Explore directory' },
      {
        role: 'assistant',
        content: 'I will list and read',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'glob', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'read', arguments: '{}' } },
          { id: 'call_3', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'A'.repeat(5000) },
      { role: 'tool', tool_call_id: 'call_2', content: 'B'.repeat(5000) },
      { role: 'tool', tool_call_id: 'call_3', content: 'C'.repeat(5000) },
      {
        role: 'assistant',
        content: 'Now next step',
        tool_calls: [
          { id: 'call_4', type: 'function', function: { name: 'glob', arguments: '{}' } },
          { id: 'call_5', type: 'function', function: { name: 'read', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_4', content: 'D'.repeat(5000) },
      { role: 'tool', tool_call_id: 'call_5', content: 'E'.repeat(5000) },
    ];

    // Request keeping 4 recent messages (which would blindly slice into tool_4 / tool_5)
    const { messages: folded, wasFolded } = compactor.checkWatermarkAndFold(messages as any, 10000, 4);
    assert.strictEqual(wasFolded, true);

    // After folding, recent messages MUST begin with assistant, NEVER an orphan tool message!
    const firstFoldedRecent = folded[2];
    assert.notStrictEqual(firstFoldedRecent.role, 'tool', 'Folded messages must never start with role: tool');
    assert.strictEqual(firstFoldedRecent.role, 'assistant');
    assert.strictEqual((firstFoldedRecent as any).tool_calls?.length, 2);
  });

  test('6. OpenAIProvider.sanitizeMessages prevents 400 errors from orphaned tool messages', () => {
    // An array containing an orphan tool message with no preceding assistant tool_calls
    const dirtyMessages: any[] = [
      { role: 'system', content: 'You are an assistant' },
      { role: 'user', content: 'List files' },
      { role: 'tool', tool_call_id: 'orphan_call_1', content: 'Directory contents' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_valid', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_valid', content: 'File contents' },
    ];

    const sanitized = OpenAIProvider.sanitizeMessages(dirtyMessages);

    // The orphan tool message should be converted to a user message
    assert.strictEqual(sanitized[2].role, 'user');
    assert.ok((sanitized[2].content as string).includes('[Previous Tool Execution Result]'));

    // The valid tool message should remain a tool message
    assert.strictEqual(sanitized[3].role, 'assistant');
    assert.strictEqual(sanitized[4].role, 'tool');
    assert.strictEqual(sanitized[4].tool_call_id, 'call_valid');
  });

  test('7. globTool lists top-level files and directories with [DIR] and [FILE] markers', async () => {
    const jail = new WorkspaceJail(process.cwd());
    const context: any = {
      workspaceJail: jail,
      threadId: 'test_thread',
      blackboard: new Blackboard('test_glob'),
    };

    const result = await globTool.execute({ pattern: '*' }, context);
    assert.ok(result.includes('[DIR]'));
    assert.ok(result.includes('[FILE]'));
    assert.ok(result.includes('package.json'));
    assert.ok(result.includes('src'));
  });

  test('8. Observation Masking: Condenses older tool outputs while preserving tool_call_id pairs', () => {
    const compactor = new MemoryCompactor();

    const messages = [
      { role: 'user', content: 'Do a complex task' },
      // Turn 1
      { role: 'assistant', content: 'Step 1', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'Line 1\n' + 'A'.repeat(5000) },
      // Turn 2
      { role: 'assistant', content: 'Step 2', tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_2', content: 'Match 1\n' + 'B'.repeat(3000) },
      // Turn 3
      { role: 'assistant', content: 'Step 3', tool_calls: [{ id: 'call_3', type: 'function', function: { name: 'edit', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_3', content: 'Successfully replaced 1 occurrence in foo.ts' },
      // Turn 4 (most recent)
      { role: 'assistant', content: 'Step 4', tool_calls: [{ id: 'call_4', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_4', content: 'All 10 tests passed' },
    ];

    // Keep the most recent 2 tool turns (call_3 and call_4)
    const masked = compactor.maskOldToolObservations(messages, 2);

    // 1. Tool 1 (older) should be masked
    assert.strictEqual(masked[2].role, 'tool');
    assert.strictEqual(masked[2].tool_call_id, 'call_1');
    assert.ok(masked[2].content.includes('[Tool observation'));
    assert.ok(masked[2].content.includes('compacted'));
    assert.ok(masked[2].content.length < 300); // 5000 chars reduced to < 300!

    // 2. Tool 2 (older) should be masked
    assert.strictEqual(masked[4].role, 'tool');
    assert.strictEqual(masked[4].tool_call_id, 'call_2');
    assert.ok(masked[4].content.includes('[Tool observation'));
    assert.ok(masked[4].content.length < 300);

    // 3. Tool 3 and Tool 4 (recent) must retain their full raw content
    assert.strictEqual(masked[6].content, 'Successfully replaced 1 occurrence in foo.ts');
    assert.strictEqual(masked[8].content, 'All 10 tests passed');
  });

  test('9. ToolRouter: Role/Skill-based tool pruning eliminates schema token bloat', () => {
    const registry = setupRegistry();
    const router = new ToolRouter(registry);

    // (A) Analyst skill receives ONLY read-only exploration tools (5 tools)
    const analystSchemas = router.getActiveToolSchemas('turn_a', 'worker', 'analyst');
    const analystToolNames = analystSchemas.map((s) => s.function.name);
    assert.deepStrictEqual(analystToolNames.sort(), ['glob', 'grep', 'question', 'read', 'skill'].sort());
    assert.ok(!analystToolNames.includes('edit'));
    assert.ok(!analystToolNames.includes('write'));
    assert.ok(!analystToolNames.includes('bash'));

    // (B) QA skill receives test execution and exploration tools
    const qaSchemas = router.getActiveToolSchemas('turn_q', 'worker', 'qa');
    const qaToolNames = qaSchemas.map((s) => s.function.name);
    assert.ok(qaToolNames.includes('bash'));
    assert.ok(qaToolNames.includes('read'));
    assert.ok(!qaToolNames.includes('edit'));
    assert.ok(!qaToolNames.includes('write'));

    // (C) Developer skill receives full suite
    const devSchemas = router.getActiveToolSchemas('turn_d', 'worker', 'developer');
    const devToolNames = devSchemas.map((s) => s.function.name);
    assert.ok(devToolNames.includes('edit'));
    assert.ok(devToolNames.includes('write'));
    assert.ok(devToolNames.includes('bash'));
  });

  test('10. Prefix-Cache Invariance: System prompt prefix is 100% byte-for-byte identical across turns', () => {
    const assembler = new DynamicContextAssembler();
    const skillRegistry = new SkillRegistry();
    const blackboard = new Blackboard('thread_cache_test');

    skillRegistry.activateSkillForTurn('turn_1', 'developer');

    // Turn 1
    const contextTurn1 = assembler.assemble({
      threadPrompt: 'Implement authentication middleware',
      turnId: 'turn_1',
      stage: 'worker',
      currentMilestoneTitle: 'Token Validation',
      currentMilestoneDescription: 'Validate JWT signatures',
      blackboard,
      skillRegistry,
      recentMessages: [{ role: 'user', content: 'Begin step 1' }],
    });

    // Simulate usage of 5000 tokens during step 1
    blackboard.recordTokenUsage(5000);

    // Turn 2 (Next step of same milestone)
    const contextTurn2 = assembler.assemble({
      threadPrompt: 'Implement authentication middleware',
      turnId: 'turn_1',
      stage: 'worker',
      currentMilestoneTitle: 'Token Validation',
      currentMilestoneDescription: 'Validate JWT signatures',
      blackboard,
      skillRegistry,
      recentMessages: [
        { role: 'user', content: 'Begin step 1' },
        { role: 'assistant', content: 'Read code' },
      ],
    });

    // CRITICAL: The System Prompt must be 100% byte-for-byte IDENTICAL despite token usage changing!
    const sysPrompt1 = contextTurn1[0].content as string;
    const sysPrompt2 = contextTurn2[0].content as string;
    assert.strictEqual(sysPrompt1, sysPrompt2, 'System prompt must remain identical for prefix cache hits');
  });
});

