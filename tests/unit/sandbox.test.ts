import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Sandbox } from '../../src/tools/sandbox';

// Mock bun:sqlite since vitest runs in Node.js
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

describe('User-Space Shadow Directory Sandbox', () => {
  const TEST_HOST_DIR = resolve(tmpdir(), 'rdt-sandbox-test-host');
  let sandbox: Sandbox | null = null;

  beforeEach(() => {
    // 1. Create a dummy host repository
    if (existsSync(TEST_HOST_DIR)) {
      rmSync(TEST_HOST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_HOST_DIR, { recursive: true });

    // Add some source files
    mkdirSync(join(TEST_HOST_DIR, 'src'));
    writeFileSync(
      join(TEST_HOST_DIR, 'src', 'index.ts'),
      'console.log("hello");',
      'utf-8',
    );
    writeFileSync(
      join(TEST_HOST_DIR, 'package.json'),
      JSON.stringify({ name: 'test-app' }),
      'utf-8',
    );

    // Add a mock large dependency directory
    mkdirSync(join(TEST_HOST_DIR, 'node_modules'));
    writeFileSync(
      join(TEST_HOST_DIR, 'node_modules', 'dep-file.txt'),
      'dependency content',
      'utf-8',
    );
  });

  afterEach(async () => {
    if (sandbox) {
      await sandbox.destroy();
    }
    if (existsSync(TEST_HOST_DIR)) {
      rmSync(TEST_HOST_DIR, { recursive: true, force: true });
    }
  });

  it('should initialize and clone source files but link node_modules', async () => {
    sandbox = new Sandbox(TEST_HOST_DIR, 'test-task-123');
    await sandbox.init();

    // Verify sandbox directory structure exists
    expect(existsSync(sandbox.sandboxPath)).toBe(true);

    // Verify source files are copied
    const sandboxIndexFile = join(sandbox.sandboxPath, 'src', 'index.ts');
    expect(existsSync(sandboxIndexFile)).toBe(true);
    expect(readFileSync(sandboxIndexFile, 'utf-8')).toBe(
      'console.log("hello");',
    );

    // Verify node_modules is symlinked/junctioned
    const sandboxNodeModules = join(sandbox.sandboxPath, 'node_modules');
    expect(existsSync(sandboxNodeModules)).toBe(true);
    expect(
      lstatSync(sandboxNodeModules).isSymbolicLink() ||
        process.platform === 'win32',
    ).toBe(true);

    // Verify read access to the symlinked dependency file
    const sandboxDepFile = join(sandboxNodeModules, 'dep-file.txt');
    expect(existsSync(sandboxDepFile)).toBe(true);
    expect(readFileSync(sandboxDepFile, 'utf-8')).toBe('dependency content');
  });

  it('should isolate edits and only write back to host on applyToHost', async () => {
    sandbox = new Sandbox(TEST_HOST_DIR, 'test-task-456');
    await sandbox.init();

    const sandboxIndexFile = join(sandbox.sandboxPath, 'src', 'index.ts');
    const hostIndexFile = join(TEST_HOST_DIR, 'src', 'index.ts');

    // Edit file inside the sandbox
    writeFileSync(sandboxIndexFile, 'console.log("edited");', 'utf-8');

    // Verify sandbox is modified but host remains unchanged
    expect(readFileSync(sandboxIndexFile, 'utf-8')).toBe(
      'console.log("edited");',
    );
    expect(readFileSync(hostIndexFile, 'utf-8')).toBe('console.log("hello");');

    // Create a new file inside the sandbox
    const sandboxNewFile = join(sandbox.sandboxPath, 'src', 'utils.ts');
    const hostNewFile = join(TEST_HOST_DIR, 'src', 'utils.ts');
    writeFileSync(sandboxNewFile, 'export const val = 42;', 'utf-8');

    expect(existsSync(sandboxNewFile)).toBe(true);
    expect(existsSync(hostNewFile)).toBe(false);

    // Apply back to host
    const applied = await sandbox.applyToHost(['src/index.ts', 'src/utils.ts']);
    expect(applied).toContain('src/index.ts');
    expect(applied).toContain('src/utils.ts');

    // Verify changes are now applied to the host
    expect(readFileSync(hostIndexFile, 'utf-8')).toBe('console.log("edited");');
    expect(existsSync(hostNewFile)).toBe(true);
    expect(readFileSync(hostNewFile, 'utf-8')).toBe('export const val = 42;');
  });

  it('should safely destroy the sandbox without affecting host files or dependency folders', async () => {
    sandbox = new Sandbox(TEST_HOST_DIR, 'test-task-789');
    await sandbox.init();

    // Verify setup
    const sandboxNodeModules = join(sandbox.sandboxPath, 'node_modules');
    expect(existsSync(sandboxNodeModules)).toBe(true);

    // Destroy sandbox
    await sandbox.destroy();

    // Verify sandbox directory is deleted
    expect(existsSync(sandbox.sandboxPath)).toBe(false);

    // Verify host and dependency folders remain intact (junction target was not deleted!)
    expect(existsSync(TEST_HOST_DIR)).toBe(true);
    expect(existsSync(join(TEST_HOST_DIR, 'src', 'index.ts'))).toBe(true);
    expect(existsSync(join(TEST_HOST_DIR, 'node_modules'))).toBe(true);
    expect(
      existsSync(join(TEST_HOST_DIR, 'node_modules', 'dep-file.txt')),
    ).toBe(true);
  });
});
