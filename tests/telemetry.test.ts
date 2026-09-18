import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { AgentDatabase } from '../dist/persistence/db.js';
import { TelemetryStore } from '../dist/persistence/telemetry-store.js';

describe('Thread-Turn-Step Telemetry & Analytics', () => {
  test('Accurately tracks stage duration, tokens, and counts across hierarchy', async () => {
    const db = new AgentDatabase();
    const store = new TelemetryStore(db);
    const threadId = 'thread_telemetry_test';

    // 1. Thread Start
    store.recordThreadStart({
      threadId,
      sessionId: 'session_1',
      prompt: 'Refactor auth module',
      workspacePath: '/tmp/work',
    });

    // 2. Turn 0: PLANNING
    store.recordTurnStart({
      turnId: 'turn_0',
      threadId,
      turnIndex: 0,
      turnType: 'PLANNING',
    });

    // Step 0: Model Call
    store.recordStepStart({
      stepId: 'step_0',
      turnId: 'turn_0',
      threadId,
      stepIndex: 0,
      stepType: 'MODEL_CALL',
    });
    await new Promise((r) => setTimeout(r, 20));
    store.recordStepEnd({
      stepId: 'step_0',
      status: 'SUCCESS',
      tokens: { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
    });

    // End Turn 0
    store.recordTurnEnd({
      turnId: 'turn_0',
      status: 'COMPLETED',
      summary: 'Planned 2 milestones',
    });

    // 3. Turn 1: WORKER
    store.recordTurnStart({
      turnId: 'turn_1',
      threadId,
      turnIndex: 1,
      turnType: 'WORKER',
      milestoneId: 'ms_1',
    });

    // Step 1: Model Call
    store.recordStepStart({
      stepId: 'step_1',
      turnId: 'turn_1',
      threadId,
      stepIndex: 0,
      stepType: 'MODEL_CALL',
    });
    store.recordStepEnd({
      stepId: 'step_1',
      status: 'SUCCESS',
      tokens: { promptTokens: 1500, completionTokens: 300, totalTokens: 1800 },
    });

    // Step 2: Tool Execution (edit)
    store.recordStepStart({
      stepId: 'step_2',
      turnId: 'turn_1',
      threadId,
      stepIndex: 1,
      stepType: 'TOOL_EXECUTION',
      toolName: 'edit',
    });
    await new Promise((r) => setTimeout(r, 10));
    store.recordStepEnd({
      stepId: 'step_2',
      status: 'SUCCESS',
    });

    // End Turn 1
    store.recordTurnEnd({
      turnId: 'turn_1',
      status: 'COMPLETED',
      summary: 'Finished ms_1',
    });

    // 4. Thread End
    store.recordThreadEnd(threadId, 'COMPLETED');

    // 5. Query Metrics Report
    const report = store.getThreadMetrics(threadId);

    assert.strictEqual(report.threadId, threadId);
    assert.strictEqual(report.status, 'COMPLETED');
    assert.strictEqual(report.counts.turns, 2, 'Total turns should be 2');
    assert.strictEqual(report.counts.steps, 3, 'Total steps should be 3');
    assert.strictEqual(report.counts.modelCalls, 2, 'Model calls should be 2');
    assert.strictEqual(report.counts.toolCalls, 1, 'Tool calls should be 1');

    // Check token accumulation: Turn 0 (1200) + Turn 1 (1800) = 3000
    assert.strictEqual(report.totalTokens.promptTokens, 2500);
    assert.strictEqual(report.totalTokens.completionTokens, 500);
    assert.strictEqual(report.totalTokens.totalTokens, 3000);

    // Check Turn 0 tokens
    assert.strictEqual(report.turnsBreakdown[0].tokens.totalTokens, 1200);
    assert.strictEqual(report.turnsBreakdown[0].stepCount, 1);

    // Check Turn 1 tokens
    assert.strictEqual(report.turnsBreakdown[1].tokens.totalTokens, 1800);
    assert.strictEqual(report.turnsBreakdown[1].stepCount, 2);

    // Check Tool Metrics
    assert.strictEqual(report.toolMetrics.length, 1);
    assert.strictEqual(report.toolMetrics[0].toolName, 'edit');
    assert.strictEqual(report.toolMetrics[0].callCount, 1);

    db.close();
  });
});
