import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';

export interface ListFilesInput {
  path?: string;
  pattern?: string;
  maxDepth?: number;
  includeHidden?: boolean;
}

export interface ListFilesOutput {
  files: Array<{ path: string; type: 'file' | 'dir'; size: number }>;
  totalCount: number;
}

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target',
  'venv', '__pycache__', '.rdt/tasks', '.rdt/cache', '.rdt/logs',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
]);

const ALLOWED_HIDDEN = new Set(['.github', '.vscode', '.rdt', '.husky', '.env']);

function shouldIgnore(relPath: string): boolean {
  const segments = relPath.split(/[/\\]/);
  for (const pattern of DEFAULT_IGNORE) {
    if (relPath === pattern || relPath.startsWith(pattern + '/') || relPath.startsWith(pattern + '\\')) return true;
    if (segments.some((s) => s === pattern)) return true;
  }
  if (segments.some((s) => s.startsWith('.') && !s.startsWith('..') && !ALLOWED_HIDDEN.has(s))) return true;
  return false;
}

export const listFilesTool: Tool<ListFilesInput, ListFilesOutput> = {
  name: 'list_files',
  description: 'Lists project files while respecting ignore rules',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative directory path to list (default: project root)' },
      maxDepth: { type: 'number', description: 'Maximum recursion depth (default: unlimited)' },
      includeHidden: { type: 'boolean', description: 'Include hidden files (default: false)' },
    },
  },

  async execute(input: ListFilesInput) {
    try {
      const root = resolve(process.cwd(), input.path || '.');
      const maxDepth = input.maxDepth ?? Infinity;
      const entries: Array<{ path: string; type: 'file' | 'dir'; size: number }> = [];
      let count = 0;

      function walk(dir: string, depth: number) {
        if (depth > maxDepth) return;
        let files: string[];
        try {
          files = readdirSync(dir);
        } catch {
          return;
        }
        for (const file of files) {
          const fullPath = join(dir, file);
          const rel = relative(process.cwd(), fullPath);
          if (shouldIgnore(rel)) continue;

          let stat: ReturnType<typeof statSync>;
          try {
            stat = statSync(fullPath);
          } catch {
            continue;
          }

          const type = stat.isDirectory() ? 'dir' : 'file';
          entries.push({ path: rel, type, size: stat.size });
          count++;

          if (stat.isDirectory()) {
            walk(fullPath, depth + 1);
          }
        }
      }

      walk(resolve(root), 0);
      return successResult({ files: entries, totalCount: count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult('INTERNAL_ERROR', `Failed to list files: ${message}`);
    }
  },
};
