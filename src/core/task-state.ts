import type { ErrorSeverity, TaskState, TaskStatus } from './runner/types';

export type {
  TaskBaselines,
  TaskState,
  TaskStatus,
} from './runner/types';

export function createTaskState(
  request: string,
  maxEditPasses = 3,
  rollbackOnFailed = true,
  taskId?: string,
): TaskState {
  const now = new Date().toISOString();
  return {
    id:
      taskId ??
      `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    request,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    maxEditPasses,
    editPass: 0,
    rollbackOnFailed,
    errors: [],
    changedFiles: [],
    providerUsage: [],
  };
}

/**
 * Add an error to the task state.
 */
export function addTaskError(
  state: TaskState,
  message: string,
  code: string,
  severity: ErrorSeverity,
): void {
  state.errors.push({
    message,
    code,
    severity,
    state: state.status,
    timestamp: new Date().toISOString(),
  });
  state.updatedAt = new Date().toISOString();

  // Auto-transition for fatal errors
  if (
    severity === 'fatal' &&
    state.status !== 'failed' &&
    state.status !== 'failed_clean' &&
    state.status !== 'failed_dirty'
  ) {
    // Timing and status update
    state.status = 'failed';
    state.finishedAt = new Date().toISOString();
  }
}
