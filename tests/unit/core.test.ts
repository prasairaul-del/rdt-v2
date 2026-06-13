import { describe, expect, it } from 'vitest';
import {
  AgentError,
  ProviderError,
  StateTransitionError,
  TaskError,
  ToolExecutionError,
} from '../../src/core/errors';
import {
  type TaskEvent,
  TaskEventBus,
  globalEventBus,
} from '../../src/core/events';
import { TaskLogger } from '../../src/core/logger';
import { StateMachine } from '../../src/core/runner/state-machine';
import {
  type TaskState,
  type TaskStatus,
  addTaskError,
  createTaskState,
} from '../../src/core/task-state';

function transitionState(state: TaskState, to: TaskStatus) {
  new StateMachine(state, new TaskLogger()).transition(to);
}

// ── Task State Machine ───────────────────────────────────────────

describe('TaskState', () => {
  it('should create a task with created status', () => {
    const state = createTaskState('fix the bug');
    expect(state.status).toBe('created');
    expect(state.id).toBeTruthy();
    expect(state.request).toBe('fix the bug');
    expect(state.editPass).toBe(0);
    expect(state.errors).toHaveLength(0);
    expect(state.changedFiles).toHaveLength(0);
  });

  it('should accept custom maxEditPasses', () => {
    const state = createTaskState('test', 5, false);
    expect(state.maxEditPasses).toBe(5);
    expect(state.rollbackOnFailed).toBe(false);
  });

  it('should generate unique task IDs', () => {
    const s1 = createTaskState('a');
    const s2 = createTaskState('b');
    expect(s1.id).not.toBe(s2.id);
  });

  it('should transition to valid states', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    expect(state.status).toBe('capturing_baseline');

    transitionState(state, 'loading_context');
    expect(state.status).toBe('loading_context');
  });

  it('should throw on invalid transition', () => {
    const state = createTaskState('test');
    // Can't go from created directly to editing
    expect(() => transitionState(state, 'editing')).toThrow(
      'Invalid state transition',
    );
  });

  it('should throw on transition from terminal state', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    transitionState(state, 'loading_context');
    transitionState(state, 'scanning_repo');
    transitionState(state, 'selecting_files');
    transitionState(state, 'planning');
    transitionState(state, 'editing');
    transitionState(state, 'reviewing');
    transitionState(state, 'finalizing');
    transitionState(state, 'done');
    expect(state.status).toBe('done');
    // Can't transition from 'done'
    expect(() => transitionState(state, 'failed')).toThrow(
      'Invalid state transition',
    );
  });

  it('should set finishedAt on done and failed states', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    transitionState(state, 'loading_context');
    transitionState(state, 'scanning_repo');
    transitionState(state, 'selecting_files');
    transitionState(state, 'planning');
    transitionState(state, 'editing');
    transitionState(state, 'reviewing');
    transitionState(state, 'finalizing');
    transitionState(state, 'done');
    expect(state.finishedAt).toBeDefined();
  });

  it('should set finishedAt on failed states', () => {
    const state = createTaskState('test');
    expect(state.finishedAt).toBeUndefined();
    addTaskError(state, 'fatal error', 'FATAL', 'fatal');
    expect(state.finishedAt).toBeDefined();
  });

  it('should allow editing -> done shortcut', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    transitionState(state, 'loading_context');
    transitionState(state, 'scanning_repo');
    transitionState(state, 'selecting_files');
    transitionState(state, 'planning');
    transitionState(state, 'editing');
    transitionState(state, 'done');
    expect(state.status).toBe('done');
  });

  it('should allow reviewing -> fixing loop', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    transitionState(state, 'loading_context');
    transitionState(state, 'scanning_repo');
    transitionState(state, 'selecting_files');
    transitionState(state, 'planning');
    transitionState(state, 'editing');
    transitionState(state, 'reviewing');
    transitionState(state, 'fixing');
    expect(state.status).toBe('fixing');
    // fixing -> editing
    transitionState(state, 'editing');
    expect(state.status).toBe('editing');
  });

  it('should auto-transition on fatal error', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');

    addTaskError(state, 'Something went wrong', 'TEST_ERROR', 'fatal');
    expect(state.status).toBe('failed');
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0].code).toBe('TEST_ERROR');
    expect(state.errors[0].severity).toBe('fatal');
  });

  it('should not auto-transition for recoverable errors', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');

    addTaskError(state, 'Recoverable issue', 'WARN', 'warning');
    expect(state.status).toBe('capturing_baseline');
  });

  it('should not auto-transition if already in terminal state', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    addTaskError(state, 'Fatal', 'FATAL', 'fatal');
    expect(state.status).toBe('failed');

    // Adding another error while already failed should keep it in failed
    const before = state.status;
    addTaskError(state, 'Another error', 'ANOTHER', 'fatal');
    expect(state.status).toBe(before);
  });

  it('should record timestamps on errors', () => {
    const state = createTaskState('test');
    addTaskError(state, 'Error', 'ERR', 'recoverable');
    expect(state.errors[0].timestamp).toBeDefined();
    expect(state.errors[0].state).toBe('created');
  });
});

// ── Task Event Bus ───────────────────────────────────────────────

describe('TaskEventBus', () => {
  it('should emit and receive events', () => {
    const bus = new TaskEventBus();
    let received: string | undefined;

    const unsub = bus.on('task:created', (event) => {
      received = event.taskId;
    });

    bus.emit('task:created', 'task-1', { request: 'test' });
    expect(received).toBe('task-1');
    unsub();
  });

  it('should support global listeners (onAny)', () => {
    const bus = new TaskEventBus();
    const events: string[] = [];

    const unsub = bus.onAny((event) => {
      events.push(event.type);
    });

    bus.emit('task:created', 't1');
    bus.emit('task:started', 't1');
    bus.emit('task:completed', 't1');
    expect(events).toEqual(['task:created', 'task:started', 'task:completed']);
    unsub();
  });

  it('should emit state change events', () => {
    const bus = new TaskEventBus();
    let received: Record<string, unknown> | undefined;

    bus.on('task:state_change', (event) => {
      received = event.data;
    });

    bus.emitStateChange('t1', 'created', 'capturing_baseline');
    expect(received).toBeDefined();
    expect(received?.from).toBe('created');
    expect(received?.to).toBe('capturing_baseline');
  });

  it('should emit error events', () => {
    const bus = new TaskEventBus();
    let received: Record<string, unknown> | undefined;

    bus.on('task:error', (event) => {
      received = event.data;
    });

    bus.emitError('t1', 'Something broke', 'ERR_CODE');
    expect(received?.message).toBe('Something broke');
    expect(received?.code).toBe('ERR_CODE');
  });

  it('should emit progress events', () => {
    const bus = new TaskEventBus();
    let received: Record<string, unknown> | undefined;

    bus.on('task:progress', (event) => {
      received = event.data;
    });

    bus.emitProgress('t1', 'editing', 0.5);
    expect(received?.step).toBe('editing');
    expect(received?.progress).toBe(0.5);
  });

  it('should not crash when listener throws', () => {
    const bus = new TaskEventBus();
    bus.on('task:created', () => {
      throw new Error('listener error');
    });

    // Should not throw
    expect(() => bus.emit('task:created', 't1')).not.toThrow();
  });

  it('should clear all listeners', () => {
    const bus = new TaskEventBus();
    let count = 0;
    bus.on('task:created', () => {
      count++;
    });
    bus.onAny(() => {
      count++;
    });

    bus.clear();
    bus.emit('task:created', 't1');
    expect(count).toBe(0);
  });

  it('should include timestamp in events', () => {
    const bus = new TaskEventBus();
    let event: TaskEvent | undefined;
    bus.on('task:created', (e) => {
      event = e;
    });
    bus.emit('task:created', 't1');
    expect(event?.timestamp).toBeDefined();
    expect(new Date(event?.timestamp ?? '').getTime()).not.toBeNaN();
  });
});

// ── Task Logger ──────────────────────────────────────────────────

describe('TaskLogger', () => {
  it('should log messages with correct level', () => {
    const logger = new TaskLogger();
    logger.info('test message');
    const entries = logger.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe('info');
    expect(entries[0].message).toBe('test message');
  });

  it('should include task ID when set', () => {
    const logger = new TaskLogger();
    logger.setTaskId('task-42');
    logger.info('hello');
    expect(logger.getEntries()[0].taskId).toBe('task-42');
  });

  it('should filter by min level', () => {
    const logger = new TaskLogger();
    logger.setMinLevel('error');
    logger.debug('should not appear');
    logger.info('should not appear either');
    logger.error('should appear');
    expect(logger.getEntries()).toHaveLength(1);
    expect(logger.getEntries()[0].level).toBe('error');
  });

  it('should store data with entries', () => {
    const logger = new TaskLogger();
    logger.info('with data', { key: 'value', count: 42 });
    expect(logger.getEntries()[0].data).toEqual({ key: 'value', count: 42 });
  });

  it('should format entries as text', () => {
    const logger = new TaskLogger();
    logger.info('line 1');
    logger.warn('line 2');
    const text = logger.formatAsText();
    expect(text).toContain('INFO');
    expect(text).toContain('WARN');
    expect(text).toContain('line 1');
    expect(text).toContain('line 2');
  });

  it('should get recent entries', () => {
    const logger = new TaskLogger();
    logger.info('first');
    logger.info('second');
    logger.info('third');
    const recent = logger.getRecentEntries(2);
    expect(recent).toHaveLength(2);
    expect(recent[0].message).toBe('second');
    expect(recent[1].message).toBe('third');
  });

  it('should filter error entries', () => {
    const logger = new TaskLogger();
    logger.info('info');
    logger.warn('warn');
    logger.error('error1');
    logger.error('error2');
    const errors = logger.getErrors();
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.level === 'error')).toBe(true);
  });

  it('should clear entries', () => {
    const logger = new TaskLogger();
    logger.info('something');
    expect(logger.getEntries()).toHaveLength(1);
    logger.clear();
    expect(logger.getEntries()).toHaveLength(0);
  });
});

// ── Error Classes ────────────────────────────────────────────────

describe('Error classes', () => {
  it('TaskError should have code and recoverable flag', () => {
    const err = new TaskError('Something went wrong', 'TEST_ERR', true, {
      detail: 'info',
    });
    expect(err.message).toBe('Something went wrong');
    expect(err.code).toBe('TEST_ERR');
    expect(err.recoverable).toBe(true);
    expect(err.details).toEqual({ detail: 'info' });
    expect(err.name).toBe('TaskError');
  });

  it('TaskError should default to non-recoverable', () => {
    const err = new TaskError('Fatal', 'FATAL');
    expect(err.recoverable).toBe(false);
    expect(err.details).toBeUndefined();
  });

  it('ProviderError should have code and retryable flag', () => {
    const err = new ProviderError(
      'Rate limited',
      'RATE_LIMITED',
      false,
      30_000,
    );
    expect(err.message).toBe('Rate limited');
    expect(err.code).toBe('RATE_LIMITED');
    expect(err.retryable).toBe(false);
    expect(err.cooldownMs).toBe(30_000);
    expect(err.name).toBe('ProviderError');
  });

  it('ProviderError should default retryable to false', () => {
    const err = new ProviderError('Server error', 'SERVER_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.cooldownMs).toBeUndefined();
  });

  it('ToolExecutionError should have tool name and suggestions', () => {
    const err = new ToolExecutionError(
      'read_file',
      'File not found',
      'NOT_FOUND',
      ['Check path'],
    );
    expect(err.toolName).toBe('read_file');
    expect(err.errorType).toBe('NOT_FOUND');
    expect(err.suggestions).toEqual(['Check path']);
    expect(err.name).toBe('ToolExecutionError');
  });

  it('ToolExecutionError should work without suggestions', () => {
    const err = new ToolExecutionError(
      'write_file',
      'Permission denied',
      'PERMISSION_DENIED',
    );
    expect(err.suggestions).toBeUndefined();
  });

  it('StateTransitionError should include from/to and allowed transitions', () => {
    const err = new StateTransitionError('created', 'editing', [
      'created',
      'failed',
    ]);
    expect(err.from).toBe('created');
    expect(err.to).toBe('editing');
    expect(err.allowedTransitions).toEqual(['created', 'failed']);
    expect(err.message).toContain('created -> editing');
  });

  it('AgentError should have agent name and code', () => {
    const err = new AgentError('planner', 'Failed to plan', 'PLANNER_ERROR', [
      { toolName: 'read_file', durationMs: 100 },
    ]);
    expect(err.agentName).toBe('planner');
    expect(err.code).toBe('PLANNER_ERROR');
    expect(err.toolCalls).toHaveLength(1);
    expect(err.toolCalls?.[0].toolName).toBe('read_file');
  });

  it('AgentError should work without tool calls', () => {
    const err = new AgentError('editor', 'Edit failed', 'EDITOR_ERROR');
    expect(err.toolCalls).toBeUndefined();
  });
});
