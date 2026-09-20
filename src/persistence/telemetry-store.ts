import { AgentDatabase } from './db.js';

export type TurnType = 'PLANNING' | 'WORKER' | 'APPROVAL' | 'USER_INPUT' | 'SUMMARY';
export type StepType =
  | 'MODEL_CALL'
  | 'TOOL_EXECUTION'
  | 'APPROVAL_WAIT'
  | 'CONTEXT_COMPACT'
  | 'ARTIFACT_INDEXING';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StepRecord {
  stepId: string;
  turnId: string;
  threadId: string;
  stepIndex: number;
  stepType: StepType;
  toolName?: string;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED' | 'REJECTED' | 'CANCELLED';
  startedAt: number;
  completedAt?: number;
  durationMs: number;
  tokens: TokenUsage;
  errorMessage?: string;
  metadata?: Record<string, any>;
}

export interface TurnRecord {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnType: TurnType;
  milestoneId?: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SUSPENDED';
  startedAt: number;
  completedAt?: number;
  durationMs: number;
  tokens: TokenUsage;
  stepCount: number;
  summary?: string;
}

export interface ThreadRecord {
  threadId: string;
  sessionId: string;
  currentState: string;
  prompt: string;
  workspacePath: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  totalDurationMs: number;
  totalTokens: TokenUsage;
  totalTurns: number;
  totalSteps: number;
  errorMessage?: string;
}

export interface ToolMetricItem {
  toolName: string;
  callCount: number;
  totalDurationMs: number;
  avgDurationMs: number;
  failedCount: number;
}

export interface StepTypeDistributionItem {
  stepType: StepType;
  occurrences: number;
  totalDurationMs: number;
  percentage: number;
}

export interface ThreadMetricsReport {
  threadId: string;
  status: string;
  prompt: string;
  totalDurationMs: number;
  totalTokens: TokenUsage;
  counts: {
    turns: number;
    steps: number;
    toolCalls: number;
    modelCalls: number;
    approvals: number;
  };
  stepTypeDistribution: StepTypeDistributionItem[];
  toolMetrics: ToolMetricItem[];
  turnsBreakdown: Array<{
    turnId: string;
    turnIndex: number;
    turnType: TurnType;
    milestoneId?: string;
    status: string;
    durationMs: number;
    tokens: TokenUsage;
    stepCount: number;
    summary?: string;
  }>;
}

export class TelemetryStore {
  constructor(private readonly db: AgentDatabase) {}

  // =================== Thread Operations ===================

  public recordThreadStart(params: {
    threadId: string;
    sessionId: string;
    parentThreadId?: string;
    prompt: string;
    workspacePath: string;
  }): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();
    const stmt = rawDb.prepare(`
      INSERT INTO threads (
        thread_id, session_id, parent_thread_id, current_state, prompt, workspace_path,
        created_at, updated_at, total_duration_ms, total_prompt_tokens,
        total_completion_tokens, total_tokens, total_turns, total_steps
      ) VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)
      ON CONFLICT(thread_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        current_state = CASE WHEN current_state = 'COMPLETED' THEN 'COMPLETED' ELSE 'PENDING' END
    `);
    stmt.run(params.threadId, params.sessionId, params.parentThreadId ?? null, params.prompt, params.workspacePath, now, now);
  }

  public getTurnCount(threadId: string): number {
    const rawDb = this.db.getRawDb();
    const row = rawDb.prepare('SELECT COUNT(*) as c FROM turns WHERE thread_id = ?').get(threadId) as any;
    return Number(row?.c || 0);
  }

  public updateThreadState(threadId: string, state: string, currentTurnId?: string): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();
    const stmt = rawDb.prepare(`
      UPDATE threads
      SET current_state = ?, current_turn_id = COALESCE(?, current_turn_id), updated_at = ?
      WHERE thread_id = ?
    `);
    stmt.run(state, currentTurnId ?? null, now, threadId);
  }

  public recordThreadEnd(threadId: string, status: string, errorMessage?: string): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();

    // Compute total duration from created_at
    const thread = rawDb.prepare('SELECT created_at FROM threads WHERE thread_id = ?').get(threadId) as any;
    const duration = thread ? now - Number(thread.created_at) : 0;

    const stmt = rawDb.prepare(`
      UPDATE threads
      SET current_state = ?, completed_at = ?, updated_at = ?,
          total_duration_ms = ?, error_message = ?
      WHERE thread_id = ?
    `);
    stmt.run(status, now, now, duration, errorMessage ?? null, threadId);
  }

  // =================== Turn Operations ===================

  public recordTurnStart(params: {
    turnId: string;
    threadId: string;
    turnIndex: number;
    turnType: TurnType;
    milestoneId?: string;
  }): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();
    const stmt = rawDb.prepare(`
      INSERT INTO turns (
        turn_id, thread_id, turn_index, turn_type, milestone_id,
        status, started_at, duration_ms, prompt_tokens,
        completion_tokens, total_tokens, step_count
      ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, 0, 0, 0, 0, 0)
    `);
    stmt.run(
      params.turnId,
      params.threadId,
      params.turnIndex,
      params.turnType,
      params.milestoneId ?? null,
      now
    );

    // Increment thread's turn count and set current_turn_id
    rawDb.prepare(`
      UPDATE threads
      SET total_turns = total_turns + 1, current_turn_id = ?, updated_at = ?
      WHERE thread_id = ?
    `).run(params.turnId, now, params.threadId);
  }

  public recordTurnEnd(params: {
    turnId: string;
    status: TurnRecord['status'];
    summary?: string;
  }): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();

    const turn = rawDb.prepare('SELECT started_at FROM turns WHERE turn_id = ?').get(params.turnId) as any;
    const duration = turn ? now - Number(turn.started_at) : 0;

    const stmt = rawDb.prepare(`
      UPDATE turns
      SET status = ?, completed_at = ?, duration_ms = ?, summary = ?
      WHERE turn_id = ?
    `);
    stmt.run(params.status, now, duration, params.summary ?? null, params.turnId);
  }

  // =================== Step Operations ===================

  public recordStepStart(params: {
    stepId: string;
    turnId: string;
    threadId: string;
    stepIndex: number;
    stepType: StepType;
    toolName?: string;
    metadata?: Record<string, any>;
  }): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();
    const stmt = rawDb.prepare(`
      INSERT INTO steps (
        step_id, turn_id, thread_id, step_index, step_type,
        tool_name, status, started_at, duration_ms,
        prompt_tokens, completion_tokens, total_tokens, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, 0, 0, 0, 0, ?)
    `);
    stmt.run(
      params.stepId,
      params.turnId,
      params.threadId,
      params.stepIndex,
      params.stepType,
      params.toolName ?? null,
      now,
      params.metadata ? JSON.stringify(params.metadata) : null
    );

    // Increment turn's step count and thread's total_steps
    rawDb.prepare('UPDATE turns SET step_count = step_count + 1 WHERE turn_id = ?').run(params.turnId);
    rawDb.prepare('UPDATE threads SET total_steps = total_steps + 1, updated_at = ? WHERE thread_id = ?').run(now, params.threadId);
  }

  public recordStepEnd(params: {
    stepId: string;
    status: StepRecord['status'];
    tokens?: Partial<TokenUsage>;
    errorMessage?: string;
    metadata?: Record<string, any>;
  }): void {
    const rawDb = this.db.getRawDb();
    const now = Date.now();

    const step = rawDb.prepare('SELECT turn_id, thread_id, started_at FROM steps WHERE step_id = ?').get(params.stepId) as any;
    if (!step) return;

    const duration = now - Number(step.started_at);
    const pTokens = params.tokens?.promptTokens ?? 0;
    const cTokens = params.tokens?.completionTokens ?? 0;
    const tTokens = params.tokens?.totalTokens ?? (pTokens + cTokens);

    const stmt = rawDb.prepare(`
      UPDATE steps
      SET status = ?, completed_at = ?, duration_ms = ?,
          prompt_tokens = ?, completion_tokens = ?, total_tokens = ?,
          error_message = ?, metadata = COALESCE(?, metadata)
      WHERE step_id = ?
    `);
    stmt.run(
      params.status,
      now,
      duration,
      pTokens,
      cTokens,
      tTokens,
      params.errorMessage ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      params.stepId
    );

    // Accumulate tokens to Turn
    if (tTokens > 0) {
      rawDb.prepare(`
        UPDATE turns
        SET prompt_tokens = prompt_tokens + ?,
            completion_tokens = completion_tokens + ?,
            total_tokens = total_tokens + ?
        WHERE turn_id = ?
      `).run(pTokens, cTokens, tTokens, step.turn_id);

      // Accumulate tokens to Thread
      rawDb.prepare(`
        UPDATE threads
        SET total_prompt_tokens = total_prompt_tokens + ?,
            total_completion_tokens = total_completion_tokens + ?,
            total_tokens = total_tokens + ?,
            updated_at = ?
        WHERE thread_id = ?
      `).run(pTokens, cTokens, tTokens, now, step.thread_id);
    }
  }

  // =================== Analytics & Reporting ===================

  public getThreadMetrics(threadId: string): ThreadMetricsReport {
    const rawDb = this.db.getRawDb();

    // 1. Thread metadata
    const thread = rawDb.prepare('SELECT * FROM threads WHERE thread_id = ?').get(threadId) as any;
    if (!thread) {
      throw new Error(`Thread '${threadId}' not found in telemetry store`);
    }

    const totalDurationMs = Number(thread.total_duration_ms) || (Date.now() - Number(thread.created_at));

    // 2. Turns breakdown
    const turnsRows = rawDb.prepare(`
      SELECT turn_id as turnId, turn_index as turnIndex, turn_type as turnType,
             milestone_id as milestoneId, status, duration_ms as durationMs,
             prompt_tokens as promptTokens, completion_tokens as completionTokens,
             total_tokens as totalTokens, step_count as stepCount, summary
      FROM turns
      WHERE thread_id = ?
      ORDER BY turn_index ASC
    `).all(threadId) as any[];

    const turnsBreakdown = turnsRows.map((r) => ({
      turnId: r.turnId,
      turnIndex: Number(r.turnIndex),
      turnType: r.turnType as TurnType,
      milestoneId: r.milestoneId || undefined,
      status: r.status,
      durationMs: Number(r.durationMs),
      tokens: {
        promptTokens: Number(r.promptTokens),
        completionTokens: Number(r.completionTokens),
        totalTokens: Number(r.totalTokens),
      },
      stepCount: Number(r.stepCount),
      summary: r.summary || undefined,
    }));

    // 3. Tool metrics
    const toolRows = rawDb.prepare(`
      SELECT tool_name as toolName,
             COUNT(*) as callCount,
             SUM(duration_ms) as totalDurationMs,
             AVG(duration_ms) as avgDurationMs,
             SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failedCount
      FROM steps
      WHERE thread_id = ? AND step_type = 'TOOL_EXECUTION' AND tool_name IS NOT NULL
      GROUP BY tool_name
      ORDER BY callCount DESC
    `).all(threadId) as any[];

    const toolMetrics: ToolMetricItem[] = toolRows.map((r) => ({
      toolName: r.toolName,
      callCount: Number(r.callCount),
      totalDurationMs: Number(r.totalDurationMs),
      avgDurationMs: Math.round(Number(r.avgDurationMs)),
      failedCount: Number(r.failedCount),
    }));

    // 4. Step type distribution
    const stepTypeRows = rawDb.prepare(`
      SELECT step_type as stepType,
             COUNT(*) as occurrences,
             SUM(duration_ms) as totalDurationMs
      FROM steps
      WHERE thread_id = ?
      GROUP BY step_type
    `).all(threadId) as any[];

    const stepTypeDistribution: StepTypeDistributionItem[] = stepTypeRows.map((r) => {
      const duration = Number(r.totalDurationMs);
      const percentage = totalDurationMs > 0 ? Math.round((duration / totalDurationMs) * 1000) / 10 : 0;
      return {
        stepType: r.stepType as StepType,
        occurrences: Number(r.occurrences),
        totalDurationMs: duration,
        percentage,
      };
    });

    // 5. Aggregate counts
    const modelCallsCount = (rawDb.prepare(
      "SELECT COUNT(*) as c FROM steps WHERE thread_id = ? AND step_type = 'MODEL_CALL'"
    ).get(threadId) as any)?.c ?? 0;

    const toolCallsCount = (rawDb.prepare(
      "SELECT COUNT(*) as c FROM steps WHERE thread_id = ? AND step_type = 'TOOL_EXECUTION'"
    ).get(threadId) as any)?.c ?? 0;

    const approvalsCount = (rawDb.prepare(
      "SELECT COUNT(*) as c FROM steps WHERE thread_id = ? AND step_type = 'APPROVAL_WAIT'"
    ).get(threadId) as any)?.c ?? 0;

    return {
      threadId,
      status: thread.current_state,
      prompt: thread.prompt,
      totalDurationMs,
      totalTokens: {
        promptTokens: Number(thread.total_prompt_tokens),
        completionTokens: Number(thread.total_completion_tokens),
        totalTokens: Number(thread.total_tokens),
      },
      counts: {
        turns: Number(thread.total_turns),
        steps: Number(thread.total_steps),
        toolCalls: Number(toolCallsCount),
        modelCalls: Number(modelCallsCount),
        approvals: Number(approvalsCount),
      },
      stepTypeDistribution,
      toolMetrics,
      turnsBreakdown,
    };
  }

  // =================== Session Conceptual Aliases ===================
  public recordSessionStart(params: {
    sessionId: string;
    parentSessionId?: string;
    prompt: string;
    workspacePath: string;
  }): void {
    this.recordThreadStart({
      threadId: params.sessionId,
      sessionId: params.sessionId,
      parentThreadId: params.parentSessionId,
      prompt: params.prompt,
      workspacePath: params.workspacePath,
    });
  }

  public updateSessionState(sessionId: string, state: string, currentTurnId?: string): void {
    this.updateThreadState(sessionId, state, currentTurnId);
  }

  public recordSessionEnd(sessionId: string, status: string, errorMessage?: string): void {
    this.recordThreadEnd(sessionId, status, errorMessage);
  }

  public getSessionMetrics(sessionId: string): ThreadMetricsReport {
    return this.getThreadMetrics(sessionId);
  }
}

