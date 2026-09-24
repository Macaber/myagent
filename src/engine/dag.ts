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
    return Array.from(this.milestonesMap.values()).map((m) => ({
      ...m,
      dependencies: [...m.dependencies],
    }));
  }

  public getMilestone(id: string): Milestone | undefined {
    const m = this.milestonesMap.get(id);
    if (!m) return undefined;
    return { ...m, dependencies: [...m.dependencies] };
  }

  /**
   * Returns milestones that are ready to run (dependencies all SUCCESS).
   * Returns defensive copies — mutate via markMilestoneStatus().
   */
  public getReadyMilestones(): Milestone[] {
    const ready: Milestone[] = [];
    for (const m of this.milestonesMap.values()) {
      if (m.status === 'WAITING' || m.status === 'READY') {
        const depsSatisfied = m.dependencies.every(
          (depId) => this.milestonesMap.get(depId)?.status === 'SUCCESS'
        );
        if (depsSatisfied) {
          ready.push({ ...m, dependencies: [...m.dependencies] });
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
    return Array.from(this.milestonesMap.values())
      .filter((m) => m.status === 'FAILED' || m.status === 'BLOCKED')
      .map((m) => ({ ...m, dependencies: [...m.dependencies] }));
  }

  /**
   * Validate DAG: dependencies exist, no self-dependency, no cycles.
   */
  public validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const m of this.milestonesMap.values()) {
      for (const dep of m.dependencies) {
        if (dep === m.id) {
          errors.push(`Milestone '${m.id}' depends on itself`);
        } else if (!this.milestonesMap.has(dep)) {
          errors.push(`Milestone '${m.id}' depends on missing milestone '${dep}'`);
        }
      }
    }
    const cycle = this.findCycle();
    if (cycle) {
      errors.push(`Dependency cycle detected: ${cycle.join(' -> ')}`);
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * DFS cycle detection. Returns cycle path or null.
   */
  public findCycle(): string[] | null {
    const visited = new Set<string>();
    const stack: string[] = [];
    const inStack = new Set<string>();

    const visit = (id: string): string[] | null => {
      visited.add(id);
      stack.push(id);
      inStack.add(id);
      const m = this.milestonesMap.get(id);
      if (m) {
        for (const dep of m.dependencies) {
          if (!this.milestonesMap.has(dep)) continue;
          if (!visited.has(dep)) {
            const found = visit(dep);
            if (found) return found;
          } else if (inStack.has(dep)) {
            return [...stack.slice(stack.indexOf(dep)), dep];
          }
        }
      }
      stack.pop();
      inStack.delete(id);
      return null;
    };

    for (const id of this.milestonesMap.keys()) {
      if (!visited.has(id)) {
        const found = visit(id);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Explain why no milestone is ready while the plan is incomplete.
   */
  public getBlockingReason(): string {
    const pending = Array.from(this.milestonesMap.values()).filter(
      (m) => m.status !== 'SUCCESS'
    );
    const details = pending.map((m) => {
      const unsatisfied = m.dependencies.filter(
        (dep) => this.milestonesMap.get(dep)?.status !== 'SUCCESS'
      );
      const missing = m.dependencies.filter((dep) => !this.milestonesMap.has(dep));
      if (missing.length > 0) {
        return `${m.id} waits on missing [${missing.join(', ')}]`;
      }
      if (unsatisfied.length > 0) {
        return `${m.id}(${m.status}) waits on [${unsatisfied.join(', ')}]`;
      }
      return `${m.id}(${m.status}) is ready but not scheduled`;
    });
    const cycle = this.findCycle();
    const cycleHint = cycle ? ` Cycle: ${cycle.join(' -> ')}.` : '';
    return `Deadlock: no ready milestones but plan incomplete. ${details.join('; ')}.${cycleHint}`;
  }

  private getDependents(id: string): string[] {
    const out: string[] = [];
    for (const m of this.milestonesMap.values()) {
      if (m.dependencies.includes(id)) out.push(m.id);
    }
    return out;
  }

  /**
   * Reset a failed milestone back to READY for targeted breakpoint resume.
   * Clears stale result/error and optionally cascades to downstream
   * FAILED/BLOCKED milestones that can never become ready otherwise.
   */
  public resetFailedMilestone(id: string, options: { cascade?: boolean } = {}): void {
    const m = this.milestonesMap.get(id);
    if (m) {
      m.status = 'READY';
      m.error = undefined;
      m.resultSummary = undefined;
    }
    if (options.cascade) {
      const queue = this.getDependents(id);
      const seen = new Set<string>(queue);
      while (queue.length > 0) {
        const depId = queue.shift()!;
        const dep = this.milestonesMap.get(depId);
        if (dep && (dep.status === 'FAILED' || dep.status === 'BLOCKED')) {
          dep.status = 'READY';
          dep.error = undefined;
          dep.resultSummary = undefined;
        }
        for (const next of this.getDependents(depId)) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
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
