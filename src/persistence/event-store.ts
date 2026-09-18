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

  public getEventsByThread(threadId: string): EventRecord[] {
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      SELECT event_id as eventId, thread_id as threadId, turn_id as turnId,
             step_id as stepId, event_type as eventType, payload, created_at as createdAt
      FROM task_events
      WHERE thread_id = ?
      ORDER BY event_id ASC
    `);
    const rows = stmt.all(threadId) as any[];
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
