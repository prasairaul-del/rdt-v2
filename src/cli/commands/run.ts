import { resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../../config/load-config';
import { TaskRunner } from '../../core/task-runner';

export function createRunCommand(): Command {
  return new Command('run')
    .description('Run a coding task')
    .argument('[task...]', 'The coding task description')
    .option('--no-rollback', 'Skip rollback on failure')
    .action(async (taskArgs: string[], options: { rollback?: boolean }) => {
      const task = taskArgs.join(' ');
      if (!task) {
        console.error('Error: task description is required');
        console.log('Usage: rdt "fix the failing test"');
        process.exit(1);
      }

      const projectRoot = process.cwd();
      console.log('\n  RDT v2 — Running task');
      console.log(`  ${'─'.repeat(40)}`);
      console.log(`  Request: ${task}\n`);

      try {
        const configResult = loadConfig(projectRoot);
        if (!configResult.loaded) {
          console.warn(
            `\n\x1b[33mWarning: Configuration file not found at: ${configResult.path}\x1b[0m`,
          );
          console.warn(
            'Please run \x1b[36mrdt init\x1b[0m to configure your project first, or continue using default configurations.\n',
          );
        }

        const runner = new TaskRunner({
          projectRoot,
          rdtConfig: configResult.config,
        });

        const result = await runner.run(task);

        // Output result
        console.log(`\n  ${'─'.repeat(40)}`);
        console.log(`  Status: ${result.state.status}`);
        console.log(`  Task ID: ${result.taskId}`);
        console.log(`  ${result.summary}`);

        if (result.diff) {
          const fileCount = result.diff.match(/^diff --git/g)?.length ?? 0;
          if (fileCount > 0) {
            console.log(`  Files changed: ${fileCount}`);
          }
        }

        if (result.providerSummary) {
          console.log('\n  Provider usage:');
          for (const line of result.providerSummary.split('\n')) {
            console.log(`    ${line}`);
          }
        }

        if (result.error) {
          console.log(`\n  Error: ${result.error}`);
        }

        // Exit with proper code
        if (!result.success) {
          process.exit(1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n  Fatal error: ${message}`);
        process.exit(1);
      }
    });
}
