import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DatabaseConfig {
  dbPath?: string; // If undefined or ':memory:', uses in-memory SQLite
}

export class AgentDatabase {
  private readonly db: DatabaseSync;

  constructor(config: DatabaseConfig = {}) {
    const dbPath = config.dbPath || ':memory:';
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
    `);
  }
}
