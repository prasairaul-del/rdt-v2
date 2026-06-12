import { gitDiffTool } from '../../../tools/git-diff';
import type { StepContext } from '../types';

/**
 * Step: Finalizing the task, capturing the final diff.
 */
export async function finalizeStep(context: StepContext): Promise<void> {
  const { state, sandboxCwd, logger } = context;

  if (!sandboxCwd) {
    throw new Error('Sandbox CWD is required for finalize step');
  }

  const diffResult = await gitDiffTool.execute({ cwd: sandboxCwd });
  if (diffResult.success && diffResult.data) {
    state.diff = diffResult.data.diff;
  }
}
