import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { agentRegistry } from '../agents/agent-registry';
import type { EditorAgentConfig } from '../agents/editor-agent';
import type { PlannerAgentConfig } from '../agents/planner-agent';
import type { ReviewerAgentConfig } from '../agents/reviewer-agent';
import { ProviderRouter } from '../router/provider-router';
import { ProviderStateStore } from '../storage/provider-state-store';
import { TaskLogStore } from '../storage/task-log-store';
import { gitDiffTool } from '../tools/git-diff';
import { globalEventBus } from './events';
import { TaskLogger } from './logger';
import { ExecutionContext } from './runner/execution-context';
import { StateMachine } from './runner/state-machine';
import {
  type TaskState,
  addTaskError,
  createTaskState,
} from './task-state';
import {
  type TaskRunnerConfig,
  type TaskResult,
} from './runner/types';

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

    const stateMachine = new StateMachine(state, this.logger, this.config.checkCancellation);
    let sandboxCwd: string | undefined;
    let result: TaskResult;

    try {
      // ── STEP 1: CAPTURE BASELINE ────────────────────────────────
      await stateMachine.executeStep('capturing_baseline', async () => {
        this.logger.info('Capturing git baseline...');
        state.baselines = await this.executionContext.captureBaseline();
        this.logger.info('Baseline captured', {
          hasGit: !!state.baselines?.headHash,
          dirtyFiles: state.baselines?.dirtyFiles.length ?? 0,
        });
      });

      // Setup Git feature branch if configured
      await this.executionContext.setupFeatureBranch(state);

      // Initialize isolated sandbox
      sandboxCwd = await this.executionContext.initSandbox(state.id);

      // ── STEP 2: LOAD CONTEXT ────────────────────────────────────
      await stateMachine.executeStep('loading_context', async () => {
        this.logger.info('Loading project context...');
        await this.executionContext.load();
        // Update local config reference if it changed
        if (this.executionContext.config) {
          this.config.rdtConfig = this.executionContext.config;
        }
        this.logger.info('Context loaded');
      });

      // ── STEP 3: SCAN REPO ───────────────────────────────────────
      await stateMachine.executeStep('scanning_repo', async () => {
        this.logger.info('Scanning repository...');
        await this.executionContext.scan();
        await this.executionContext.indexForSearch();
        this.logger.info('Repository scanned');
      });

      // ── STEP 4: SELECT FILES ────────────────────────────────────
      await stateMachine.executeStep('selecting_files', async () => {
        this.logger.info('Selecting relevant files...');
        await this.selectFiles(state);
        this.logger.info('Files selected', { count: state.selectedFilesCount });
      });

      // ── STEP 5: PLAN ────────────────────────────────────────────
      await stateMachine.executeStep('planning', async () => {
        this.logger.info('Creating plan...');
        await this.createPlan(state);
        this.logger.info('Plan created', { summary: state.planSummary });
      });

      // ── STEP 6-8: EDIT/REVIEW LOOP ──────────────────────────────
      let approved = false;
      while (state.editPass < state.maxEditPasses && !approved) {
        state.editPass++;

        // EDIT
        await stateMachine.executeStep('editing', async () => {
          this.logger.info(
            `Edit pass ${state.editPass}/${state.maxEditPasses}...`,
          );
          await this.editFiles(state, sandboxCwd!);
        });

        // REVIEW
        await stateMachine.executeStep('reviewing', async () => {
          this.logger.info(
            `Reviewing pass ${state.editPass}/${state.maxEditPasses}...`,
          );
          approved = await this.reviewChanges(state, sandboxCwd!);
        });

        // Check if we need another pass
        if (!approved && state.editPass < state.maxEditPasses) {
          stateMachine.transition('fixing');
          this.logger.info(
            `Edit pass ${state.editPass} not approved — moving to fixing`,
            {
              issues: state.errors.length,
            },
          );
        } else if (approved) {
          this.logger.info('Review approved');
        } else {
          this.logger.warn('Max edit passes reached without approval');
        }
      }

      // ── STEP 9: FINALIZE ────────────────────────────────────────
      await stateMachine.executeStep('finalizing', async () => {
        this.logger.info('Finalizing task...');
        await this.finalize(state, sandboxCwd!);
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

  private async selectFiles(state: TaskState): Promise<void> {
    const context = this.executionContext.buildAgentContext(state.request);

    // Use the file picker agent
    const filePicker = agentRegistry.get('file_picker');
    if (!filePicker) {
      addTaskError(
        state,
        'File picker agent not found',
        'AGENT_NOT_FOUND',
        'fatal',
      );
      return;
    }

    const filePickerConfig = {
      router: this.router,
      policyName:
        this.config.rdtConfig?.agents?.file_picker?.model_policy ??
        'cheap_fast',
    };
    const result = await filePicker.execute(
      {
        task: state,
        project: context,
      },
      filePickerConfig,
    );

    if (result.success && result.result) {
      const selection = result.result as {
        files: Array<{
          path: string;
          reason: string;
          priority: 'high' | 'medium' | 'low';
        }>;
      };
      state.selectedFilesCount = selection.files.length;
      state.selectedFiles = selection.files;
      this.logger.info(`Selected ${selection.files.length} files`, {
        high: selection.files.filter(
          (f: { priority: string }) => f.priority === 'high',
        ).length,
        medium: selection.files.filter(
          (f: { priority: string }) => f.priority === 'medium',
        ).length,
      });
    } else {
      this.logger.warn('File picker returned no results', {
        error: result.error?.message,
      });
      state.selectedFilesCount = 0;
    }
  }

  private async createPlan(state: TaskState): Promise<void> {
    const context = this.executionContext.buildAgentContext(state.request);

    const planner = agentRegistry.get('planner');
    if (!planner) {
      addTaskError(
        state,
        'Planner agent not found',
        'AGENT_NOT_FOUND',
        'fatal',
      );
      return;
    }

    const plannerConfig: PlannerAgentConfig = {
      router: this.router ?? ({} as ProviderRouter),
      policyName:
        this.config.rdtConfig?.agents?.planner?.model_policy ??
        'smart_reasoning',
      tools: [],
    };

    const result = await planner.execute(
      {
        task: state,
        project: context,
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
      this.logger.info(`Plan: ${plan.summary}`, {
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

  private async editFiles(
    state: TaskState,
    sandboxCwd: string,
  ): Promise<void> {
    const context = this.executionContext.buildAgentContext(state.request);

    const editor = agentRegistry.get('editor');
    if (!editor) {
      addTaskError(state, 'Editor agent not found', 'AGENT_NOT_FOUND', 'fatal');
      return;
    }

    const editorConfig: EditorAgentConfig = {
      router: this.router ?? ({} as ProviderRouter),
      policyName:
        this.config.rdtConfig?.agents?.editor?.model_policy ?? 'code_strong',
      tools: [],
      cwd: sandboxCwd,
    };

    this.logger.info('Starting edit trial to generate changes...');

    const res = await editor.execute(
      { task: state, plan: state.plan, project: context },
      editorConfig,
    );

    if (res.success && res.result) {
      const editResult = res.result as {
        changedFiles: string[];
        diff: string;
        needsReview: boolean;
        summary: string;
      };
      state.changedFiles = [
        ...new Set([...state.changedFiles, ...editResult.changedFiles]),
      ];

      if (state.baselines) {
        state.baselines.rdtTouchedFiles = [
          ...new Set([
            ...state.baselines.rdtTouchedFiles,
            ...editResult.changedFiles,
          ]),
        ];
      }

      this.logger.info('Edits applied to sandbox', {
        files: editResult.changedFiles.length,
        needsReview: editResult.needsReview,
      });
    } else {
      addTaskError(
        state,
        'Editor agent failed',
        'EDITOR_FAILED',
        'recoverable',
      );
    }
  }

  private async reviewChanges(
    state: TaskState,
    sandboxCwd: string,
  ): Promise<boolean> {
    const context = this.executionContext.buildAgentContext(state.request);

    // Capture diff from the sandbox directory explicitly
    const diffResult = await gitDiffTool.execute({ cwd: sandboxCwd });
    if (diffResult.success && diffResult.data) {
      state.diff = diffResult.data.diff;
    }

    const reviewer = agentRegistry.get('reviewer');
    if (!reviewer) {
      this.logger.warn('Reviewer agent not found — auto-approving');
      return true;
    }

    const reviewerConfig: ReviewerAgentConfig = {
      router: this.router ?? ({} as ProviderRouter),
      policyName:
        this.config.rdtConfig?.agents?.reviewer?.model_policy ??
        'smart_reasoning',
      cwd: sandboxCwd,
    };

    const result = await reviewer.execute(
      {
        task: state,
        plan: state.plan as any,
        project: context,
        diff: state.diff,
      },
      reviewerConfig,
    );

    if (result.success && result.result) {
      const review = result.result as any;

      if (!state.reviewResults) {
        state.reviewResults = [];
      }
      state.reviewResults.push(review);

      if (review.issues.length > 0) {
        for (const issue of review.issues) {
          this.logger.warn(`Review issue: ${issue}`);
        }
      }

      this.logger.info(
        `Review: ${review.approved ? 'APPROVED' : 'NOT APPROVED'}`,
        {
          issues: review.issues.length,
          summary: review.finalSummary,
        },
      );

      return review.approved;
    }

    this.logger.warn('Reviewer agent failed — auto-approving');
    return true;
  }

  private async finalize(
    state: TaskState,
    sandboxCwd: string,
  ): Promise<void> {
    const diffResult = await gitDiffTool.execute({ cwd: sandboxCwd });
    if (diffResult.success && diffResult.data) {
      state.diff = diffResult.data.diff;
    }

    await this.saveTaskLog(state);
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
          ? (err as any).code
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

  // ── Result Builder ─────────────────────────────────────────────

  private buildResult(
    state: TaskState,
    success: boolean,
    errorMessage?: string,
  ): TaskResult {
    const isFailedClean = state.status === 'failed_clean';
    const isFailedDirty = state.status === 'failed_dirty';

    const providerSummary =
      state.providerUsage.length > 0
        ? state.providerUsage
            .map(
              (p) =>
                `${p.agentName}: ${p.providerId}/${p.modelId}${p.error ? ` — ${p.error}` : ''}`,
            )
            .join('\n')
        : 'No provider calls recorded';

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
