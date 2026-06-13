import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ProviderRouter } from '../router/provider-router';
import { ProviderStateStore } from '../storage/provider-state-store';
import { TaskLogStore } from '../storage/task-log-store';
import { globalEventBus } from './events';
import { TaskLogger } from './logger';
import { ExecutionContext } from './runner/execution-context';
import { StateMachine } from './runner/state-machine';
import type { StepContext, TaskResult, TaskRunnerConfig } from './runner/types';
import { type TaskState, createTaskState } from './task-state';

// Steps
import { baselineStep } from './runner/steps/baseline-step';
import { contextStep } from './runner/steps/context-step';
import { editStep } from './runner/steps/edit-step';
import { finalizeStep } from './runner/steps/finalize-step';
import { pickStep } from './runner/steps/pick-step';
import { planStep } from './runner/steps/plan-step';
import { reviewStep } from './runner/steps/review-step';
import { scanStep } from './runner/steps/scan-step';

// ── Task Runner ──────────────────────────────────────────────────

/**
 * TaskRunner orchestrates the execution of a coding task.
 * It coordinates agents, manages state transitions, and project context.
 */
export class TaskRunner {
  private config: TaskRunnerConfig;
  private router?: ProviderRouter;
  private stateStore: ProviderStateStore;
  private logStore: TaskLogStore;
  private logger: TaskLogger;
  private executionContext: ExecutionContext;

  constructor(config: TaskRunnerConfig) {
    this.config = config;
    this.stateStore = config.stateStore ?? new ProviderStateStore();
    this.logStore =
      config.logStore ??
      new TaskLogStore(resolve(config.projectRoot, '.rdt', 'tasks.db'));
    this.logger = config.logger ?? new TaskLogger();

    // Initialize provider router from config if not provided externally
    if (!config.providerRouter && config.rdtConfig) {
      const router = new ProviderRouter(config.rdtConfig);
      router.initFromConfig(config.rdtConfig);
      this.router = router;
    } else {
      this.router = config.providerRouter;
    }

    this.executionContext = new ExecutionContext(
      config.projectRoot,
      this.logger,
      this.router,
    );
  }

  /**
   * Run a coding task through the full state machine.
   */
  async run(request: string, taskId?: string): Promise<TaskResult> {
    const state = createTaskState(
      request,
      this.config.rdtConfig?.runtime.max_edit_passes ?? 3,
      this.config.rdtConfig?.runtime.rollback_on_failed_task ?? true,
      taskId,
    );

    this.logger.setTaskId(state.id);
    this.logger.info('Task created', { id: state.id, request });
    globalEventBus.emit('task:created', state.id, { request });

    const stateMachine = new StateMachine(
      state,
      this.logger,
      this.config.checkCancellation,
    );
    let sandboxCwd: string | undefined;
    let result: TaskResult;

    const stepContext: StepContext = {
      state,
      config: this.config,
      executionContext: this.executionContext,
      router: this.router,
      logger: this.logger,
    };

    try {
      // ── STEP 1: CAPTURE BASELINE ────────────────────────────────
      await stateMachine.executeStep('capturing_baseline', async () => {
        await baselineStep(stepContext);
      });

      // ── STEP 2: LOAD CONTEXT ────────────────────────────────────
      await stateMachine.executeStep('loading_context', async () => {
        await contextStep(stepContext);
      });

      // Setup Git feature branch if configured
      await this.executionContext.setupFeatureBranch(state);

      // Initialize isolated sandbox
      sandboxCwd = await this.executionContext.initSandbox(state.id);
      stepContext.sandboxCwd = sandboxCwd;

      // ── STEP 3: SCAN REPO ───────────────────────────────────────
      await stateMachine.executeStep('scanning_repo', async () => {
        await scanStep(stepContext);
      });

      // ── STEP 4: SELECT FILES ────────────────────────────────────
      await stateMachine.executeStep('selecting_files', async () => {
        await pickStep(stepContext);
      });

      // ── STEP 5: PLAN ────────────────────────────────────────────
      await stateMachine.executeStep('planning', async () => {
        await planStep(stepContext);
      });

      // ── STEP 6-8: EDIT/REVIEW LOOP ──────────────────────────────
      let approved = false;
      while (state.editPass < state.maxEditPasses && !approved) {
        state.editPass++;

        // EDIT
        await stateMachine.executeStep('editing', async () => {
          await editStep(stepContext);
        });

        // REVIEW
        approved = await stateMachine.executeStep('reviewing', async () => {
          return await reviewStep(stepContext);
        });

        // Check if we need another pass
        if (!approved && state.editPass < state.maxEditPasses) {
          await stateMachine.executeStep('fixing', async () => {
            this.logger.info(
              `Edit pass ${state.editPass} not approved — re-planning...`,
              {
                issues: state.errors.filter((e) => e.state === 'reviewing')
                  .length,
              },
            );
            await planStep(stepContext);
          });
        } else if (approved) {
          this.logger.info('Review approved');
        } else {
          this.logger.warn('Max edit passes reached without approval');
        }
      }

      if (!approved) {
        throw new Error('Task was not approved after maximum edit passes');
      }

      // ── STEP 9: FINALIZE ────────────────────────────────────────
      await stateMachine.executeStep('finalizing', async () => {
        await finalizeStep(stepContext);
        await this.saveTaskLog(state);
      });

      // Apply sandboxed edits back to host workspace
      await this.executionContext.applySandboxChanges(state.changedFiles);

      // Git Auto Commit or Feature Branch Commit
      await this.executionContext.commitChanges(state);

      // Restore original branch if we used a feature branch
      await this.executionContext.restoreBranch(state);

      // ── SUCCESS ─────────────────────────────────────────────────
      stateMachine.transition('done');
      this.logger.info('Task completed successfully');

      result = this.buildResult(state, true);
    } catch (err) {
      result = await this.handleFailure(state, stateMachine, err);

      // Restore Git branch and delete unused feature branch on failure
      await this.executionContext.restoreBranch(state, true);
    } finally {
      await this.executionContext.destroySandbox();
    }

    return result;
  }

  // ── Step Implementations ───────────────────────────────────────
  async editFiles(state: TaskState): Promise<void> {
    const stepContext: StepContext = {
      state,
      config: this.config,
      executionContext: this.executionContext,
      router: this.router,
      logger: this.logger,
      sandboxCwd: process.cwd(),
    };
    await editStep(stepContext);
  }

  // ── Failure Handling ───────────────────────────────────────────

  private async handleFailure(
    state: TaskState,
    stateMachine: StateMachine,
    err: unknown,
  ): Promise<TaskResult> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Task failed: ${message}`);
    globalEventBus.emitError(state.id, message, 'TASK_FAILURE');

    if (!state.errors.some((e) => e.message === message)) {
      const code =
        err instanceof Error && 'code' in err
          ? String(err.code)
          : 'TASK_FAILURE';
      stateMachine.addError(message, code, 'fatal');
    }

    // Rollback if configured
    if (state.rollbackOnFailed && state.baselines?.rdtTouchedFiles.length) {
      try {
        stateMachine.transition('rolling_back');
        this.logger.info('Rolling back RDT-touched files...');

        // Use ExecutionContext for rollback (via git checkout)
        await this.executionContext.restoreBranch(state, true);

        stateMachine.transition('failed_clean');
        this.logger.info('Rollback succeeded — state is FAILED_CLEAN');
      } catch (rollbackErr) {
        const rollbackMsg =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        this.logger.error(`Rollback failed: ${rollbackMsg}`);
        stateMachine.transition('failed_dirty');
      }
    } else if (state.rollbackOnFailed) {
      stateMachine.transition('failed_clean');
    } else {
      stateMachine.transition('failed_dirty');
    }

    await this.saveTaskLog(state);
    await this.saveFailedPatch(state);

    return this.buildResult(state, false, message);
  }

  private async saveFailedPatch(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;
    const rdtDir = resolve(projectRoot, '.rdt', 'tasks');
    if (!existsSync(rdtDir)) {
      mkdirSync(rdtDir, { recursive: true });
    }

    const diff = state.diff || '';
    if (diff) {
      const patchPath = resolve(rdtDir, `${state.id}.failed.patch`);
      writeFileSync(
        patchPath,
        `# Failed task patch: ${state.id}\n# Request: ${state.request}\n${diff}`,
        'utf-8',
      );
      this.logger.info(`Failed patch saved: ${patchPath}`);
    }
  }

  // ── Logging ────────────────────────────────────────────────────

  private async saveTaskLog(state: TaskState): Promise<void> {
    try {
      if (!this.logStore.getLog(state.id)) {
        this.logStore.createLog(state.request, state.id);
      }
      this.logStore.updateLog(state.id, {
        status: state.status === 'done' ? 'success' : 'failed',
        finishedAt: state.finishedAt ?? new Date().toISOString(),
        selectedFiles: state.changedFiles,
        planSummary: state.planSummary,
        changedFiles: state.changedFiles,
        diff: state.diff,
        providersUsed: state.providerUsage.map(
          (p) => `${p.providerId}/${p.modelId}`,
        ),
        finalSummary: `Task ${state.status}: ${state.changedFiles.length} file(s) changed`,
        errorMessage: state.errors.map((e) => e.message).join('; '),
      });

      const logsDir = resolve(this.config.projectRoot, '.rdt', 'logs');
      if (!existsSync(logsDir)) {
        mkdirSync(logsDir, { recursive: true });
      }
      const logFilePath = resolve(logsDir, `${state.id}.log`);
      writeFileSync(logFilePath, this.logger.formatAsText(), 'utf-8');
    } catch (err) {
      this.logger.warn('Failed to save task log', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private calculateEstimatedCost(
    providerId: string,
    modelId: string,
    promptTokens?: number,
    completionTokens?: number,
  ): number {
    if (!promptTokens && !completionTokens) return 0;
    const pTokens = promptTokens ?? 0;
    const cTokens = completionTokens ?? 0;

    const mId = modelId.toLowerCase();
    const pId = providerId.toLowerCase();

    // Check if it's a mini model or cheap model
    const isMini =
      mId.includes('mini') ||
      mId.includes('haiku') ||
      mId.includes('flash') ||
      mId.includes('8b') ||
      pId.includes('ollama') ||
      mId.includes('llama3') ||
      mId.includes('deepseek');

    // Check if it's a premium/standard model (Claude 3.5 Sonnet, GPT-4o, GPT-4, Opus, etc.)
    const isPremium =
      mId.includes('sonnet') ||
      mId.includes('gpt-4o') ||
      mId.includes('gpt-4') ||
      mId.includes('opus') ||
      mId.includes('pro');

    let promptRatePerM = 1.5; // fallback standard rate
    let completionRatePerM = 7.5; // fallback standard rate

    if (isMini) {
      promptRatePerM = 0.15;
      completionRatePerM = 0.6;
    } else if (isPremium) {
      promptRatePerM = 3.0;
      completionRatePerM = 15.0;
    }

    const promptCost = (pTokens / 1_000_000) * promptRatePerM;
    const completionCost = (cTokens / 1_000_000) * completionRatePerM;

    return promptCost + completionCost;
  }

  // ── Result Builder ─────────────────────────────────────────────

  private buildResult(
    state: TaskState,
    success: boolean,
    errorMessage?: string,
  ): TaskResult {
    const isFailedClean = state.status === 'failed_clean';
    const isFailedDirty = state.status === 'failed_dirty';

    let providerSummary = '';
    if (state.providerUsage.length > 0) {
      let totalLatency = 0;
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalCost = 0;

      const lines = state.providerUsage.map((p) => {
        totalLatency += p.durationMs;
        const pTokens = p.promptTokens ?? 0;
        const cTokens = p.completionTokens ?? 0;
        totalPromptTokens += pTokens;
        totalCompletionTokens += cTokens;

        const cost = this.calculateEstimatedCost(
          p.providerId,
          p.modelId,
          p.promptTokens,
          p.completionTokens,
        );
        totalCost += cost;

        const tokenStr =
          p.promptTokens !== undefined
            ? `${pTokens} prompt, ${cTokens} completion`
            : 'no token data';

        return `${p.agentName} (${p.providerId}/${p.modelId}):
  Latency: ${p.durationMs}ms
  Tokens: ${tokenStr}
  Cost: $${cost.toFixed(6)}${p.error ? `\n  Error: ${p.error}` : ''}`;
      });

      providerSummary = `${lines.join('\n\n')}

Aggregated Totals:
  Total Latency: ${totalLatency}ms
  Total Tokens: ${totalPromptTokens + totalCompletionTokens} (${totalPromptTokens} prompt, ${totalCompletionTokens} completion)
  Total Estimated Cost: $${totalCost.toFixed(6)}`;
    } else {
      providerSummary = 'No provider calls recorded';
    }

    const summaryParts: string[] = [];
    if (success) {
      summaryParts.push('Task completed successfully');
    } else if (isFailedClean) {
      summaryParts.push('Task failed — changes rolled back (FAILED_CLEAN)');
    } else if (isFailedDirty) {
      summaryParts.push(
        'Task failed — repository may have uncommitted changes (FAILED_DIRTY)',
      );
    } else {
      summaryParts.push('Task failed');
    }

    if (state.changedFiles.length > 0) {
      summaryParts.push(`Modified ${state.changedFiles.length} file(s)`);
    }

    if (errorMessage) {
      summaryParts.push(`Error: ${errorMessage}`);
    }

    for (const usage of state.providerUsage) {
      this.logger.info(
        `Provider: ${usage.agentName} -> ${usage.providerId}/${usage.modelId}`,
        {
          duration: `${usage.durationMs}ms`,
          tokens: usage.promptTokens
            ? `${usage.promptTokens} in / ${usage.completionTokens} out`
            : undefined,
          error: usage.error,
        },
      );
    }

    return {
      success,
      taskId: state.id,
      state,
      summary: summaryParts.join('. '),
      diff: state.diff,
      error: errorMessage,
      providerSummary,
    };
  }
}
