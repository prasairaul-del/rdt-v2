import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskRunner } from '../../src/core/task-runner';
import { execSync, spawnSync } from 'node:child_process';

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
    constructor() {}
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
    }
  };
});

vi.mock('../../src/config/load-config', () => {
  return {
    loadConfig: () => ({
      config: {
        version: 1,
        project: { name: 'test' },
        runtime: { git_feature_branch: true, git_auto_commit: true, require_git_repo: false },
        agents: {},
      }
    })
  };
});

describe('Git Feature Branch Workflow', () => {
  let runner: TaskRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new TaskRunner({
      projectRoot: '/mock/project',
      rdtConfig: {
        version: 1,
        project: { name: 'test', language: 'typescript', package_manager: 'bun', test_command: 'bun test', lint_command: '' },
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
          default_max_input_tokens: 1000, reserved_output_tokens: 100, repo_map_max_tokens: 100, file_picker_max_tokens: 100,
          planner_max_tokens: 100, editor_max_tokens: 100, reviewer_max_tokens: 100, max_file_read_tokens: 100, max_total_file_tokens_per_step: 100,
          truncation_strategy: 'summarize', never_truncate: [],
        },
        providers: [],
        model_policies: {},
        agents: {},
      },
    });

    // Mock internal methods of runner that require real agent executions
    (runner as any).captureBaseline = vi.fn().mockImplementation((state) => {
      state.baselines = { headHash: 'mock-commit-hash', dirtyFiles: [], rdtTouchedFiles: [] };
    });
    (runner as any).loadProjectContext = vi.fn();
    (runner as any).scanRepository = vi.fn();
    (runner as any).selectFiles = vi.fn();
    (runner as any).createPlan = vi.fn();
    (runner as any).editFiles = vi.fn().mockImplementation((state) => {
      state.changedFiles = ['src/index.ts'];
    });
    (runner as any).reviewChanges = vi.fn().mockResolvedValue(true);
    (runner as any).finalize = vi.fn();
  });

  it('should checkout feature branch on run, commit, and checkout back to original branch on success', async () => {
    const result = await runner.run('create feature');
    expect(result.success).toBe(true);

    // Verify original branch was detected
    expect(execSync).toHaveBeenCalledWith('git rev-parse --abbrev-ref HEAD', expect.any(Object));

    // Verify feature branch was checked out
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('git checkout -b "rdt/task-'), expect.any(Object));

    // Verify files were staged and committed
    expect(spawnSync).toHaveBeenCalledWith('git', ['add', 'src/index.ts'], expect.any(Object));
    expect(spawnSync).toHaveBeenCalledWith('git', ['commit', '-m', expect.stringContaining('rdt: create feature')], expect.any(Object));

    // Verify original branch was checked out back
    expect(execSync).toHaveBeenCalledWith('git checkout "main-branch"', expect.any(Object));
  });

  it('should checkout original branch and delete temporary feature branch on run failure', async () => {
    // Force editFiles to throw an error, causing a run failure
    (runner as any).editFiles = vi.fn().mockRejectedValue(new Error('Editor crashed'));

    const result = await runner.run('failing task');
    expect(result.success).toBe(false);

    // Verify original branch was checked out back on failure
    expect(execSync).toHaveBeenCalledWith('git checkout -f "main-branch"', expect.any(Object));

    // Verify temporary feature branch was deleted on failure
    expect(execSync).toHaveBeenCalledWith(expect.stringContaining('git branch -D "rdt/task-'), expect.any(Object));
  });
});
