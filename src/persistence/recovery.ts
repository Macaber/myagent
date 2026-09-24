import { AgentDatabase } from './db.js';
import { EventStore } from './event-store.js';

export interface UnfinishedThreadSummary {
  threadId: string;
  sessionId: string;
  currentState: string;
  currentTurnId?: string;
  prompt: string;
  workspacePath: string;
  lastActiveAt: number;
}

export class RecoveryManager {
  constructor(
    private readonly db: AgentDatabase,
    private readonly eventStore: EventStore
  ) {}

  public getUnfinishedThreads(): UnfinishedThreadSummary[] {
    const rawDb = this.db.getRawDb();
    const rows = rawDb.prepare(`
      SELECT thread_id as threadId, session_id as sessionId,
             current_state as currentState, current_turn_id as currentTurnId,
             prompt, workspace_path as workspacePath, updated_at as lastActiveAt
      FROM threads
      WHERE current_state IN ('PENDING', 'PLANNING', 'RUNNING', 'SUSPENDED_APPROVAL', 'SUSPENDED_INPUT')
      ORDER BY updated_at DESC
    `).all() as any[];

    return rows.map((r) => ({
      threadId: r.threadId,
      sessionId: r.sessionId,
      currentState: r.currentState,
      currentTurnId: r.currentTurnId || undefined,
      prompt: r.prompt,
      workspacePath: r.workspacePath,
      lastActiveAt: Number(r.lastActiveAt),
    }));
  }

  public healThreadAfterCrash(threadId: string): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();

    rawDb.exec('BEGIN IMMEDIATE;');
    try {
      // 1. Find any Step that was in 'RUNNING' status when crash occurred
      // (clock-guard: duration never negative)
      rawDb.prepare(`
        UPDATE steps
        SET status = 'FAILED', error_message = 'Process crashed or terminated unexpectedly during step execution',
            completed_at = ?, duration_ms = MAX(0, ? - started_at)
        WHERE thread_id = ? AND status = 'RUNNING'
      `).run(now, now, threadId);

      // 2. Find any Turn that was 'RUNNING'
      rawDb.prepare(`
        UPDATE turns
        SET status = 'SUSPENDED', completed_at = ?, duration_ms = MAX(0, ? - started_at)
        WHERE thread_id = ? AND status = 'RUNNING'
      `).run(now, now, threadId);

      // 3. Mark Thread so it can be resumed (covers every unfinished state
      // listed by getUnfinishedThreads, not just RUNNING/PLANNING)
      rawDb.prepare(`
        UPDATE threads
        SET current_state = 'SUSPENDED_INPUT', updated_at = ?
        WHERE thread_id = ? AND current_state IN ('PENDING', 'PLANNING', 'RUNNING', 'SUSPENDED_APPROVAL', 'SUSPENDED_INPUT')
      `).run(now, threadId);

      // 4. Log crash recovery event
      this.eventStore.appendEvent({
        threadId,
        eventType: 'CRASH_RECOVERED',
        payload: { recoveredAt: now, message: 'Cleaned up orphan running steps/turns' },
        createdAt: now,
      });

      rawDb.exec('COMMIT;');
    } catch (err) {
      try {
        rawDb.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
  }
}
