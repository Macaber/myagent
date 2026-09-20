import { AgentDatabase } from '../persistence/db.js';
import { EventStore } from '../persistence/event-store.js';
import { TelemetryStore, TurnType, ThreadMetricsReport } from '../persistence/telemetry-store.js';
import { Blackboard } from '../context/blackboard.js';
import { WorkspaceJail } from '../security/workspace-jail.js';
import { RpcDispatcher } from '../protocol/rpc-dispatcher.js';
import { ExecutionPlan } from '../engine/dag.js';
import { TurnContext } from './turn-context.js';

export interface ThreadContextConfig {
  threadId: string;
  sessionId: string;
  parentThreadId?: string;
  prompt: string;
  workspacePath: string;
}

export class ThreadContext {
  public readonly threadId: string;
  public readonly sessionId: string;
  public readonly parentThreadId?: string;
  public prompt: string;
  public readonly workspaceJail: WorkspaceJail;
  public readonly blackboard: Blackboard;
  public readonly telemetryStore: TelemetryStore;
  public readonly eventStore: EventStore;

  private turnCounter = 0;
  private currentTurn?: TurnContext;
  private executionPlan?: ExecutionPlan;
  private currentState = 'PENDING';

  constructor(
    config: ThreadContextConfig,
    private readonly db: AgentDatabase,
    public readonly dispatcher?: RpcDispatcher
  ) {
    this.threadId = config.threadId;
    this.sessionId = config.sessionId;
    this.parentThreadId = config.parentThreadId;
    this.prompt = config.prompt;
    this.workspaceJail = new WorkspaceJail(config.workspacePath);
    this.blackboard = new Blackboard(this.threadId, this.db);
    this.telemetryStore = new TelemetryStore(this.db);
    this.eventStore = new EventStore(this.db);
    this.turnCounter = this.telemetryStore.getTurnCount(this.threadId);

    // 1. Record thread start
    this.telemetryStore.recordThreadStart({
      threadId: this.threadId,
      sessionId: this.sessionId,
      parentThreadId: this.parentThreadId,
      prompt: this.prompt,
      workspacePath: config.workspacePath,
    });

    // 2. Append event
    this.eventStore.appendEvent({
      threadId: this.threadId,
      eventType: 'THREAD_STARTED',
      payload: { prompt: this.prompt, workspacePath: config.workspacePath },
      createdAt: Date.now(),
    });

    // 3. Emit ACP (canonical session/update and task/event)
    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'state_changed',
      timestamp: Date.now(),
      data: { prompt: this.prompt, state: 'PENDING' },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      type: 'THREAD_STARTED',
      timestamp: Date.now(),
      data: { prompt: this.prompt },
    });
  }

  public setState(newState: string): void {
    this.currentState = newState;
    this.telemetryStore.updateThreadState(this.threadId, newState, this.currentTurn?.turnId);

    this.eventStore.appendEvent({
      threadId: this.threadId,
      turnId: this.currentTurn?.turnId,
      eventType: 'THREAD_STATE_CHANGED',
      payload: { newState },
      createdAt: Date.now(),
    });

    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'state_changed',
      timestamp: Date.now(),
      data: { turnId: this.currentTurn?.turnId, state: newState },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      turnId: this.currentTurn?.turnId,
      type: 'THREAD_STATE_CHANGED',
      timestamp: Date.now(),
      data: { state: newState },
    });
  }

  public getState(): string {
    return this.currentState;
  }

  public createTurn(turnType: TurnType, milestoneId?: string): TurnContext {
    const turnId = `${this.threadId}_turn_${this.turnCounter++}`;
    this.currentTurn = new TurnContext(
      {
        turnId,
        threadId: this.threadId,
        turnIndex: this.turnCounter - 1,
        turnType,
        milestoneId,
      },
      this.telemetryStore,
      this.eventStore,
      this.dispatcher
    );
    this.telemetryStore.updateThreadState(this.threadId, this.currentState, turnId);
    return this.currentTurn;
  }

  public getCurrentTurn(): TurnContext | undefined {
    return this.currentTurn;
  }

  public setPrompt(prompt: string): void {
    this.prompt = prompt;
    this.executionPlan = undefined;
    this.blackboard.delete('__execution_plan__');
    this.setState('PENDING');
  }

  public setExecutionPlan(plan?: ExecutionPlan): void {
    this.executionPlan = plan;
    if (plan) {
      this.blackboard.set('__execution_plan__', plan.toJSON());

      this.eventStore.appendEvent({
        threadId: this.threadId,
        turnId: this.currentTurn?.turnId,
        eventType: 'PLAN_GENERATED',
        payload: plan.toJSON(),
        createdAt: Date.now(),
      });

      const entries = plan.getMilestones().map((m) => ({
        content: m.title + (m.description ? `: ${m.description}` : ''),
        priority: 'medium' as const,
        status:
          m.status === 'SUCCESS'
            ? ('completed' as const)
            : m.status === 'RUNNING'
            ? ('in_progress' as const)
            : ('pending' as const),
      }));

      this.dispatcher?.emitSessionUpdate({
        sessionId: this.threadId,
        updateType: 'plan_generated',
        sessionUpdate: 'plan',
        update: {
          sessionUpdate: 'plan',
          entries,
        },
        timestamp: Date.now(),
        data: plan.toJSON(),
      });
      this.dispatcher?.emitTaskEvent({
        threadId: this.threadId,
        turnId: this.currentTurn?.turnId,
        type: 'PLAN_GENERATED',
        timestamp: Date.now(),
        data: plan.toJSON(),
      });
    } else {
      this.blackboard.delete('__execution_plan__');
    }
  }

  public getExecutionPlan(): ExecutionPlan | undefined {
    if (this.executionPlan) return this.executionPlan;
    const raw = this.blackboard.get<{ goal: string; milestones: any[] }>('__execution_plan__');
    if (raw) {
      this.executionPlan = ExecutionPlan.fromJSON(raw);
      return this.executionPlan;
    }
    return undefined;
  }

  public complete(summary?: string): ThreadMetricsReport {
    this.setState('COMPLETED');
    this.telemetryStore.recordThreadEnd(this.threadId, 'COMPLETED');

    const report = this.telemetryStore.getThreadMetrics(this.threadId);

    this.eventStore.appendEvent({
      threadId: this.threadId,
      eventType: 'THREAD_COMPLETED',
      payload: { summary, report },
      createdAt: Date.now(),
    });

    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'state_changed',
      timestamp: Date.now(),
      data: { state: 'COMPLETED', summary, report },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      type: 'THREAD_COMPLETED',
      timestamp: Date.now(),
      data: { summary, report },
    });

    return report;
  }

  public fail(errorMessage: string): ThreadMetricsReport {
    this.setState('FAILED');
    this.telemetryStore.recordThreadEnd(this.threadId, 'FAILED', errorMessage);

    const report = this.telemetryStore.getThreadMetrics(this.threadId);

    this.eventStore.appendEvent({
      threadId: this.threadId,
      eventType: 'THREAD_FAILED',
      payload: { error: errorMessage, report },
      createdAt: Date.now(),
    });

    this.dispatcher?.emitSessionUpdate({
      sessionId: this.threadId,
      updateType: 'state_changed',
      timestamp: Date.now(),
      data: { state: 'FAILED', error: errorMessage, report },
    });
    this.dispatcher?.emitTaskEvent({
      threadId: this.threadId,
      type: 'THREAD_FAILED',
      timestamp: Date.now(),
      data: { error: errorMessage, report },
    });

    return report;
  }
}

// Session conceptual aliases
export const SessionContext = ThreadContext;
export type SessionContext = ThreadContext;
export type SessionContextConfig = ThreadContextConfig;

