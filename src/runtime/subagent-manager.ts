import { ThreadContext } from './thread-context.js';
import { AgentDatabase } from '../persistence/db.js';
import { RpcDispatcher } from '../protocol/rpc-dispatcher.js';
import { WorkerAgent } from '../engine/worker.js';
import { SkillRegistry } from '../skills/skill-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { TokenUsage } from '../persistence/telemetry-store.js';

export interface SpawnSubagentParams {
  role: string;
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

  public async runSubagent(
    parentThread: ThreadContext,
    params: SpawnSubagentParams
  ): Promise<SubagentExecutionResult> {
    const subagentId = `sub_${this.subagentCounter++}_${Date.now()}`;
    const childThreadId = `${parentThread.threadId}_${subagentId}`;

    // 1. Create Child Thread Context with parent link
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

    // 2. Emit ACP notification that subagent has started
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

    // 3. Create isolated single Turn for the Sub-agent
    const subTurn = childThread.createTurn('WORKER', subagentId);

    const syntheticMilestone = {
      id: subagentId,
      title: params.role,
      description: params.taskDescription,
      dependencies: [],
      assignedSkill: params.skillId || 'developer',
      status: 'RUNNING' as const,
    };

    // 4. Execute Subagent ReAct loop in complete isolation
    const workerResult = await this.worker.executeMilestone(
      syntheticMilestone,
      subTurn,
      {
        threadId: childThreadId,
        turnId: subTurn.turnId,
        workspaceJail: childThread.workspaceJail,
        blackboard: childThread.blackboard,
      }
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
