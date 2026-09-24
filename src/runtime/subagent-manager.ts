import { randomUUID } from 'node:crypto';
import { ThreadContext } from './thread-context.js';
import { AgentDatabase } from '../persistence/db.js';
import { RpcDispatcher } from '../protocol/rpc-dispatcher.js';
import { WorkerAgent } from '../engine/worker.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { TokenUsage } from '../persistence/telemetry-store.js';

export type SubagentRole = 'explore' | 'coder' | 'qa' | 'analyst' | 'developer' | string;

export interface SpawnSubagentParams {
  role: SubagentRole;
  taskDescription: string;
  skillId?: string;
  maxSteps?: number;
}

export interface SubagentExecutionResult {
  subagentId: string;
  role: string;
  status: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  summary: string;
  durationMs: number;
  tokens: TokenUsage;
  childThreadId?: string;
  stepCount?: number;
}

export class SubagentManager {
  private subagentCounter = 1;
  private static readonly MAX_BATCH = 4;
  private static readonly MAX_PARALLEL = 3;
  private static readonly MAX_TASK_CHARS = 4000;
  private static readonly MAX_STEPS_HARD = 20;

  constructor(
    private readonly db: AgentDatabase,
    private readonly worker: WorkerAgent,
    private readonly toolRegistry: ToolRegistry,
    private readonly skillRegistry: SkillRegistry,
    private readonly dispatcher?: RpcDispatcher
  ) {}

  private static isReadOnlyRole(role: string): boolean {
    const r = (role || '').toLowerCase();
    return r.includes('explore') || r.includes('research') || r.includes('analyst') || r.includes('search');
  }

  private static sanitizeParams(params: SpawnSubagentParams): SpawnSubagentParams {
    const role = (params.role || 'analyst').slice(0, 64);
    const taskDescription = (params.taskDescription || '').slice(0, SubagentManager.MAX_TASK_CHARS);
    if (!taskDescription.trim()) {
      throw new Error('invoke_subagent requires a non-empty taskDescription');
    }
    const maxSteps = Math.min(
      Math.max(params.maxSteps ?? 10, 1),
      SubagentManager.MAX_STEPS_HARD
    );
    return { role, taskDescription, skillId: params.skillId, maxSteps };
  }

  /**
   * Run multiple subagents with bounded concurrency.
   * Read-only explorers run in parallel (≤3); writers run sequentially
   * to avoid concurrent edits to the same workspace. Failures are
   * collected as FAILED results (allSettled) so siblings are not orphaned.
   */
  public async runSubagentsBatch(
    parentThread: ThreadContext,
    tasks: SpawnSubagentParams[],
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<SubagentExecutionResult[]> {
    if (tasks.length === 0) return [];
    // Depth guard: grandchild subagents are restricted to read-only, max 2.
    const isNested = !!parentThread.parentThreadId;
    let effectiveTasks = tasks.slice(0, SubagentManager.MAX_BATCH);
    if (isNested) {
      effectiveTasks = effectiveTasks
        .filter((t) => SubagentManager.isReadOnlyRole(t.role))
        .slice(0, 2);
      if (effectiveTasks.length === 0) {
        throw new Error('Nested subagents (depth > 2) are restricted to read-only explore tasks');
      }
    }
    if (tasks.length === 1 && !isNested) {
      const single = await this.runSubagent(parentThread, SubagentManager.sanitizeParams(tasks[0]), options);
      return [single];
    }

    const sanitized = effectiveTasks.map((t) => SubagentManager.sanitizeParams(t));
    const readers = sanitized.filter((t) => SubagentManager.isReadOnlyRole(t.role));
    const writers = sanitized.filter((t) => !SubagentManager.isReadOnlyRole(t.role));

    const results: SubagentExecutionResult[] = [];
    // Readers: bounded parallel pool
    for (let i = 0; i < readers.length; i += SubagentManager.MAX_PARALLEL) {
      const chunk = readers.slice(i, i + SubagentManager.MAX_PARALLEL);
      const settled = await Promise.allSettled(
        chunk.map((t) => this.runSubagent(parentThread, t, options))
      );
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j];
        if (s.status === 'fulfilled') {
          results.push(s.value);
        } else {
          results.push({
            subagentId: `sub_failed_${Date.now()}_${j}`,
            role: chunk[j].role,
            status: 'FAILED',
            summary: `Subagent crashed: ${(s.reason as Error)?.message || String(s.reason)}`,
            durationMs: 0,
            tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          });
        }
      }
      if (options.abortSignal?.aborted) break;
    }
    // Writers: sequential to avoid same-workspace file races
    for (const t of writers) {
      if (options.abortSignal?.aborted) {
        results.push({
          subagentId: `sub_aborted_${Date.now()}`,
          role: t.role,
          status: 'FAILED',
          summary: 'Subagent batch aborted by client',
          durationMs: 0,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
        break;
      }
      try {
        results.push(await this.runSubagent(parentThread, t, options));
      } catch (err: any) {
        results.push({
          subagentId: `sub_failed_${Date.now()}`,
          role: t.role,
          status: 'FAILED',
          summary: `Subagent crashed: ${err?.message || String(err)}`,
          durationMs: 0,
          tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        });
      }
    }
    return results;
  }

  /**
   * Format a list of subagent outcomes into a high-density Markdown summary card.
   */
  public static formatSubagentResults(results: SubagentExecutionResult[]): string {
    if (results.length === 0) return 'No subagents executed.';

    const cards = results.map((r, idx) => {
      const icon = r.status === 'SUCCESS' ? '✅' : '❌';
      const stepsInfo = r.stepCount !== undefined ? ` | ${r.stepCount} steps` : '';
      return (
        `### ${icon} [Subagent ${idx + 1}: ${r.role.toUpperCase()}] (${r.subagentId})\n` +
        `- **执行状态**: ${r.status}\n` +
        `- **耗时 / 步骤 / Tokens**: ${(r.durationMs / 1000).toFixed(2)}s${stepsInfo} | ${r.tokens?.totalTokens || 0} tokens\n` +
        `- **核心调研事实与结果报告**:\n${r.summary.trim()}`
      );
    });

    return (
      `=== SUBAGENTS CONCURRENT EXECUTION REPORT (${results.length} subagents completed) ===\n\n` +
      cards.join('\n\n---\n\n')
    );
  }

  public async runSubagent(
    parentThread: ThreadContext,
    params: SpawnSubagentParams,
    options: { abortSignal?: AbortSignal } = {}
  ): Promise<SubagentExecutionResult> {
    const clean = SubagentManager.sanitizeParams(params);
    const subagentId = `sub_${randomUUID().slice(0, 8)}_${Date.now().toString(36)}`;
    const childThreadId = `${parentThread.threadId}_${subagentId}`;

    // 1. Resolve role, skill, and specialized prompt (unknown roles default to read-only analyst)
    const normalizedRole = (clean.role || 'analyst').toLowerCase();
    let effectiveSkill = clean.skillId;
    let roleInstructions = '';
    let defaultMaxSteps = 8;

    if (!effectiveSkill) {
      if (
        normalizedRole.includes('explore') ||
        normalizedRole.includes('research') ||
        normalizedRole.includes('analyst') ||
        normalizedRole.includes('search')
      ) {
        effectiveSkill = 'explore';
        defaultMaxSteps = 8;
        roleInstructions =
          'You are an Explore Subagent (Read-Only). Your sole goal is to inspect files, search patterns, and report factual findings factually. ' +
          'You only have read-only tools (read, glob, grep). Do NOT attempt to modify files or run bash commands. ' +
          'Quickly locate the relevant code, extract key lines/interfaces, and provide a clear, concise bulleted summary.';
      } else if (
        normalizedRole.includes('coder') ||
        normalizedRole.includes('develop') ||
        normalizedRole.includes('edit')
      ) {
        effectiveSkill = 'coder';
        defaultMaxSteps = 10;
        roleInstructions =
          'You are a Coder Subagent. Focus on implementing the specified localized code edits and creations accurately. Verify your changes.';
      } else if (
        normalizedRole.includes('qa') ||
        normalizedRole.includes('test')
      ) {
        effectiveSkill = 'qa';
        defaultMaxSteps = 8;
        roleInstructions =
          'You are a QA Subagent. Execute specified tests and report diagnostic outcomes and failure root causes.';
      } else {
        effectiveSkill = 'analyst';
        defaultMaxSteps = 8;
        roleInstructions =
          'You are an Analyst Subagent (Read-Only by default). Inspect and summarize only. ' +
          'Do NOT modify files or run shell commands unless the task explicitly requires it.';
      }
    }

    const effectiveMaxSteps = Math.min(clean.maxSteps ?? defaultMaxSteps, SubagentManager.MAX_STEPS_HARD);

    // 2. Create Child Thread Context with parent link
    const childThread = new ThreadContext(
      {
        threadId: childThreadId,
        sessionId: parentThread.sessionId,
        parentThreadId: parentThread.threadId,
        prompt: `[Subagent: ${clean.role}] ${clean.taskDescription}`,
        workspacePath: parentThread.workspaceJail.getWorkspaceRoot(),
      },
      this.db,
      this.dispatcher
    );

    // 3. Emit ACP notification that subagent has started
    this.dispatcher?.emitSessionUpdate({
      sessionId: parentThread.threadId,
      updateType: 'step_started' as any,
      timestamp: Date.now(),
      data: {
        event: 'subagent_started',
        subagentId,
        childThreadId,
        role: clean.role,
        taskDescription: clean.taskDescription,
      },
    });

    // 4. Create isolated single Turn for the Sub-agent
    const subTurn = childThread.createTurn('WORKER', subagentId);

    const syntheticMilestone = {
      id: subagentId,
      title: `Subagent [${clean.role}]`,
      description: `${roleInstructions ? roleInstructions + '\n\n' : ''}Task: ${clean.taskDescription}`,
      dependencies: [],
      assignedSkill: effectiveSkill,
      status: 'RUNNING' as const,
    };

    // 5. Execute Subagent ReAct loop in complete isolation with tight step budget
    const workerResult = await this.worker.executeMilestone(
      syntheticMilestone,
      subTurn,
      {
        threadId: childThreadId,
        turnId: subTurn.turnId,
        workspaceJail: childThread.workspaceJail,
        blackboard: childThread.blackboard,
        abortSignal: options.abortSignal,
      },
      undefined,
      effectiveMaxSteps
    );

    subTurn.end({
      status: workerResult.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED',
      summary: workerResult.summary,
    });

    // Preserve BLOCKED semantics so the parent can suspend for user input
    // instead of misreporting as FAILED.
    let report;
    if (workerResult.status === 'SUCCESS') {
      report = childThread.complete(workerResult.summary);
    } else if (workerResult.status === 'BLOCKED') {
      childThread.setState('SUSPENDED_INPUT');
      report = childThread.telemetryStore.getThreadMetrics(childThreadId);
      try {
        childThread.blackboard.set(`subagent_${subagentId}_blocked`, {
          error: workerResult.error,
          remedySuggestion: (workerResult as any).remedySuggestion,
        });
      } catch {}
    } else {
      report = childThread.fail(workerResult.error || 'Subagent execution failed');
    }

    // 5. Store subagent outcome in Parent Blackboard for cross-agent coordination
    parentThread.blackboard.set(`subagent_${subagentId}`, {
      role: clean.role,
      status: workerResult.status,
      summary: workerResult.summary,
      error: (workerResult as any).error,
      remedySuggestion: (workerResult as any).remedySuggestion,
      tokens: report.totalTokens,
      durationMs: report.totalDurationMs,
    });

    // 6. Emit ACP notification that subagent has finished
    this.dispatcher?.emitSessionUpdate({
      sessionId: parentThread.threadId,
      updateType: 'step_finished' as any,
      timestamp: Date.now(),
      data: {
        event: 'subagent_finished',
        subagentId,
        childThreadId,
        role: clean.role,
        status: workerResult.status,
        durationMs: report.totalDurationMs,
        tokens: report.totalTokens,
        summary: workerResult.summary,
      },
    });

    return {
      subagentId,
      role: clean.role,
      status: workerResult.status,
      summary: workerResult.summary,
      durationMs: report.totalDurationMs,
      tokens: report.totalTokens,
      childThreadId,
      stepCount: report.counts?.steps || 0,
    };
  }
}
