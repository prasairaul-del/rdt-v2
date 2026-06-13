import {
  type Stats,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { scanRepo } from '../project-context/repo-scanner';
import { cleanupIsolationArtifacts } from './process-isolation';

export class Sandbox {
  readonly sandboxPath: string;
  readonly hostPath: string;
  private junctions: string[] = [];

  constructor(hostPath: string, taskId: string) {
    this.hostPath = resolve(hostPath);
    // Create a temp directory name in OS temp directory
    this.sandboxPath = resolve(tmpdir(), `rdt-sandbox-${taskId}`);
  }

  /**
   * Initialize the sandbox by copying source files and symlinking dependencies.
   */
  async init(): Promise<void> {
    if (existsSync(this.sandboxPath)) {
      await this.destroy();
    }
    mkdirSync(this.sandboxPath, { recursive: true });

    // 1. Create junctions for large ignored dependency directories if they exist in host
    const directoriesToLink = [
      'node_modules',
      'venv',
      '.venv',
      '.git',
      'dist',
      'build',
      '.next',
      'target',
    ];
    for (const dir of directoriesToLink) {
      const hostDir = join(this.hostPath, dir);
      if (existsSync(hostDir) && lstatSync(hostDir).isDirectory()) {
        const sandboxDir = join(this.sandboxPath, dir);
        try {
          // On Windows, 'junction' is used to create directory junctions without admin privileges.
          // On non-Windows, it falls back to a standard directory symlink.
          const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
          symlinkSync(hostDir, sandboxDir, symlinkType);
          this.junctions.push(sandboxDir);
        } catch (err) {
          console.warn(`[Sandbox] Failed to link directory '${dir}':`, err);
        }
      }
    }

    // 2. Scan host and copy source files
    const repoMap = scanRepo(this.hostPath);
    for (const entry of repoMap.entries) {
      const hostFilePath = join(this.hostPath, entry.path);
      const sandboxFilePath = join(this.sandboxPath, entry.path);

      if (entry.type === 'dir') {
        mkdirSync(sandboxFilePath, { recursive: true });
      } else {
        // Ensure parent directory exists
        mkdirSync(dirname(sandboxFilePath), { recursive: true });
        copyFileSync(hostFilePath, sandboxFilePath);
      }
    }
  }

  /**
   * Apply modified files back to the host workspace.
   * Fix #9 — validates that all paths are relative and contain no traversal sequences.
   * Copies only files that exist in the sandbox.
   */
  async applyToHost(changedFiles: string[]): Promise<string[]> {
    const applied: string[] = [];
    for (const file of changedFiles) {
      // Fix #9 — path traversal guard
      if (isAbsolute(file)) {
        console.warn(
          `[Sandbox] Skipping absolute path in changedFiles: ${file}`,
        );
        continue;
      }
      const normalised = normalize(file);
      if (
        normalised.startsWith('..') ||
        normalised.includes('\\..') ||
        normalised.includes('/..')
      ) {
        console.warn(
          `[Sandbox] Skipping potentially unsafe path in changedFiles: ${file}`,
        );
        continue;
      }

      const sandboxFilePath = join(this.sandboxPath, normalised);
      const hostFilePath = join(this.hostPath, normalised);

      // Belt-and-suspenders: ensure the resolved path is actually inside the host workspace
      const resolvedHost = resolve(hostFilePath);
      if (!resolvedHost.startsWith(resolve(this.hostPath))) {
        console.warn(
          `[Sandbox] Path escaped host workspace boundary, skipping: ${file}`,
        );
        continue;
      }

      if (existsSync(sandboxFilePath)) {
        mkdirSync(dirname(hostFilePath), { recursive: true });
        copyFileSync(sandboxFilePath, hostFilePath);
        applied.push(normalised.replace(/\\/g, '/'));
      }
    }
    return applied;
  }

  /**
   * Safely clean up the sandbox directory by unlinking junctions first to prevent deleting host files.
   */
  async destroy(): Promise<void> {
    if (!existsSync(this.sandboxPath)) return;

    // First, explicitly unlink all tracked junctions/symlinks
    for (const junction of this.junctions) {
      if (existsSync(junction)) {
        try {
          unlinkSync(junction);
        } catch {
          try {
            rmSync(junction, { recursive: false, force: true });
          } catch (e) {
            console.warn(`[Sandbox] Failed to remove link '${junction}':`, e);
          }
        }
      }
    }
    this.junctions = [];

    // Also scan the sandbox directory for any other symlinks/junctions (defensive check)
    const scanAndUnlink = (dir: string) => {
      let items: string[] = [];
      try {
        items = readdirSync(dir);
      } catch {
        return;
      }
      for (const item of items) {
        const fullPath = join(dir, item);
        let stat: Stats;
        try {
          stat = lstatSync(fullPath);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) {
          try {
            unlinkSync(fullPath);
          } catch {
            try {
              rmSync(fullPath, { recursive: false, force: true });
            } catch {}
          }
        } else if (stat.isDirectory()) {
          scanAndUnlink(fullPath);
        }
      }
    };
    scanAndUnlink(this.sandboxPath);

    // Now it is 100% safe to recursively delete the sandbox directory
    try {
      rmSync(this.sandboxPath, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        `[Sandbox] Failed to delete sandbox path '${this.sandboxPath}':`,
        err,
      );
    }

    // Fix #5 — clean up any leftover process isolation artifacts (macOS .sb profile)
    cleanupIsolationArtifacts(this.sandboxPath);
  }
}
