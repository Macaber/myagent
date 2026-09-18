import { TelemetryStore, TurnType, StepType, TokenUsage } from '../persistence/telemetry-store.js';
import { EventStore } from '../persistence/event-store.js';
import { RpcDispatcher } from '../protocol/rpc-dispatcher.js';
import { StepContext } from './step-context.js';

export interface TurnContextConfig {
  turnId: string;
  threadId: string;
  turnIndex: number;
  turnType: TurnType;
  milestoneId?: string;
}

export class TurnContext {
  public readonly turnId: string;
  public readonly threadId: string;
  public readonly turnIndex: number;
  public readonly turnType: TurnType;
  public readonly milestoneId?: string;
  public readonly startedAt: number;

  private stepCounter = 0;
  private currentStep?: StepContext;
  private completed = false;
  private durationMs = 0;

  constructor(
    private readonly config: TurnContextConfig,
    private readonly telemetryStore: TelemetryStore,
    private readonly eventStore: EventStore,
    public readonly dispatcher?: RpcDispatcher
  ) {
    this.turnId = config.turnId;
    this.threadId = config.threadId;
    this.turnIndex = config.turnIndex;
    this.turnType = config.turnType;
    this.milestoneId = config.milestoneId;
    this.startedAt = Date.now();

    // 1. Record Turn Start in Telemetry
    this.telemetryStore.recordTurnStart({
      turnId: this.turnId,
      threadId: this.threadId,
      turnIndex: this.turnIndex,
      turnType: this.turnType,
      milestoneId: this.milestoneId,
    });

    // 2. Append event to EventStore
    this.eventStore.appendEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      eventType: 'TURN_STARTED',
      payload: {
        turnIndex: this.turnIndex,
        turnType: this.turnType,
        milestoneId: this.milestoneId,
      },
      createdAt: this.startedAt,
    });

    // 3. Emit ACP notification (canonical session/update and task/event)
    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'turn_started',
      timestamp: this.startedAt,
      data: {
        turnId: this.turnId,
        turnIndex: this.turnIndex,
        turnType: this.turnType,
        milestoneId: this.milestoneId,
      },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      type: 'TURN_STARTED',
      timestamp: this.startedAt,
      data: {
        turnIndex: this.turnIndex,
        turnType: this.turnType,
        milestoneId: this.milestoneId,
      },
    });
  }

  public createStep(params: {
    stepType: StepType;
    toolName?: string;
    metadata?: Record<string, any>;
  }): StepContext {
    const stepId = `${this.turnId}_step_${this.stepCounter++}`;
    this.currentStep = new StepContext(
      {
        stepId,
        turnId: this.turnId,
        threadId: this.threadId,
        stepIndex: this.stepCounter - 1,
        stepType: params.stepType,
        toolName: params.toolName,
        metadata: params.metadata,
      },
      this.telemetryStore,
      this.eventStore,
      this.dispatcher
    );
    return this.currentStep;
  }

  public end(params: {
    status: 'COMPLETED' | 'FAILED' | 'SUSPENDED';
    summary?: string;
  }): void {
    if (this.completed) return;
    this.completed = true;

    const now = Date.now();
    this.durationMs = now - this.startedAt;

    // 1. Update TelemetryStore
    this.telemetryStore.recordTurnEnd({
      turnId: this.turnId,
      status: params.status,
      summary: params.summary,
    });

    // 2. Append EventStore
    this.eventStore.appendEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      eventType: 'TURN_FINISHED',
      payload: {
        status: params.status,
        durationMs: this.durationMs,
        summary: params.summary,
      },
      createdAt: now,
    });

    // 3. Emit ACP notification (canonical session/update and task/event)
    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'turn_finished',
      timestamp: now,
      data: {
        turnId: this.turnId,
        status: params.status,
        durationMs: this.durationMs,
        summary: params.summary,
      },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      turnId: this.turnId,
      type: 'TURN_FINISHED',
      timestamp: now,
      data: {
        status: params.status,
        durationMs: this.durationMs,
        summary: params.summary,
      },
    });
  }

  public getDurationMs(): number {
    return this.completed ? this.durationMs : Date.now() - this.startedAt;
  }
}
