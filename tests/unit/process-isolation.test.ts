import { existsSync, readFileSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapCommand } from '../../src/tools/process-isolation';

// Mock bun:sqlite since vitest runs in Node.js
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

describe('Process Isolation Sandboxing', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  it('should wrap command in PowerShell boundary check on Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    const sandboxPath = 'C:\\temp\\sandbox';
    const wrapped = wrapCommand('dir', sandboxPath);

    expect(wrapped).toContain('powershell');
    expect(wrapped).toContain('-EncodedCommand');

    const match = wrapped.match(/-EncodedCommand\s+(.+)/);
    expect(match).not.toBeNull();
    const base64 = match?.[1] ?? '';
    const decoded = Buffer.from(base64, 'base64').toString('utf16le');
    expect(decoded).toContain('Get-Location');
    expect(decoded).toContain('c:\\temp\\sandbox');
    expect(decoded).toContain('dir');
  });

  it('should wrap command in sandbox-exec with temporary profile on macOS (darwin)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    const sandboxPath = '/tmp/sandbox';
    const wrapped = wrapCommand('ls', sandboxPath);

    expect(wrapped).toContain('sandbox-exec');
    expect(wrapped).toContain('-f');
    expect(wrapped).toContain('ls');

    // Extract profile path
    const match = wrapped.match(/sandbox-exec -f "([^"]+)"/);
    expect(match).not.toBeNull();
    const profilePath = match?.[1] ?? '';

    // Verify profile file was created and contains correct rules
    expect(existsSync(profilePath)).toBe(true);
    const content = readFileSync(profilePath, 'utf-8');
    expect(content).toContain('(version 1)');
    expect(content).toContain(
      `(allow file-read* file-write* (subpath "${sandboxPath}"))`,
    );
    expect(content).toContain('(deny network-outbound)');

    // Cleanup
    rmSync(profilePath, { force: true });
  });

  it('should return raw command as fallback on Linux and other platforms', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });

    const wrapped = wrapCommand('ls', '/tmp/sandbox');
    expect(wrapped).toBe('ls');
  });
});
