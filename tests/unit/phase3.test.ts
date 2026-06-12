import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { makeDirectoryTool } from '../../src/tools/make-directory';
import { deleteFileTool } from '../../src/tools/delete-file';
import { moveFileTool } from '../../src/tools/move-file';
import { runShellTool } from '../../src/tools/run-shell';
import { testRunnerTool } from '../../src/tools/test-runner';
import { loadInstructions } from '../../src/project-context/load-instructions';
import { TaskLogger } from '../../src/core/logger';

const TEST_DIR = resolve(process.cwd(), 'tmp-phase3');

beforeAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe('Phase 3 - Filesystem Tools', () => {
  describe('makeDirectoryTool', () => {
    it('should create a directory successfully', async () => {
      const dirPath = 'test-dir-1';
      const fullPath = join(TEST_DIR, dirPath);

      const result = await makeDirectoryTool.execute({
        path: dirPath,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(true);
      expect(existsSync(fullPath)).toBe(true);
    });

    it('should return created: false if directory already exists', async () => {
      const dirPath = 'test-dir-1';

      const result = await makeDirectoryTool.execute({
        path: dirPath,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.data?.created).toBe(false);
    });

    it('should error if path exists but is not a directory', async () => {
      const filePath = 'test-file-dir';
      writeFileSync(join(TEST_DIR, filePath), 'not a directory');

      const result = await makeDirectoryTool.execute({
        path: filePath,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('VALIDATION_ERROR');
    });

    it('should prevent path escaping the workspace boundary', async () => {
      const result = await makeDirectoryTool.execute({
        path: '../escaped-dir',
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('PERMISSION_DENIED');
    });
  });

  describe('deleteFileTool', () => {
    it('should delete a file successfully', async () => {
      const filePath = 'delete-me.txt';
      const fullPath = join(TEST_DIR, filePath);
      writeFileSync(fullPath, 'delete me');

      const result = await deleteFileTool.execute({
        path: filePath,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.data?.deleted).toBe(true);
      expect(existsSync(fullPath)).toBe(false);
    });

    it('should delete a directory recursively if recursive: true', async () => {
      const subDir = 'delete-subdir';
      const subDirPath = join(TEST_DIR, subDir);
      mkdirSync(subDirPath, { recursive: true });
      writeFileSync(join(subDirPath, 'nested.txt'), 'nested file');

      const result = await deleteFileTool.execute({
        path: subDir,
        recursive: true,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.data?.deleted).toBe(true);
      expect(existsSync(subDirPath)).toBe(false);
    });

    it('should return NOT_FOUND if file does not exist', async () => {
      const result = await deleteFileTool.execute({
        path: 'non-existent-file.txt',
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('NOT_FOUND');
    });

    it('should prevent escaping boundaries', async () => {
      const result = await deleteFileTool.execute({
        path: '../escaped-delete',
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('PERMISSION_DENIED');
    });

    it('should prevent deleting the root itself', async () => {
      const result = await deleteFileTool.execute({
        path: '',
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('PERMISSION_DENIED');
    });
  });

  describe('moveFileTool', () => {
    it('should move a file successfully', async () => {
      const src = 'move-src.txt';
      const dest = 'move-dest.txt';
      writeFileSync(join(TEST_DIR, src), 'hello');

      const result = await moveFileTool.execute({
        sourcePath: src,
        destPath: dest,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(result.data?.moved).toBe(true);
      expect(existsSync(join(TEST_DIR, dest))).toBe(true);
      expect(existsSync(join(TEST_DIR, src))).toBe(false);
    });

    it('should create dest parent directories recursively if needed', async () => {
      const src = 'move-src-parent.txt';
      const dest = 'nested/parent/dir/move-dest.txt';
      writeFileSync(join(TEST_DIR, src), 'hello');

      const result = await moveFileTool.execute({
        sourcePath: src,
        destPath: dest,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(existsSync(join(TEST_DIR, dest))).toBe(true);
    });

    it('should error if destination exists and overwrite is false', async () => {
      const src = 'move-src-exists.txt';
      const dest = 'move-dest-exists.txt';
      writeFileSync(join(TEST_DIR, src), 'hello');
      writeFileSync(join(TEST_DIR, dest), 'world');

      const result = await moveFileTool.execute({
        sourcePath: src,
        destPath: dest,
        overwrite: false,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(false);
      expect(result.error?.type).toBe('VALIDATION_ERROR');
    });

    it('should overwrite if destination exists and overwrite is true', async () => {
      const src = 'move-src-overwrite.txt';
      const dest = 'move-dest-overwrite.txt';
      writeFileSync(join(TEST_DIR, src), 'hello');
      writeFileSync(join(TEST_DIR, dest), 'world');

      const result = await moveFileTool.execute({
        sourcePath: src,
        destPath: dest,
        overwrite: true,
        cwd: TEST_DIR,
      });

      expect(result.success).toBe(true);
      expect(existsSync(join(TEST_DIR, dest))).toBe(true);
    });

    it('should prevent escaping boundaries on source or destination', async () => {
      const resultSource = await moveFileTool.execute({
        sourcePath: '../escaped-source',
        destPath: 'dest.txt',
        cwd: TEST_DIR,
      });
      expect(resultSource.success).toBe(false);
      expect(resultSource.error?.type).toBe('PERMISSION_DENIED');

      const resultDest = await moveFileTool.execute({
        sourcePath: 'src.txt',
        destPath: '../escaped-dest',
        cwd: TEST_DIR,
      });
      expect(resultDest.success).toBe(false);
      expect(resultDest.error?.type).toBe('PERMISSION_DENIED');
    });
  });
});

describe('Phase 3 - Spawn Refactoring and Real-time Streaming', () => {
  it('should stream runShellTool output line-by-line via TaskLogger', async () => {
    const logger = new TaskLogger();
    const infoSpy = vi.spyOn(logger, 'info');

    const result = await runShellTool.execute({
      command: "node -e \"console.log('line1'); console.log('line2')\"",
      logger,
      cwd: TEST_DIR,
    });

    expect(result.success).toBe(true);
    expect(result.data?.stdout.trim()).toBe(
      'line1\r\nline2'.replace(/\r/g, ''),
    );
    expect(infoSpy).toHaveBeenCalledWith('line1');
    expect(infoSpy).toHaveBeenCalledWith('line2');
  });

  it('should stream testRunnerTool output line-by-line via TaskLogger', async () => {
    const logger = new TaskLogger();
    const infoSpy = vi.spyOn(logger, 'info');

    const result = await testRunnerTool.execute({
      command:
        "node -e \"console.log('test1Passed'); console.log('test2Passed')\"",
      logger,
      cwd: TEST_DIR,
    });

    expect(result.success).toBe(true);
    expect(infoSpy).toHaveBeenCalledWith('test1Passed');
    expect(infoSpy).toHaveBeenCalledWith('test2Passed');
  });
});

describe('Phase 3 - Custom Instructions Loading', () => {
  it('should scan .rdt/instructions/ for .md files, combine their contents, and load them', () => {
    const instructionsDir = join(TEST_DIR, '.rdt', 'instructions');
    mkdirSync(instructionsDir, { recursive: true });

    writeFileSync(
      join(instructionsDir, '01-first.md'),
      'First custom instruction',
    );
    writeFileSync(
      join(instructionsDir, '02-second.md'),
      'Second custom instruction',
    );

    const result = loadInstructions(TEST_DIR);
    expect(result.customInstructions).toContain('First custom instruction');
    expect(result.customInstructions).toContain('Second custom instruction');
    expect(result.customInstructions).toBe(
      'First custom instruction\n\nSecond custom instruction',
    );

    // Cleanup
    rmSync(instructionsDir, { recursive: true, force: true });
  });

  it('should return null for customInstructions if the directory is empty or does not exist', () => {
    const result = loadInstructions(TEST_DIR);
    expect(result.customInstructions).toBeNull();
  });
});
