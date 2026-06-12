import { existsSync, mkdirSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { errorResult, successResult } from '../core/result';
import type { Tool } from './types';

export interface MakeDirectoryInput {
  path: string;
  recursive?: boolean;
  cwd?: string;
}

export interface MakeDirectoryOutput {
  path: string;
  created: boolean;
}

export const makeDirectoryTool: Tool<MakeDirectoryInput, MakeDirectoryOutput> =
  {
    name: 'make_directory',
    description: 'Creates a new directory safely',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the directory' },
        recursive: {
          type: 'boolean',
          description: 'Create parent directories recursively (default: true)',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for path resolution',
        },
      },
      required: ['path'],
    },

    async execute(input: MakeDirectoryInput) {
      try {
        const base = input.cwd ?? process.cwd();
        const absPath = resolve(base, input.path);
        const resolvedBase = resolve(base);
        const rel = relative(resolvedBase, absPath);

        if (rel.startsWith('..') || isAbsolute(rel)) {
          return errorResult(
            'PERMISSION_DENIED',
            `Path '${input.path}' escapes workspace boundary`,
          );
        }

        if (existsSync(absPath)) {
          const stat = statSync(absPath);
          if (!stat.isDirectory()) {
            return errorResult(
              'VALIDATION_ERROR',
              `Path '${input.path}' exists and is not a directory`,
            );
          }
          return successResult({
            path: input.path,
            created: false,
          });
        }

        mkdirSync(absPath, { recursive: input.recursive ?? true });

        return successResult({
          path: input.path,
          created: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('EACCES') || message.includes('EPERM')) {
          return errorResult(
            'PERMISSION_DENIED',
            `Cannot create directory '${input.path}': ${message}`,
          );
        }
        return errorResult(
          'INTERNAL_ERROR',
          `Failed to create directory '${input.path}': ${message}`,
        );
      }
    },
  };
