import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { TaskLogStore } from '../../storage/task-log-store';

export function createUndoCommand(): Command {
  return new Command('undo')
    .description('Undo/Rollback changes made by a task')
    .argument('<taskId>', 'The ID of the task to undo (e.g. task_a1b2c3d4)')
    .action(async (taskId: string) => {
      const projectRoot = process.cwd();
      const dbPath = resolve(projectRoot, '.rdt', 'tasks.db');

      console.log(`\n  RDT v2 — Undoing Task: ${taskId}`);
      console.log(`  ${'─'.repeat(40)}`);

      try {
        let originalRequest = '';
        if (existsSync(dbPath)) {
          const logStore = new TaskLogStore(dbPath);
          const log = logStore.getLog(taskId);
          if (log) {
            originalRequest = log.request;
            console.log(`  Found task log: "${originalRequest}"`);
          }
        }

        // 1. Check if a feature branch exists for this task
        const branchName = `rdt/task-${taskId}`;
        let branchExists = false;
        try {
          const branches = execSync('git branch --list', { encoding: 'utf-8' });
          if (branches.includes(branchName)) {
            branchExists = true;
          }
        } catch {
          // ignore
        }

        if (branchExists) {
          console.log(`  Detected feature branch: ${branchName}`);

          // Check if we are currently on that branch
          let currentBranch = '';
          try {
            currentBranch = execSync('git branch --show-current', {
              encoding: 'utf-8',
            }).trim();
          } catch {
            // ignore
          }

          if (currentBranch === branchName) {
            // Need to checkout away from it first
            // Find default branch
            let targetBranch = 'main';
            try {
              const branches = execSync('git branch --list', {
                encoding: 'utf-8',
              });
              if (!branches.includes('main') && branches.includes('master')) {
                targetBranch = 'master';
              }
            } catch {
              // ignore
            }
            console.log(
              `  Currently on feature branch. Checking out to '${targetBranch}'...`,
            );
            execSync(`git checkout ${targetBranch}`, { stdio: 'inherit' });
          }

          console.log(`  Deleting feature branch '${branchName}'...`);
          execSync(`git branch -D ${branchName}`, { stdio: 'inherit' });
          console.log(
            `\n  \x1b[32mSuccess: Deleted feature branch and discarded changes for task ${taskId}.\x1b[0m\n`,
          );
          return;
        }

        // 2. Fallback: Check if there is a commit directly in history to revert
        console.log(`  Searching git history for task ID: ${taskId}...`);
        let commitHash = '';
        try {
          commitHash = execSync(
            `git log --grep="rdt \\[${taskId}\\]" --format="%H" -n 1`,
            { encoding: 'utf-8' },
          ).trim();
        } catch {
          // ignore
        }

        if (commitHash) {
          console.log(`  Found commit to revert: ${commitHash.slice(0, 8)}`);
          console.log('  Running git revert...');
          execSync(`git revert ${commitHash} --no-edit`, { stdio: 'inherit' });
          console.log(
            `\n  \x1b[32mSuccess: Reverted commit ${commitHash.slice(0, 8)} for task ${taskId}.\x1b[0m\n`,
          );
          return;
        }

        console.error(
          `\n  \x1b[31mError: No branch or commit found for task ${taskId}.\x1b[0m`,
        );
        console.error(
          '  Make sure the task ID is correct and that git changes were committed.\n',
        );
        process.exit(1);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n  Fatal error during rollback: ${message}`);
        process.exit(1);
      }
    });
}
