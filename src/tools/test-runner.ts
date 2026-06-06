import { execSync } from 'node:child_process';
import { detectCommands } from '../project-context/command-detector';
import type { Tool } from './types';
import { successResult, errorResult } from '../core/result';
import { wrapCommand } from './process-isolation';

export interface TestRunnerInput {
  command?: string;
  testPath?: string;
  timeoutMs?: number;
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
      command: { type: 'string', description: 'Override: specific command to run' },
      testPath: { type: 'string', description: 'Specific test file or path filter' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default: 120000)' },
    },
  },

  async execute(input: TestRunnerInput) {
    try {
      const timeout = input.timeoutMs ?? 120_000;
      let command: string;

      if (input.command) {
        command = input.command;
      } else {
        const detected = detectCommands(process.cwd());
        if (!detected.testCommand) {
          return errorResult('NOT_FOUND', 'No test command detected. Use command override.', [
            'Specify a command explicitly',
            'Add a "test" script to package.json',
            'Check for test configuration files',
          ]);
        }
        command = detected.testCommand;
      }

      // Append test path if specified
      if (input.testPath) {
        command = `${command} ${input.testPath}`;
      }

      try {
        const isolatedCommand = wrapCommand(command, process.cwd());
        const stdout = execSync(isolatedCommand, {
          encoding: 'utf-8',
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        });

        return successResult({
          command,
          stdout: stdout.trim(),
          stderr: '',
          exitCode: 0,
          passed: true,
        });
      } catch (err) {
        const error = err as Error & { code?: number; stdout?: string; stderr?: string; killed?: boolean };

        if (error.killed) {
          return errorResult('TIMEOUT', `Test command timed out after ${timeout}ms`);
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
