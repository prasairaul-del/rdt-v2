import type { StepContext } from '../types';

/**
 * Step: Capturing the initial state of the repository.
 */
export async function baselineStep(context: StepContext): Promise<void> {
  const { state, executionContext, logger } = context;

  logger.info('Capturing git baseline...');
  state.baselines = await executionContext.captureBaseline();
  logger.info('Baseline captured', {
    hasGit: !!state.baselines?.headHash,
    dirtyFiles: state.baselines?.dirtyFiles.length ?? 0,
  });
}
