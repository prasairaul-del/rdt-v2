import type { StepContext } from '../types';

/**
 * Step: Loading project instructions and configuration.
 */
export async function contextStep(context: StepContext): Promise<void> {
  const { executionContext, logger, config } = context;

  logger.info('Loading project context...');
  await executionContext.load();
  
  // Update config reference in context if it changed
  if (executionContext.config) {
    config.rdtConfig = executionContext.config;
  }
  
  logger.info('Context loaded');
}
