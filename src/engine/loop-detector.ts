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

// FNV-1a 32-bit: cheap non-crypto hash for hot-path fingerprinting
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Stable normalization: sorted keys, trimmed strings, so whitespace-only
// or key-order differences can't dodge loop detection.
function normalizeParams(raw: any): string {
  const norm = (v: any): any => {
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
      return out;
    }
    return v;
  };
  try {
    return JSON.stringify(norm(raw) ?? {});
  } catch {
    return String(raw);
  }
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
    const paramsHash = fnv1a(`${toolName}:${normalizeParams(rawParams)}`);

    this.history.push({
      toolName,
      paramsHash,
      failed,
      timestamp: Date.now(),
    });

    // If edit/write, track file target + content snippet hash
    if (toolName === 'edit' || toolName === 'write') {
      const params = typeof rawParams === 'object' && rawParams !== null ? rawParams : {};
      const target = `${params.filePath || 'unknown'}:${fnv1a(String(params.newStr ?? params.content ?? ''))}`;
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

    // 2b. Check identical consecutive calls regardless of outcome (successful
    // repeats like re-reading the same file are loops too). Higher threshold
    // so normal retries don't trip.
    const repeatThreshold = Math.max(4, this.maxConsecutiveSameAction * 2);
    if (this.history.length >= repeatThreshold) {
      const recent = this.history.slice(-repeatThreshold);
      const allSame = recent.every(
        (a) => a.toolName === recent[0].toolName && a.paramsHash === recent[0].paramsHash
      );
      if (allSame) {
        return {
          tripped: true,
          reason: `Detected dead-loop: Tool '${recent[0].toolName}' called ${repeatThreshold} times consecutively with identical arguments.`,
        };
      }
    }

    // 3. Check oscillation in edits: last target repeats any earlier target
    // within the window with a different edit in between (A-B-A, A-B-C-A, ...).
    const window = this.editTargetHistory.slice(-6);
    if (window.length >= 3) {
      const last = window[window.length - 1];
      const earlier = window.slice(0, -1);
      const prevIdx = earlier.lastIndexOf(last);
      if (prevIdx !== -1 && earlier.slice(prevIdx + 1).some((t) => t !== last)) {
        const other = earlier.slice(prevIdx + 1).find((t) => t !== last)!;
        return {
          tripped: true,
          reason: `Detected cognitive oscillation: Ping-pong file modifications detected (${last} <-> ${other}). Halting to prevent thrashing.`,
        };
      }
    }

    return { tripped: false };
  }

  public resetTurn(): void {
    this.history = [];
    this.editTargetHistory = [];
    this.modelIterations = 0;
  }
}
