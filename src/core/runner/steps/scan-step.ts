import type { StepContext } from '../types';

/**
 * Step: Scanning the repository to build a map and search index.
 */
export async function scanStep(context: StepContext): Promise<void> {
  const { executionContext, logger } = context;

  logger.info('Scanning repository...');
  await executionContext.scan();
  await executionContext.indexForSearch();
  logger.info('Repository scanned');
}
