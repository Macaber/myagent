import { AgentDatabase } from './db.js';

export interface EventRecord<T = any> {
  eventId?: number;
  threadId: string;
  turnId?: string;
  stepId?: string;
  eventType: string;
  payload: T;
  createdAt: number;
}

export class EventStore {
  constructor(private readonly db: AgentDatabase) {}

  public appendEvent<T = any>(event: Omit<EventRecord<T>, 'eventId'>): number {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      INSERT INTO task_events (thread_id, turn_id, step_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      event.threadId,
      event.turnId ?? null,
      event.stepId ?? null,
      event.eventType,
      JSON.stringify(event.payload),
      event.createdAt || Date.now()
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Batch append in a single transaction (one fsync under WAL instead of N).
   */
  public appendEventsBatch<T = any>(events: Array<Omit<EventRecord<T>, 'eventId'>>): number[] {
    if (events.length === 0) return [];
    if (events.length === 1) return [this.appendEvent(events[0])];
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      INSERT INTO task_events (thread_id, turn_id, step_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const ids: number[] = [];
    rawDb.exec('BEGIN IMMEDIATE;');
    try {
      for (const event of events) {
        const result = stmt.run(
          event.threadId,
          event.turnId ?? null,
          event.stepId ?? null,
          event.eventType,
          JSON.stringify(event.payload),
          event.createdAt || Date.now()
        );
        ids.push(Number(result.lastInsertRowid));
      }
      rawDb.exec('COMMIT;');
    } catch (err) {
      try {
        rawDb.exec('ROLLBACK;');
      } catch {}
      throw err;
    }
    return ids;
  }

  public getEventsByThread(
    threadId: string,
    options: { after?: number; limit?: number } = {}
  ): EventRecord[] {
    const rawDb = this.db.getRawDb();
    const limit = Math.min(Math.max(options.limit ?? 1000, 1), 5000);
    let query = `
      SELECT event_id as eventId, thread_id as threadId, turn_id as turnId,
              step_id as stepId, event_type as eventType, payload, created_at as createdAt
      FROM task_events
      WHERE thread_id = ?
    `;
    const params: any[] = [threadId];
    if (options.after !== undefined) {
      query += ` AND event_id > ?`;
      params.push(options.after);
    }
    query += ` ORDER BY event_id ASC LIMIT ?`;
    params.push(limit);
    const rows = rawDb.prepare(query).all(...params) as any[];
    return rows.map((row) => ({
      eventId: row.eventId,
      threadId: row.threadId,
      turnId: row.turnId || undefined,
      stepId: row.stepId || undefined,
      eventType: row.eventType,
      payload: JSON.parse(row.payload),
      createdAt: row.createdAt,
    }));
  }
}
