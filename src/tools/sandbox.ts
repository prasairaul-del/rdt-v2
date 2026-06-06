import { existsSync, mkdirSync, copyFileSync, symlinkSync, rmSync, lstatSync, unlinkSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanRepo } from '../project-context/repo-scanner';

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
    const directoriesToLink = ['node_modules', 'venv', '.venv', '.git', 'dist', 'build', '.next', 'target'];
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
   * Copies only files that are modified (different content) in the sandbox compared to the host.
   */
  async applyToHost(changedFiles: string[]): Promise<string[]> {
    const applied: string[] = [];
    for (const file of changedFiles) {
      const sandboxFilePath = join(this.sandboxPath, file);
      const hostFilePath = join(this.hostPath, file);

      if (existsSync(sandboxFilePath)) {
        mkdirSync(dirname(hostFilePath), { recursive: true });
        copyFileSync(sandboxFilePath, hostFilePath);
        applied.push(file);
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
        let stat;
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
      console.warn(`[Sandbox] Failed to delete sandbox path '${this.sandboxPath}':`, err);
    }
  }
}
