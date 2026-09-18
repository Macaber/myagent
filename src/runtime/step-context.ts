import { TelemetryStore, StepType, TokenUsage } from '../persistence/telemetry-store.js';
import { EventStore } from '../persistence/event-store.js';
import { RpcDispatcher } from '../protocol/rpc-dispatcher.js';

export interface StepContextConfig {
  stepId: string;
  turnId: string;
  threadId: string;
  stepIndex: number;
  stepType: StepType;
  toolName?: string;
  metadata?: Record<string, any>;
}

export class StepContext {
  public readonly stepId: string;
  public readonly turnId: string;
  public readonly threadId: string;
  public readonly stepIndex: number;
  public readonly stepType: StepType;
  public readonly toolName?: string;
  public readonly startedAt: number;

  private completed = false;
  private durationMs = 0;
  private tokens: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  constructor(
    private readonly config: StepContextConfig,
    private readonly telemetryStore: TelemetryStore,
    private readonly eventStore: EventStore,
    private readonly dispatcher?: RpcDispatcher
  ) {
    this.stepId = config.stepId;
    this.turnId = config.turnId;
    this.threadId = config.threadId;
    this.stepIndex = config.stepIndex;
    this.stepType = config.stepType;
    this.toolName = config.toolName;
    this.startedAt = Date.now();

    // 1. Record Step Start in Telemetry
    this.telemetryStore.recordStepStart({
      stepId: this.stepId,
      turnId: this.turnId,
      threadId: this.threadId,
      stepIndex: this.stepIndex,
      stepType: this.stepType,
      toolName: this.toolName,
      metadata: config.metadata,
    });

    // 2. Append event to EventStore
    this.eventStore.appendEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      stepId: this.stepId,
      eventType: 'STEP_STARTED',
      payload: {
        stepIndex: this.stepIndex,
        stepType: this.stepType,
        toolName: this.toolName,
      },
      createdAt: this.startedAt,
    });

    // 3. Emit ACP notification (canonical session/update and task/event)
    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'step_started',
      timestamp: this.startedAt,
      data: {
        turnId: this.turnId,
        stepId: this.stepId,
        stepIndex: this.stepIndex,
        stepType: this.stepType,
        toolName: this.toolName,
      },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      stepId: this.stepId,
      type: 'STEP_STARTED',
      timestamp: this.startedAt,
      data: {
        stepIndex: this.stepIndex,
        stepType: this.stepType,
        toolName: this.toolName,
      },
    });
  }

  public end(params: {
    status: 'SUCCESS' | 'FAILED' | 'REJECTED' | 'CANCELLED';
    tokens?: Partial<TokenUsage>;
    errorMessage?: string;
    metadata?: Record<string, any>;
  }): void {
    if (this.completed) return;
    this.completed = true;

    const now = Date.now();
    this.durationMs = now - this.startedAt;
    if (params.tokens) {
      this.tokens = {
        promptTokens: params.tokens.promptTokens ?? 0,
        completionTokens: params.tokens.completionTokens ?? 0,
        totalTokens:
          params.tokens.totalTokens ??
          ((params.tokens.promptTokens ?? 0) + (params.tokens.completionTokens ?? 0)),
      };
    }

    // 1. Update TelemetryStore
    this.telemetryStore.recordStepEnd({
      stepId: this.stepId,
      status: params.status,
      tokens: this.tokens,
      errorMessage: params.errorMessage,
      metadata: params.metadata,
    });

    // 2. Append EventStore
    this.eventStore.appendEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      stepId: this.stepId,
      eventType: 'STEP_FINISHED',
      payload: {
        status: params.status,
        durationMs: this.durationMs,
        tokens: this.tokens,
        errorMessage: params.errorMessage,
      },
      createdAt: now,
    });

    // 3. Emit ACP notification (canonical session/update and task/event)
    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'step_finished',
      timestamp: now,
      data: {
        turnId: this.turnId,
        stepId: this.stepId,
        status: params.status,
        durationMs: this.durationMs,
        tokens: this.tokens,
        toolName: this.toolName,
        errorMessage: params.errorMessage,
      },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      stepId: this.stepId,
      type: 'STEP_FINISHED',
      timestamp: now,
      data: {
        status: params.status,
        durationMs: this.durationMs,
        tokens: this.tokens,
        toolName: this.toolName,
        errorMessage: params.errorMessage,
      },
    });
  }

  public getDurationMs(): number {
    return this.completed ? this.durationMs : Date.now() - this.startedAt;
  }

  public getTokens(): TokenUsage {
    return this.tokens;
  }
}
