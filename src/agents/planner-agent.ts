import type { CompletionMessage } from '../providers/types';
import type { ProviderRouter } from '../router/provider-router';
import type { Tool } from '../tools/types';
import type { AgentInput, AgentOutput, Plan, SelectedFile } from './types';

export interface PlannerAgentConfig {
  router: ProviderRouter;
  policyName: string;
  tools: Tool[];
}

/**
 * Planner Agent — creates a minimal, step-by-step implementation plan.
 *
 * Uses a provider model (smart_reasoning) to generate the plan from
 * context. Since we don't have an LLM available in this local context,
 * this agent builds the plan heuristically from the selected files
 * and task request, with structure matching the Plan interface.
 *
 * In production, this would be replaced by a call through the provider
 * router to an LLM with the proper system prompt.
 */
export async function plannerAgent(
  input: AgentInput,
  config: PlannerAgentConfig,
): Promise<AgentOutput<Plan>> {
  const { task, project } = input;
  const request = task.request;
  const toolCalls: AgentOutput['toolCalls'] = [];

  try {
    // Try to use the provider router for AI-powered plan generation
    if (config.router?.route) {
      try {
        let userContent = `Task: ${request}\n\nSelected files context:\n${(
          input.files ?? []
        )
          .slice(0, 10)
          .map((f) => `- ${f.path}: ${f.reason}`)
          .join('\n')}`;

        if (task.reviewResults && task.reviewResults.length > 0) {
          const lastReview = task.reviewResults[task.reviewResults.length - 1];
          userContent +=
            `\n\n### PREVIOUS IMPLEMENTATION ATTEMPT FAILURE\n` +
            `The previous implementation attempt did not pass checks. You must revise your plan to address this.\n\n` +
            `Last Plan summary: ${task.planSummary || 'None'}\n` +
            `Issues identified by reviewer:\n${lastReview.issues.map((i) => `- ${i}`).join('\n')}\n` +
            `Required fixes:\n${lastReview.requiredFixes.map((f) => `- ${f}`).join('\n')}`;
        }

        let systemPrompt = `You are a senior software engineer planning code changes.
Given a task request and project context, create a step-by-step implementation plan.

Project: ${project.project.name}
Language: ${project.project.language}
Repo files: ${project.repoMap.totalFiles}
Source dirs: ${project.project.sourceDirs.join(', ')}

Respond with a JSON plan containing:
- summary: brief overview of the approach
- steps: array of { description, targetFiles[], risk (low/medium/high) }
- testPlan: array of test verification steps
- risks: array of potential issues

Keep steps concrete and actionable.`;

        if (project.instructions.customInstructions) {
          systemPrompt += `\n\nCustom Instructions:\n${project.instructions.customInstructions}`;
        }

        const messages: CompletionMessage[] = [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: userContent,
          },
        ];

        const routerResult = await config.router.route(
          config.policyName,
          { model: '', messages, max_tokens: 2000, temperature: 0.3 },
          { needsTools: false, needsJson: true },
        );

        if (routerResult.success && routerResult.response) {
          const content = routerResult.response.content;
          // Record provider usage
          const successAttempt =
            routerResult.attempts[routerResult.attempts.length - 1];
          task.providerUsage.push({
            agentName: 'planner',
            providerId: successAttempt?.providerId ?? 'unknown',
            modelId: successAttempt?.modelId ?? 'unknown',
            usage: routerResult.response.usage,
            promptTokens: routerResult.response.usage?.prompt_tokens,
            completionTokens: routerResult.response.usage?.completion_tokens,
            durationMs: successAttempt?.durationMs ?? 0,
          });

          // Try to parse JSON from response
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]) as {
                summary?: string;
                steps?: Array<{
                  description: string;
                  targetFiles?: string[];
                  risk?: string;
                }>;
                testPlan?: string[];
                risks?: string[];
              };
              if (parsed.steps && parsed.steps.length > 0) {
                const plan: Plan = {
                  summary:
                    parsed.summary ?? `Plan: ${parsed.steps.length} step(s)`,
                  steps: parsed.steps.map((s, i) => ({
                    id: `step_${i + 1}`,
                    description: s.description,
                    targetFiles: s.targetFiles ?? [],
                    risk: (s.risk as 'low' | 'medium' | 'high') ?? 'medium',
                  })),
                  testPlan: parsed.testPlan ?? ['Run tests to verify changes'],
                  risks: parsed.risks ?? [],
                };

                return {
                  success: true,
                  result: plan,
                  modelUsed: `${successAttempt?.providerId}/${successAttempt?.modelId}`,
                  providerUsed: successAttempt?.providerId ?? 'provider',
                  toolCalls,
                };
              }
            } catch {
              // JSON parse failed — fall through to heuristic
            }
          }
        }
      } catch {
        // Provider call failed — fall through to heuristic
      }
    }

    // Fallback: build a structured plan heuristically
    const plan = buildPlan(
      request,
      project.repoMap.entries.length,
      project.repoMap.root,
    );

    return {
      success: true,
      result: plan,
      modelUsed: config.policyName,
      providerUsed: 'heuristic',
      toolCalls,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { message, code: 'PLANNER_ERROR', recoverable: true },
      modelUsed: config.policyName,
      providerUsed: 'planner',
      toolCalls,
    };
  }
}

function buildPlan(request: string, repoSize: number, _root: string): Plan {
  // Extract potential file paths and key actions from the request
  const actionWords = [
    'fix',
    'add',
    'update',
    'refactor',
    'remove',
    'rename',
    'move',
    'create',
    'delete',
    'change',
    'implement',
  ];
  const actions: string[] = [];
  const targetFiles: string[] = [];

  const requestLower = request.toLowerCase();

  // Detect action type
  for (const action of actionWords) {
    if (requestLower.includes(action)) {
      actions.push(action);
    }
  }

  // Extract file paths from request
  const pathMatches = request.match(/[a-zA-Z0-9_./-]+\.[a-zA-Z]+/g);
  if (pathMatches) {
    for (const match of pathMatches) {
      targetFiles.push(match);
    }
  }

  // Detect if tests are involved
  const involvesTests =
    requestLower.includes('test') || requestLower.includes('spec');

  const steps: Plan['steps'] = [];
  let stepId = 0;

  // Step 1: Understand the code
  steps.push({
    id: `step_${++stepId}`,
    description:
      actions.length > 0
        ? `Read and understand the code to ${actions.join(', ')}`
        : 'Read and understand the relevant code',
    targetFiles: [...targetFiles],
    risk: 'low' as const,
  });

  // Step 2: Plan the changes
  steps.push({
    id: `step_${++stepId}`,
    description:
      targetFiles.length > 0
        ? `Plan changes to ${targetFiles.join(', ')}`
        : 'Plan the necessary changes',
    targetFiles: [...targetFiles],
    risk: 'low' as const,
  });

  // Step 3: Apply changes
  if (actions.includes('create') || actions.includes('add')) {
    steps.push({
      id: `step_${++stepId}`,
      description: 'Create new files with the required implementation',
      targetFiles: [...targetFiles],
      risk: 'medium' as const,
    });
  }

  if (
    actions.includes('fix') ||
    actions.includes('update') ||
    actions.includes('refactor') ||
    actions.includes('change')
  ) {
    steps.push({
      id: `step_${++stepId}`,
      description: 'Apply targeted edits to the identified files',
      targetFiles: [...targetFiles],
      risk: 'medium' as const,
    });
  }

  if (actions.includes('remove') || actions.includes('delete')) {
    steps.push({
      id: `step_${++stepId}`,
      description: 'Remove the identified code or files',
      targetFiles: [...targetFiles],
      risk: 'medium' as const,
    });
  }

  // Step 4: Verify
  steps.push({
    id: `step_${++stepId}`,
    description: involvesTests
      ? 'Run tests and verify the changes work correctly'
      : 'Run typecheck and verify the changes compile',
    targetFiles: [],
    risk: 'low' as const,
  });

  return {
    summary:
      actions.length > 0
        ? `${actions[0].charAt(0).toUpperCase() + actions[0].slice(1)} ${targetFiles.length > 0 ? targetFiles.join(', ') : 'relevant files'} — ${stepId} step plan`
        : `Implement the requested changes — ${stepId} step plan`,
    steps,
    testPlan: involvesTests
      ? [
          'Run the existing tests to verify no regressions',
          'Check if new tests are needed for the changes',
        ]
      : [
          'Run typecheck to ensure compilation',
          'Run existing tests to verify no regressions',
        ],
    risks: [
      targetFiles.length === 0
        ? 'No specific target files identified in request — may need broader exploration'
        : 'Changes are scoped to identified files',
      repoSize > 100 ? 'Large repository — focus only on relevant files' : '',
    ].filter(Boolean),
  };
}
