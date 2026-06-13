import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { errorResult, successResult } from '../core/result';
import type { Tool } from './types';

export interface MoveFileInput {
  sourcePath: string;
  destPath: string;
  overwrite?: boolean;
  cwd?: string;
}

export interface MoveFileOutput {
  sourcePath: string;
  destPath: string;
  moved: boolean;
}

export const moveFileTool: Tool<MoveFileInput, MoveFileOutput> = {
  name: 'move_file',
  description: 'Moves or renames a file or directory safely',
  inputSchema: {
    type: 'object',
    properties: {
      sourcePath: {
        type: 'string',
        description: 'Relative path to the source file or directory',
      },
      destPath: {
        type: 'string',
        description: 'Relative path to the destination file or directory',
      },
      overwrite: {
        type: 'boolean',
        description: 'Overwrite destination if it exists (default: false)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for path resolution',
      },
    },
    required: ['sourcePath', 'destPath'],
  },

  async execute(input: MoveFileInput) {
    try {
      const base = input.cwd ?? process.cwd();
      const resolvedBase = resolve(base);

      const absSource = resolve(resolvedBase, input.sourcePath);
      const relSource = relative(resolvedBase, absSource);
      if (
        relSource.startsWith('..') ||
        isAbsolute(relSource) ||
        relSource === ''
      ) {
        return errorResult(
          'PERMISSION_DENIED',
          `Source path '${input.sourcePath}' is invalid or escapes workspace boundary`,
        );
      }

      const absDest = resolve(resolvedBase, input.destPath);
      const relDest = relative(resolvedBase, absDest);
      if (relDest.startsWith('..') || isAbsolute(relDest) || relDest === '') {
        return errorResult(
          'PERMISSION_DENIED',
          `Destination path '${input.destPath}' is invalid or escapes workspace boundary`,
        );
      }

      if (!existsSync(absSource)) {
        return errorResult(
          'NOT_FOUND',
          `Source path '${input.sourcePath}' does not exist`,
        );
      }

      if (existsSync(absDest)) {
        if (!input.overwrite) {
          return errorResult(
            'VALIDATION_ERROR',
            `Destination path '${input.destPath}' already exists. Set overwrite to true to replace it.`,
          );
        }
        rmSync(absDest, { recursive: true, force: true });
      }

      // Ensure destination directory exists
      mkdirSync(dirname(absDest), { recursive: true });

      try {
        renameSync(absSource, absDest);
      } catch (renameErr) {
        if (
          renameErr instanceof Error &&
          'code' in renameErr &&
          renameErr.code === 'EXDEV'
        ) {
          cpSync(absSource, absDest, { recursive: true });
          rmSync(absSource, { recursive: true, force: true });
        } else {
          throw renameErr;
        }
      }

      return successResult({
        sourcePath: input.sourcePath,
        destPath: input.destPath,
        moved: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return errorResult(
          'PERMISSION_DENIED',
          `Cannot move '${input.sourcePath}' to '${input.destPath}': ${message}`,
        );
      }
      return errorResult(
        'INTERNAL_ERROR',
        `Failed to move '${input.sourcePath}' to '${input.destPath}': ${message}`,
      );
    }
  },
};
