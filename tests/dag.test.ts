import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExecutionPlan } from '../dist/engine/dag.js';
import { VerificationGuard } from '../dist/engine/verification-guard.js';
import { WorkspaceJail } from '../dist/security/workspace-jail.js';

describe('Milestone DAG Execution Plan', () => {
  test('Resolves ready milestones according to dependency graph', () => {
    const plan = new ExecutionPlan('Test DAG', [
      {
        id: 'm1',
        title: 'Initial setup',
        description: 'setup',
        dependencies: [],
        assignedSkill: 'analyst',
        status: 'WAITING',
      },
      {
        id: 'm2',
        title: 'Backend feature',
        description: 'feature',
        dependencies: ['m1'],
        assignedSkill: 'developer',
        status: 'WAITING',
      },
      {
        id: 'm3',
        title: 'QA testing',
        description: 'tests',
        dependencies: ['m2'],
        assignedSkill: 'qa',
        status: 'WAITING',
      },
    ]);

    // Initially, only m1 has no dependencies
    const ready1 = plan.getReadyMilestones();
    assert.strictEqual(ready1.length, 1);
    assert.strictEqual(ready1[0].id, 'm1');

    // Mark m1 SUCCESS
    plan.markMilestoneStatus('m1', 'SUCCESS', 'Done');
    const ready2 = plan.getReadyMilestones();
    assert.strictEqual(ready2.length, 1);
    assert.strictEqual(ready2[0].id, 'm2');

    // Mark m2 SUCCESS
    plan.markMilestoneStatus('m2', 'SUCCESS', 'Done');
    const ready3 = plan.getReadyMilestones();
    assert.strictEqual(ready3.length, 1);
    assert.strictEqual(ready3[0].id, 'm3');

    // Mark m3 SUCCESS -> all completed
    plan.markMilestoneStatus('m3', 'SUCCESS', 'Done');
    assert.strictEqual(plan.isAllCompleted(), true);
  });

  test('VerificationGuard performs native safe file checks without shell execution', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vg-test-'));
    const testFile = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(testFile, '你好', 'utf8');

    const jail = new WorkspaceJail(tmpDir);
    let bashToolCalled = false;
    const mockToolRegistry: any = {
      executeTool: async (toolName: string) => {
        if (toolName === 'bash') bashToolCalled = true;
        return { output: 'mocked' };
      },
    };

    const guard = new VerificationGuard(mockToolRegistry);
    const mockContext: any = {
      workspaceJail: jail,
      threadId: 't1',
    };

    // 1. Chinese criteria with cmd: cat ... and expected text
    const r1 = await guard.verifyMilestone(
      {
        id: 'ms_1',
        title: 'Verify hello.txt',
        description: 'Check content',
        dependencies: [],
        assignedSkill: 'qa',
        acceptanceCriteria: `cmd: cat ${testFile} 输出为“你好”；判定通过条件为文件存在且内容与“你好”完全一致。`,
        status: 'WAITING',
      },
      mockContext
    );

    assert.strictEqual(r1.passed, true);
    assert.strictEqual(bashToolCalled, false, 'Should verify natively without calling bash tool');

    // 2. Non-existent file
    const r2 = await guard.verifyMilestone(
      {
        id: 'ms_2',
        title: 'Verify missing.txt',
        description: 'Check missing file',
        dependencies: [],
        assignedSkill: 'qa',
        acceptanceCriteria: 'file_exists: nonexistent_123.txt',
        status: 'WAITING',
      },
      mockContext
    );

    assert.strictEqual(r2.passed, false);
    assert.match(r2.message, /does not exist/);

    // 3. Command criteria clean execution
    const r3 = await guard.verifyMilestone(
      {
        id: 'ms_3',
        title: 'Run test suite',
        description: 'test',
        dependencies: [],
        assignedSkill: 'qa',
        acceptanceCriteria: 'cmd: echo "ok" ；判定通过条件为运行成功',
        status: 'WAITING',
      },
      mockContext
    );

    assert.strictEqual(r3.passed, true);
    assert.strictEqual(bashToolCalled, true, 'Cleaned command should be executed via tool registry');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
