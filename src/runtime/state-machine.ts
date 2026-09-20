export type TaskState =
  | 'PENDING'
  | 'PLANNING'
  | 'RUNNING'
  | 'SUSPENDED_APPROVAL'
  | 'SUSPENDED_INPUT'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  PENDING: ['PLANNING', 'RUNNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['RUNNING', 'FAILED', 'CANCELLED', 'SUSPENDED_INPUT'],
  RUNNING: [
    'RUNNING', // self-transition allowed during multi-turn milestone transitions
    'SUSPENDED_APPROVAL',
    'SUSPENDED_INPUT',
    'PAUSED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ],
  SUSPENDED_APPROVAL: ['RUNNING', 'FAILED', 'CANCELLED'],
  SUSPENDED_INPUT: ['RUNNING', 'FAILED', 'CANCELLED'],
  PAUSED: ['RUNNING', 'CANCELLED', 'PLANNING'],
  COMPLETED: ['PLANNING', 'RUNNING', 'PENDING'],
  FAILED: ['PLANNING', 'RUNNING', 'PENDING'], // allowed when user triggers retry or new prompt
  CANCELLED: ['PLANNING', 'RUNNING', 'PENDING'],
};

export class TaskStateMachine {
  private currentState: TaskState;

  constructor(initialState: TaskState = 'PENDING') {
    this.currentState = initialState;
  }

  public getState(): TaskState {
    return this.currentState;
  }

  public canTransitionTo(target: TaskState): boolean {
    const allowed = VALID_TRANSITIONS[this.currentState] || [];
    return allowed.includes(target);
  }

  public transitionTo(target: TaskState): void {
    if (!this.canTransitionTo(target)) {
      throw new Error(`Invalid state transition from '${this.currentState}' to '${target}'`);
    }
    this.currentState = target;
  }
}
