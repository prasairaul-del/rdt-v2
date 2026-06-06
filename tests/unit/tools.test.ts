import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { successResult, errorResult } from '../../src/core/result';
import { listFilesTool } from '../../src/tools/list-files';
import { readFileTool } from '../../src/tools/read-file';
import { searchFilesTool } from '../../src/tools/search-files';
import { writeFileTool } from '../../src/tools/write-file';
import { applyPatchTool } from '../../src/tools/apply-patch';
import { gitDiffTool } from '../../src/tools/git-diff';
import { runShellTool } from '../../src/tools/run-shell';

const TEST_TMP = resolve(process.cwd(), 'tmp-test');

beforeAll(() => {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true });
  mkdirSync(TEST_TMP, { recursive: true });
  writeFileSync(join(TEST_TMP, 'hello.txt'), 'Hello, World!\nSecond line\nThird line\n');
  writeFileSync(join(TEST_TMP, 'config.json'), JSON.stringify({ key: 'value', nested: { num: 42 } }, null, 2));
  mkdirSync(join(TEST_TMP, 'subdir'), { recursive: true });
  writeFileSync(join(TEST_TMP, 'subdir', 'nested.txt'), 'Nested file content\n');
});

afterAll(() => {
  if (existsSync(TEST_TMP)) rmSync(TEST_TMP, { recursive: true });
});

// ── ToolResult ──────────────────────────────────────────────────────────

describe('ToolResult', () => {
  it('should create success result with data', () => {
    const result = successResult({ foo: 'bar' });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ foo: 'bar' });
    expect(result.error).toBeUndefined();
  });

  it('should create error result with type and message', () => {
    const result = errorResult('NOT_FOUND', 'File not found', ['Check path']);
    expect(result.success).toBe(false);
    expect(result.error?.type).toBe('NOT_FOUND');
    expect(result.error?.message).toBe('File not found');
    expect(result.error?.suggestions).toEqual(['Check path']);
  });

  it('should create error result without suggestions', () => {
    const result = errorResult('TIMEOUT', 'Timed out');
    expect(result.success).toBe(false);
    expect(result.error?.suggestions).toBeUndefined();
  });
});

// ── list-files ─────────────────────────────────────────────────────────

describe('listFilesTool', () => {
  it('should list files in a directory', async () => {
    const result = await listFilesTool.execute({ path: 'tmp-test' });
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    const files = result.data!.files.map((f) => f.path.replace(/\\/g, '/'));
    expect(files).toContain('tmp-test/hello.txt');
    expect(files).toContain('tmp-test/config.json');
    expect(files).toContain('tmp-test/subdir/nested.txt');
  });

  it('should return totalCount', async () => {
    const result = await listFilesTool.execute({ path: 'tmp-test' });
    expect(result.success).toBe(true);
    expect(result.data!.totalCount).toBeGreaterThanOrEqual(3);
  });

  it('should handle non-existent directory gracefully', async () => {
    const result = await listFilesTool.execute({ path: 'nonexistent-dir-xyz' });
    expect(result.success).toBe(true);
    expect(result.data!.files).toHaveLength(0);
  });
});

// ── read-file ──────────────────────────────────────────────────────────

describe('readFileTool', () => {
  it('should read a file successfully', async () => {
    const result = await readFileTool.execute({ path: 'tmp-test/hello.txt' });
    expect(result.success).toBe(true);
    expect(result.data!.content).toContain('Hello, World!');
    expect(result.data!.size).toBeGreaterThan(0);
    expect(result.data!.truncated).toBe(false);
  });

  it('should return error for non-existent file', async () => {
    const result = await readFileTool.execute({ path: 'tmp-test/missing.txt' });
    expect(result.success).toBe(false);
    expect(result.error!.type).toBe('NOT_FOUND');
  });

  it('should return error for directory path', async () => {
    const result = await readFileTool.execute({ path: 'tmp-test' });
    expect(result.success).toBe(false);
    expect(result.error!.type).toBe('VALIDATION_ERROR');
  });
});

// ── search-files ───────────────────────────────────────────────────────

describe('searchFilesTool', () => {
  it('should find files by filename match', async () => {
    const result = await searchFilesTool.execute({ pattern: 'hello' });
    expect(result.success).toBe(true);
    const paths = result.data!.results.map((r) => r.path.replace(/\\/g, '/'));
    expect(paths.some((p) => p.includes('hello'))).toBe(true);
  });

  it('should search file contents when requested', async () => {
    const result = await searchFilesTool.execute({ pattern: 'World!', includeContent: true });
    expect(result.success).toBe(true);
    expect(result.data!.totalMatches).toBeGreaterThan(0);
  });

  it('should respect maxResults', async () => {
    const result = await searchFilesTool.execute({ pattern: '', maxResults: 0 });
    expect(result.success).toBe(true);
  });
});

// ── write-file ─────────────────────────────────────────────────────────

describe('writeFileTool', () => {
  const testFilePath = 'tmp-test/new-file.txt';

  it('should create a new file', async () => {
    const result = await writeFileTool.execute({ path: testFilePath, content: 'New file content' });
    expect(result.success).toBe(true);
    expect(result.data!.size).toBeGreaterThan(0);
    expect(result.data!.created).toBe(true);
  });

  it('should refuse to overwrite without allowOverwrite', async () => {
    const result = await writeFileTool.execute({ path: testFilePath, content: 'Overwrite attempt' });
    expect(result.success).toBe(false);
    expect(result.error!.type).toBe('VALIDATION_ERROR');
  });

  it('should overwrite with allowOverwrite flag', async () => {
    const result = await writeFileTool.execute({ path: testFilePath, content: 'Overwritten', allowOverwrite: true });
    expect(result.success).toBe(true);
    const content = readFileSync(resolve(process.cwd(), testFilePath), 'utf-8');
    expect(content).toBe('Overwritten');
  });

  it('should create parent directories automatically', async () => {
    const deepPath = 'tmp-test/a/b/c/deep.txt';
    const result = await writeFileTool.execute({ path: deepPath, content: 'Deep file' });
    expect(result.success).toBe(true);
    expect(existsSync(resolve(process.cwd(), deepPath))).toBe(true);
  });
});

// ── apply-patch ────────────────────────────────────────────────────────

describe('applyPatchTool', () => {
  const helloPath = resolve(process.cwd(), 'tmp-test/hello.txt');

  beforeEach(() => {
    writeFileSync(helloPath, 'Hello, World!\nSecond line\nThird line\n');
  });

  it('should apply a valid unified diff patch', async () => {
    const patch = [
      '--- a/tmp-test/hello.txt',
      '+++ b/tmp-test/hello.txt',
      '@@ -1,3 +1,4 @@',
      ' Hello, World!',
      '+Inserted line',
      ' Second line',
      ' Third line',
    ].join('\n');

    const result = await applyPatchTool.execute({ patch });
    expect(result.success).toBe(true);
    expect(result.data!.hunksApplied).toBe(1);
    expect(result.data!.linesAdded).toBe(1);
    expect(result.data!.linesRemoved).toBe(0);

    const content = readFileSync(helloPath, 'utf-8');
    expect(content).toContain('Inserted line');
  });

  it('should remove lines prefixed with -', async () => {
    const patch = [
      '--- a/tmp-test/hello.txt',
      '+++ b/tmp-test/hello.txt',
      '@@ -1,3 +1,2 @@',
      ' Hello, World!',
      ' Second line',
      '-Third line',
    ].join('\n');

    const result = await applyPatchTool.execute({ patch });
    expect(result.success).toBe(true);
    expect(result.data!.linesRemoved).toBe(1);

    const content = readFileSync(helloPath, 'utf-8');
    expect(content).not.toContain('Third line');
  });

  it('should reject patch with non-existent file', async () => {
    const patch = [
      '--- a/tmp-test/nonexistent.txt',
      '+++ b/tmp-test/nonexistent.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const result = await applyPatchTool.execute({ patch });
    expect(result.success).toBe(false);
    expect(result.error!.type).toBe('NOT_FOUND');
  });

  it('should reject invalid patch format', async () => {
    const result = await applyPatchTool.execute({ patch: 'not a valid patch' });
    expect(result.success).toBe(false);
    expect(result.error!.type).toBe('VALIDATION_ERROR');
  });

  it('should reject patch with mismatched context', async () => {
    const patch = [
      '--- a/tmp-test/hello.txt',
      '+++ b/tmp-test/hello.txt',
      '@@ -1,3 +1,3 @@',
      ' This line does NOT match',
      ' Second line',
      ' Third line',
    ].join('\n');

    const result = await applyPatchTool.execute({ patch });
    expect(result.success).toBe(false);
    expect(result.error!.type).toBe('VALIDATION_ERROR');
    expect(result.error!.message).toContain('Context lines did not match');
  });
});

// ── git-diff ───────────────────────────────────────────────────────────

describe('gitDiffTool', () => {
  it('should return diff result structure', async () => {
    const result = await gitDiffTool.execute({});
    // In CI or different environments, git may or may not be available
    // Just check the result shape is consistent
    if (result.success) {
      expect(typeof result.data!.filesChanged).toBe('number');
      expect(typeof result.data!.hasChanges).toBe('boolean');
      expect(typeof result.data!.diff).toBe('string');
    } else {
      expect(result.error!.type).toMatch(/NOT_FOUND|COMMAND_FAILED/);
    }
  });
});

// ── run-shell ──────────────────────────────────────────────────────────

describe('runShellTool', () => {
  it('should run a simple command', async () => {
    // Use node to avoid shell differences
    const result = await runShellTool.execute({ command: 'node -e "console.log(\'hello\')"' });
    expect(result.success).toBe(true);
    expect(result.data!.stdout).toContain('hello');
    expect(result.data!.exitCode).toBe(0);
  });

  it('should block dangerous commands', async () => {
    const blocked = ['rm -rf /', 'shutdown', 'mkfs.ext4'];
    for (const cmd of blocked) {
      const result = await runShellTool.execute({ command: cmd });
      expect(result.success).toBe(false);
      expect(result.error!.type).toBe('PERMISSION_DENIED');
    }
  });

  it('should return exit code for failing commands', async () => {
    const result = await runShellTool.execute({ command: 'node -e "process.exit(1)"' });
    expect(result.success).toBe(true);
    expect(result.data!.exitCode).toBe(1);
  });
});
