import { execSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../../src/core/task-runner';

import { baselineStep } from '../../src/core/runner/steps/baseline-step';
import { contextStep } from '../../src/core/runner/steps/context-step';
import { scanStep } from '../../src/core/runner/steps/scan-step';
import { pickStep } from '../../src/core/runner/steps/pick-step';
import { planStep } from '../../src/core/runner/steps/plan-step';
import { editStep } from '../../src/core/runner/steps/edit-step';
import { reviewStep } from '../../src/core/runner/steps/review-step';
import { finalizeStep } from '../../src/core/runner/steps/finalize-step';

// Mock node:child_process
vi.mock('node:child_process', () => {
  const execMock = vi.fn((cmd: string) => {
    if (cmd.includes('git rev-parse HEAD')) return 'mock-commit-hash';
    if (cmd.includes('git rev-parse --abbrev-ref HEAD')) return 'main-branch';
    return '';
  });
  const spawnMock = vi.fn(() => ({ status: 0 }));
  return {
    execSync: execMock,
    spawnSync: spawnMock,
  };
});

// Mock bun:sqlite
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {
    exec() {}
    run() {}
    query() {
      return { get: () => null, all: () => [] };
    }
    close() {}
  },
}));

// Mock TaskRunner dependency imports to avoid executing real agents
vi.mock('../../src/storage/task-log-store', () => {
  return {
    TaskLogStore: class MockTaskLogStore {
      createLog() {}
      updateLog() {}
    },
  };
});

vi.mock('../../src/config/load-config', () => {
  return {
    loadConfig: () => ({
      config: {
        version: 1,
        project: { name: 'test' },
        runtime: {
          git_feature_branch: true,
          git_auto_commit: true,
          require_git_repo: false,
        },
        agents: {},
      },
    }),
  };
});

// Mock modular runner steps
vi.mock('../../src/core/runner/steps/baseline-step', () => ({
  baselineStep: vi.fn().mockImplementation(async (context) => {
    context.state.baselines = {
      headHash: 'mock-commit-hash',
      dirtyFiles: [],
      rdtTouchedFiles: [],
    };
  }),
}));
vi.mock('../../src/core/runner/steps/context-step', () => ({
  contextStep: vi.fn().mockImplementation(async (context) => {
    await context.executionContext.load();
    if (context.executionContext.config) {
      context.config.rdtConfig = context.executionContext.config;
    }
  }),
}));
vi.mock('../../src/core/runner/steps/scan-step', () => ({
  scanStep: vi.fn(),
}));
vi.mock('../../src/core/runner/steps/pick-step', () => ({
  pickStep: vi.fn(),
}));
vi.mock('../../src/core/runner/steps/plan-step', () => ({
  planStep: vi.fn().mockImplementation(async (context) => {
    context.state.plan = { steps: [] };
  }),
}));
vi.mock('../../src/core/runner/steps/edit-step', () => ({
  editStep: vi.fn().mockImplementation(async (context) => {
    context.state.changedFiles = ['src/index.ts'];
  }),
}));
vi.mock('../../src/core/runner/steps/review-step', () => ({
  reviewStep: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../src/core/runner/steps/finalize-step', () => ({
  finalizeStep: vi.fn(),
}));

describe('Git Feature Branch Workflow', () => {
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set default mock implementations
    vi.mocked(baselineStep).mockImplementation(async (context) => {
      context.state.baselines = {
        headHash: 'mock-commit-hash',
        dirtyFiles: [],
        rdtTouchedFiles: [],
      };
    });
    vi.mocked(editStep).mockImplementation(async (context) => {
      context.state.changedFiles = ['src/index.ts'];
    });
    vi.mocked(reviewStep).mockResolvedValue(true);

    runner = new TaskRunner({
      projectRoot: '/mock/project',
      rdtConfig: {
        version: 1,
        project: {
          name: 'test',
          language: 'typescript',
          package_manager: 'bun',
          test_command: 'bun test',
          lint_command: '',
        },
        runtime: {
          max_agent_steps: 10,
          max_edit_passes: 1,
          require_git_repo: false,
          allow_shell_commands: true,
          allow_destructive_commands: false,
          rollback_on_failed_task: true,
          preserve_user_changes: true,
          git_feature_branch: true,
          git_auto_commit: true,
        },
        context_budget: {
          default_max_input_tokens: 1000,
          reserved_output_tokens: 100,
          repo_map_max_tokens: 100,
          file_picker_max_tokens: 100,
          planner_max_tokens: 100,
          editor_max_tokens: 100,
          reviewer_max_tokens: 100,
          max_file_read_tokens: 100,
          max_total_file_tokens_per_step: 100,
          truncation_strategy: 'summarize',
          never_truncate: [],
        },
        providers: [],
        model_policies: {},
        agents: {},
      },
    });
  });

  it('should checkout feature branch on run, commit, and checkout back to original branch on success', async () => {
    const result = await runner.run('create feature');
    expect(result.success).toBe(true);

    // Verify original branch was detected
    expect(execSync).toHaveBeenCalledWith(
      'git rev-parse --abbrev-ref HEAD',
      expect.any(Object),
    );

    // Verify feature branch was checked out
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('git checkout -b "rdt/task-'),
      expect.any(Object),
    );

    // Verify files were staged and committed
    expect(spawnSync).toHaveBeenCalledWith(
      'git',
      ['add', 'src/index.ts'],
      expect.any(Object),
    );
    expect(spawnSync).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', expect.stringContaining('create feature')],
      expect.any(Object),
    );

    // Verify original branch was checked out back
    expect(execSync).toHaveBeenCalledWith(
      'git checkout "main-branch"',
      expect.any(Object),
    );
  });

  it('should checkout original branch and delete temporary feature branch on run failure', async () => {
    // Force editFiles to throw an error, causing a run failure
    vi.mocked(editStep).mockRejectedValueOnce(new Error('Editor crashed'));

    const result = await runner.run('failing task');
    expect(result.success).toBe(false);

    // Verify original branch was checked out back on failure
    expect(execSync).toHaveBeenCalledWith(
      'git checkout -f "main-branch"',
      expect.any(Object),
    );

    // Verify temporary feature branch was deleted on failure
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('git branch -D "rdt/task-'),
      expect.any(Object),
    );
  });
});
