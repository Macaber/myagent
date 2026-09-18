import { ThreadContext } from './thread-context.js';
import { TaskStateMachine } from './state-machine.js';
import { Planner } from '../engine/planner.js';
import { WorkerAgent } from '../engine/worker.js';
import { BreakpointResumer } from './breakpoint-resumer.js';
import { ArtifactManager } from './artifacts.js';
import { ThreadMetricsReport } from '../persistence/telemetry-store.js';
import { ToolRegistry } from '../tools/tool-registry.js';

export interface TaskRunnerConfig {
  maxTurns?: number;
}

export class TaskRunner {
  constructor(
    private readonly planner: Planner,
    private readonly worker: WorkerAgent,
    private readonly toolRegistry: ToolRegistry,
    private readonly config: TaskRunnerConfig = { maxTurns: 50 }
  ) {}

  public async runTask(
    threadContext: ThreadContext,
    options: { abortSignal?: AbortSignal; userHint?: string } = {}
  ): Promise<ThreadMetricsReport> {
    const stateMachine = new TaskStateMachine(threadContext.getState() as any);

    // 1. Planning Phase (if no plan exists yet)
    let plan = threadContext.getExecutionPlan();
    if (!plan) {
      stateMachine.transitionTo('PLANNING');
      threadContext.setState('PLANNING');

      const planningTurn = threadContext.createTurn('PLANNING');
      try {
        plan = await this.planner.createPlan(threadContext.prompt, planningTurn, {
          threadId: threadContext.threadId,
          turnId: planningTurn.turnId,
          workspaceJail: threadContext.workspaceJail,
          blackboard: threadContext.blackboard,
          abortSignal: options.abortSignal,
        });

        threadContext.setExecutionPlan(plan);
        planningTurn.end({
          status: 'COMPLETED',
          summary: `Decomposed goal into ${plan.getMilestones().length} milestones`,
        });
      } catch (err: any) {
        planningTurn.end({ status: 'FAILED', summary: err.message });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Planning phase failed: ${err.message}`);
      }
    }

    // 2. Execution Loop
    stateMachine.transitionTo('RUNNING');
    threadContext.setState('RUNNING');

    let turnsCount = 0;
    while (!plan.isAllCompleted()) {
      if (options.abortSignal?.aborted) {
        stateMachine.transitionTo('CANCELLED');
        threadContext.setState('CANCELLED');
        return threadContext.fail('Task cancelled by user');
      }

      turnsCount++;
      if (turnsCount > (this.config.maxTurns || 50)) {
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Max turn limit exceeded (${this.config.maxTurns})`);
      }

      const readyMilestones = plan.getReadyMilestones();
      if (readyMilestones.length === 0) {
        // If no ready milestones and not all completed, check if any failed or blocked
        const blocked = plan.getFailedMilestones();
        if (blocked.length > 0) {
          stateMachine.transitionTo('FAILED');
          return threadContext.fail(
            `Task execution blocked: Milestones [${blocked.map((b) => b.id).join(', ')}] failed or require user intervention`
          );
        }
        break;
      }

      // Execute next milestone in worker turn
      const currentMilestone = readyMilestones[0];
      currentMilestone.status = 'RUNNING';

      const workerTurn = threadContext.createTurn('WORKER', currentMilestone.id);
      const workerResult = await this.worker.executeMilestone(
        currentMilestone,
        workerTurn,
        {
          threadId: threadContext.threadId,
          turnId: workerTurn.turnId,
          workspaceJail: threadContext.workspaceJail,
          blackboard: threadContext.blackboard,
          abortSignal: options.abortSignal,
        },
        options.userHint
      );

      if (workerResult.status === 'SUCCESS') {
        plan.markMilestoneStatus(currentMilestone.id, 'SUCCESS', workerResult.summary);
        workerTurn.end({
          status: 'COMPLETED',
          summary: workerResult.summary,
        });
      } else if (workerResult.status === 'BLOCKED') {
        // Blocked / Fast-fail: Alert user immediately and halt without blind retry
        plan.markMilestoneStatus(currentMilestone.id, 'BLOCKED', workerResult.summary, workerResult.error);
        workerTurn.end({
          status: 'FAILED',
          summary: `Milestone blocked: ${workerResult.error || workerResult.summary}`,
        });

        stateMachine.transitionTo('SUSPENDED_INPUT');
        threadContext.setState('SUSPENDED_INPUT');

        threadContext.dispatcher?.emitTaskEvent({
          threadId: threadContext.threadId,
          turnId: workerTurn.turnId,
          type: 'BLOCKED_NEED_USER',
          timestamp: Date.now(),
          data: {
            milestoneId: currentMilestone.id,
            error: workerResult.error,
            remedySuggestion: workerResult.remedySuggestion,
          },
        });

        return threadContext.telemetryStore.getThreadMetrics(threadContext.threadId);
      } else {
        // Failed
        plan.markMilestoneStatus(currentMilestone.id, 'FAILED', workerResult.summary, workerResult.error);
        workerTurn.end({
          status: 'FAILED',
          summary: workerResult.error || 'Execution failed',
        });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Milestone '${currentMilestone.id}' failed: ${workerResult.error}`);
      }
    }

    // 3. Summary Phase
    const summaryTurn = threadContext.createTurn('SUMMARY');
    const finalReport = threadContext.complete('All milestones in DAG completed successfully.');
    summaryTurn.end({ status: 'COMPLETED', summary: 'Generated final metrics and artifact summary' });

    // Save summary artifact
    ArtifactManager.saveRunSummary(
      threadContext.workspaceJail.getWorkspaceRoot(),
      threadContext.threadId,
      finalReport,
      threadContext.blackboard
    );

    return finalReport;
  }

  /**
   * Targeted Breakpoint Resume: Resumes execution from failed milestone without re-running completed ones
   */
  public async resumeTask(
    threadContext: ThreadContext,
    options: { targetMilestoneId?: string; userHint?: string; abortSignal?: AbortSignal } = {}
  ): Promise<ThreadMetricsReport> {
    const resumeInfo = BreakpointResumer.prepareResume(
      threadContext,
      options.targetMilestoneId
    );

    threadContext.dispatcher?.emitTaskEvent({
      threadId: threadContext.threadId,
      type: 'THREAD_STATE_CHANGED',
      timestamp: Date.now(),
      data: {
        action: 'RESUMED',
        resumedMilestoneId: resumeInfo.resumedMilestone.id,
        skippedMilestoneIds: resumeInfo.skippedMilestoneIds,
        userHint: options.userHint,
      },
    });

    return this.runTask(threadContext, {
      abortSignal: options.abortSignal,
      userHint: options.userHint,
    });
  }
}
