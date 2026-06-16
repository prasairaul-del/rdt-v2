import { agentRegistry } from '../../../agents/agent-registry';
import type { PlannerAgentConfig } from '../../../agents/planner-agent';
import { addTaskError } from '../../task-state';
import type { StepContext } from '../types';

/**
 * Step: Creating a plan for the task.
 */
export async function planStep(context: StepContext): Promise<void> {
  const { state, executionContext, router, logger, config } = context;

  const agentContext = executionContext.buildAgentContext(state.request);

  const planner = agentRegistry.get('planner');
  if (!planner) {
    addTaskError(state, 'Planner agent not found', 'AGENT_NOT_FOUND', 'fatal');
    return;
  }

  if (!router) {
    addTaskError(
      state,
      'Planner step requires a provider router',
      'MISSING_ROUTER',
      'fatal',
    );
    return;
  }

  const plannerConfig: PlannerAgentConfig = {
    router,
    policyName:
      config.rdtConfig?.agents?.planner?.model_policy ?? 'smart_reasoning',
    tools: [],
  };

  const result = await planner.execute(
    {
      task: state,
      project: agentContext,
      files: state.selectedFiles,
    },
    plannerConfig,
  );

  if (result.success && result.result) {
    const plan = result.result as {
      summary: string;
      steps: Array<{
        id: string;
        description: string;
        targetFiles: string[];
        risk: 'low' | 'medium' | 'high';
      }>;
      testPlan: string[];
      risks: string[];
    };
    state.planSummary = plan.summary.substring(0, 200);
    state.plan = plan;
    logger.info(`Plan: ${plan.summary}`, {
      steps: plan.steps.length,
    });
  } else {
    addTaskError(
      state,
      'Planner agent failed',
      'PLANNER_FAILED',
      'recoverable',
    );
  }
}
