import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { ExecutionPlan } from '../dist/engine/dag.js';

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
});
