import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { AgentDatabase } from '../dist/persistence/db.js';
import { ThreadContext } from '../dist/runtime/thread-context.js';
import { ExecutionPlan } from '../dist/engine/dag.js';
import { BreakpointResumer } from '../dist/runtime/breakpoint-resumer.js';

describe('Targeted Breakpoint Resume (Zero-Rerun of Completed Milestones)', () => {
  test('Preserves SUCCESS milestones and resets only failed milestones', () => {
    const db = new AgentDatabase();
    const thread = new ThreadContext(
      {
        threadId: 'thread_resume_test',
        sessionId: 'sess_1',
        prompt: 'Build auth and test',
        workspacePath: '/tmp/work',
      },
      db
    );

    const plan = new ExecutionPlan('Resume Plan', [
      {
        id: 'm1',
        title: 'Step 1: Code analysis',
        description: 'Analyze',
        dependencies: [],
        assignedSkill: 'analyst',
        status: 'SUCCESS',
        resultSummary: 'Analysis artifacts generated',
      },
      {
        id: 'm2',
        title: 'Step 2: Service implementation',
        description: 'Implement',
        dependencies: ['m1'],
        assignedSkill: 'developer',
        status: 'FAILED',
        error: 'TypeScript compile error in auth.ts:25',
      },
      {
        id: 'm3',
        title: 'Step 3: Verification',
        description: 'Verify',
        dependencies: ['m2'],
        assignedSkill: 'qa',
        status: 'WAITING',
      },
    ]);

    thread.setExecutionPlan(plan);

    // Perform breakpoint resume preparation
    const resumeInfo = BreakpointResumer.prepareResume(thread);

    // Assert: m1 remains SUCCESS and is skipped
    assert.deepStrictEqual(resumeInfo.skippedMilestoneIds, ['m1']);
    assert.strictEqual(resumeInfo.resumedMilestone.id, 'm2');

    // Assert: m2 is reset to READY
    const updatedPlan = thread.getExecutionPlan()!;
    assert.strictEqual(updatedPlan.getMilestone('m1')!.status, 'SUCCESS');
    assert.strictEqual(updatedPlan.getMilestone('m2')!.status, 'READY');
    assert.strictEqual(updatedPlan.getMilestone('m2')!.error, undefined);
    assert.strictEqual(updatedPlan.getMilestone('m3')!.status, 'WAITING');

    db.close();
  });
});
