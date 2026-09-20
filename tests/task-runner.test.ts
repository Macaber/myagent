import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentDatabase } from '../dist/persistence/db.js';
import { ToolRegistry } from '../dist/tools/tool-registry.js';
import { SkillRegistry } from '../dist/skills/skill-registry.js';
import { VerificationGuard } from '../dist/engine/verification-guard.js';
import { Planner } from '../dist/engine/planner.js';
import { WorkerAgent } from '../dist/engine/worker.js';
import { TaskRunner } from '../dist/runtime/task-runner.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import {
  bashTool,
  editTool,
  writeTool,
  readTool,
  grepTool,
  globTool,
} from '../dist/tools/core-tools.js';

describe('TaskRunner End-to-End Execution', () => {
  const testDir = path.resolve('/tmp/agent_e2e_workspace');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  test('Executes end-to-end task through Planning, Worker, and Summary turns', async () => {
    const db = new AgentDatabase();
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTool(bashTool);
    toolRegistry.registerTool(editTool);
    toolRegistry.registerTool(writeTool);
    toolRegistry.registerTool(readTool);
    toolRegistry.registerTool(grepTool);
    toolRegistry.registerTool(globTool);

    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);

    // Planner and Worker in offline/testing mode (no LLM credentials needed)
    const planner = new Planner(undefined, toolRegistry);
    const worker = new WorkerAgent(undefined, toolRegistry, skillRegistry, verificationGuard);
    const runner = new TaskRunner(planner, worker, toolRegistry);

    const threadId = 'task_e2e_001';
    const thread = new ThreadContext(
      {
        threadId,
        sessionId: 'sess_e2e',
        prompt: 'Setup typescript project and write hello world',
        workspacePath: testDir,
      },
      db
    );

    // Run task
    const report = await runner.runTask(thread);

    assert.strictEqual(report.threadId, threadId);
    assert.strictEqual(report.status, 'COMPLETED');
    assert.ok(report.counts.turns >= 4, 'Should execute Planning + 3 Worker turns + Summary');
    assert.ok(report.totalDurationMs >= 0);

    // Check that summary file was generated
    const summaryPath = path.join(testDir, '.agent', 'tasks', threadId, 'metrics_summary.json');
    assert.ok(fs.existsSync(summaryPath), `Summary artifact must exist at ${summaryPath}`);

    const savedSummary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    assert.strictEqual(savedSummary.threadId, threadId);
    assert.strictEqual(savedSummary.status, 'COMPLETED');

    db.close();
  });

  test('Seamlessly verifies file creation with Chinese cmd: criteria without shell execution', async () => {
    const db = new AgentDatabase();
    const toolRegistry = new ToolRegistry();
    let bashInvoked = false;
    toolRegistry.registerTool({
      ...bashTool,
      async execute(params: any, ctx: any) {
        bashInvoked = true;
        return bashTool.execute(params, ctx);
      },
    });
    toolRegistry.registerTool(writeTool);
    toolRegistry.registerTool(readTool);

    const skillRegistry = new SkillRegistry();
    const verificationGuard = new VerificationGuard(toolRegistry);

    const threadId = 'task_file_001';
    const thread = new ThreadContext(
      {
        threadId,
        sessionId: 'sess_file',
        prompt: '帮我创建一个 txt文件，内容是你好',
        workspacePath: testDir,
      },
      db
    );

    const targetFile = path.join(testDir, 'hello_test.txt');
    // Pre-create the file to simulate developer writing it
    fs.writeFileSync(targetFile, '你好', 'utf8');

    const criteria = `cmd: cat ${targetFile} 输出为“你好”；判定通过条件为文件存在且内容与“你好”完全一致。`;
    const milestone = {
      id: 'ms_1',
      title: '创建包含“你好”的文本文件',
      description: '新建 hello_test.txt 并写入 你好',
      dependencies: [],
      assignedSkill: 'developer',
      acceptanceCriteria: criteria,
      resultSummary: '文件 hello_test.txt 创建成功，内容为 你好',
      status: 'WAITING' as const,
    };

    const toolContext = {
      threadId: thread.threadId,
      workspaceJail: thread.workspaceJail,
      blackboard: thread.blackboard,
    };
    const verification = await verificationGuard.verifyMilestone(milestone, toolContext as any);

    assert.strictEqual(verification.passed, true);
    assert.strictEqual(bashInvoked, false, 'Should verify natively without triggering bash approval');

    // Clean up
    if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    db.close();
  });
});
