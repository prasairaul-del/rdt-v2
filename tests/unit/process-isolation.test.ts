import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // Cleanup any rdt-cmd- temp directories
    try {
      const tmpContents = readdirSync(tmpdir());
      for (const item of tmpContents) {
        if (
          item.startsWith('rdt-cmd-') ||
          item.startsWith('rdt-mac-sandbox-')
        ) {
          rmSync(join(tmpdir(), item), { recursive: true, force: true });
        }
      }
    } catch {
      // ignore
    }
  });

  it('should wrap command in PowerShell script on Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    });

    const sandboxPath = 'C:\\temp\\sandbox';
    const wrapped = wrapCommand('dir', sandboxPath);

    expect(wrapped).toContain('powershell');
    expect(wrapped).toContain('-ExecutionPolicy');
    expect(wrapped).toContain('-File');

    // Extract script path
    const match = wrapped.match(/-File "([^"]+)"/);
    expect(match).not.toBeNull();
    const scriptPath = match?.[1] ?? '';

    // Verify script file was created and contains the command
    expect(existsSync(scriptPath)).toBe(true);
    const content = readFileSync(scriptPath, 'utf-8');
    expect(content).toContain('Get-Location');
    expect(content).toContain('dir');

    // Cleanup
    rmSync(scriptPath, { force: true });
  });

  it('should wrap command in sandbox-exec with script file on macOS (darwin)', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    });

    const sandboxPath = '/tmp/sandbox';
    const wrapped = wrapCommand('ls', sandboxPath);

    expect(wrapped).toContain('sandbox-exec');
    expect(wrapped).toContain('-f');

    // Extract profile path
    const profileMatch = wrapped.match(/sandbox-exec -f "([^"]+)"/);
    expect(profileMatch).not.toBeNull();
    const profilePath = profileMatch?.[1] ?? '';

    // Extract script path
    const scriptMatch = wrapped.match(/bash "([^"]+)"/);
    expect(scriptMatch).not.toBeNull();
    const scriptPath = scriptMatch?.[1] ?? '';

    // Verify profile file was created and contains correct rules
    expect(existsSync(profilePath)).toBe(true);
    const content = readFileSync(profilePath, 'utf-8');
    expect(content).toContain('(version 1)');
    expect(content).toContain(
      `(allow file-read* file-write* (subpath "${sandboxPath}"))`,
    );
    expect(content).toContain('(deny network-outbound)');

    // Verify script file was created and contains the command
    expect(existsSync(scriptPath)).toBe(true);
    const scriptContent = readFileSync(scriptPath, 'utf-8');
    expect(scriptContent).toContain('ls');

    // Cleanup
    rmSync(profilePath, { force: true });
    rmSync(scriptPath, { force: true });
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
