import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentRegistry } from '../../../agents/agent-registry';
import type { EditorAgentConfig } from '../../../agents/editor-agent';
import type { AgentInput, EditResult } from '../../../agents/types';
import { Sandbox } from '../../../tools/sandbox';
import { testRunnerTool } from '../../../tools/test-runner';
import { addTaskError } from '../../task-state';
import type { StepContext } from '../types';

/**
 * Step: Editing files to implement the plan.
 */
export async function editStep(context: StepContext): Promise<void> {
  const { state, executionContext, router, logger, config, sandboxCwd } =
    context;

  if (!sandboxCwd) {
    throw new Error('Sandbox CWD is required for edit step');
  }

  const agentContext = executionContext.buildAgentContext(state.request);

  const editor = agentRegistry.get<AgentInput, EditResult>('editor');
  if (!editor) {
    addTaskError(state, 'Editor agent not found', 'AGENT_NOT_FOUND', 'fatal');
    return;
  }

  const projectRoot = config.projectRoot ?? sandboxCwd;

  logger.info('Starting parallel edit trials to evaluate best fix...');

  if (!router) {
    addTaskError(
      state,
      'Editor step requires a provider router',
      'MISSING_ROUTER',
      'fatal',
    );
    return;
  }

  const editorConfig: EditorAgentConfig = {
    router,
    policyName: config.rdtConfig?.agents?.editor?.model_policy ?? 'code_strong',
    tools: [],
    cwd: sandboxCwd,
  };

  const originalCwd = process.cwd();
  const plan = state.plan;
  if (!plan) {
    addTaskError(state, 'Edit step requires a plan', 'PLAN_MISSING', 'fatal');
    return;
  }

  // --- TRIAL 1 ---
  const sandbox1 = new Sandbox(projectRoot, `${state.id}-trial-1`);
  let trial1Passed = false;
  let trial1Result: EditResult | null = null;

  try {
    await sandbox1.init();
    process.chdir(sandbox1.sandboxPath);
    logger.info(`Running Edit Trial 1 in: ${sandbox1.sandboxPath}`);
    const res = await editor.execute(
      { task: state, plan, project: agentContext },
      { ...editorConfig, cwd: sandbox1.sandboxPath },
    );
    if (res.success && res.result) {
      trial1Result = res.result;
      const testRes = await testRunnerTool.execute({
        cwd: sandbox1.sandboxPath,
      });
      trial1Passed = testRes.success && (testRes.data?.passed ?? false);
      logger.info(`Trial 1 test result: ${trial1Passed ? 'PASSED' : 'FAILED'}`);
    }
  } catch (err) {
    logger.warn('Edit Trial 1 failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // --- TRIAL 2 ---
  const sandbox2 = new Sandbox(projectRoot, `${state.id}-trial-2`);
  let trial2Passed = false;
  let trial2Result: EditResult | null = null;

  try {
    await sandbox2.init();
    process.chdir(sandbox2.sandboxPath);
    logger.info(`Running Edit Trial 2 in: ${sandbox2.sandboxPath}`);
    const res = await editor.execute(
      { task: state, plan, project: agentContext },
      { ...editorConfig, cwd: sandbox2.sandboxPath },
    );
    if (res.success && res.result) {
      trial2Result = res.result;
      const testRes = await testRunnerTool.execute({
        cwd: sandbox2.sandboxPath,
      });
      trial2Passed = testRes.success && (testRes.data?.passed ?? false);
      logger.info(`Trial 2 test result: ${trial2Passed ? 'PASSED' : 'FAILED'}`);
    }
  } catch (err) {
    logger.warn('Edit Trial 2 failed:', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Restore directory back to main sandbox
  process.chdir(originalCwd);

  // Evaluate trials
  let selectedSandbox = sandbox1;
  let selectedResult = trial1Result;

  if (trial2Passed && !trial1Passed) {
    logger.info('Selecting Trial 2 (tests passed, Trial 1 failed)');
    selectedSandbox = sandbox2;
    selectedResult = trial2Result;
  } else {
    logger.info('Selecting Trial 1 as primary candidate');
  }

  if (selectedResult?.changedFiles) {
    const editResult = selectedResult;
    state.changedFiles = [
      ...new Set([...state.changedFiles, ...editResult.changedFiles]),
    ];

    if (state.baselines) {
      state.baselines.rdtTouchedFiles = [
        ...new Set([
          ...state.baselines.rdtTouchedFiles,
          ...editResult.changedFiles,
        ]),
      ];
    }

    // Copy files from winner sandbox to main sandboxCwd
    for (const file of editResult.changedFiles) {
      const srcFile = join(selectedSandbox.sandboxPath, file);
      const destFile = join(sandboxCwd, file);
      if (existsSync(srcFile)) {
        mkdirSync(dirname(destFile), { recursive: true });
        copyFileSync(srcFile, destFile);
      }
    }

    logger.info('Selected trial edits applied to sandbox', {
      files: editResult.changedFiles.length,
      needsReview: editResult.needsReview,
    });
  } else {
    addTaskError(
      state,
      'All editor trials failed',
      'EDITOR_FAILED',
      'recoverable',
    );
  }

  // Cleanup trial sandboxes
  await sandbox1.destroy();
  await sandbox2.destroy();
}
