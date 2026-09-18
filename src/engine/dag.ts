export type MilestoneStatus =
  | 'WAITING'
  | 'READY'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'BLOCKED';

export interface Milestone {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  assignedSkill: string;
  acceptanceCriteria?: string;
  status: MilestoneStatus;
  resultSummary?: string;
  error?: string;
}

export class ExecutionPlan {
  private milestonesMap = new Map<string, Milestone>();

  constructor(
    public readonly goal: string,
    milestones: Milestone[]
  ) {
    for (const m of milestones) {
      this.milestonesMap.set(m.id, { ...m });
    }
  }

  public getMilestones(): Milestone[] {
    return Array.from(this.milestonesMap.values());
  }

  public getMilestone(id: string): Milestone | undefined {
    return this.milestonesMap.get(id);
  }

  /**
   * Returns milestones that are ready to run (dependencies all SUCCESS)
   */
  public getReadyMilestones(): Milestone[] {
    const ready: Milestone[] = [];
    for (const m of this.milestonesMap.values()) {
      if (m.status === 'WAITING' || m.status === 'READY') {
        const depsSatisfied = m.dependencies.every(
          (depId) => this.milestonesMap.get(depId)?.status === 'SUCCESS'
        );
        if (depsSatisfied) {
          ready.push(m);
        }
      }
    }
    return ready;
  }

  public markMilestoneStatus(
    id: string,
    status: MilestoneStatus,
    resultSummary?: string,
    error?: string
  ): void {
    const m = this.milestonesMap.get(id);
    if (!m) throw new Error(`Milestone '${id}' not found in DAG`);
    m.status = status;
    if (resultSummary !== undefined) m.resultSummary = resultSummary;
    if (error !== undefined) m.error = error;
  }

  public isAllCompleted(): boolean {
    return Array.from(this.milestonesMap.values()).every((m) => m.status === 'SUCCESS');
  }

  public hasFailedOrBlocked(): boolean {
    return Array.from(this.milestonesMap.values()).some(
      (m) => m.status === 'FAILED' || m.status === 'BLOCKED'
    );
  }

  public getFailedMilestones(): Milestone[] {
    return Array.from(this.milestonesMap.values()).filter(
      (m) => m.status === 'FAILED' || m.status === 'BLOCKED'
    );
  }

  /**
   * Reset a failed milestone back to READY for targeted breakpoint resume
   */
  public resetFailedMilestone(id: string): void {
    const m = this.milestonesMap.get(id);
    if (m) {
      m.status = 'READY';
      m.error = undefined;
    }
  }

  public toJSON(): { goal: string; milestones: Milestone[] } {
    return {
      goal: this.goal,
      milestones: this.getMilestones(),
    };
  }

  public static fromJSON(data: { goal: string; milestones: Milestone[] }): ExecutionPlan {
    return new ExecutionPlan(data.goal, data.milestones);
  }
}
