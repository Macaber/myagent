import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createAgentRuntime } from '../dist/index.js';
import { AcpClient } from '../dist/client/acp-client.js';
import { createMemoryTransportPair } from '../dist/client/memory-transport.js';
import { DashboardService } from '../dist/dashboard/dashboard-service.js';
import { AgentDatabase } from '../dist/persistence/db.js';

describe('Session Concept & Multi-Turn Conversation Resumption', () => {
  let tmpDir: string;
  let testDbPath: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myagent-resume-test-'));
    testDbPath = path.join(tmpDir, 'test-resume.db');
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test('1. Creates session, executes prompt turn 1, and persists history to SQLite', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: testDbPath,
      autoScanSkills: false,
      autoLoadMcp: false,
    });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    const sessionRes = await client.newSession({
      cwd: tmpDir,
      sessionId: 'session_test_resume_1',
    });

    assert.strictEqual(sessionRes.sessionId, 'session_test_resume_1');

    // Run Turn 1
    const promptRes = await client.promptSession('session_test_resume_1', '你好，请准备编写测试。');
    assert.strictEqual(promptRes.status, 'completed');

    // Verify session persisted in SQLite
    const fromDb = runtime.db.getAcpSession('session_test_resume_1');
    assert.ok(fromDb, 'Session should exist in acp_sessions table');
    assert.ok(fromDb.history.length >= 2, 'Should persist history chunks to database');

    await client.close();
    runtime.close();
  });

  test('2. Reopens database in a new runtime, loads historical session, and replays complete history', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: testDbPath,
      autoScanSkills: false,
      autoLoadMcp: false,
    });
    const client = new AcpClient(clientTransport);

    await client.initialize();

    const replayedUpdates: any[] = [];
    client.onSessionUpdate((notif) => {
      replayedUpdates.push(notif);
    });

    // Load session from disk
    const loadRes = await client.loadSession('session_test_resume_1');
    assert.strictEqual(loadRes.sessionId, 'session_test_resume_1');

    await new Promise((r) => setTimeout(r, 30));

    // Verify replayed conversation
    const hasUserChunk = replayedUpdates.some(
      (u) => (u.update?.sessionUpdate || u.sessionUpdate) === 'user_message_chunk'
    );
    const hasAgentChunk = replayedUpdates.some(
      (u) => (u.update?.sessionUpdate || u.sessionUpdate) === 'agent_message_chunk'
    );
    assert.ok(hasUserChunk, 'Must replay historical user prompt');
    assert.ok(hasAgentChunk, 'Must replay historical agent response');

    await client.close();
    runtime.close();
  });

  test('3. Resumes conversation on loaded session, increments turns without SQLite conflicts', async () => {
    const { clientTransport, serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({
      transport: serverTransport,
      dbPath: testDbPath,
      autoScanSkills: false,
      autoLoadMcp: false,
    });
    const client = new AcpClient(clientTransport);

    await client.initialize();
    await client.loadSession('session_test_resume_1');

    // Execute Turn 2 on resumed session
    const promptRes2 = await client.promptSession('session_test_resume_1', '请继续第二轮指令：输出完成。');
    assert.strictEqual(promptRes2.status, 'completed');

    // Verify turns count in telemetry
    const metrics = runtime.activeThreads.get('session_test_resume_1')?.telemetryStore.getThreadMetrics('session_test_resume_1');
    assert.ok(metrics, 'Metrics should exist');
    assert.ok(metrics.counts.turns >= 2, 'Should accumulate turns on the resumed session');

    await client.close();
    runtime.close();
  });

  test('4. DashboardService serves sessions, session detail, and status updates', () => {
    // 1. getSessionList
    const sessions = DashboardService.getSessionList(testDbPath);
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length > 0);
    assert.strictEqual(sessions[0].sessionId, 'session_test_resume_1');

    // 2. getSessionDetail
    const detail = DashboardService.getSessionDetail(testDbPath, 'session_test_resume_1');
    assert.ok(detail);
    assert.strictEqual(detail.thread.sessionId, 'session_test_resume_1');
    assert.ok(detail.turns.length >= 2, 'Detail should include all accumulated turns');

    // 3. updateSessionStatus
    const updated = DashboardService.updateSessionStatus(testDbPath, 'session_test_resume_1', 'SUSPENDED');
    assert.strictEqual(updated, true);
    const detailAfter = DashboardService.getSessionDetail(testDbPath, 'session_test_resume_1');
    assert.strictEqual(detailAfter?.thread.currentState, 'SUSPENDED');
  });

  test('5. DashboardService.resumeSession executes follow-up prompt on session', async () => {
    const resumeRes = await DashboardService.resumeSession(testDbPath, 'session_test_resume_1', {
      prompt: '通过 Dashboard API 恢复并发送后续提示词',
      mode: 'continue',
      autoDiscoverProvider: false,
    });

    assert.strictEqual(resumeRes.success, true);
    assert.strictEqual(resumeRes.sessionId, 'session_test_resume_1');

    // Verify that a new turn was recorded
    const detail = DashboardService.getSessionDetail(testDbPath, 'session_test_resume_1');
    assert.ok(detail);
    assert.ok(detail.turns.length >= 3, 'Should have at least 3 turns after dashboard resumption');
  });

  test('6. Synthesizes session history from raw threads/turns if acp_sessions was absent', () => {
    const { serverTransport } = createMemoryTransportPair();
    const runtime = createAgentRuntime({
      dbPath: testDbPath,
      transport: serverTransport,
      autoScanSkills: false,
      autoLoadMcp: false,
    });

    // Manually insert a legacy thread with turns and steps into SQLite
    const rawDb = runtime.db.getRawDb();
    const legacyId = `legacy_task_${Date.now()}`;
    rawDb.prepare(`
      INSERT INTO threads (
        thread_id, session_id, current_state, prompt, workspace_path, created_at, updated_at
      ) VALUES (?, ?, 'COMPLETED', '原始旧任务目标', '/tmp', ?, ?)
    `).run(legacyId, legacyId, Date.now() - 10000, Date.now());

    rawDb.prepare(`
      INSERT INTO turns (
        turn_id, thread_id, turn_index, turn_type, status, started_at, summary
      ) VALUES (?, ?, 0, 'WORKER', 'COMPLETED', ?, '旧任务执行总结完成')
    `).run(`${legacyId}_turn_0`, legacyId, Date.now() - 5000);

    // Call synthesizeSessionHistory
    const synthesized = runtime.db.synthesizeSessionHistory(legacyId);
    assert.ok(Array.isArray(synthesized));
    assert.ok(synthesized.length >= 2);
    assert.strictEqual(synthesized[0].sessionUpdate, 'user_message_chunk');
    assert.strictEqual(synthesized[0].content.text, '原始旧任务目标');
    assert.strictEqual(synthesized[1].sessionUpdate, 'agent_message_chunk');
    assert.strictEqual(synthesized[1].content.text, '旧任务执行总结完成');

    runtime.close();
  });

  test('7. Auto-migrates legacy task_ IDs to session_ IDs in AgentDatabase and DashboardService', () => {
    const legacyDbPath = path.join(tmpDir, 'legacy-task.db');
    const legacyDb = new AgentDatabase(legacyDbPath);
    const rawDb = legacyDb.getRawDb();

    // Insert legacy task_ thread with turns and child steps
    const legacyTaskId = 'task_1789870355106';
    const canonicalSessionId = 'session_1789870355106';
    rawDb.prepare(`
      INSERT INTO threads (
        thread_id, session_id, current_state, prompt, workspace_path, created_at, updated_at
      ) VALUES (?, ?, 'COMPLETED', '历史评测任务', '/tmp', ?, ?)
    `).run(legacyTaskId, canonicalSessionId, Date.now() - 50000, Date.now() - 10000);

    rawDb.prepare(`
      INSERT INTO turns (
        turn_id, thread_id, turn_index, turn_type, status, started_at, summary
      ) VALUES (?, ?, 0, 'WORKER', 'COMPLETED', ?, '历史总结')
    `).run(`turn_0`, legacyTaskId, Date.now() - 40000);

    rawDb.prepare(`
      INSERT INTO steps (
        step_id, turn_id, thread_id, step_index, step_type, status, started_at
      ) VALUES (?, ?, ?, 0, 'MODEL_CALL', 'SUCCESS', ?)
    `).run('step_0', 'turn_0', legacyTaskId, Date.now() - 30000);

    legacyDb.close();

    // Reopen database - initSchema triggers auto-migration
    const reopenedDb = new AgentDatabase(legacyDbPath);
    const reopenedRaw = reopenedDb.getRawDb();

    // Check threads table
    const legacyCheck = reopenedRaw.prepare('SELECT * FROM threads WHERE thread_id = ?').get(legacyTaskId);
    assert.strictEqual(legacyCheck, undefined, 'Old task_ thread_id should have been migrated');

    const migratedRow = reopenedRaw.prepare('SELECT * FROM threads WHERE thread_id = ?').get(canonicalSessionId) as any;
    assert.ok(migratedRow, 'Thread should now have canonical session_id as thread_id');
    assert.strictEqual(migratedRow.session_id, canonicalSessionId);

    // Check turns & steps foreign keys
    const turnsCheck = reopenedRaw.prepare('SELECT * FROM turns WHERE thread_id = ?').all(canonicalSessionId);
    assert.strictEqual(turnsCheck.length, 1, 'Turns should reference new session_id');

    const stepsCheck = reopenedRaw.prepare('SELECT * FROM steps WHERE thread_id = ?').all(canonicalSessionId);
    assert.strictEqual(stepsCheck.length, 1, 'Steps should reference new session_id');

    // Check DashboardService
    const sessions = DashboardService.getSessionList(legacyDbPath);
    assert.strictEqual(sessions[0].sessionId, canonicalSessionId);
    assert.strictEqual(sessions[0].threadId, canonicalSessionId);

    const detail = DashboardService.getSessionDetail(legacyDbPath, canonicalSessionId);
    assert.ok(detail);
    assert.strictEqual(detail.thread.sessionId, canonicalSessionId);
    assert.strictEqual(detail.turns.length, 1);

    // Also verify querying by legacy task_ id still resolves via dual query
    const dualDetail = DashboardService.getSessionDetail(legacyDbPath, legacyTaskId);
    assert.ok(dualDetail, 'Should still resolve if queried with legacy task_ id');

    reopenedDb.close();
  });
});
