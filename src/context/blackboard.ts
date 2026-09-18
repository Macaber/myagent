import { AgentDatabase } from '../persistence/db.js';

export interface ArtifactEntry {
  artifactId: string;
  filePath: string;
  action: 'CREATE' | 'MODIFY' | 'DELETE';
  diffContent?: string;
  createdAt: number;
}

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface MilestoneSummaryEntry {
  milestoneId: string;
  title: string;
  summary: string;
  completedAt: number;
  artifacts?: string[];
}

export class Blackboard {
  private inMemoryEntries = new Map<string, any>();
  private inMemoryArtifacts: ArtifactEntry[] = [];
  private inMemoryMilestones: MilestoneSummaryEntry[] = [];
  private totalBudget = 200000;
  private usedBudget = 0;

  constructor(
    private readonly threadId: string = 'default_thread',
    private readonly db?: AgentDatabase
  ) {}

  public set<T = any>(key: string, value: T): void {
    if (!this.db) {
      this.inMemoryEntries.set(key, value);
      return;
    }
    const rawDb = this.db.getRawDb();
    const now = Date.now();
    const stmt = rawDb.prepare(`
      INSERT INTO blackboard_entries (thread_id, entry_key, entry_value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, entry_key) DO UPDATE SET
        entry_value = excluded.entry_value,
        updated_at = excluded.updated_at
    `);
    stmt.run(this.threadId, key, JSON.stringify(value), now);
  }

  public get<T = any>(key: string): T | undefined {
    if (!this.db) {
      return this.inMemoryEntries.get(key) as T;
    }
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      SELECT entry_value FROM blackboard_entries
      WHERE thread_id = ? AND entry_key = ?
    `);
    const row = stmt.get(this.threadId, key) as any;
    if (!row) return undefined;
    try {
      return JSON.parse(row.entry_value) as T;
    } catch {
      return row.entry_value as any;
    }
  }

  public listEntries(): Record<string, any> {
    if (!this.db) {
      return Object.fromEntries(this.inMemoryEntries);
    }
    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      SELECT entry_key, entry_value FROM blackboard_entries
      WHERE thread_id = ?
    `);
    const rows = stmt.all(this.threadId) as any[];
    const result: Record<string, any> = {};
    for (const r of rows) {
      try {
        result[r.entry_key] = JSON.parse(r.entry_value);
      } catch {
        result[r.entry_key] = r.entry_value;
      }
    }
    return result;
  }

  // =================== Artifact Management ===================

  public appendArtifact(entry: Omit<ArtifactEntry, 'createdAt'>): void {
    const now = Date.now();
    const fullEntry: ArtifactEntry = { ...entry, createdAt: now };

    if (!this.db) {
      this.inMemoryArtifacts.push(fullEntry);
      return;
    }

    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      INSERT INTO artifacts (artifact_id, thread_id, file_path, action, diff_content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.artifactId,
      this.threadId,
      entry.filePath,
      entry.action,
      entry.diffContent ?? null,
      now
    );
  }

  public getArtifacts(): ArtifactEntry[] {
    if (!this.db) {
      return [...this.inMemoryArtifacts];
    }

    const rawDb = this.db.getRawDb();
    const stmt = rawDb.prepare(`
      SELECT artifact_id as artifactId, file_path as filePath, action,
             diff_content as diffContent, created_at as createdAt
      FROM artifacts
      WHERE thread_id = ?
      ORDER BY created_at ASC
    `);
    const rows = stmt.all(this.threadId) as any[];
    return rows.map((r) => ({
      artifactId: r.artifactId,
      filePath: r.filePath,
      action: r.action,
      diffContent: r.diffContent || undefined,
      createdAt: Number(r.createdAt),
    }));
  }

  public getModifiedFiles(): string[] {
    const arts = this.getArtifacts();
    return Array.from(new Set(arts.map((a) => a.filePath)));
  }

  // =================== Milestone Summaries (Compaction) ===================

  public recordMilestoneCompletion(
    milestoneId: string,
    title: string,
    summary: string,
    artifacts?: string[]
  ): void {
    const entry: MilestoneSummaryEntry = {
      milestoneId,
      title,
      summary,
      completedAt: Date.now(),
      artifacts,
    };
    const summaries = this.getMilestoneSummaries();
    summaries.push(entry);
    this.set('__milestone_summaries__', summaries);
    this.inMemoryMilestones = summaries;
  }

  public getMilestoneSummaries(): MilestoneSummaryEntry[] {
    return this.get<MilestoneSummaryEntry[]>('__milestone_summaries__') || this.inMemoryMilestones;
  }

  // =================== Token Budget Tracking ===================

  public setTokenBudget(totalTokens: number): void {
    this.totalBudget = totalTokens;
    this.set('__total_budget__', totalTokens);
  }

  public recordTokenUsage(tokens: number): void {
    this.usedBudget += tokens;
    this.set('__used_budget__', this.usedBudget);
  }

  public getTokenBudgetStatus(): { total: number; used: number; remaining: number } {
    const total = this.get<number>('__total_budget__') ?? this.totalBudget;
    const used = this.get<number>('__used_budget__') ?? this.usedBudget;
    return {
      total,
      used,
      remaining: Math.max(0, total - used),
    };
  }

  // =================== Todo List (for todowrite tool) ===================

  public updateTodos(todos: TodoItem[]): void {
    this.set('__todos__', todos);
  }

  public getTodos(): TodoItem[] {
    return this.get<TodoItem[]>('__todos__') || [];
  }
}
