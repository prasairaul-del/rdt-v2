import { globalEventBus } from '../events';
import { TaskLogger } from '../logger';
import {
  type TaskState,
  type TaskStatus,
  addTaskError,
  transitionState,
} from '../task-state';

/**
 * StateMachine handles task state transitions, events, and step execution.
 */
export class StateMachine {
  constructor(
    private state: TaskState,
    private logger: TaskLogger,
    private checkCancellation?: () => boolean,
  ) {}

  /**
   * Execute a task step with state transition and event emission.
   */
  async executeStep(
    targetState: TaskStatus,
    fn: () => Promise<void>,
  ): Promise<void> {
    if (this.checkCancellation?.()) {
      throw new Error('Task was cancelled by user');
    }

    const from = this.state.status;
    
    // Explicitly transition to target state
    transitionState(this.state, targetState);
    
    this.logger.info(`Step: ${targetState}`);
    globalEventBus.emitStateChange(this.state.id, from, targetState);

    try {
      await fn();
      
      globalEventBus.emitProgress(
        this.state.id,
        targetState,
        this.state.editPass / this.state.maxEditPasses,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof Error && 'code' in err
          ? (err as any).code
          : 'STEP_ERROR';
      
      addTaskError(this.state, message, code, 'fatal');
      throw err; // Re-throw to be caught by runner
    }
  }

  /**
   * Manually transition to a new state.
   */
  transition(to: TaskStatus): void {
    const from = this.state.status;
    transitionState(this.state, to);
    globalEventBus.emitStateChange(this.state.id, from, to);
  }

  /**
   * Record an error without necessarily failing the task.
   */
  addError(message: string, code: string, severity: 'fatal' | 'recoverable' | 'warning' = 'recoverable'): void {
    addTaskError(this.state, message, code, severity);
  }

  /**
   * Get the current task state.
   */
  getState(): TaskState {
    return this.state;
  }

  /**
   * Get the current status.
   */
  get status(): TaskStatus {
    return this.state.status;
  }
}
