import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { AgentDatabase } from '../dist/persistence/db.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { ToolRegistry } from '../dist/tools/tool-registry.js';
import { SkillRegistry } from '../dist/skills/skill-registry.js';
import { VerificationGuard } from '../dist/engine/verification-guard.js';
import { WorkerAgent } from '../dist/engine/worker.js';
import { SubagentManager } from '../dist/runtime/subagent-manager.js';
import { createInvokeSubagentTool } from '../dist/tools/subagent-tool.js';
import { readTool, writeTool, globTool, grepTool } from '../dist/tools/core-tools.js';

describe('Sub-agent Task Delegation & Context Isolation', () => {
  test('SubagentManager spawns isolated child thread and reports back to parent', async () => {
    const db = new AgentDatabase();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(readTool);
    toolRegistry.registerTool(writeTool);

    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);
    const worker = new WorkerAgent(undefined, toolRegistry, skillRegistry, verificationGuard);
    const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry);

    // 1. Create Master Parent Thread
    const masterThread = new ThreadContext(
      {
        threadId: 'master_thread_001',
        sessionId: 'session_parent',
        prompt: 'Build entire system with microservices',
        workspacePath: '/tmp/master_work',
      },
      db
    );

    // 2. Delegate a subtask to Subagent
    const subResult = await subagentManager.runSubagent(masterThread, {
      role: 'Auth Module Specialist',
      taskDescription: 'Design JWT authentication schema and token rotation',
      skillId: 'analyst',
    });

    // 3. Verify Subagent Result
    assert.ok(subResult.subagentId.startsWith('sub_'));
    assert.strictEqual(subResult.role, 'Auth Module Specialist');
    assert.strictEqual(subResult.status, 'SUCCESS');
    assert.ok(subResult.summary.includes('executed successfully'));

    // 4. Verify Parent Blackboard has the subagent artifact
    const savedEntry = masterThread.blackboard.get(`subagent_${subResult.subagentId}`);
    assert.ok(savedEntry, 'Subagent output must be saved in parent blackboard');
    assert.strictEqual(savedEntry.role, 'Auth Module Specialist');
    assert.strictEqual(savedEntry.status, 'SUCCESS');

    // 5. Verify Parent-Child hierarchy in SQLite threads table
    const rawDb = db.getRawDb();
    const childRow = rawDb.prepare('SELECT * FROM threads WHERE thread_id = ?').get(
      `${masterThread.threadId}_${subResult.subagentId}`
    ) as any;

    assert.ok(childRow, 'Child thread must exist in threads table');
    assert.strictEqual(childRow.parent_thread_id, 'master_thread_001', 'Must link to parent thread ID');
    assert.strictEqual(childRow.current_state, 'COMPLETED');

    db.close();
  });

  test('invoke_subagent tool executes and returns concise summary without leaking context', async () => {
    const db = new AgentDatabase();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);
    const worker = new WorkerAgent(undefined, toolRegistry, skillRegistry, verificationGuard);
    const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry);

    const activeThreads = new Map<string, ThreadContext>();
    const invokeTool = createInvokeSubagentTool(subagentManager, (id) => activeThreads.get(id));

    const masterThread = new ThreadContext(
      {
        threadId: 'master_thread_002',
        sessionId: 'session_parent_2',
        prompt: 'Master goal',
        workspacePath: '/tmp/master_work_2',
      },
      db
    );
    activeThreads.set(masterThread.threadId, masterThread);

    // Call invoke_subagent tool
    const output = await invokeTool.execute(
      {
        role: 'Database Schema Researcher',
        taskDescription: 'Analyze migration tables',
        skillId: 'developer',
      },
      {
        threadId: masterThread.threadId,
        workspaceJail: masterThread.workspaceJail,
        blackboard: masterThread.blackboard,
      }
    );

    // Tool returns clean, concise result (only high-level summary, preventing context overflow)
    assert.match(output, /DATABASE SCHEMA RESEARCHER/);
    assert.match(output, /SUCCESS/);
    assert.match(output, /核心调研事实与结果报告/);

    db.close();
  });

  test('explore subagent strictly receives read-only tools and cannot write or execute bash', async () => {
    const db = new AgentDatabase();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(readTool);
    toolRegistry.registerTool(writeTool);
    toolRegistry.registerTool(globTool);
    toolRegistry.registerTool(grepTool);

    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);
    const worker = new WorkerAgent(undefined, toolRegistry, skillRegistry, verificationGuard);
    const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry);

    // Verify ToolRouter schemas for 'explore' role
    const exploreSchemas = worker.toolRouter.getActiveToolSchemas('turn_explore', 'worker', 'explore');
    const exploreToolNames = exploreSchemas.map((t) => t.function.name);

    assert.ok(exploreToolNames.includes('read'), 'explore must have read');
    assert.ok(exploreToolNames.includes('glob'), 'explore must have glob');
    assert.ok(exploreToolNames.includes('grep'), 'explore must have grep');
    assert.ok(!exploreToolNames.includes('write'), 'explore must NOT have write');
    assert.ok(!exploreToolNames.includes('edit'), 'explore must NOT have edit');
    assert.ok(!exploreToolNames.includes('bash'), 'explore must NOT have bash');

    db.close();
  });

  test('invoke_subagent executes batch concurrent subagents in parallel (Promise.all)', async () => {
    const db = new AgentDatabase();
    const toolRegistry = new ToolRegistry();
    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);
    const worker = new WorkerAgent(undefined, toolRegistry, skillRegistry, verificationGuard);
    const subagentManager = new SubagentManager(db, worker, toolRegistry, skillRegistry);

    const activeThreads = new Map<string, ThreadContext>();
    const invokeTool = createInvokeSubagentTool(subagentManager, (id) => activeThreads.get(id));

    const masterThread = new ThreadContext(
      {
        threadId: 'master_thread_003',
        sessionId: 'session_parent_3',
        prompt: 'Analyze whole codebase subsystems in parallel',
        workspacePath: '/tmp/master_work_3',
      },
      db
    );
    activeThreads.set(masterThread.threadId, masterThread);

    // Dispatch 3 concurrent subagents in a single tool call
    const batchOutput = await invokeTool.execute(
      {
        subagents: [
          { role: 'explore', taskDescription: 'Explore src/security modules' },
          { role: 'explore', taskDescription: 'Explore src/protocol modules' },
          { role: 'explore', taskDescription: 'Explore src/engine modules' },
        ],
      },
      {
        threadId: masterThread.threadId,
        workspaceJail: masterThread.workspaceJail,
        blackboard: masterThread.blackboard,
      }
    );

    // Verify aggregated report contains all 3 subagents
    assert.match(batchOutput, /SUBAGENTS CONCURRENT EXECUTION REPORT \(3 subagents completed\)/);
    assert.match(batchOutput, /Subagent 1: EXPLORE/);
    assert.match(batchOutput, /Subagent 2: EXPLORE/);
    assert.match(batchOutput, /Subagent 3: EXPLORE/);

    // Verify SQLite has 3 separate child threads recorded
    const rawDb = db.getRawDb();
    const childRows = rawDb.prepare('SELECT * FROM threads WHERE parent_thread_id = ?').all(masterThread.threadId);
    assert.strictEqual(childRows.length, 3, 'Must create 3 isolated child threads in database');

    db.close();
  });
});
