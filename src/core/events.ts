import type { TaskStatus } from './task-state';

/**
 * Typed event system for task lifecycle events.
 * Allows listeners to react to state changes and errors.
 */

export type TaskEventType =
  | 'task:created'
  | 'task:started'
  | 'task:state_change'
  | 'task:error'
  | 'task:progress'
  | 'task:completed'
  | 'task:failed'
  | 'task:log';

export interface TaskEvent {
  type: TaskEventType;
  taskId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type TaskEventListener = (event: TaskEvent) => void;

export class TaskEventBus {
  private listeners = new Map<TaskEventType, Set<TaskEventListener>>();
  private globalListeners = new Set<TaskEventListener>();

  on(type: TaskEventType, listener: TaskEventListener): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  onAny(listener: TaskEventListener): () => void {
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  emit(
    type: TaskEventType,
    taskId: string,
    data?: Record<string, unknown>,
  ): void {
    const event: TaskEvent = {
      type,
      taskId,
      timestamp: new Date().toISOString(),
      data,
    };

    // Notify type-specific listeners
    this.listeners.get(type)?.forEach((fn) => {
      try {
        fn(event);
      } catch {
        /* swallow */
      }
    });

    // Notify global listeners
    this.globalListeners.forEach((fn) => {
      try {
        fn(event);
      } catch {
        /* swallow */
      }
    });
  }

  emitStateChange(taskId: string, from: TaskStatus, to: TaskStatus): void {
    this.emit('task:state_change', taskId, { from, to });
  }

  emitError(taskId: string, message: string, code: string): void {
    this.emit('task:error', taskId, { message, code });
  }

  emitProgress(taskId: string, step: string, progress: number): void {
    this.emit('task:progress', taskId, { step, progress });
  }

  clear(): void {
    this.listeners.clear();
    this.globalListeners.clear();
  }
}

export const globalEventBus = new TaskEventBus();
