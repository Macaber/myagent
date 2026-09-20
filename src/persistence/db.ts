import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DatabaseConfig {
  dbPath?: string; // If undefined or ':memory:', uses in-memory SQLite
}

export class AgentDatabase {
  private readonly db: DatabaseSync;

  constructor(config: DatabaseConfig | string = {}) {
    const dbPath = typeof config === 'string' ? config : (config.dbPath || ':memory:');
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  public getRawDb(): DatabaseSync {
    return this.db;
  }

  public close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      -- 1. Threads
      CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_thread_id TEXT,
        current_state TEXT NOT NULL,
        current_turn_id TEXT,
        prompt TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        total_duration_ms INTEGER DEFAULT 0,
        total_prompt_tokens INTEGER DEFAULT 0,
        total_completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        total_turns INTEGER DEFAULT 0,
        total_steps INTEGER DEFAULT 0,
        error_message TEXT
      );

      -- 2. Turns
      CREATE TABLE IF NOT EXISTS turns (
        turn_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        turn_type TEXT NOT NULL,
        milestone_id TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        step_count INTEGER DEFAULT 0,
        summary TEXT,
        FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_turns_thread ON turns(thread_id, turn_index);

      -- 3. Steps
      CREATE TABLE IF NOT EXISTS steps (
        step_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_type TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        duration_ms INTEGER DEFAULT 0,
        prompt_tokens INTEGER DEFAULT 0,
        completion_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        error_message TEXT,
        metadata TEXT,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id) ON DELETE CASCADE,
        FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_steps_turn ON steps(turn_id, step_index);
      CREATE INDEX IF NOT EXISTS idx_steps_thread ON steps(thread_id, step_type);

      -- 4. Event Sourcing Journal
      CREATE TABLE IF NOT EXISTS task_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        step_id TEXT,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(thread_id) REFERENCES threads(thread_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_events ON task_events(thread_id, event_id);

      -- 5. Blackboard Entries
      CREATE TABLE IF NOT EXISTS blackboard_entries (
        thread_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        entry_value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(thread_id, entry_key)
      );

      -- 6. Artifacts
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        action TEXT NOT NULL,
        diff_content TEXT,
        created_at INTEGER NOT NULL
      );

        -- 7. ACP Sessions
        CREATE TABLE IF NOT EXISTS acp_sessions (
          session_id TEXT PRIMARY KEY,
          cwd TEXT NOT NULL,
          title TEXT,
          additional_directories TEXT,
          current_mode_id TEXT,
          config_options TEXT,
          history TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_acp_sessions_cwd ON acp_sessions(cwd);
      `);

      // Safe schema migration for existing databases
      try {
        this.db.exec(`ALTER TABLE acp_sessions ADD COLUMN history TEXT`);
      } catch {}

      // Auto-migrate legacy task_ thread IDs to canonical session_ IDs
      try {
        this.db.exec('PRAGMA foreign_keys = OFF;');
        const legacyRows = this.db.prepare(
          "SELECT thread_id, session_id FROM threads WHERE thread_id LIKE 'task_%'"
        ).all() as Array<{ thread_id: string; session_id: string | null }>;

        for (const row of legacyRows) {
          const targetSessionId = (row.session_id && row.session_id.startsWith('session_'))
            ? row.session_id
            : row.thread_id.replace(/^task_/, 'session_');

          this.db.prepare('UPDATE threads SET thread_id = ?, session_id = ? WHERE thread_id = ?').run(targetSessionId, targetSessionId, row.thread_id);
          this.db.prepare('UPDATE turns SET thread_id = ? WHERE thread_id = ?').run(targetSessionId, row.thread_id);
          this.db.prepare('UPDATE steps SET thread_id = ? WHERE thread_id = ?').run(targetSessionId, row.thread_id);
          this.db.prepare('UPDATE task_events SET thread_id = ? WHERE thread_id = ?').run(targetSessionId, row.thread_id);
          this.db.prepare('UPDATE blackboard_entries SET thread_id = ? WHERE thread_id = ?').run(targetSessionId, row.thread_id);
          this.db.prepare('UPDATE artifacts SET thread_id = ? WHERE thread_id = ?').run(targetSessionId, row.thread_id);
          this.db.prepare('UPDATE threads SET parent_thread_id = ? WHERE parent_thread_id = ?').run(targetSessionId, row.thread_id);
        }
        this.db.exec('PRAGMA foreign_keys = ON;');
      } catch {}
    }

  public saveAcpSession(session: {
    sessionId: string;
    cwd: string;
    title?: string | null;
    additionalDirectories?: string[];
    currentModeId?: string;
    configOptions?: any[];
    history?: any[];
    createdAt?: number;
    updatedAt?: number;
    deleted?: boolean;
  }): void {
    const stmt = this.db.prepare(`
      INSERT INTO acp_sessions (session_id, cwd, title, additional_directories, current_mode_id, config_options, history, created_at, updated_at, deleted)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cwd = excluded.cwd,
        title = excluded.title,
        additional_directories = excluded.additional_directories,
        current_mode_id = excluded.current_mode_id,
        config_options = excluded.config_options,
        history = COALESCE(excluded.history, acp_sessions.history),
        updated_at = excluded.updated_at,
        deleted = excluded.deleted
    `);
    stmt.run(
      session.sessionId,
      session.cwd,
      session.title ?? null,
      JSON.stringify(session.additionalDirectories || []),
      session.currentModeId ?? 'code',
      JSON.stringify(session.configOptions || []),
      session.history ? JSON.stringify(session.history) : null,
      session.createdAt || Date.now(),
      session.updatedAt || Date.now(),
      session.deleted ? 1 : 0
    );
  }

  public getAcpSession(sessionId: string): any | undefined {
    const stmt = this.db.prepare(`SELECT * FROM acp_sessions WHERE session_id = ? AND deleted = 0`);
    const row = stmt.get(sessionId) as any;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      cwd: row.cwd,
      title: row.title,
      additionalDirectories: row.additional_directories ? JSON.parse(row.additional_directories) : [],
      currentModeId: row.current_mode_id,
      configOptions: row.config_options ? JSON.parse(row.config_options) : [],
      history: row.history ? JSON.parse(row.history) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: Boolean(row.deleted),
    };
  }

  public synthesizeSessionHistory(sessionId: string): any[] {
    const existing = this.getAcpSession(sessionId);
    if (existing && existing.history && existing.history.length > 0) {
      return existing.history;
    }

    const rawDb = this.getRawDb();
    const history: any[] = [];

    // 1. Locate thread or session record
    const thread = rawDb.prepare(
      'SELECT thread_id, session_id, prompt, workspace_path FROM threads WHERE thread_id = ? OR session_id = ? LIMIT 1'
    ).get(sessionId, sessionId) as any;

    if (!thread) return history;

    // 2. Synthesize initial user prompt
    if (thread.prompt && thread.prompt !== 'Session initialized' && thread.prompt !== 'Session loaded') {
      history.push({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: thread.prompt },
      });
    }

    // 3. Synthesize from turns & steps
    const turns = rawDb.prepare(
      'SELECT turn_id, turn_index, turn_type, status, summary FROM turns WHERE thread_id = ? ORDER BY turn_index ASC'
    ).all(thread.thread_id) as any[];

    for (const turn of turns) {
      const steps = rawDb.prepare(
        'SELECT step_id, step_type, tool_name, status, error_message, metadata FROM steps WHERE turn_id = ? ORDER BY step_index ASC'
      ).all(turn.turn_id) as any[];

      for (const step of steps) {
        if (step.step_type === 'TOOL_EXECUTION' && step.tool_name) {
          let parsedMeta: any = {};
          try {
            parsedMeta = step.metadata ? JSON.parse(step.metadata) : {};
          } catch {}

          history.push({
            sessionUpdate: 'tool_call',
            callId: step.step_id,
            title: step.tool_name,
            rawInput: parsedMeta.args || {},
          });

          history.push({
            sessionUpdate: 'tool_call_update',
            callId: step.step_id,
            status: step.status === 'SUCCESS' ? 'completed' : 'failed',
            output: parsedMeta.resultPreview || step.error_message || 'Success',
          });
        }
      }

      if (turn.summary) {
        history.push({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: turn.summary },
        });
      }
    }

    // Cache synthesized history back into acp_sessions
    if (existing) {
      this.saveAcpSession({
        ...existing,
        history,
      });
    }

    return history;
  }

  public listAcpSessions(cwd?: string, limit: number = 50, cursor?: string): { sessions: any[]; nextCursor?: string } {
    let query = `SELECT * FROM acp_sessions WHERE deleted = 0`;
    const params: any[] = [];
    if (cwd) {
      query += ` AND cwd = ?`;
      params.push(cwd);
    }
    if (cursor) {
      const cursorTime = parseInt(cursor, 10);
      if (!isNaN(cursorTime)) {
        query += ` AND updated_at < ?`;
        params.push(cursorTime);
      }
    }
    query += ` ORDER BY updated_at DESC LIMIT ?`;
    params.push(limit + 1);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    let nextCursor: string | undefined;
    if (rows.length > limit) {
      const last = rows[limit - 1];
      nextCursor = String(last.updated_at);
      rows.splice(limit);
    }

    return {
      sessions: rows.map((r) => ({
        sessionId: r.session_id,
        cwd: r.cwd,
        title: r.title,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      nextCursor,
    };
  }

  public deleteAcpSession(sessionId: string): void {
    const stmt = this.db.prepare(`UPDATE acp_sessions SET deleted = 1, updated_at = ? WHERE session_id = ?`);
    stmt.run(Date.now(), sessionId);
  }
}

