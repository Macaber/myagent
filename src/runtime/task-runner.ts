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

    // 1. Create a single Turn for this user interaction / prompt
    const promptTurn = threadContext.createTurn('USER_INPUT');

    // 2. Planning Phase (if no plan exists yet)
    let plan = threadContext.getExecutionPlan();
    if (!plan) {
      stateMachine.transitionTo('PLANNING');
      threadContext.setState('PLANNING');

      try {
        plan = await this.planner.createPlan(threadContext.prompt, promptTurn, {
          threadId: threadContext.threadId,
          turnId: promptTurn.turnId,
          workspaceJail: threadContext.workspaceJail,
          blackboard: threadContext.blackboard,
          abortSignal: options.abortSignal,
        });

        threadContext.setExecutionPlan(plan);
      } catch (err: any) {
        promptTurn.end({ status: 'FAILED', summary: err.message });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Planning phase failed: ${err.message}`);
      }
    }

    // 3. Execution Loop (all milestones execute within the prompt turn)
    stateMachine.transitionTo('RUNNING');
    threadContext.setState('RUNNING');

    let turnsCount = 0;
    let lastSummary = '';
    while (!plan.isAllCompleted()) {
      if (options.abortSignal?.aborted) {
        promptTurn.end({ status: 'FAILED', summary: 'Task cancelled by user' });
        stateMachine.transitionTo('CANCELLED');
        threadContext.setState('CANCELLED');
        return threadContext.fail('Task cancelled by user');
      }

      turnsCount++;
      if (turnsCount > (this.config.maxTurns || 50)) {
        promptTurn.end({ status: 'FAILED', summary: `Max turn limit exceeded (${this.config.maxTurns})` });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Max turn limit exceeded (${this.config.maxTurns})`);
      }

      const readyMilestones = plan.getReadyMilestones();
      if (readyMilestones.length === 0) {
        const blocked = plan.getFailedMilestones();
        if (blocked.length > 0) {
          promptTurn.end({
            status: 'FAILED',
            summary: `Task execution blocked: Milestones [${blocked.map((b) => b.id).join(', ')}] failed or require user intervention`,
          });
          stateMachine.transitionTo('FAILED');
          return threadContext.fail(
            `Task execution blocked: Milestones [${blocked.map((b) => b.id).join(', ')}] failed or require user intervention`
          );
        }
        break;
      }

      // Execute next milestone within this turn
      const currentMilestone = readyMilestones[0];
      currentMilestone.status = 'RUNNING';

      const workerResult = await this.worker.executeMilestone(
        currentMilestone,
        promptTurn,
        {
          threadId: threadContext.threadId,
          prompt: threadContext.prompt,
          turnId: promptTurn.turnId,
          workspaceJail: threadContext.workspaceJail,
          blackboard: threadContext.blackboard,
          abortSignal: options.abortSignal,
        },
        options.userHint
      );

      if (workerResult.summary) {
        lastSummary = workerResult.summary;
      }

      if (workerResult.status === 'SUCCESS') {
        plan.markMilestoneStatus(currentMilestone.id, 'SUCCESS', workerResult.summary);
      } else if (workerResult.status === 'BLOCKED') {
        plan.markMilestoneStatus(currentMilestone.id, 'BLOCKED', workerResult.summary, workerResult.error);
        promptTurn.end({
          status: 'FAILED',
          summary: `Milestone blocked: ${workerResult.error || workerResult.summary}`,
        });

        stateMachine.transitionTo('SUSPENDED_INPUT');
        threadContext.setState('SUSPENDED_INPUT');

        threadContext.dispatcher?.emitTaskEvent({
          threadId: threadContext.threadId,
          turnId: promptTurn.turnId,
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
        plan.markMilestoneStatus(currentMilestone.id, 'FAILED', workerResult.summary, workerResult.error);
        promptTurn.end({
          status: 'FAILED',
          summary: workerResult.error || 'Execution failed',
        });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Milestone '${currentMilestone.id}' failed: ${workerResult.error}`);
      }
    }

    // 4. Summary & Completion
    const finalSummary = lastSummary || 'All milestones in DAG completed successfully.';
    promptTurn.end({
      status: 'COMPLETED',
      summary: finalSummary,
    });

    const finalReport = threadContext.complete(finalSummary);

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
