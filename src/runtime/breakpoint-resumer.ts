import { ThreadContext } from './thread-context.js';
import { Milestone } from '../engine/dag.js';

export interface ResumePlanResult {
  resumedMilestone: Milestone;
  skippedMilestoneIds: string[];
}

export class BreakpointResumer {
  /**
   * Resets failed milestones and prepares the plan to resume without re-running successful ones
   */
  public static prepareResume(
    threadContext: ThreadContext,
    targetMilestoneId?: string
  ): ResumePlanResult {
    const plan = threadContext.getExecutionPlan();
    if (!plan) {
      throw new Error(`Cannot resume thread '${threadContext.threadId}': No execution plan found`);
    }

    const milestones = plan.getMilestones();
    const successfulMilestones = milestones.filter((m) => m.status === 'SUCCESS');
    const skippedMilestoneIds = successfulMilestones.map((m) => m.id);

    // Find target milestone to resume
    let target: Milestone | undefined;
    if (targetMilestoneId) {
      target = plan.getMilestone(targetMilestoneId);
    } else {
      target = milestones.find((m) => m.status === 'FAILED' || m.status === 'BLOCKED');
    }

    if (!target) {
      // If nothing is explicitly failed, find the first non-SUCCESS milestone
      target = milestones.find((m) => m.status !== 'SUCCESS');
    }

    if (!target) {
      throw new Error('All milestones in DAG are already completed successfully. Nothing to resume.');
    }

    // Reset status to READY (cascade to downstream FAILED/BLOCKED so resume doesn't deadlock)
    plan.resetFailedMilestone(target.id, { cascade: true });

    // Update plan in blackboard & emit event
    threadContext.setExecutionPlan(plan);

    return {
      resumedMilestone: target,
      skippedMilestoneIds,
    };
  }
}
