import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { RepoMap, RepoMapEntry } from './repo-map';

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  'venv',
  '__pycache__',
  '.vitepress/dist',
  '.rdt/tasks',
  '.rdt/cache',
  '.rdt/logs',
  '*.db',
  '*.sqlite',
  '*.sqlite3',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
];

export function scanRepo(
  projectRoot: string,
  extraIgnore: string[] = [],
): RepoMap {
  const ignorePatterns = [...DEFAULT_IGNORE, ...extraIgnore];
  const entries: RepoMapEntry[] = [];
  let totalFiles = 0;
  let totalDirs = 0;

  function shouldIgnore(relPath: string): boolean {
    const segments = relPath.split(/[/\\]/);
    const normRelPath = relPath.replace(/\\/g, '/');
    // Check if any ignore pattern matches a complete path prefix or segment
    for (const pattern of ignorePatterns) {
      const normPattern = pattern.replace(/\\/g, '/');
      if (
        normRelPath === normPattern ||
        normRelPath.startsWith(`${normPattern}/`) ||
        normRelPath.includes(`/${normPattern}/`) ||
        normRelPath.endsWith(`/${normPattern}`)
      )
        return true;
      if (segments.some((s) => s === pattern)) return true;
    }
    // Skip hidden dirs except common meaningful ones
    const allowedHidden = new Set([
      '.github',
      '.vscode',
      '.rdt',
      '.husky',
      '.env',
    ]);
    if (
      segments.some(
        (s) =>
          s.startsWith('.') && !s.startsWith('..') && !allowedHidden.has(s),
      )
    )
      return true;
    return false;
  }

  function walk(dir: string) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      return;
    }

    for (const file of files) {
      const fullPath = join(dir, file);
      const relPath = relative(projectRoot, fullPath);

      if (shouldIgnore(relPath)) continue;

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        totalDirs++;
        entries.push({ path: relPath, type: 'dir', size: 0 });
        walk(fullPath);
      } else {
        totalFiles++;
        entries.push({ path: relPath, type: 'file', size: stat.size });
      }
    }
  }

  walk(projectRoot);

  return {
    root: projectRoot,
    entries,
    totalFiles,
    totalDirs,
    ignoredPatterns: [...DEFAULT_IGNORE, ...extraIgnore],
  };
}
