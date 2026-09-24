import { ThreadContext } from './thread-context.js';
import { TaskStateMachine } from './state-machine.js';
import { Planner } from '../engine/planner.js';
import { WorkerAgent } from '../engine/worker.js';
import { DirectAgentLoop } from '../engine/direct-agent-loop.js';
import { BreakpointResumer } from './breakpoint-resumer.js';
import { ArtifactManager } from './artifacts.js';
import { ThreadMetricsReport } from '../persistence/telemetry-store.js';
import { ToolRegistry } from '../tools/tool-registry.js';

export interface TaskRunnerConfig {
  maxTurns?: number;
  maxParallelMilestones?: number;
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
    let turnEnded = false;
    const endTurnOnce = (params: { status: 'COMPLETED' | 'FAILED' | 'SUSPENDED'; summary?: string }) => {
      if (turnEnded) return;
      turnEnded = true;
      try {
        promptTurn.end(params);
      } catch {
        // Best-effort: telemetry end must not mask the real result.
      }
    };

    try {
      return await this.runTaskInner(threadContext, options, stateMachine, promptTurn, endTurnOnce);
    } catch (err: any) {
      if (options.abortSignal?.aborted) {
        endTurnOnce({ status: 'FAILED', summary: 'Task cancelled by user' });
        try {
          stateMachine.transitionTo('CANCELLED');
        } catch {}
        return threadContext.cancel(err?.message || 'Task cancelled by user');
      }
      endTurnOnce({ status: 'FAILED', summary: err?.message || 'Execution failed' });
      try {
        stateMachine.transitionTo('FAILED');
      } catch {}
      // Preserve CANCELLED semantics if the error is an abort.
      if (err?.name === 'AbortError') {
        return threadContext.cancel(err?.message || 'Task cancelled by user');
      }
      return threadContext.fail(err?.message || 'Execution failed');
    }
  }

  private async runTaskInner(
    threadContext: ThreadContext,
    options: { abortSignal?: AbortSignal; userHint?: string },
    stateMachine: TaskStateMachine,
    promptTurn: import('./turn-context.js').TurnContext,
    endTurnOnce: (params: { status: 'COMPLETED' | 'FAILED' | 'SUSPENDED'; summary?: string }) => void
  ): Promise<ThreadMetricsReport> {

    // 2. Planning Phase vs Direct Agent Loop
    let plan = threadContext.getExecutionPlan();

    // If an LLM provider is present and no pre-existing DAG plan was set, use unified DirectAgentLoop
    if (!plan && this.worker.provider) {
      stateMachine.transitionTo('RUNNING');
      threadContext.setState('RUNNING');

      const directLoop = new DirectAgentLoop(
        this.worker.provider,
        this.toolRegistry,
        this.worker.toolRouter,
        this.worker.skillRegistry,
        this.worker.contextAssembler
      );

      const loopResult = await directLoop.run({
        threadContext,
        turnContext: promptTurn,
        toolContext: {
          threadId: threadContext.threadId,
          prompt: threadContext.prompt,
          workspaceJail: threadContext.workspaceJail,
          blackboard: threadContext.blackboard,
          abortSignal: options.abortSignal,
        },
        userHint: options.userHint,
        steeringQueue: threadContext.steeringQueue,
        abortSignal: options.abortSignal,
      });

      if (loopResult.status === 'CANCELLED') {
        endTurnOnce({ status: 'FAILED', summary: 'Task cancelled by user' });
        try {
          stateMachine.transitionTo('CANCELLED');
        } catch {}
        return threadContext.cancel('Task cancelled by user');
      }

      if (loopResult.status === 'FAILED') {
        endTurnOnce({ status: 'FAILED', summary: loopResult.error || 'Execution failed' });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(loopResult.error || 'Execution failed');
      }

      endTurnOnce({
        status: 'COMPLETED',
        summary: loopResult.summary,
      });

      stateMachine.transitionTo('COMPLETED');
      threadContext.setState('COMPLETED');

      const finalReport = threadContext.complete(loopResult.summary);
      ArtifactManager.saveRunSummary(
        threadContext.workspaceJail.getWorkspaceRoot(),
        threadContext.threadId,
        finalReport,
        threadContext.blackboard
      );
      return finalReport;
    }

    // Otherwise (offline testing mode or explicit DAG plan), use Milestone DAG execution
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

        const validation = plan.validate();
        if (!validation.valid) {
          throw new Error(`Generated plan is invalid: ${validation.errors.join('; ')}`);
        }

        threadContext.setExecutionPlan(plan);
      } catch (err: any) {
        endTurnOnce({ status: 'FAILED', summary: err.message });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Planning phase failed: ${err.message}`);
      }
    } else {
      const validation = plan.validate();
      if (!validation.valid) {
        endTurnOnce({ status: 'FAILED', summary: `Stored plan is invalid: ${validation.errors.join('; ')}` });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Stored plan is invalid: ${validation.errors.join('; ')}`);
      }
    }

    // 3. Execution Loop (all milestones execute within the prompt turn)
    stateMachine.transitionTo('RUNNING');
    threadContext.setState('RUNNING');

    let turnsCount = 0;
    let lastSummary = '';
    while (!plan.isAllCompleted()) {
      if (options.abortSignal?.aborted) {
        endTurnOnce({ status: 'FAILED', summary: 'Task cancelled by user' });
        try {
          stateMachine.transitionTo('CANCELLED');
        } catch {}
        return threadContext.cancel('Task cancelled by user');
      }

      turnsCount++;
      if (turnsCount > (this.config.maxTurns || 50)) {
        endTurnOnce({ status: 'FAILED', summary: `Max turn limit exceeded (${this.config.maxTurns})` });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Max turn limit exceeded (${this.config.maxTurns})`);
      }

      const readyMilestones = plan.getReadyMilestones();
      if (readyMilestones.length === 0) {
        const blocked = plan.getFailedMilestones();
        if (blocked.length > 0) {
          endTurnOnce({
            status: 'FAILED',
            summary: `Task execution blocked: Milestones [${blocked.map((b) => b.id).join(', ')}] failed or require user intervention`,
          });
          stateMachine.transitionTo('FAILED');
          return threadContext.fail(
            `Task execution blocked: Milestones [${blocked.map((b) => b.id).join(', ')}] failed or require user intervention`
          );
        }
        // No ready and no failed, but incomplete => deadlock (missing dep / cycle).
        // Must fail explicitly instead of breaking into a false COMPLETED.
        const reason = plan.getBlockingReason();
        endTurnOnce({ status: 'FAILED', summary: reason });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(reason);
      }

      // Execute ready milestones. Independent ready milestones run in a bounded
      // parallel batch; single ready milestone keeps the legacy serial path.
      const batchSize = Math.min(
        readyMilestones.length,
        (this.config.maxParallelMilestones ?? Number(process.env.MAX_PARALLEL_MILESTONES)) || 3
      );
      const batch = readyMilestones.slice(0, Math.max(batchSize, 1));
      for (const m of batch) {
        plan.markMilestoneStatus(m.id, 'RUNNING');
      }
      threadContext.persistExecutionPlan();

      const batchResults = await Promise.allSettled(
        batch.map((m) =>
          this.worker.executeMilestone(
            m,
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
          ).then((r) => ({ milestoneId: m.id, result: r }))
        )
      );

      // Collect batch outcomes; a rejected promise counts as FAILED (never orphans siblings).
      let blockedOutcome: { milestoneId: string; result: import('../engine/worker.js').WorkerExecutionResult } | undefined;
      let failedOutcome: { milestoneId: string; result: import('../engine/worker.js').WorkerExecutionResult } | undefined;
      for (let i = 0; i < batchResults.length; i++) {
        const settled = batchResults[i];
        const mid = batch[i].id;
        if (settled.status === 'fulfilled') {
          const { result } = settled.value;
          if (result.summary) lastSummary = result.summary;
          if (result.status === 'SUCCESS') {
            plan.markMilestoneStatus(mid, 'SUCCESS', result.summary);
          } else if (result.status === 'BLOCKED') {
            plan.markMilestoneStatus(mid, 'BLOCKED', result.summary, result.error);
            blockedOutcome = blockedOutcome ?? { milestoneId: mid, result };
          } else {
            plan.markMilestoneStatus(mid, 'FAILED', result.summary, result.error);
            failedOutcome = failedOutcome ?? { milestoneId: mid, result };
          }
        } else {
          const errMsg = (settled.reason as Error)?.message || String(settled.reason);
          plan.markMilestoneStatus(mid, 'FAILED', '', errMsg);
          failedOutcome = failedOutcome ?? {
            milestoneId: mid,
            result: { status: 'FAILED', summary: '', error: errMsg },
          };
        }
      }
      threadContext.persistExecutionPlan();

      if (blockedOutcome) {
        endTurnOnce({
          status: 'FAILED',
          summary: `Milestone blocked: ${blockedOutcome.result.error || blockedOutcome.result.summary}`,
        });

        stateMachine.transitionTo('SUSPENDED_INPUT');
        threadContext.setState('SUSPENDED_INPUT');

        threadContext.dispatcher?.emitTaskEvent({
          threadId: threadContext.threadId,
          turnId: promptTurn.turnId,
          type: 'BLOCKED_NEED_USER',
          timestamp: Date.now(),
          data: {
            milestoneId: blockedOutcome.milestoneId,
            error: blockedOutcome.result.error,
            remedySuggestion: blockedOutcome.result.remedySuggestion,
          },
        });

        return threadContext.telemetryStore.getThreadMetrics(threadContext.threadId);
      }
      if (failedOutcome) {
        endTurnOnce({
          status: 'FAILED',
          summary: failedOutcome.result.error || 'Execution failed',
        });
        stateMachine.transitionTo('FAILED');
        return threadContext.fail(`Milestone '${failedOutcome.milestoneId}' failed: ${failedOutcome.result.error}`);
      }
      // Batch fully succeeded — continue to next ready set.
    }

    // 4. Summary & Completion
    const finalSummary = lastSummary || 'All milestones in DAG completed successfully.';
    endTurnOnce({
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
