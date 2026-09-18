import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { AgentDatabase } from '../dist/persistence/db.js';
import { EventStore } from '../dist/persistence/event-store.js';
import { TelemetryStore } from '../dist/persistence/telemetry-store.js';
import { Blackboard } from '../dist/context/blackboard.js';

describe('Persistence & Event Sourcing', () => {
  test('AgentDatabase initializes tables in memory', () => {
    const db = new AgentDatabase({ dbPath: ':memory:' });
    const raw = db.getRawDb();
    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const names = tables.map((t) => t.name);

    assert.ok(names.includes('threads'), 'threads table exists');
    assert.ok(names.includes('turns'), 'turns table exists');
    assert.ok(names.includes('steps'), 'steps table exists');
    assert.ok(names.includes('task_events'), 'task_events table exists');
    assert.ok(names.includes('blackboard_entries'), 'blackboard_entries table exists');
    assert.ok(names.includes('artifacts'), 'artifacts table exists');
    db.close();
  });

  test('EventStore appends and retrieves sequential events', () => {
    const db = new AgentDatabase();
    const telemetry = new TelemetryStore(db);
    const store = new EventStore(db);

    // Create thread row first to satisfy Foreign Key
    telemetry.recordThreadStart({
      threadId: 't_1',
      sessionId: 's_1',
      prompt: 'test prompt',
      workspacePath: '/tmp',
    });

    const id1 = store.appendEvent({
      threadId: 't_1',
      turnId: 'turn_0',
      eventType: 'THREAD_STARTED',
      payload: { goal: 'test' },
      createdAt: 1000,
    });
    const id2 = store.appendEvent({
      threadId: 't_1',
      turnId: 'turn_0',
      stepId: 's_0',
      eventType: 'STEP_FINISHED',
      payload: { status: 'SUCCESS' },
      createdAt: 1010,
    });

    assert.strictEqual(id1, 1);
    assert.strictEqual(id2, 2);

    const events = store.getEventsByThread('t_1');
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].eventType, 'THREAD_STARTED');
    assert.strictEqual(events[1].eventType, 'STEP_FINISHED');
    assert.strictEqual(events[1].payload.status, 'SUCCESS');
    db.close();
  });

  test('Blackboard stores state, artifacts, and todos', () => {
    const db = new AgentDatabase();
    const bb = new Blackboard('thread_bb_1', db);

    bb.set('config', { timeout: 5000, verbose: true });
    assert.deepStrictEqual(bb.get('config'), { timeout: 5000, verbose: true });

    bb.appendArtifact({
      artifactId: 'art_1',
      filePath: 'src/main.ts',
      action: 'CREATE',
      diffContent: '+console.log("hello")',
    });
    const artifacts = bb.getArtifacts();
    assert.strictEqual(artifacts.length, 1);
    assert.strictEqual(artifacts[0].filePath, 'src/main.ts');

    bb.updateTodos([
      { id: '1', content: 'Step 1', status: 'completed' },
      { id: '2', content: 'Step 2', status: 'in_progress' },
    ]);
    const todos = bb.getTodos();
    assert.strictEqual(todos.length, 2);
    assert.strictEqual(todos[0].status, 'completed');
    db.close();
  });
});
