import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';

export interface GitDiffInput {
  staged?: boolean;
  path?: string;
  contextLines?: number;
}

export interface GitDiffOutput {
  diff: string;
  filesChanged: number;
  hasChanges: boolean;
}

export const gitDiffTool: Tool<GitDiffInput, GitDiffOutput> = {
  name: 'git_diff',
  description: 'Shows current git diff (unstaged changes by default)',
  inputSchema: {
    type: 'object',
    properties: {
      staged: { type: 'boolean', description: 'Show staged diff instead of unstaged' },
      path: { type: 'string', description: 'Filter to specific path' },
      contextLines: { type: 'number', description: 'Number of context lines (default: 3)' },
    },
  },

  async execute(input: GitDiffInput) {
    try {
      const cwd = process.cwd();
      if (!existsSync(resolve(cwd, '.git'))) {
        return errorResult('NOT_FOUND', 'Not a git repository. Cannot show diff.', [
          'Initialize a git repository with git init',
          'Check your working directory',
        ]);
      }

      const ctxLines = input.contextLines ?? 3;
      const flag = input.staged ? '--staged' : '';
      const pathFilter = input.path || '.';

      const diff = execSync(`git diff ${flag} -U${ctxLines} -- "${pathFilter}"`, {
        cwd,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();

      const filesChanged = diff ? (diff.match(/^diff --git/g) || []).length : 0;

      return successResult({
        diff,
        filesChanged,
        hasChanges: filesChanged > 0,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult('COMMAND_FAILED', `Git diff failed: ${message}`);
    }
  },
};
