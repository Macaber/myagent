import { createHash } from 'node:crypto';

export interface ActionFingerprint {
  toolName: string;
  paramsHash: string;
  failed: boolean;
  timestamp: number;
}

export interface BudgetStatus {
  modelIterations: number;
  maxModelIterations: number;
  toolExecutions: number;
  maxToolExecutions: number;
  shouldWarnBudget: boolean;
  shouldForceAnswer: boolean;
}

export class LoopDetector {
  private history: ActionFingerprint[] = [];
  private editTargetHistory: string[] = []; // Tracks modified file keys for oscillation detection
  private modelIterations: number = 0;

  constructor(
    private readonly maxStepsPerTurn: number = Number(process.env.MAX_STEPS_PER_TURN) || 60,
    private readonly maxConsecutiveSameAction: number = 2,
    private readonly maxModelIterations: number = Number(process.env.MAX_MODEL_ITERATIONS) || 12
  ) {}

  public recordModelIteration(): void {
    this.modelIterations++;
  }

  public getModelIterations(): number {
    return this.modelIterations;
  }

  public getBudgetStatus(): BudgetStatus {
    const warnIterations = Math.max(1, Math.floor(this.maxModelIterations * 0.7));
    const warnTools = Math.max(1, Math.floor(this.maxStepsPerTurn * 0.7));

    const shouldWarnBudget =
      this.modelIterations >= warnIterations || this.history.length >= warnTools;

    const shouldForceAnswer =
      this.modelIterations >= this.maxModelIterations || this.history.length >= this.maxStepsPerTurn;

    return {
      modelIterations: this.modelIterations,
      maxModelIterations: this.maxModelIterations,
      toolExecutions: this.history.length,
      maxToolExecutions: this.maxStepsPerTurn,
      shouldWarnBudget,
      shouldForceAnswer,
    };
  }

  public recordAction(toolName: string, rawParams: any, failed: boolean): void {
    const paramsStr = typeof rawParams === 'string' ? rawParams : JSON.stringify(rawParams);
    const paramsHash = createHash('sha256').update(paramsStr).digest('hex').slice(0, 16);

    this.history.push({
      toolName,
      paramsHash,
      failed,
      timestamp: Date.now(),
    });

    // If edit/write, track file target + content snippet hash
    if (toolName === 'edit' || toolName === 'write') {
      const target = `${rawParams.filePath || 'unknown'}:${createHash('md5').update(String(rawParams.newStr || rawParams.content || '')).digest('hex').slice(0, 8)}`;
      this.editTargetHistory.push(target);
      if (this.editTargetHistory.length > 8) {
        this.editTargetHistory.shift();
      }
    }
  }

  /**
   * Check if current execution should trip the circuit breaker
   */
  public checkCircuitBreaker(): { tripped: boolean; reason?: string } {
    // 1. Check max steps per turn
    if (this.history.length >= this.maxStepsPerTurn) {
      return {
        tripped: true,
        reason: `Turn step budget exhausted (${this.history.length}/${this.maxStepsPerTurn} steps). Halting to prevent runaway execution.`,
      };
    }

    // 2. Check identical consecutive failed tool calls
    if (this.history.length >= this.maxConsecutiveSameAction) {
      const recent = this.history.slice(-this.maxConsecutiveSameAction);
      const allSame = recent.every(
        (a) => a.toolName === recent[0].toolName && a.paramsHash === recent[0].paramsHash && a.failed
      );
      if (allSame) {
        return {
          tripped: true,
          reason: `Detected dead-loop: Tool '${recent[0].toolName}' called ${this.maxConsecutiveSameAction} times consecutively with identical arguments and failed.`,
        };
      }
    }

    // 3. Check oscillation (A -> B -> A) in edits
    if (this.editTargetHistory.length >= 3) {
      const n = this.editTargetHistory.length;
      if (this.editTargetHistory[n - 1] === this.editTargetHistory[n - 3] && this.editTargetHistory[n - 1] !== this.editTargetHistory[n - 2]) {
        return {
          tripped: true,
          reason: `Detected cognitive oscillation: Ping-pong file modifications detected (${this.editTargetHistory[n - 1]} <-> ${this.editTargetHistory[n - 2]}). Halting to prevent thrashing.`,
        };
      }
    }

    return { tripped: false };
  }

  public resetTurn(): void {
    this.history = [];
    this.editTargetHistory = [];
  }
}
