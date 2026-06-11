import type { CompletionMessage } from '../providers/types';
import type { ProviderRouter } from '../router/provider-router';
import { applyPatchTool } from '../tools/apply-patch';
import { gitDiffTool } from '../tools/git-diff';
import { readFileTool } from '../tools/read-file';
import type { Tool } from '../tools/types';
import { writeFileTool } from '../tools/write-file';
import { safeParseJson } from '../utils/json';
import { EditResultSchema } from './schemas';
import type { AgentInput, AgentOutput, EditResult } from './types';

export interface EditorAgentConfig {
  router: ProviderRouter;
  policyName: string;
  tools: Tool[];
  /** Explicit working directory for file operations (avoids process.cwd() dependency) */
  cwd?: string;
}

/**
 * Editor Agent — applies the approved plan using safe patches.
 *
 * Uses a provider model to generate actual patches from the plan + file context.
 * Falls back to heuristic reporting if no provider is available.
 */
export async function editorAgent(
  input: AgentInput,
  config?: EditorAgentConfig,
): Promise<AgentOutput<EditResult>> {
  const { task, plan, project } = input;
  const toolCalls: AgentOutput['toolCalls'] = [];
  const changedFiles: string[] = [];
  const errors: string[] = [];

  try {
    if (!plan) {
      return {
        success: false,
        error: {
          message: 'No plan provided to editor agent',
          code: 'MISSING_PLAN',
          recoverable: true,
        },
        modelUsed: 'none',
        providerUsed: 'none',
        toolCalls,
      };
    }

    // Get all target files from the plan
    const targetFiles = new Set<string>();
    for (const step of plan.steps) {
      for (const file of step.targetFiles) {
        targetFiles.add(file);
      }
    }

    // Read each target file for context
    const fileContents: Array<{ path: string; content: string }> = [];
    for (const filePath of targetFiles) {
      const readStart = performance.now();
      const readResult = await readFileTool.execute({
        path: filePath,
        cwd: config?.cwd,
      });
      const readDuration = performance.now() - readStart;
      toolCalls.push({
        toolName: 'read_file',
        input: { path: filePath },
        output: { success: readResult.success },
        durationMs: Math.round(readDuration),
      });

      if (readResult.success && readResult.data) {
        fileContents.push({
          path: filePath,
          content:
            typeof readResult.data === 'string'
              ? readResult.data
              : JSON.stringify(readResult.data),
        });
      } else {
        errors.push(
          `Could not read ${filePath}: ${readResult.error?.message ?? 'unknown'}`,
        );
      }
    }

    // Try to use the provider router for AI-powered patch generation
    if (config?.router?.route && targetFiles.size > 0) {
      try {
        const fileContext = fileContents
          .slice(0, 8)
          .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`)
          .join('\n\n');

        const planSteps = plan.steps
          .map(
            (s) =>
              `  ${s.id}: ${s.description} (files: ${s.targetFiles.join(', ')}, risk: ${s.risk})`,
          )
          .join('\n');

        // Extract feedback from previous review passes if available
        let reviewFeedback = '';
        if (task.reviewResults && task.reviewResults.length > 0) {
          const lastReview = task.reviewResults[task.reviewResults.length - 1];
          if (!lastReview.approved) {
            const issuesStr = lastReview.issues.map((i) => `- ${i}`).join('\n');
            const fixesStr = lastReview.requiredFixes
              .map((f) => `- ${f}`)
              .join('\n');
            const testsStr = lastReview.testsRun
              .map(
                (t) =>
                  `[${t.passed ? 'PASS' : 'FAIL'}] Command: ${t.command}\nOutput Summary:\n${t.outputSummary}`,
              )
              .join('\n\n');

            reviewFeedback = `\n### FEEDBACK FROM PREVIOUS REVIEW PASS\nThe previous implementation attempt did not pass checks. Please fix the following:\n\nIssues identified:\n${issuesStr || 'None listed'}\n\nRequired fixes:\n${fixesStr || 'None listed'}\n\nCheck / Test Results:\n${testsStr || 'None run'}\n`;
          }
        }

        const messages: CompletionMessage[] = [
          {
            role: 'system',
            content: `You are a senior software engineer applying code changes using unified diff patches.
Given a task request, implementation plan, file contents, and any previous review feedback or test failures, generate the unified diff patches needed.

Project: ${project.project.name}
Language: ${project.project.language}

Respond with a JSON object containing:
- summary: brief description of what was changed
- edits: array of { file: string, patch: string } where patch is a unified diff patch string.

IMPORTANT: Each edit.patch MUST be a valid unified diff patch format. Ensure it includes:
--- a/<file>
+++ b/<file>
@@ -start,count +start,count @@
 <lines with leading space for context, - for removal, + for additions>

Keep patches minimal, precise, and targeted. Prefer surgical changes over rewriting whole files.`,
          },
          {
            role: 'user',
            content: `Task: ${task.request}

Plan:
${planSteps}
${reviewFeedback}
Target files content:
${fileContext}`,
          },
        ];

        const routerResult = await config.router.route(
          config.policyName,
          { model: '', messages, max_tokens: 3000, temperature: 0.2 },
          { needsTools: false, needsJson: true },
        );
        if (routerResult.success && routerResult.response) {
          const content = routerResult.response.content;
          // Record provider usage
          const successAttempt =
            routerResult.attempts[routerResult.attempts.length - 1];
          task.providerUsage.push({
            agentName: 'editor',
            providerId: successAttempt?.providerId ?? 'unknown',
            modelId: successAttempt?.modelId ?? 'unknown',
            usage: routerResult.response.usage,
            durationMs: successAttempt?.durationMs ?? 0,
          });

          // Fix #2 — robust JSON extraction (handles markdown fences + nested JSON)
          const parsedJson = safeParseJson<unknown>(content);
          const validationResult = EditResultSchema.safeParse(parsedJson);
          if (validationResult.success && validationResult.data.edits && validationResult.data.edits.length > 0) {
            const parsed = validationResult.data;
            for (const edit of parsed.edits) {
              if (edit.patch) {
                const applyStart = performance.now();
                const applyResult = await applyPatchTool.execute({
                  patch: edit.patch,
                  cwd: config?.cwd,
                });
                const applyDuration = performance.now() - applyStart;
                toolCalls.push({
                  toolName: 'apply_patch',
                  input: { path: edit.file, patchLength: edit.patch.length },
                  output: { success: applyResult.success },
                  durationMs: Math.round(applyDuration),
                });

                if (applyResult.success) {
                  changedFiles.push(edit.file);
                } else {
                  errors.push(
                    `Failed to apply patch to ${edit.file}: ${applyResult.error?.message ?? 'unknown'}`,
                  );
                }
              } else if (edit.content) {
                // Fallback: full content rewrite if LLM didn't return a patch
                const writeStart = performance.now();
                const writeResult = await writeFileTool.execute({
                  path: edit.file,
                  content: edit.content,
                  allowOverwrite: true,
                  cwd: config?.cwd,
                });
                const writeDuration = performance.now() - writeStart;
                toolCalls.push({
                  toolName: 'write_file',
                  input: {
                    path: edit.file,
                    contentLength: edit.content.length,
                  },
                  output: { success: writeResult.success },
                  durationMs: Math.round(writeDuration),
                });

                if (writeResult.success) {
                  changedFiles.push(edit.file);
                } else {
                  errors.push(
                    `Failed to write ${edit.file}: ${writeResult.error?.message ?? 'unknown'}`,
                  );
                }
              }
            }
          } else if (!validationResult.success) {
            errors.push(
              `LLM response validation failed: ${validationResult.error.message}`,
            );
          } else if (!validationResult.data.edits || validationResult.data.edits.length === 0) {
            errors.push(
              'LLM response did not contain edit instructions',
            );
          }

          // Capture diff after edits
          const diffAfterStart = performance.now();
          const diffAfter = await gitDiffTool.execute({ cwd: config?.cwd });
          const diffAfterDuration = performance.now() - diffAfterStart;
          toolCalls.push({
            toolName: 'git_diff',
            input: {},
            output: { hasChanges: diffAfter.data?.hasChanges ?? false },
            durationMs: Math.round(diffAfterDuration),
          });

          return {
            success: true,
            result: {
              changedFiles: [...new Set(changedFiles)],
              summary: content.slice(0, 500),
              diff: diffAfter.data?.diff ?? '',
              needsReview: changedFiles.length > 0 || targetFiles.size > 0,
            },
            modelUsed: `${successAttempt?.providerId}/${successAttempt?.modelId}`,
            providerUsed: successAttempt?.providerId ?? 'provider',
            toolCalls,
          };
        }
      } catch {
        // Provider call failed — fall through to heuristic
      }
    }

    // Fallback: report what files would be edited (heuristic)
    // Capture diff before any edits (baseline)
    const diffBeforeStart = performance.now();
    const diffBefore = await gitDiffTool.execute({});
    const diffBeforeDuration = performance.now() - diffBeforeStart;
    toolCalls.push({
      toolName: 'git_diff',
      input: {},
      output: { hasChanges: diffBefore.data?.hasChanges ?? false },
      durationMs: Math.round(diffBeforeDuration),
    });

    return {
      success: true,
      result: {
        changedFiles: Array.from(targetFiles),
        summary: `Editor prepared to modify ${targetFiles.size} file(s): ${Array.from(targetFiles).join(', ')}. Patches should be applied through the provider.`,
        diff: '',
        needsReview: targetFiles.size > 0,
      },
      modelUsed: config?.policyName ?? 'editor',
      providerUsed: 'heuristic',
      toolCalls,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: { message, code: 'EDITOR_ERROR', recoverable: true },
      modelUsed: config?.policyName ?? 'editor',
      providerUsed: 'editor',
      toolCalls,
    };
  }
}
