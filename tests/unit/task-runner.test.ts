import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../../src/core/task-runner';
import {
  addTaskError,
  createTaskState,
  transitionState,
} from '../../src/core/task-state';
import type { TaskState } from '../../src/core/task-state';

// Mock bun:sqlite since vitest can't resolve Bun built-in modules.
// The TaskRunner creates a TaskLogStore which depends on bun:sqlite.
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {
    exec(_sql: string) {}
    run(_sql: string, ..._params: unknown[]) {}
    query(_sql: string) {
      return { get: () => null, all: () => [] };
    }
    close() {}
  },
}));

// Mock git-diff and test-runner tools to prevent recursive test execution.
// The reviewer agent calls testRunnerTool.execute({}) which runs `bun run test`
// recursively, creating an infinite loop. Similarly, git-diff is called by
// the editor and reviewer agents during the state machine run.
vi.mock('../../src/tools/git-diff', () => ({
  gitDiffTool: {
    name: 'git_diff',
    description: 'Mocked git diff',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      success: true,
      data: { diff: '', filesChanged: 0, hasChanges: false },
    }),
  },
}));

vi.mock('../../src/tools/test-runner', () => ({
  testRunnerTool: {
    name: 'test_runner',
    description: 'Mocked test runner',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      success: true,
      data: {
        command: 'echo mocked',
        stdout: 'Tests passed',
        stderr: '',
        exitCode: 0,
        passed: true,
      },
    }),
  },
}));

const TEST_DIR = resolve(process.cwd(), 'tmp-test-runner');

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'test.txt'), 'Hello, RDT v2!\n');
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// ── Task Runner ──────────────────────────────────────────────────

describe('TaskRunner', () => {
  it('should create a runner with project root', () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    expect(runner).toBeDefined();
  });

  it('should run a task to completion', async () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    const result = await runner.run('say hello');

    // Should complete with some status
    expect(result.taskId).toBeTruthy();
    expect(result.state).toBeDefined();
    expect(result.summary).toBeTruthy();
  });

  it('should return a result with state information', async () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    const result = await runner.run('test task');

    expect(result.state.status).toBeDefined();
    expect(result.state.createdAt).toBeDefined();
    expect(result.state.updatedAt).toBeDefined();
  });

  it('should track provider usage', async () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    const result = await runner.run('check provider tracking');

    expect(result.providerSummary).toBeTruthy();
  });

  it('should handle empty requests gracefully', async () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    const result = await runner.run('');

    // Should not crash
    expect(result.taskId).toBeTruthy();
  });
});

// ── State Machine Integration ────────────────────────────────────

describe('State machine integration', () => {
  it('should transition through expected states for a successful run', async () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    const result = await runner.run('simple task');

    // For a non-git project, should still complete
    const state = result.state;
    // Should have progressed through multiple states
    expect(state.errors).toBeDefined();
  });

  it('should handle nonexistent project root gracefully', async () => {
    const runner = new TaskRunner({
      projectRoot: '/nonexistent/path/xyz_123',
    });
    const result = await runner.run('task in wrong dir');

    // Should handle gracefully — all I/O functions catch errors internally
    // so the task completes without crashing
    expect(result.taskId).toBeTruthy();
    expect(result.state.status).toBe('done');
  });

  it('should build proper TaskResult on success', async () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
    });
    const result = await runner.run('verify result structure');

    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('taskId');
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('diff');
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('providerSummary');
  });
});

// ── createTaskState ──────────────────────────────────────────────

describe('createTaskState utility', () => {
  it('should create state with default values', () => {
    const state = createTaskState('test request');
    expect(state.id).toBeTruthy();
    expect(state.request).toBe('test request');
    expect(state.status).toBe('created');
    expect(state.editPass).toBe(0);
    expect(state.maxEditPasses).toBe(3);
    expect(state.rollbackOnFailed).toBe(true);
    expect(state.errors).toHaveLength(0);
    expect(state.changedFiles).toHaveLength(0);
    expect(state.providerUsage).toHaveLength(0);
  });

  it('should create state with custom config', () => {
    const state = createTaskState('test', 5, false);
    expect(state.maxEditPasses).toBe(5);
    expect(state.rollbackOnFailed).toBe(false);
  });

  it('should generate unique IDs', () => {
    const ids = new Set(
      Array.from({ length: 100 }, () => createTaskState('test').id),
    );
    expect(ids.size).toBe(100);
  });
});

// ── transitionState ──────────────────────────────────────────────

describe('transitionState', () => {
  it('should follow the happy path: created -> ... -> done', () => {
    const state = createTaskState('test');
    const path: Array<{ from: string; to: string }> = [];

    const steps: string[] = [
      'capturing_baseline',
      'loading_context',
      'scanning_repo',
      'selecting_files',
      'planning',
      'editing',
      'reviewing',
      'finalizing',
      'done',
    ];

    for (const step of steps) {
      const from = state.status;
      transitionState(state, step as any);
      path.push({ from, to: state.status });
    }

    expect(state.status).toBe('done');
    expect(path).toHaveLength(9);
    expect(path[0].from).toBe('created');
    expect(path[0].to).toBe('capturing_baseline');
  });

  it('should support the edit-review-fix loop', () => {
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
    // fixing -> editing (second pass)
    transitionState(state, 'editing');
    expect(state.editPass).toBe(0); // editPass only incremented by runner
  });

  it('should support the failure path: failed -> rolling_back -> failed_clean', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    addTaskError(state, 'fatal', 'FATAL', 'fatal');
    expect(state.status).toBe('failed');
    transitionState(state, 'rolling_back');
    transitionState(state, 'failed_clean');
    expect(state.status).toBe('failed_clean');
  });

  it('should support failed_dirty state', () => {
    const state = createTaskState('test');
    transitionState(state, 'capturing_baseline');
    addTaskError(state, 'fatal error', 'FATAL', 'fatal');
    transitionState(state, 'rolling_back');
    transitionState(state, 'failed_dirty');
    expect(state.status).toBe('failed_dirty');
  });

  it('should reject invalid transitions', () => {
    const state = createTaskState('test');
    // created -> selecting_files is invalid
    expect(() => transitionState(state, 'selecting_files')).toThrow();
    // created -> done is invalid
    expect(() => transitionState(state, 'done')).toThrow();
  });

  it('should update updatedAt on each transition', async () => {
    const state = createTaskState('test');
    const firstUpdate = state.updatedAt;
    // Ensure at least 25ms passes so timestamps differ on Windows
    await new Promise((r) => setTimeout(r, 25));
    transitionState(state, 'capturing_baseline');
    expect(state.updatedAt).not.toBe(firstUpdate);
  });
});
