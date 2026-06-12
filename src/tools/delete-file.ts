import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { errorResult, successResult } from '../core/result';
import type { Tool } from './types';

export interface DeleteFileInput {
  path: string;
  recursive?: boolean;
  cwd?: string;
}

export interface DeleteFileOutput {
  path: string;
  deleted: boolean;
}

export const deleteFileTool: Tool<DeleteFileInput, DeleteFileOutput> = {
  name: 'delete_file',
  description: 'Deletes a file or directory safely',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative path to the file or directory',
      },
      recursive: {
        type: 'boolean',
        description: 'Delete directories recursively (default: false)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for path resolution',
      },
    },
    required: ['path'],
  },

  async execute(input: DeleteFileInput) {
    try {
      const base = input.cwd ?? process.cwd();
      const absPath = resolve(base, input.path);
      const resolvedBase = resolve(base);
      const rel = relative(resolvedBase, absPath);

      if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
        return errorResult(
          'PERMISSION_DENIED',
          `Path '${input.path}' is invalid or escapes workspace boundary`,
        );
      }

      if (!existsSync(absPath)) {
        return errorResult('NOT_FOUND', `Path '${input.path}' does not exist`);
      }

      rmSync(absPath, { recursive: input.recursive ?? false, force: true });

      return successResult({
        path: input.path,
        deleted: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return errorResult(
          'PERMISSION_DENIED',
          `Cannot delete '${input.path}': ${message}`,
        );
      }
      return errorResult(
        'INTERNAL_ERROR',
        `Failed to delete '${input.path}': ${message}`,
      );
    }
  },
};
