import { readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';

export interface ReadFileInput {
  path: string;
  maxBytes?: number;
  encoding?: BufferEncoding;
}

export interface ReadFileOutput {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1MB

export const readFileTool: Tool<ReadFileInput, ReadFileOutput> = {
  name: 'read_file',
  description: 'Reads a file safely with size limits',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to file' },
      maxBytes: { type: 'number', description: 'Maximum bytes to read (default: 1MB)' },
      encoding: { type: 'string', description: 'File encoding (default: utf-8)' },
    },
    required: ['path'],
  },

  async execute(input: ReadFileInput) {
    try {
      const absPath = resolve(process.cwd(), input.path);
      const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

      if (!existsSync(absPath)) {
        return errorResult('NOT_FOUND', `File '${input.path}' does not exist`, [
          'Check the file path is correct',
          'Search for similar files',
          'Refresh the repo map',
        ]);
      }

      const stat = statSync(absPath);
      if (stat.isDirectory()) {
        return errorResult('VALIDATION_ERROR', `'${input.path}' is a directory, not a file`);
      }

      if (stat.size > maxBytes) {
        const fd = openSync(absPath, 'r');
        const buf = Buffer.alloc(maxBytes);
        readSync(fd, buf, 0, maxBytes, 0);
        closeSync(fd);
        const content = buf.toString(input.encoding || 'utf-8');
        return successResult({ path: input.path, content, size: stat.size, truncated: true });
      }

      const content = readFileSync(absPath, input.encoding || 'utf-8');
      return successResult({ path: input.path, content, size: stat.size, truncated: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('EACCES') || message.includes('EPERM')) {
        return errorResult('PERMISSION_DENIED', `Cannot read '${input.path}': ${message}`);
      }
      return errorResult('INTERNAL_ERROR', `Failed to read '${input.path}': ${message}`);
    }
  },
};
