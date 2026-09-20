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
}

export class SubagentManager {
  private subagentCounter = 1;

  constructor(
    private readonly db: AgentDatabase,
    private readonly worker: WorkerAgent,
    private readonly toolRegistry: ToolRegistry,
    private readonly skillRegistry: SkillRegistry,
    private readonly dispatcher?: RpcDispatcher
  ) {}

  /**
   * Run multiple subagents concurrently in parallel via Promise.all.
   * Isolates context completely across all subagent threads.
   */
  public async runSubagentsBatch(
    parentThread: ThreadContext,
    tasks: SpawnSubagentParams[]
  ): Promise<SubagentExecutionResult[]> {
    if (tasks.length === 0) return [];
    if (tasks.length === 1) {
      const single = await this.runSubagent(parentThread, tasks[0]);
      return [single];
    }

    // Run all subagents concurrently in parallel via Promise.all
    return Promise.all(tasks.map((task) => this.runSubagent(parentThread, task)));
  }

  /**
   * Format a list of subagent outcomes into a high-density Markdown summary card.
   */
  public static formatSubagentResults(results: SubagentExecutionResult[]): string {
    if (results.length === 0) return 'No subagents executed.';

    const cards = results.map((r, idx) => {
      const icon = r.status === 'SUCCESS' ? '✅' : '❌';
      return (
        `### ${icon} [Subagent ${idx + 1}: ${r.role.toUpperCase()}] (${r.subagentId})\n` +
        `- **执行状态**: ${r.status}\n` +
        `- **耗时 / Tokens**: ${(r.durationMs / 1000).toFixed(2)}s | ${r.tokens?.totalTokens || 0} tokens\n` +
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
    params: SpawnSubagentParams
  ): Promise<SubagentExecutionResult> {
    const subagentId = `sub_${this.subagentCounter++}_${Date.now()}`;
    const childThreadId = `${parentThread.threadId}_${subagentId}`;

    // 1. Resolve role, skill, and specialized prompt
    const normalizedRole = (params.role || 'explore').toLowerCase();
    let effectiveSkill = params.skillId;
    let roleInstructions = '';
    let defaultMaxSteps = 10;

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
        effectiveSkill = 'developer';
        defaultMaxSteps = 12;
      }
    }

    const effectiveMaxSteps = params.maxSteps ?? defaultMaxSteps;

    // 2. Create Child Thread Context with parent link
    const childThread = new ThreadContext(
      {
        threadId: childThreadId,
        sessionId: parentThread.sessionId,
        parentThreadId: parentThread.threadId,
        prompt: `[Subagent: ${params.role}] ${params.taskDescription}`,
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
        role: params.role,
        taskDescription: params.taskDescription,
      },
    });

    // 4. Create isolated single Turn for the Sub-agent
    const subTurn = childThread.createTurn('WORKER', subagentId);

    const syntheticMilestone = {
      id: subagentId,
      title: `Subagent [${params.role}]`,
      description: `${roleInstructions ? roleInstructions + '\n\n' : ''}Task: ${params.taskDescription}`,
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
      },
      undefined,
      effectiveMaxSteps
    );

    subTurn.end({
      status: workerResult.status === 'SUCCESS' ? 'COMPLETED' : 'FAILED',
      summary: workerResult.summary,
    });

    const report = workerResult.status === 'SUCCESS'
      ? childThread.complete(workerResult.summary)
      : childThread.fail(workerResult.error || 'Subagent execution failed');

    // 5. Store subagent outcome in Parent Blackboard for cross-agent coordination
    parentThread.blackboard.set(`subagent_${subagentId}`, {
      role: params.role,
      status: workerResult.status,
      summary: workerResult.summary,
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
        role: params.role,
        status: workerResult.status,
        durationMs: report.totalDurationMs,
        tokens: report.totalTokens,
        summary: workerResult.summary,
      },
    });

    return {
      subagentId,
      role: params.role,
      status: workerResult.status,
      summary: workerResult.summary,
      durationMs: report.totalDurationMs,
      tokens: report.totalTokens,
    };
  }
}
