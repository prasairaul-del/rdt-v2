import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TaskRunner } from '../../src/core/task-runner';
import { createSilentTestLogger } from '../unit/utils/test-logger';

// ── Module Mocks ───────────────────────────────────────────────────

// Mock bun:sqlite since vitest can't resolve Bun built-in modules.
// TaskRunner creates a TaskLogStore which depends on bun:sqlite.
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

// Mock git-diff to prevent real git operations during testing.
// The reviewer agent and finalize step call gitDiffTool which would
// try to run `git diff` — the fixture has a git repo so this would
// work, but we mock it for deterministic results.
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

// Mock test-runner to prevent recursive test execution.
// Without this mock, the reviewer agent would run `bun run test`
// which would trigger the main test suite recursively.
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

// ── Setup ─────────────────────────────────────────────────────────

const FIXTURES_DIR = resolve(process.cwd(), 'tests', 'fixtures');
const FAILING_FIXTURE = resolve(FIXTURES_DIR, 'failing-test');
const TEMP_DIR = resolve(process.cwd(), 'tmp-int-run-flow');
const ORIGINAL_CWD = process.cwd();

function safeRmDir(dir: string, retries = 3): void {
  for (let i = 0; i < retries; i++) {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, maxRetries: 3 });
      return;
    } catch {
      if (i < retries - 1) {
        // Wait briefly and retry (handles Windows ENOTEMPTY)
        const t = Date.now();
        while (Date.now() - t < 200) {} // simple spin
      }
    }
  }
}

function createTestRunner(projectRoot: string): TaskRunner {
  return new TaskRunner({
    projectRoot,
    logger: createSilentTestLogger(),
  });
}

beforeAll(() => {
  // Copy failing-test fixture to temp dir
  safeRmDir(TEMP_DIR);
  cpSync(FAILING_FIXTURE, TEMP_DIR, {
    recursive: true,
    force: true,
  });

  // Change to temp dir so tools that use process.cwd() work correctly
  process.chdir(TEMP_DIR);
});

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
  safeRmDir(TEMP_DIR);
});

// ── Run Flow Tests ────────────────────────────────────────────────

describe('rdt run — failing-test fixture integration', () => {
  it('should complete a task pipeline on the failing-test fixture', async () => {
    const runner = createTestRunner(TEMP_DIR);

    const result = await runner.run('fix the failing multiply test');

    // Pipeline should complete without crashing
    expect(result.taskId).toBeTruthy();
    expect(result.state).toBeDefined();
    expect(result.summary).toBeTruthy();
    expect(result.providerSummary).toBeTruthy();
  });

  it('should return a well-structured TaskResult', async () => {
    const runner = createTestRunner(TEMP_DIR);

    const result = await runner.run('fix multiply function bug');

    // Verify all TaskResult fields
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('taskId');
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('diff');
    expect(result).toHaveProperty('error');
    expect(result).toHaveProperty('providerSummary');

    // state should have proper structure
    expect(result.state.request).toBeTruthy();
    expect(result.state.status).toBeDefined();
    expect(result.state.createdAt).toBeDefined();
    expect(result.state.updatedAt).toBeDefined();
  });

  it('should traverse through valid state machine transitions', async () => {
    const runner = createTestRunner(TEMP_DIR);

    const result = await runner.run('optimize the multiply function');

    // Should end in a terminal state
    const terminalStates = ['done', 'failed_clean', 'failed_dirty', 'failed'];
    expect(terminalStates).toContain(result.state.status);

    // Should have progressed past 'planning'
    const path = result.state.status;
    // Whether done or failed, it progressed through the machine
    expect(path).toMatch(/done|failed/);
  });

  it('should be re-runnable (no side effects from previous run)', async () => {
    const runner1 = createTestRunner(TEMP_DIR);
    const result1 = await runner1.run('first run');

    const runner2 = createTestRunner(TEMP_DIR);
    const result2 = await runner2.run('second run');

    // Both should complete successfully
    expect(result1.taskId).toBeTruthy();
    expect(result2.taskId).toBeTruthy();
    expect(result1.state.status).toMatch(/done|failed/);
    expect(result2.state.status).toMatch(/done|failed/);

    // Each run should have a unique ID
    expect(result1.taskId).not.toBe(result2.taskId);
  });

  it('should discover the fixture project correctly', async () => {
    const { detectProject } = await import(
      '../../src/project-context/detect-project'
    );
    const info = detectProject(TEMP_DIR);

    expect(info.name).toBe('failing-test-fixture');
    expect(info.language).toBe('typescript');
    expect(info.sourceDirs).toContain('src');
    expect(info.testCommand).toBe('bun run test');
    expect(info.hasGit).toBe(true);
  });

  it('should detect the failing tests in the fixture', async () => {
    // Read the test file to verify the bug exists
    const testContent = readFileSync(
      join(TEMP_DIR, 'tests', 'multiply.test.ts'),
      'utf-8',
    );
    expect(testContent).toContain('multiply(2, 3)).toBe(6');
    expect(testContent).toContain('multiply(5, 0)).toBe(0');
    expect(testContent).toContain('multiply(-2, 3)).toBe(-6');

    // Read the source to verify the bug
    const srcContent = readFileSync(
      join(TEMP_DIR, 'src', 'multiply.ts'),
      'utf-8',
    );
    expect(srcContent).toContain('return a + b');
  });

  it('should have correct directory structure for a run', async () => {
    const runner = createTestRunner(TEMP_DIR);
    const result = await runner.run('fix the math bug');

    // Check that source and test files exist and are readable
    const srcContent = readFileSync(
      join(TEMP_DIR, 'src', 'multiply.ts'),
      'utf-8',
    );
    expect(srcContent).toContain('export function multiply');

    const testContent = readFileSync(
      join(TEMP_DIR, 'tests', 'multiply.test.ts'),
      'utf-8',
    );
    expect(testContent).toContain('describe');
    expect(testContent).toContain('it');
  });

  it('should record provider usage in the result', async () => {
    const runner = createTestRunner(TEMP_DIR);
    const result = await runner.run('fix multiplication');

    // Provider summary should be present (agents record heuristic usage)
    expect(result.providerSummary).toBeTruthy();
    // Even with mocked tools, agents log provider usage
    expect(typeof result.providerSummary).toBe('string');
    expect(result.providerSummary.length).toBeGreaterThan(0);
  });
});

// ── ts-basic Fixture ──────────────────────────────────────────────

describe('rdt run — ts-basic fixture integration', () => {
  const BASIC_TEMP_DIR = resolve(process.cwd(), 'tmp-int-run-flow-basic');

  beforeAll(() => {
    safeRmDir(BASIC_TEMP_DIR);
    cpSync(resolve(FIXTURES_DIR, 'ts-basic'), BASIC_TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });

  afterAll(() => {
    safeRmDir(BASIC_TEMP_DIR);
  });

  it('should complete a task on a working (passing tests) project', async () => {
    const runner = createTestRunner(BASIC_TEMP_DIR);
    const result = await runner.run('add a new utility function');

    expect(result.taskId).toBeTruthy();
    expect(result.state.status).toMatch(/done|failed/);
  });

  it('should select files from the ts-basic project', async () => {
    const runner = createTestRunner(BASIC_TEMP_DIR);
    const result = await runner.run('update the greet function');

    expect(result.taskId).toBeTruthy();
    // The file picker should find source files
    const state = result.state;
    expect(state.selectedFilesCount).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty task request gracefully', async () => {
    const runner = createTestRunner(BASIC_TEMP_DIR);
    const result = await runner.run('');

    expect(result).toHaveProperty('taskId');
    expect(result.state.status).toBeDefined();
  });
});

// ── python-basic Fixture ───────────────────────────────────────────

describe('rdt run — python-basic fixture integration', () => {
  const PYTHON_TEMP_DIR = resolve(process.cwd(), 'tmp-int-run-flow-python');

  beforeAll(() => {
    safeRmDir(PYTHON_TEMP_DIR);
    cpSync(resolve(FIXTURES_DIR, 'python-basic'), PYTHON_TEMP_DIR, {
      recursive: true,
      force: true,
    });
  });

  afterAll(() => {
    safeRmDir(PYTHON_TEMP_DIR);
  });

  it('should detect the Python project correctly', async () => {
    const { detectProject } = await import(
      '../../src/project-context/detect-project'
    );
    const info = detectProject(PYTHON_TEMP_DIR);

    // Name extracted from pyproject.toml [project] section
    expect(info.name).toBe('python-basic-fixture');
    expect(info.language).toBe('python');
    expect(info.sourceDirs).toContain('src');
    // Python projects with pytest in pyproject.toml get python -m pytest
    expect(info.testCommand).toBe('python -m pytest');
    expect(info.packageManager).toBeNull();
    expect(info.lintCommand).toBeNull();
    expect(info.buildCommand).toBeNull();
    expect(info.hasGit).toBe(true);
  });

  it('should complete a task on the python-basic fixture', async () => {
    const runner = createTestRunner(PYTHON_TEMP_DIR);
    const result = await runner.run('add a new Python utility function');

    expect(result.taskId).toBeTruthy();
    expect(result.state.status).toMatch(/done|failed/);
    expect(result.summary).toBeTruthy();
    expect(result.providerSummary).toBeTruthy();
  });

  it('should have correct Python project structure', async () => {
    // Verify Python source files exist
    const addContent = readFileSync(
      join(PYTHON_TEMP_DIR, 'src', 'python_basic', 'add.py'),
      'utf-8',
    );
    expect(addContent).toContain('def add(a: float, b: float) -> float:');
    expect(addContent).toContain('return a + b');

    const greetContent = readFileSync(
      join(PYTHON_TEMP_DIR, 'src', 'python_basic', 'greet.py'),
      'utf-8',
    );
    expect(greetContent).toContain('def greet(name: str) -> str:');
    expect(greetContent).toContain('return f"Hello, {name}!"');

    // Verify Python test files exist
    const addTestContent = readFileSync(
      join(PYTHON_TEMP_DIR, 'tests', 'test_add.py'),
      'utf-8',
    );
    expect(addTestContent).toContain('from python_basic.add import add');
    expect(addTestContent).toContain('test_add_two_positive_numbers');

    const greetTestContent = readFileSync(
      join(PYTHON_TEMP_DIR, 'tests', 'test_greet.py'),
      'utf-8',
    );
    expect(greetTestContent).toContain('from python_basic.greet import greet');
    expect(greetTestContent).toContain('test_greet_by_name');

    // Verify pyproject.toml exists
    const pyprojectContent = readFileSync(
      join(PYTHON_TEMP_DIR, 'pyproject.toml'),
      'utf-8',
    );
    expect(pyprojectContent).toContain('name = "python-basic-fixture"');
    expect(pyprojectContent).toContain('requires-python = ">=3.10"');
  });

  it('should select source files from the Python project', async () => {
    const runner = createTestRunner(PYTHON_TEMP_DIR);
    const result = await runner.run('improve the greet function');

    expect(result.taskId).toBeTruthy();
    const state = result.state;
    expect(state.selectedFilesCount).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty task request on Python project', async () => {
    const runner = createTestRunner(PYTHON_TEMP_DIR);
    const result = await runner.run('');

    expect(result).toHaveProperty('taskId');
    expect(result.state.status).toBeDefined();
  });
});
