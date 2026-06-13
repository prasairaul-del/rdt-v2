import { spawn } from 'node:child_process';
import { type TaskLogger, defaultLogger } from '../core/logger';
import { type ToolResult, errorResult, successResult } from '../core/result';
import { detectCommands } from '../project-context/command-detector';
import { wrapCommand } from './process-isolation';
import type { Tool } from './types';

export interface TestRunnerInput {
  command?: string;
  testPath?: string;
  timeoutMs?: number;
  /** Override working directory (avoids process.cwd() dependency) */
  cwd?: string;
  logger?: TaskLogger;
}

export interface TestRunnerOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  passed: boolean;
}

export const testRunnerTool: Tool<TestRunnerInput, TestRunnerOutput> = {
  name: 'test_runner',
  description: 'Runs the detected test/lint/typecheck command for the project',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Override: specific command to run',
      },
      testPath: {
        type: 'string',
        description: 'Specific test file or path filter',
      },
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 120000)',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for running tests',
      },
    },
  },

  async execute(input: TestRunnerInput) {
    try {
      const timeout = input.timeoutMs ?? 120_000;
      const cwd = input.cwd ?? process.cwd();
      const logger = input.logger ?? defaultLogger;
      let command: string;

      if (input.command) {
        command = input.command;
      } else {
        const detected = detectCommands(cwd);
        if (!detected.testCommand) {
          return errorResult(
            'NOT_FOUND',
            'No test command detected. Use command override.',
            [
              'Specify a command explicitly',
              'Add a "test" script to package.json',
              'Check for test configuration files',
            ],
          );
        }
        command = detected.testCommand;
      }

      // Append test path if specified
      if (input.testPath) {
        command = `${command} ${input.testPath}`;
      }

      try {
        const isolatedCommand = wrapCommand(command, cwd);

        return new Promise<ToolResult<TestRunnerOutput>>((resolvePromise) => {
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
                'INTERNAL_ERROR',
                `Test runner failed to start process: ${err.message}`,
              ),
            );
          });

          child.on('exit', (code, signal) => {
            clearTimeout(timeoutTimer);
            if (stdoutBuffer) logger.info(stdoutBuffer);
            if (stderrBuffer) logger.error(stderrBuffer);

            if (killed || signal === 'SIGTERM') {
              resolvePromise(
                errorResult(
                  'TIMEOUT',
                  `Test command timed out after ${timeout}ms`,
                ),
              );
              return;
            }

            const finalExitCode = code ?? 1;

            resolvePromise(
              successResult({
                command,
                stdout: stdoutData.trim(),
                stderr: stderrData.trim(),
                exitCode: finalExitCode,
                passed: finalExitCode === 0,
              }),
            );
          });
        });
      } catch (err) {
        const error = err as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };

        if (error.killed) {
          return errorResult(
            'TIMEOUT',
            `Test command timed out after ${timeout}ms`,
          );
        }

        return successResult({
          command,
          stdout: error.stdout?.toString().trim() || '',
          stderr: error.stderr?.toString().trim() || error.message,
          exitCode: typeof error.code === 'number' ? error.code : 1,
          passed: false,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult('INTERNAL_ERROR', `Test runner failed: ${message}`);
    }
  },
};
