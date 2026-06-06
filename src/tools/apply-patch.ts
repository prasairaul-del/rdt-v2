import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';

export interface ApplyPatchInput {
  patch: string;
}

export interface ApplyPatchOutput {
  file: string;
  hunksApplied: number;
  linesAdded: number;
  linesRemoved: number;
}

interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ type: 'context' | 'add' | 'remove'; text: string }>;
}

interface ParsedPatch {
  file: string;
  hunks: ParsedHunk[];
}

/**
 * Parse a unified diff patch string.
 * Format:
 *   --- a/<file>
 *   +++ b/<file>
 *   @@ -start,count +start,count @@
 *    context
 *   -removed
 *   +added
 */
function parsePatch(patch: string): ParsedPatch | null {
  const lines = patch.split('\n');
  let file = '';
  const hunks: ParsedHunk[] = [];
  let currentHunk: ParsedHunk | null = null;
  let inHunk = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    // File headers
    if (line.startsWith('--- a/')) continue; // skip old file
    if (line.startsWith('+++ b/')) {
      file = line.slice(6); // '+++ b/'.length = 6
      continue;
    }

    // Hunk header
    const hunkMatch = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (hunkMatch) {
      if (currentHunk && inHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: hunkMatch[2] ? parseInt(hunkMatch[2], 10) : 1,
        newStart: parseInt(hunkMatch[3], 10),
        newCount: hunkMatch[4] ? parseInt(hunkMatch[4], 10) : 1,
        lines: [],
      };
      inHunk = true;
      continue;
    }

    if (currentHunk && inHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', text: line.slice(1) });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'remove', text: line.slice(1) });
      } else {
        // Context line (starts with space or empty)
        currentHunk.lines.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
      }
    }
  }

  // Push last hunk
  if (currentHunk && inHunk) {
    hunks.push(currentHunk);
  }

  if (!file || hunks.length === 0) return null;
  return { file, hunks };
}

/**
 * Apply parsed hunks to file content.
 */
function applyHunks(
  content: string,
  hunks: ParsedHunk[],
): { result: string; linesAdded: number; linesRemoved: number } | null {
  const fileLines = content.split('\n');
  // Work on a copy with line-by-line tracking
  const resultLines: string[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;

  let currentLine = 0; // 0-indexed position in fileLines

  for (const hunk of hunks) {
    const hunkOldStart = hunk.oldStart - 1; // convert to 0-indexed

    // Copy lines before this hunk
    while (currentLine < hunkOldStart && currentLine < fileLines.length) {
      resultLines.push(fileLines[currentLine]);
      currentLine++;
    }

    // Verify and apply hunk
    let hunkPos = 0;
    const hunkLines = hunk.lines;
    const hunkFilePos = currentLine;

    // Verify context before applying
    let contextValid = true;
    for (let i = 0; i < hunkLines.length; i++) {
      const hl = hunkLines[i];
      if (hl.type === 'context' || hl.type === 'remove') {
        const fileIdx = hunkFilePos + hunkPos;
        if (fileIdx >= fileLines.length) {
          contextValid = false;
          break;
        }
        // Compare trimmed for whitespace flexibility
        const fileLine = fileLines[fileIdx];
        if (fileLine.trim() !== hl.text.trim()) {
          // Try exact match
          if (fileLine !== hl.text) {
            contextValid = false;
            break;
          }
        }
        if (hl.type === 'remove') {
          hunkPos++;
          totalRemoved++;
        } else {
          hunkPos++;
        }
      } else {
        // add line — don't consume from file
        totalAdded++;
      }
    }

    if (!contextValid) {
      return null; // Context mismatch
    }

    // Write result for this hunk
    let fileOffset = 0;
    for (const hl of hunkLines) {
      if (hl.type === 'context') {
        resultLines.push(fileLines[hunkFilePos + fileOffset]);
        fileOffset++;
      } else if (hl.type === 'remove') {
        fileOffset++;
      } else {
        resultLines.push(hl.text);
      }
    }

    // Advance past the hunk in the file
    currentLine = hunkFilePos + fileOffset;
  }

  // Copy remaining lines
  while (currentLine < fileLines.length) {
    resultLines.push(fileLines[currentLine]);
    currentLine++;
  }

  // Remove trailing empty line if original didn't have one
  if (!content.endsWith('\n') && resultLines[resultLines.length - 1] === '') {
    resultLines.pop();
  }

  return { result: resultLines.join('\n'), linesAdded: totalAdded, linesRemoved: totalRemoved };
}

export const applyPatchTool: Tool<ApplyPatchInput, ApplyPatchOutput> = {
  name: 'apply_patch',
  description: 'Applies a unified diff patch to a file. Preserves unrelated content.',
  inputSchema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Unified diff patch content' },
    },
    required: ['patch'],
  },

  async execute(input: ApplyPatchInput) {
    try {
      const parsed = parsePatch(input.patch);
      if (!parsed) {
        return errorResult(
          'VALIDATION_ERROR',
          'Could not parse patch. Expected unified diff format.',
          [
            'Ensure patch starts with --- a/<file> and +++ b/<file>',
            'Include @@ hunk headers with line numbers',
            'Use - for removed lines and + for added lines',
          ],
        );
      }

      const absPath = resolve(process.cwd(), parsed.file);
      if (!existsSync(absPath)) {
        return errorResult('NOT_FOUND', `File '${parsed.file}' does not exist`, [
          'Check the file path in the patch header',
          'Create the file first with write_file if needed',
        ]);
      }

      const content = readFileSync(absPath, 'utf-8');
      const applied = applyHunks(content, parsed.hunks);

      if (!applied) {
        return errorResult(
          'VALIDATION_ERROR',
          `Patch does not apply to '${parsed.file}'. Context lines did not match.`,
          [
            'The file may have been modified since the patch was created',
            'Check the hunk line numbers in the @@ headers',
            'Re-read the file and regenerate the patch',
          ],
        );
      }

      writeFileSync(absPath, applied.result, 'utf-8');

      return successResult({
        file: parsed.file,
        hunksApplied: parsed.hunks.length,
        linesAdded: applied.linesAdded,
        linesRemoved: applied.linesRemoved,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult('INTERNAL_ERROR', `Failed to apply patch: ${message}`);
    }
  },
};
