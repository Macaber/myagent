import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getMyAgentHome, getDefaultDbPath } from '../config/paths.js';

export interface DatabaseMeta {
  name: string;
  filePath: string;
  sizeBytes: number;
  sizeFormatted: string;
  mtime: number;
  isDefault: boolean;
}

export interface DashboardSummary {
  database: DatabaseMeta;
  totalThreads: number;
  mainThreads: number;
  subagentThreads: number;
  statusCounts: Record<string, number>;
  totalTokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  totalDurationMs: number;
  totalTurns: number;
  totalSteps: number;
  totalToolCalls: number;
  totalSubagentCalls: number;
  totalSkillCalls: number;
}

export interface ThreadTreeItem {
  threadId: string;
  sessionId: string;
  parentThreadId: string | null;
  role: string;
  currentState: string;
  prompt: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  durationMs: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  totalTurns: number;
  totalSteps: number;
  errorMessage: string | null;
  children: ThreadTreeItem[];
}

export interface StepDetail {
  stepId: string;
  turnId: string;
  threadId: string;
  stepIndex: number;
  stepType: string;
  toolName: string | null;
  isSubagent: boolean;
  isSkill: boolean;
  subagentRole?: string;
  skillName?: string;
  status: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  errorMessage: string | null;
  metadata: any;
}

export interface TurnDetail {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnType: string;
  milestoneId: string | null;
  status: string;
  startedAt: number;
  completedAt: number | null;
  durationMs: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  stepCount: number;
  summary: string | null;
  metrics: {
    toolCallsCount: number;
    subagentCallsCount: number;
    skillCallsCount: number;
    modelCallsCount: number;
    toolsUsed: Record<string, number>;
  };
  steps: StepDetail[];
}

export interface ThreadDetailReport {
  thread: ThreadTreeItem;
  parentThread?: {
    threadId: string;
    prompt: string;
    role: string;
  };
  turns: TurnDetail[];
  toolSummary: Array<{
    toolName: string;
    callCount: number;
    totalDurationMs: number;
    avgDurationMs: number;
    failedCount: number;
  }>;
  subagentsSummary: Array<{
    threadId: string;
    role: string;
    prompt: string;
    totalTokens: number;
    durationMs: number;
    status: string;
  }>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export class DashboardService {
  /**
   * Scans ~/.myagent and returns all available .db files.
   */
  public static listDatabases(): DatabaseMeta[] {
    const home = getMyAgentHome();
    const defaultDb = getDefaultDbPath();
    const results: DatabaseMeta[] = [];

    const searchDirs = [home, path.join(process.cwd(), '.agent')];
    const seenNames = new Set<string>();

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (file.endsWith('.db')) {
            if (seenNames.has(file)) continue;
            seenNames.add(file);

            const fullPath = path.resolve(dir, file);
            const stat = fs.statSync(fullPath);
            results.push({
              name: file,
              filePath: fullPath,
              sizeBytes: stat.size,
              sizeFormatted: formatBytes(stat.size),
              mtime: stat.mtimeMs,
              isDefault: fullPath === defaultDb || file === 'data.db',
            });
          }
        }
      } catch (err) {
        console.error(`[DashboardService] Error scanning dir ${dir}:`, err);
      }
    }

    // Sort: default db first, then mtime desc
    results.sort((a, b) => {
      if (a.isDefault) return -1;
      if (b.isDefault) return 1;
      return b.mtime - a.mtime;
    });

    return results;
  }

  /**
   * Resolves target DB path safely.
   */
  public static resolveDbPath(requestedDb?: string): string {
    if (!requestedDb || requestedDb === 'default' || requestedDb === 'data.db') {
      return getDefaultDbPath();
    }
    // If requestedDb is a pure filename, resolve against ~/.myagent
    if (!requestedDb.includes('/') && !requestedDb.includes('\\')) {
      const p = path.join(getMyAgentHome(), requestedDb);
      if (fs.existsSync(p)) return p;
    }
    // If absolute path
    if (path.isAbsolute(requestedDb) && fs.existsSync(requestedDb)) {
      return requestedDb;
    }
    return getDefaultDbPath();
  }

  private static openDb(targetPath: string): DatabaseSync | null {
    if (!fs.existsSync(targetPath)) return null;
    try {
      return new DatabaseSync(targetPath);
    } catch (err) {
      console.error(`[DashboardService] Failed to open SQLite DB at ${targetPath}:`, err);
      return null;
    }
  }

  /**
   * Returns high-level summary KPI metrics for a database.
   */
  public static getDashboardSummary(requestedDb?: string): DashboardSummary {
    const dbPath = this.resolveDbPath(requestedDb);
    const meta: DatabaseMeta = {
      name: path.basename(dbPath),
      filePath: dbPath,
      sizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
      sizeFormatted: fs.existsSync(dbPath) ? formatBytes(fs.statSync(dbPath).size) : '0 B',
      mtime: fs.existsSync(dbPath) ? fs.statSync(dbPath).mtimeMs : 0,
      isDefault: dbPath === getDefaultDbPath(),
    };

    const emptySummary: DashboardSummary = {
      database: meta,
      totalThreads: 0,
      mainThreads: 0,
      subagentThreads: 0,
      statusCounts: {},
      totalTokens: { prompt: 0, completion: 0, total: 0 },
      totalDurationMs: 0,
      totalTurns: 0,
      totalSteps: 0,
      totalToolCalls: 0,
      totalSubagentCalls: 0,
      totalSkillCalls: 0,
    };

    const db = this.openDb(dbPath);
    if (!db) return emptySummary;

    try {
      // 1. Thread counts and status distribution
      const threadStats = db.prepare(`
        SELECT
          COUNT(*) as totalThreads,
          SUM(CASE WHEN parent_thread_id IS NULL THEN 1 ELSE 0 END) as mainThreads,
          SUM(CASE WHEN parent_thread_id IS NOT NULL THEN 1 ELSE 0 END) as subagentThreads,
          SUM(total_prompt_tokens) as totalPromptTokens,
          SUM(total_completion_tokens) as totalCompletionTokens,
          SUM(total_tokens) as totalTokens,
          SUM(total_duration_ms) as totalDurationMs,
          SUM(total_turns) as totalTurns,
          SUM(total_steps) as totalSteps
        FROM threads
      `).get() as any;

      const statusRows = db.prepare(`
        SELECT current_state, COUNT(*) as c FROM threads GROUP BY current_state
      `).all() as any[];

      const statusCounts: Record<string, number> = {};
      for (const row of statusRows) {
        statusCounts[row.current_state] = Number(row.c);
      }

      // 2. Tool and step counts
      const toolStats = db.prepare(`
        SELECT
          COUNT(*) as totalSteps,
          SUM(CASE WHEN step_type = 'TOOL_EXECUTION' THEN 1 ELSE 0 END) as toolCalls,
          SUM(CASE WHEN tool_name = 'invoke_subagent' THEN 1 ELSE 0 END) as subagentCalls,
          SUM(CASE WHEN tool_name = 'skill' THEN 1 ELSE 0 END) as skillCalls
        FROM steps
      `).get() as any;

      return {
        database: meta,
        totalThreads: Number(threadStats?.totalThreads || 0),
        mainThreads: Number(threadStats?.mainThreads || 0),
        subagentThreads: Number(threadStats?.subagentThreads || 0),
        statusCounts,
        totalTokens: {
          prompt: Number(threadStats?.totalPromptTokens || 0),
          completion: Number(threadStats?.totalCompletionTokens || 0),
          total: Number(threadStats?.totalTokens || 0),
        },
        totalDurationMs: Number(threadStats?.totalDurationMs || 0),
        totalTurns: Number(threadStats?.totalTurns || 0),
        totalSteps: Number(threadStats?.totalSteps || 0),
        totalToolCalls: Number(toolStats?.toolCalls || 0),
        totalSubagentCalls: Number(toolStats?.subagentCalls || 0),
        totalSkillCalls: Number(toolStats?.skillCalls || 0),
      };
    } catch (err) {
      console.error(`[DashboardService] Error querying summary from ${dbPath}:`, err);
      return emptySummary;
    } finally {
      db.close();
    }
  }

  /**
   * Returns full thread list with parent-child tree hierarchy.
   */
  public static getThreadList(requestedDb?: string): ThreadTreeItem[] {
    const dbPath = this.resolveDbPath(requestedDb);
    const db = this.openDb(dbPath);
    if (!db) return [];

    try {
      const rows = db.prepare(`
        SELECT
          thread_id, session_id, parent_thread_id, current_state, prompt, workspace_path,
          created_at, updated_at, completed_at, total_duration_ms,
          total_prompt_tokens, total_completion_tokens, total_tokens,
          total_turns, total_steps, error_message
        FROM threads
        ORDER BY created_at DESC
      `).all() as any[];

      const itemMap = new Map<string, ThreadTreeItem>();
      const rootItems: ThreadTreeItem[] = [];

      for (const r of rows) {
        let role = 'main';
        const promptStr = String(r.prompt || '');
        const roleMatch = promptStr.match(/^\[Subagent:\s*([^\]]+)\]/i);
        if (roleMatch) {
          role = roleMatch[1].trim();
        } else if (r.parent_thread_id) {
          role = 'subagent';
        }

        const duration = Number(r.total_duration_ms) || (r.completed_at ? Number(r.completed_at) - Number(r.created_at) : Date.now() - Number(r.created_at));

        const item: ThreadTreeItem = {
          threadId: r.thread_id,
          sessionId: r.session_id,
          parentThreadId: r.parent_thread_id || null,
          role,
          currentState: r.current_state,
          prompt: r.prompt,
          workspacePath: r.workspace_path,
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
          completedAt: r.completed_at ? Number(r.completed_at) : null,
          durationMs: duration,
          tokens: {
            prompt: Number(r.total_prompt_tokens),
            completion: Number(r.total_completion_tokens),
            total: Number(r.total_tokens),
          },
          totalTurns: Number(r.total_turns),
          totalSteps: Number(r.total_steps),
          errorMessage: r.error_message || null,
          children: [],
        };
        itemMap.set(item.threadId, item);
      }

      // Build hierarchy
      for (const item of itemMap.values()) {
        if (item.parentThreadId && itemMap.has(item.parentThreadId)) {
          itemMap.get(item.parentThreadId)!.children.push(item);
        } else {
          rootItems.push(item);
        }
      }

      // Sort children chronologically
      for (const item of itemMap.values()) {
        if (item.children.length > 0) {
          item.children.sort((a, b) => a.createdAt - b.createdAt);
        }
      }

      return rootItems;
    } catch (err) {
      console.error(`[DashboardService] Error getting thread list from ${dbPath}:`, err);
      return [];
    } finally {
      db.close();
    }
  }

  /**
   * Returns deep, detailed analytics for a single thread, including all turns, steps, tool/skill usage.
   */
  public static getThreadDetail(requestedDb: string | undefined, threadId: string): ThreadDetailReport | null {
    const dbPath = this.resolveDbPath(requestedDb);
    const db = this.openDb(dbPath);
    if (!db) return null;

    try {
      const threadRow = db.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId) as any;
      if (!threadRow) return null;

      let role = 'main';
      const promptStr = String(threadRow.prompt || '');
      const roleMatch = promptStr.match(/^\[Subagent:\s*([^\]]+)\]/i);
      if (roleMatch) {
        role = roleMatch[1].trim();
      } else if (threadRow.parent_thread_id) {
        role = 'subagent';
      }

      const duration = Number(threadRow.total_duration_ms) || (threadRow.completed_at ? Number(threadRow.completed_at) - Number(threadRow.created_at) : Date.now() - Number(threadRow.created_at));

      const threadItem: ThreadTreeItem = {
        threadId: threadRow.thread_id,
        sessionId: threadRow.session_id,
        parentThreadId: threadRow.parent_thread_id || null,
        role,
        currentState: threadRow.current_state,
        prompt: threadRow.prompt,
        workspacePath: threadRow.workspace_path,
        createdAt: Number(threadRow.created_at),
        updatedAt: Number(threadRow.updated_at),
        completedAt: threadRow.completed_at ? Number(threadRow.completed_at) : null,
        durationMs: duration,
        tokens: {
          prompt: Number(threadRow.total_prompt_tokens),
          completion: Number(threadRow.total_completion_tokens),
          total: Number(threadRow.total_tokens),
        },
        totalTurns: Number(threadRow.total_turns),
        totalSteps: Number(threadRow.total_steps),
        errorMessage: threadRow.error_message || null,
        children: [],
      };

      // Check if parent exists
      let parentThread: { threadId: string; prompt: string; role: string } | undefined;
      if (threadRow.parent_thread_id) {
        const parentRow = db.prepare('SELECT thread_id, prompt FROM threads WHERE thread_id = ?').get(threadRow.parent_thread_id) as any;
        if (parentRow) {
          parentThread = {
            threadId: parentRow.thread_id,
            prompt: parentRow.prompt,
            role: 'main',
          };
        }
      }

      // Child subagents for this thread
      const childRows = db.prepare(`
        SELECT thread_id, prompt, current_state, total_tokens, total_duration_ms
        FROM threads WHERE parent_thread_id = ? ORDER BY created_at ASC
      `).all(threadId) as any[];

      const subagentsSummary = childRows.map((c) => {
        let childRole = 'explore';
        const m = String(c.prompt).match(/^\[Subagent:\s*([^\]]+)\]/i);
        if (m) childRole = m[1].trim();
        return {
          threadId: c.thread_id,
          role: childRole,
          prompt: c.prompt,
          totalTokens: Number(c.total_tokens),
          durationMs: Number(c.total_duration_ms),
          status: c.current_state,
        };
      });

      // Query turns
      const turnRows = db.prepare(`
        SELECT * FROM turns WHERE thread_id = ? ORDER BY turn_index ASC
      `).all(threadId) as any[];

      // Query steps
      const stepRows = db.prepare(`
        SELECT * FROM steps WHERE thread_id = ? ORDER BY turn_id, step_index ASC
      `).all(threadId) as any[];

      const stepsByTurn = new Map<string, StepDetail[]>();

      for (const s of stepRows) {
        let parsedMetadata: any = null;
        if (s.metadata) {
          try {
            parsedMetadata = JSON.parse(s.metadata);
          } catch {
            parsedMetadata = s.metadata;
          }
        }

        const isSubagent = s.tool_name === 'invoke_subagent';
        const isSkill = s.tool_name === 'skill';
        let subagentRole: string | undefined;
        let skillName: string | undefined;

        if (isSubagent && parsedMetadata?.args) {
          subagentRole = parsedMetadata.args.role || (parsedMetadata.args.subagents ? 'batch' : undefined);
        }
        if (isSkill && parsedMetadata?.args) {
          skillName = parsedMetadata.args.skillName;
        }

        const stepDetail: StepDetail = {
          stepId: s.step_id,
          turnId: s.turn_id,
          threadId: s.thread_id,
          stepIndex: Number(s.step_index),
          stepType: s.step_type,
          toolName: s.tool_name || null,
          isSubagent,
          isSkill,
          subagentRole,
          skillName,
          status: s.status,
          startedAt: Number(s.started_at),
          completedAt: s.completed_at ? Number(s.completed_at) : null,
          durationMs: Number(s.duration_ms),
          tokens: {
            prompt: Number(s.prompt_tokens),
            completion: Number(s.completion_tokens),
            total: Number(s.total_tokens),
          },
          errorMessage: s.error_message || null,
          metadata: parsedMetadata,
        };

        if (!stepsByTurn.has(s.turn_id)) {
          stepsByTurn.set(s.turn_id, []);
        }
        stepsByTurn.get(s.turn_id)!.push(stepDetail);
      }

      // Assemble turns
      const turns: TurnDetail[] = turnRows.map((t) => {
        const turnSteps = stepsByTurn.get(t.turn_id) || [];
        const toolsUsed: Record<string, number> = {};
        let toolCallsCount = 0;
        let subagentCallsCount = 0;
        let skillCallsCount = 0;
        let modelCallsCount = 0;

        for (const st of turnSteps) {
          if (st.stepType === 'MODEL_CALL') {
            modelCallsCount++;
          } else if (st.stepType === 'TOOL_EXECUTION' && st.toolName) {
            toolCallsCount++;
            toolsUsed[st.toolName] = (toolsUsed[st.toolName] || 0) + 1;
            if (st.isSubagent) subagentCallsCount++;
            if (st.isSkill) skillCallsCount++;
          }
        }

        return {
          turnId: t.turn_id,
          threadId: t.thread_id,
          turnIndex: Number(t.turn_index),
          turnType: t.turn_type,
          milestoneId: t.milestone_id || null,
          status: t.status,
          startedAt: Number(t.started_at),
          completedAt: t.completed_at ? Number(t.completed_at) : null,
          durationMs: Number(t.duration_ms),
          tokens: {
            prompt: Number(t.prompt_tokens),
            completion: Number(t.completion_tokens),
            total: Number(t.total_tokens),
          },
          stepCount: Number(t.step_count),
          summary: t.summary || null,
          metrics: {
            toolCallsCount,
            subagentCallsCount,
            skillCallsCount,
            modelCallsCount,
            toolsUsed,
          },
          steps: turnSteps,
        };
      });

      // Aggregate thread tool summary
      const toolSummaryRows = db.prepare(`
        SELECT tool_name,
               COUNT(*) as callCount,
               SUM(duration_ms) as totalDurationMs,
               AVG(duration_ms) as avgDurationMs,
               SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failedCount
        FROM steps
        WHERE thread_id = ? AND step_type = 'TOOL_EXECUTION' AND tool_name IS NOT NULL
        GROUP BY tool_name
        ORDER BY callCount DESC
      `).all(threadId) as any[];

      const toolSummary = toolSummaryRows.map((r) => ({
        toolName: r.tool_name,
        callCount: Number(r.callCount),
        totalDurationMs: Number(r.totalDurationMs),
        avgDurationMs: Math.round(Number(r.avgDurationMs)),
        failedCount: Number(r.failedCount),
      }));

      return {
        thread: threadItem,
        parentThread,
        turns,
        toolSummary,
        subagentsSummary,
      };
    } catch (err) {
      console.error(`[DashboardService] Error getting thread detail for ${threadId}:`, err);
      return null;
    } finally {
      db.close();
    }
  }

  /**
   * Updates thread status (e.g. marking interrupted RUNNING threads as SUSPENDED).
   */
  public static updateThreadStatus(requestedDb: string | undefined, threadId: string, status: string): boolean {
    const dbPath = this.resolveDbPath(requestedDb);
    const db = this.openDb(dbPath);
    if (!db) return false;
    try {
      const stmt = db.prepare('UPDATE threads SET current_state = ?, updated_at = ? WHERE thread_id = ?');
      stmt.run(status, Date.now(), threadId);
      return true;
    } catch (err) {
      console.error(`[DashboardService] Error updating status for ${threadId}:`, err);
      return false;
    } finally {
      db.close();
    }
  }

  /**
   * Exports full telemetry data of a database as JSON.
   */
  public static exportFullDatabaseJson(requestedDb?: string): any {
    const summary = this.getDashboardSummary(requestedDb);
    const threads = this.getThreadList(requestedDb);
    const detailedThreads: any[] = [];

    for (const root of threads) {
      const detail = this.getThreadDetail(requestedDb, root.threadId);
      if (detail) {
        detailedThreads.push(detail);
      }
      for (const child of root.children) {
        const childDetail = this.getThreadDetail(requestedDb, child.threadId);
        if (childDetail) {
          detailedThreads.push(childDetail);
        }
      }
    }

      return {
        exportVersion: '1.0',
        exportedAt: new Date().toISOString(),
        summary,
        threads: detailedThreads,
        sessions: detailedThreads,
      };
    }

  /**
   * Resumes a session (either with a follow-up prompt or continuing from checkpoint).
   */
  public static async resumeSession(
    requestedDb: string | undefined,
    sessionId: string,
    options: { prompt?: string; mode?: 'continue' | 'checkpoint'; autoDiscoverProvider?: boolean } = {}
  ): Promise<{ success: boolean; sessionId: string; status?: string; message?: string; metrics?: any }> {
    const dbPath = this.resolveDbPath(requestedDb);
    if (!fs.existsSync(dbPath)) {
      return { success: false, sessionId, message: `Database not found: ${dbPath}` };
    }

    try {
      const { createAgentRuntime } = await import('../index.js');
      const { MemoryTransport } = await import('../client/memory-transport.js');
      const autoDiscover = options.autoDiscoverProvider !== undefined
        ? options.autoDiscoverProvider
        : process.env.NODE_ENV !== 'test';

      const runtime = createAgentRuntime({
        dbPath,
        transport: new MemoryTransport(),
        autoDiscoverProvider: autoDiscover,
        autoScanSkills: false,
        autoLoadMcp: false,
      });

      try {
        const promptText = (options.prompt || '').trim();

        if (options.mode === 'checkpoint' && !promptText) {
          // Checkpoint mode: resume existing task DAG
          let thread = runtime.activeThreads.get(sessionId);
          if (!thread) {
            await runtime.dispatcher.callMethod('session/load', { sessionId });
            thread = runtime.activeThreads.get(sessionId);
          }
          if (!thread) {
            return { success: false, sessionId, message: `Could not load session context for ${sessionId}` };
          }
          const report = await runtime.runner.resumeTask(thread);
          return { success: true, sessionId, status: report.status, message: 'Resumed from checkpoint', metrics: report };
        } else {
          // Continue dialogue mode: send follow-up prompt to session
          const promptToSend = promptText || '请从之前中断的地方继续推进并汇报最新进展。';
          const promptRes = await runtime.dispatcher.callMethod<any, any>('session/prompt', {
            sessionId,
            prompt: promptToSend,
          });
          return {
            success: promptRes.status === 'completed' || promptRes.status === 'blocked',
            sessionId,
            status: promptRes.status,
            message: promptRes.summary || 'Prompt executed',
            metrics: promptRes.metrics,
          };
        }
      } finally {
        runtime.close();
      }
    } catch (err: any) {
      console.error(`[DashboardService] Error resuming session ${sessionId}:`, err);
      return { success: false, sessionId, message: err.message || String(err) };
    }
  }

  // Conceptual aliases for Thread -> Session
  public static getSessionList = (requestedDb?: string) => DashboardService.getThreadList(requestedDb);
  public static getSessionDetail = (requestedDb?: string, sessionId?: string) => DashboardService.getThreadDetail(requestedDb, sessionId || '');
  public static updateSessionStatus = (requestedDb: string | undefined, sessionId: string, status: string) => DashboardService.updateThreadStatus(requestedDb, sessionId, status);
}
