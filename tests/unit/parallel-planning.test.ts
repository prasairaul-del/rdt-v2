import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRegistry } from '../../src/agents/agent-registry';
import { TaskRunner } from '../../src/core/task-runner';
import { Sandbox } from '../../src/tools/sandbox';
import { testRunnerTool } from '../../src/tools/test-runner';

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

// Mock Log Store
vi.mock('../../src/storage/task-log-store', () => {
  return {
    TaskLogStore: class MockTaskLogStore {
      createLog() {}
      updateLog() {}
    },
  };
});

describe('Parallel Path Planning Trials', () => {
  const TEST_ROOT = resolve(tmpdir(), 'rdt-parallel-test');
  let runner: TaskRunner;

  beforeEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
    mkdirSync(TEST_ROOT, { recursive: true });

    runner = new TaskRunner({
      projectRoot: TEST_ROOT,
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

    vi.clearAllMocks();
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
  });

  it('should select Trial 2 when Trial 2 tests pass and Trial 1 fails', async () => {
    // 1. Mock Editor Agent execute to simulate different results for Trial 1 vs Trial 2
    const editorMock = {
      execute: vi
        .fn()
        .mockImplementationOnce(async () => {
          mkdirSync('src', { recursive: true });
          writeFileSync(join('src', 'file.ts'), 'content1');
          return {
            success: true,
            result: {
              changedFiles: ['src/file.ts'],
              diff: 'diff1',
              needsReview: true,
              summary: 'edit1',
            },
          };
        }) // Trial 1
        .mockImplementationOnce(async () => {
          mkdirSync('src', { recursive: true });
          writeFileSync(join('src', 'file.ts'), 'content2');
          return {
            success: true,
            result: {
              changedFiles: ['src/file.ts'],
              diff: 'diff2',
              needsReview: true,
              summary: 'edit2',
            },
          };
        }), // Trial 2
    };

    vi.spyOn(agentRegistry, 'get').mockImplementation((name) => {
      if (name === 'editor') return editorMock as any;
      return null;
    });

    // 2. Mock testRunnerTool to return FAILED for Trial 1 and PASSED for Trial 2
    vi.spyOn(testRunnerTool, 'execute')
      .mockResolvedValueOnce({
        success: true,
        data: {
          command: 'test',
          stdout: '',
          stderr: '',
          exitCode: 1,
          passed: false,
        },
      }) // Trial 1 Test fails
      .mockResolvedValueOnce({
        success: true,
        data: {
          command: 'test',
          stdout: '',
          stderr: '',
          exitCode: 0,
          passed: true,
        },
      }); // Trial 2 Test passes

    // 3. Setup mock state
    const state: any = {
      id: 'task-parallel',
      request: 'fix',
      status: 'editing',
      errors: [],
      changedFiles: [],
      maxEditPasses: 1,
      editPass: 0,
      baselines: { rdtTouchedFiles: [] },
      plan: { steps: [] },
    };

    // Mock Sandbox to capture creations
    const sandbox1Path = resolve(tmpdir(), 'rdt-sandbox-task-parallel-trial-1');
    const sandbox2Path = resolve(tmpdir(), 'rdt-sandbox-task-parallel-trial-2');
    const mainSandboxPath = resolve(tmpdir(), 'rdt-sandbox-task-parallel-main');

    if (existsSync(sandbox1Path))
      rmSync(sandbox1Path, { recursive: true, force: true });
    if (existsSync(sandbox2Path))
      rmSync(sandbox2Path, { recursive: true, force: true });
    if (existsSync(mainSandboxPath))
      rmSync(mainSandboxPath, { recursive: true, force: true });

    mkdirSync(sandbox1Path, { recursive: true });
    mkdirSync(sandbox2Path, { recursive: true });
    mkdirSync(mainSandboxPath, { recursive: true });

    // Write file in sandbox 1 and 2
    mkdirSync(join(sandbox1Path, 'src'), { recursive: true });
    mkdirSync(join(sandbox2Path, 'src'), { recursive: true });
    writeFileSync(join(sandbox1Path, 'src', 'file.ts'), 'content1');
    writeFileSync(join(sandbox2Path, 'src', 'file.ts'), 'content2');

    const originalCwd = process.cwd();
    process.chdir(mainSandboxPath);

    try {
      // Execute editFiles
      await (runner as any).editFiles(state);

      // Verify that content from Trial 2 sandbox was copied to main sandbox Cwd
      const mainFile = join(mainSandboxPath, 'src', 'file.ts');
      expect(existsSync(mainFile)).toBe(true);
      expect(readFileSync(mainFile, 'utf-8')).toBe('content2'); // Selected Trial 2!

      // Verify task state changes
      expect(state.changedFiles).toContain('src/file.ts');
    } finally {
      process.chdir(originalCwd);
      rmSync(sandbox1Path, { recursive: true, force: true });
      rmSync(sandbox2Path, { recursive: true, force: true });
      rmSync(mainSandboxPath, { recursive: true, force: true });
    }
  });
});
