import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';

export interface WriteFileInput {
  path: string;
  content: string;
  allowOverwrite?: boolean;
}

export interface WriteFileOutput {
  path: string;
  size: number;
  created: boolean;
}

export const writeFileTool: Tool<WriteFileInput, WriteFileOutput> = {
  name: 'write_file',
  description: 'Writes a new file. Only allowed for new files or explicitly approved overwrites.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file' },
      content: { type: 'string', description: 'File content' },
      allowOverwrite: { type: 'boolean', description: 'Allow overwriting existing file (default: false)' },
    },
    required: ['path', 'content'],
  },

  async execute(input: WriteFileInput) {
    try {
      const absPath = resolve(process.cwd(), input.path);
      const alreadyExists = existsSync(absPath);

      if (alreadyExists && !input.allowOverwrite) {
        return errorResult(
          'VALIDATION_ERROR',
          `File '${input.path}' already exists. Use allowOverwrite: true or apply_patch instead.`,
          ['Set allowOverwrite: true to overwrite', 'Use apply_patch for surgical edits'],
        );
      }

      // Create directory if needed
      mkdirSync(dirname(absPath), { recursive: true });

      writeFileSync(absPath, input.content, 'utf-8');
      const size = Buffer.byteLength(input.content, 'utf-8');

      return successResult({
        path: input.path,
        size,
        created: !alreadyExists,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return errorResult('PERMISSION_DENIED', `Cannot write '${input.path}': ${message}`);
      }
      return errorResult('INTERNAL_ERROR', `Failed to write '${input.path}': ${message}`);
    }
  },
};
