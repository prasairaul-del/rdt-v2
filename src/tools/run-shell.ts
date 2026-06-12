import { spawn } from 'node:child_process';
import { defaultLogger } from '../core/logger';
import { errorResult, successResult, type ToolResult } from '../core/result';
import { wrapCommand } from './process-isolation';
import type { Tool } from './types';

export interface RunShellInput {
  command: string;
  timeoutMs?: number;
  allowBlocked?: boolean;
  /** Override working directory (avoids process.cwd() dependency) */
  cwd?: string;
  logger?: any;
}

export interface RunShellOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf / ',
  'rm -rf /*',
  'rm -rf .*',
  'format ',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'dd if=',
  ':(){ :|:& };:',
  '> /dev/sda',
  'sudo rm',
  'sudo dd',
  'sudo shutdown',
  'sudo reboot',
];

const BLOCKED_PATTERNS = [
  /\bcurl\b.*\|\s*(bash|sh|zsh)\b/i,
  /\bwget\b.*\|\s*(bash|sh|zsh)\b/i,
  /del\s+\/f\s+\/s/i,
  /rmdir\s+\/s\b/i,
];

const RISKY_PATTERNS = [
  /\bnpm\s+(install|add|i)(\s|$)/,
  /\bbun\s+(install|add|i)(\s|$)/,
  /\byarn\s+(add|install)(\s|$)/,
  /\bpnpm\s+(install|add)(\s|$)/,
  /\bgit\s+(push|commit)\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f[du]/,
  /\bmigration\s+(apply|run|migrate)\b/,
  /\bdrop\s+(table|database|schema)\b/i,
  /\bdelete\s+from\b/i,
];

function isBlocked(command: string): string | null {
  const trimmed = command.trim().toLowerCase();
  for (const blocked of BLOCKED_COMMANDS) {
    if (trimmed.includes(blocked)) {
      return `Command '${blocked}' is blocked for safety reasons.`;
    }
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return 'Piped shell download commands are blocked for safety.';
    }
  }
  return null;
}

function isRisky(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  return RISKY_PATTERNS.some((p) => p.test(trimmed));
}

export const runShellTool: Tool<RunShellInput, RunShellOutput> = {
  name: 'run_shell',
  description:
    'Runs a safe shell command with timeout. Blocks dangerous commands.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
      },
      allowBlocked: {
        type: 'boolean',
        description: 'Override block for risky commands (default: false)',
      },
    },
    required: ['command'],
  },

  async execute(input: RunShellInput) {
    const timeout = input.timeoutMs ?? 30_000;
    const logger = input.logger ?? defaultLogger;

    // Check blocked commands
    const blockedMsg = isBlocked(input.command);
    if (blockedMsg && !input.allowBlocked) {
      return errorResult('PERMISSION_DENIED', blockedMsg, [
        'Use allowBlocked: true if you explicitly need this command',
        'Consider a safer alternative',
      ]);
    }

    // Warn about risky commands
    if (isRisky(input.command) && !input.allowBlocked) {
      return errorResult(
        'PERMISSION_DENIED',
        `Command '${input.command.split(/\s+/)[0]} ...' is risky and requires allowBlocked: true.`,
        [
          'Set allowBlocked: true to run this command',
          'Verify the command is safe before running',
        ],
      );
    }

    try {
      const cwd = input.cwd ?? process.cwd();
      const isolatedCommand = wrapCommand(input.command, cwd);

      return new Promise<ToolResult<RunShellOutput>>((resolvePromise) => {
        const child = spawn(isolatedCommand, [], {
          shell: true,
          cwd,
        });

        let stdoutData = '';
        let stderrData = '';
        let stdoutBuffer = '';
        let stderrBuffer = '';

        child.stdout?.on('data', (chunk) => {
          const data = chunk.toString();
          stdoutData += data;
          stdoutBuffer += data;
          const lines = stdoutBuffer.split(/\r?\n/);
          stdoutBuffer = lines.pop() || '';
          for (const line of lines) {
            logger.info(line);
          }
        });

        child.stderr?.on('data', (chunk) => {
          const data = chunk.toString();
          stderrData += data;
          stderrBuffer += data;
          const lines = stderrBuffer.split(/\r?\n/);
          stderrBuffer = lines.pop() || '';
          for (const line of lines) {
            logger.error(line);
          }
        });

        let killed = false;
        const timeoutTimer = setTimeout(() => {
          killed = true;
          child.kill();
        }, timeout);

        child.on('error', (err) => {
          clearTimeout(timeoutTimer);
          resolvePromise(
            errorResult(
              'COMMAND_FAILED',
              `Shell command failed to start process: ${err.message}`,
            ),
          );
        });

        child.on('exit', (code, signal) => {
          clearTimeout(timeoutTimer);
          if (stdoutBuffer) logger.info(stdoutBuffer);
          if (stderrBuffer) logger.error(stderrBuffer);

          if (killed || signal === 'SIGTERM') {
            resolvePromise(
              errorResult('TIMEOUT', `Command timed out after ${timeout}ms`),
            );
            return;
          }

          const finalExitCode = code ?? 1;

          resolvePromise(
            successResult({
              stdout: stdoutData.trim(),
              stderr: stderrData.trim(),
              exitCode: finalExitCode,
            }),
          );
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult('COMMAND_FAILED', `Shell command failed: ${message}`);
    }
  },
};
