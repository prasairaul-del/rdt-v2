import { StateTransitionError } from '../errors';
import { globalEventBus } from '../events';
import type { TaskLogger } from '../logger';
import { type TaskState, type TaskStatus, addTaskError } from '../task-state';

/** Transitions that are valid from each state. */
export const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created: ['capturing_baseline', 'failed'],
  capturing_baseline: ['loading_context', 'failed'],
  loading_context: ['scanning_repo', 'failed'],
  scanning_repo: ['selecting_files', 'failed'],
  selecting_files: ['planning', 'failed'],
  planning: ['editing', 'failed'],
  editing: ['reviewing', 'failed'],
  reviewing: ['fixing', 'finalizing', 'failed'],
  fixing: ['editing', 'failed'],
  finalizing: ['done', 'failed'],
  done: [],
  failed: ['rolling_back', 'failed_clean', 'failed_dirty'],
  rolling_back: ['failed_clean', 'failed_dirty'],
  failed_clean: [],
  failed_dirty: [],
};

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
  async executeStep<T>(
    targetState: TaskStatus,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.checkCancellation?.()) {
      throw new Error('Task was cancelled by user');
    }

    const from = this.state.status;

    // Explicitly transition to target state
    this.transition(targetState);

    this.logger.info(`Step: ${targetState}`);

    try {
      const result = await fn();

      globalEventBus.emitProgress(
        this.state.id,
        targetState,
        this.state.editPass / this.state.maxEditPasses,
      );

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof Error && 'code' in err && typeof err.code === 'string'
          ? err.code
          : 'STEP_ERROR';

      addTaskError(this.state, message, code, 'fatal');
      throw err; // Re-throw to be caught by runner
    }
  }

  /**
   * Transition the state machine to a new state.
   * Throws if the transition is not valid.
   */
  transition(to: TaskStatus): void {
    const from = this.state.status;

    const allowed = TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new StateTransitionError(from, to, allowed);
    }

    // Track timing
    if (
      to === 'failed' ||
      to === 'failed_clean' ||
      to === 'failed_dirty' ||
      to === 'done'
    ) {
      this.state.finishedAt = new Date().toISOString();
    }

    this.state.status = to;
    this.state.updatedAt = new Date().toISOString();

    globalEventBus.emitStateChange(this.state.id, from, to);
  }

  /**
   * Record an error without necessarily failing the task.
   */
  addError(
    message: string,
    code: string,
    severity: 'fatal' | 'recoverable' | 'warning' = 'recoverable',
  ): void {
    addTaskError(this.state, message, code, severity);

    if (severity === 'fatal' && this.state.status === 'failed') {
      this.logger.error(
        `Fatal error in state ${this.state.status}: ${message}`,
      );
    }
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
