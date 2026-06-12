import type { CompletionMessage } from '../providers/types';
import type { ProviderRouter } from '../router/provider-router';
import { gitDiffTool } from '../tools/git-diff';
import { testRunnerTool } from '../tools/test-runner';
import { safeParseJson } from '../utils/json';
import { ReviewResultSchema } from './schemas';
import type { AgentInput, AgentOutput, ReviewResult } from './types';

export interface ReviewerAgentConfig {
  router: ProviderRouter;
  policyName: string;
  /** Explicit working directory for tool operations (avoids process.cwd() dependency) */
  cwd?: string;
  logger?: any;
}

/**
 * Reviewer Agent — reviews the diff, runs checks, and decides
 * whether another edit pass is needed.
 *
 * Uses a provider model for AI-powered review decisions.
 * Falls back to heuristic pass/fail logic if no provider is available.
 */
export async function reviewerAgent(
  input: AgentInput,
  config?: ReviewerAgentConfig,
): Promise<AgentOutput<ReviewResult>> {
  const { task, plan, project } = input;
  const toolCalls: AgentOutput['toolCalls'] = [];
  const issues: string[] = [];
  const testsRun: ReviewResult['testsRun'] = [];
  const requiredFixes: string[] = [];

  try {
    // 1. Check git diff
    const diffStart = performance.now();
    const diffResult = await gitDiffTool.execute({ cwd: config?.cwd });
    const diffDuration = performance.now() - diffStart;
    toolCalls.push({
      toolName: 'git_diff',
      input: {},
      output: {
        hasChanges: diffResult.data?.hasChanges ?? false,
        filesChanged: diffResult.data?.filesChanged ?? 0,
      },
      durationMs: Math.round(diffDuration),
    });

    let diff = '';
    if (diffResult.success && diffResult.data) {
      diff = diffResult.data.diff;
      if (!diffResult.data.hasChanges) {
        issues.push(
          'No changes detected in git diff. Edits may not have been applied.',
        );
        requiredFixes.push('Ensure patches are being applied correctly');
      }
    } else {
      issues.push(
        `Git diff failed: ${diffResult.error?.message ?? 'unknown error'}`,
      );
    }

    // 2. Run tests if available
    const testStart = performance.now();
    const testResult = await testRunnerTool.execute({
      timeoutMs: 120_000,
      cwd: config?.cwd,
      logger: config?.logger,
    });
    const testDuration = performance.now() - testStart;
    toolCalls.push({
      toolName: 'test_runner',
      input: { timeoutMs: 120_000 },
      output: {
        passed: testResult.data?.passed ?? false,
        exitCode: testResult.data?.exitCode ?? -1,
      },
      durationMs: Math.round(testDuration),
    });

    let testsPassed = false;
    let testOutput = '';
    if (testResult.success && testResult.data) {
      testOutput = testResult.data.stdout;
      testsPassed = testResult.data.passed;
      const hadPreExistingFailure =
        task.baselines?.dirtyFiles?.some(
          (f) => f.includes('test') || f.includes('spec'),
        ) ?? false;

      testsRun.push({
        command: testResult.data.command,
        passed: testResult.data.passed,
        outputSummary:
          testOutput.slice(0, 500) + (testOutput.length > 500 ? '...' : ''),
      });

      if (!testResult.data.passed) {
        if (hadPreExistingFailure) {
          issues.push(
            'Tests are failing (may be pre-existing — test files were dirty before edits)',
          );
        } else {
          issues.push('Tests are failing after the edit');
          requiredFixes.push('Fix the failing tests');
        }
      }
    } else {
      issues.push(
        `Test runner failed: ${testResult.error?.message ?? 'unknown error'}`,
      );
    }

    // 3. Check typecheck — fix #6: detect script presence first, fall back to tsc
    const typecheckStart = performance.now();
    let typecheckCmd: string;
    const cwd = config?.cwd ?? process.cwd();
    const pkgMgr = project?.project?.packageManager;
    // Check if a typecheck script exists in package.json before using it
    let hasTypecheckScript = false;
    try {
      const { readFileSync, existsSync } = await import('node:fs');
      const { join } = await import('node:path');
      const pkgPath = join(cwd, 'package.json');
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
          scripts?: Record<string, string>;
        };
        hasTypecheckScript = !!pkg.scripts?.typecheck;
      }
    } catch {
      /* ignore */
    }
    if (hasTypecheckScript && pkgMgr) {
      typecheckCmd = `${pkgMgr} run typecheck`;
    } else {
      typecheckCmd = 'node node_modules/typescript/bin/tsc --noEmit';
    }
    const typecheckResult = await testRunnerTool.execute({
      command: typecheckCmd,
      timeoutMs: 60_000,
      cwd,
      logger: config?.logger,
    });
    const typecheckDuration = performance.now() - typecheckStart;
    toolCalls.push({
      toolName: 'test_runner',
      input: { command: typecheckResult.data?.command ?? 'typecheck' },
      output: { passed: typecheckResult.data?.passed ?? false },
      durationMs: Math.round(typecheckDuration),
    });

    let typecheckPassed = true;
    if (
      typecheckResult.success &&
      typecheckResult.data &&
      !typecheckResult.data.passed
    ) {
      typecheckPassed = false;
      issues.push('Typecheck failed after edits');
      requiredFixes.push('Fix type errors');
      testsRun.push({
        command: typecheckResult.data.command,
        passed: false,
        outputSummary: `${typecheckResult.data.stderr.slice(0, 300)}...`,
      });
    } else if (typecheckResult.success && typecheckResult.data?.passed) {
      testsRun.push({
        command: typecheckResult.data.command,
        passed: true,
        outputSummary: 'Typecheck passed',
      });
    }

    // 4. Try to use provider for AI-powered review decision
    let approved = false;
    let providerMadeDecision = false;
    if (config?.router?.route && diff) {
      try {
        const planSteps = plan?.steps
          ? plan.steps
              .map((s) => `  ${s.id}: ${s.description} (risk: ${s.risk})`)
              .join('\n')
          : 'No plan steps available';

        let systemPrompt = `You are a senior engineer reviewing code changes.
Given the task, plan, git diff, and test results, determine if the changes are correct and should be approved.

Project: ${project.project.name}
Language: ${project.project.language}

Respond with a JSON object:
- approved: boolean — true if changes are correct and tests pass
- summary: string — brief review summary
- issues: string[] — any concerns found
- requiredFixes: string[] — what must be fixed before approval`;

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
            content: `Task: ${task.request}

Plan:
${planSteps}

Git diff:
${diff.slice(0, 6000)}

Test results:
${testOutput.slice(0, 2000)}

Tests passed: ${testsPassed}
Typecheck passed: ${typecheckPassed}`,
          },
        ];

        const routerResult = await config.router.route(
          config.policyName,
          { model: '', messages, max_tokens: 1500, temperature: 0.1 },
          { needsTools: false, needsJson: true },
        );

        if (routerResult.success && routerResult.response) {
          const content = routerResult.response.content;
          // Record provider usage
          const successAttempt =
            routerResult.attempts[routerResult.attempts.length - 1];
          task.providerUsage.push({
            agentName: 'reviewer',
            providerId: successAttempt?.providerId ?? 'unknown',
            modelId: successAttempt?.modelId ?? 'unknown',
            usage: routerResult.response.usage,
            durationMs: successAttempt?.durationMs ?? 0,
          });

          // Fix #2 — robust JSON extraction and Zod validation
          const parsed = safeParseJson<unknown>(content);
          if (parsed !== null) {
            const validation = ReviewResultSchema.safeParse(parsed);
            if (validation.success) {
              approved = validation.data.approved;
              providerMadeDecision = true;

              const parsedIssues = validation.data.issues ?? [];
              const parsedFixes = validation.data.requiredFixes ?? [];

              issues.push(...parsedIssues);
              requiredFixes.push(...parsedFixes);
            }
          }
        }
      } catch {
        // Provider call failed — fall through to heuristic
      }
    }

    // Heuristic approval (only if provider didn't make a decision)
    if (!providerMadeDecision) {
      const testsAllPassed = testsRun.every((t) => t.passed);
      const noCriticalIssues = !issues.some(
        (i) =>
          i.includes('Tests are failing after') ||
          i.includes('Typecheck failed'),
      );
      approved = testsAllPassed && noCriticalIssues;
    }

    // 5. Build final summary
    const summaryParts: string[] = [];
    if (diff) {
      const fileCount = diff.match(/^diff --git/g)?.length ?? 0;
      summaryParts.push(`Changed ${fileCount} file(s)`);
    }
    if (testsRun.length > 0) {
      const passed = testsRun.filter((t) => t.passed).length;
      summaryParts.push(`${passed}/${testsRun.length} checks passed`);
    }

    return {
      success: true,
      result: {
        approved,
        issues,
        testsRun,
        requiredFixes,
        finalSummary:
          summaryParts.length > 0 ? summaryParts.join(', ') : 'Review complete',
      },
      modelUsed: config?.policyName ?? 'reviewer',
      providerUsed: config?.router ? 'provider' : 'heuristic',
      toolCalls,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { message, code: 'REVIEWER_ERROR', recoverable: true },
      modelUsed: config?.policyName ?? 'reviewer',
      providerUsed: 'reviewer',
      toolCalls,
    };
  }
}
