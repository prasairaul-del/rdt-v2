import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';

export interface SearchFilesInput {
  pattern: string;
  includeContent?: boolean;
  filePattern?: string;
  maxResults?: number;
  cwd?: string;
}

export interface SearchFilesOutput {
  results: Array<{
    path: string;
    matches: Array<{ line: number; content: string }>;
  }>;
  totalMatches: number;
}

const DEFAULT_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'target',
  'venv', '__pycache__',
]);

function shouldIgnore(relPath: string): boolean {
  const segments = relPath.split(/[/\\]/);
  for (const pattern of DEFAULT_IGNORE) {
    if (segments.some((s) => s === pattern)) return true;
  }
  if (segments.some((s) => s.startsWith('.') && !s.startsWith('..'))) return true;
  return false;
}

export const searchFilesTool: Tool<SearchFilesInput, SearchFilesOutput> = {
  name: 'search_files',
  description: 'Searches filenames and optionally file contents',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Search pattern (case-insensitive substring)' },
      includeContent: { type: 'boolean', description: 'Search file contents too (default: false)' },
      filePattern: { type: 'string', description: 'Only search files matching this glob/extension' },
      maxResults: { type: 'number', description: 'Max results (default: 50)' },
      cwd: { type: 'string', description: 'Working directory relative to project root' },
    },
    required: ['pattern'],
  },

  async execute(input: SearchFilesInput) {
    try {
      const root = resolve(process.cwd(), input.cwd || '.');
      const maxResults = input.maxResults ?? 50;
      const patternLower = input.pattern.toLowerCase();
      const results: SearchFilesOutput['results'] = [];
      let totalMatches = 0;

      function walk(dir: string) {
        if (totalMatches >= maxResults) return;
        let files: string[];
        try {
          files = readdirSync(dir);
        } catch {
          return;
        }
        for (const file of files) {
          if (totalMatches >= maxResults) break;
          const fullPath = join(dir, file);
          const rel = relative(process.cwd(), fullPath);
          if (shouldIgnore(rel)) continue;

          let stat: ReturnType<typeof statSync>;
          try {
            stat = statSync(fullPath);
          } catch {
            continue;
          }

          if (stat.isDirectory()) {
            walk(fullPath);
            continue;
          }

          // Check file pattern filter
          if (input.filePattern && !file.includes(input.filePattern.replace(/\*/g, ''))) {
            continue;
          }

          const fileMatches: Array<{ line: number; content: string }> = [];

          // Check filename
          if (file.toLowerCase().includes(patternLower)) {
            fileMatches.push({ line: 0, content: `filename matches: ${file}` });
          }

          // Check content
          if (input.includeContent && stat.size < 1024 * 1024) {
            try {
              const content = readFileSync(fullPath, 'utf-8');
              const lines = content.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(patternLower)) {
                  fileMatches.push({ line: i + 1, content: lines[i].trim() });
                  if (fileMatches.length >= 5) break; // limit per file
                }
              }
            } catch {
              // skip binary/unreadable
            }
          }

          if (fileMatches.length > 0) {
            results.push({ path: rel, matches: fileMatches });
            totalMatches += fileMatches.length;
          }
        }
      }

      walk(root);
      return successResult({ results, totalMatches });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult('INTERNAL_ERROR', `Search failed: ${message}`);
    }
  },
};
