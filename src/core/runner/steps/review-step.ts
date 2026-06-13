import { agentRegistry } from '../../../agents/agent-registry';
import type { ReviewerAgentConfig } from '../../../agents/reviewer-agent';
import type { AgentInput, ReviewResult } from '../../../agents/types';
import type { ProviderRouter } from '../../../router/provider-router';
import { gitDiffTool } from '../../../tools/git-diff';
import type { StepContext } from '../types';

/**
 * Step: Reviewing changes made by the editor.
 * Returns true if approved, false otherwise.
 */
export async function reviewStep(context: StepContext): Promise<boolean> {
  const { state, executionContext, router, logger, config, sandboxCwd } =
    context;

  if (!sandboxCwd) {
    throw new Error('Sandbox CWD is required for review step');
  }

  const agentContext = executionContext.buildAgentContext(state.request);

  // Capture diff from the sandbox directory explicitly
  const diffResult = await gitDiffTool.execute({ cwd: sandboxCwd });
  if (diffResult.success && diffResult.data) {
    state.diff = diffResult.data.diff;
  }

  const reviewer = agentRegistry.get<AgentInput, ReviewResult>('reviewer');
  if (!reviewer) {
    logger.warn('Reviewer agent not found — auto-approving');
    return true;
  }

  const reviewerConfig: ReviewerAgentConfig = {
    router: router ?? ({} as ProviderRouter),
    policyName:
      config.rdtConfig?.agents?.reviewer?.model_policy ?? 'smart_reasoning',
    cwd: sandboxCwd,
    logger,
  };

  const result = await reviewer.execute(
    {
      task: state,
      plan: state.plan,
      project: agentContext,
      diff: state.diff || '',
    },
    reviewerConfig,
  );

  if (result.success && result.result) {
    const review = result.result as ReviewResult;

    if (!state.reviewResults) {
      state.reviewResults = [];
    }
    state.reviewResults.push(review);

    if (review.issues.length > 0) {
      for (const issue of review.issues) {
        logger.warn(`Review issue: ${issue}`);
      }
    }

    logger.info(`Review: ${review.approved ? 'APPROVED' : 'NOT APPROVED'}`, {
      issues: review.issues.length,
      summary: review.finalSummary,
    });

    return review.approved;
  }

  logger.warn('Reviewer agent failed — auto-approving');
  return true;
}
