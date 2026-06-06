import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';

import { createTaskState, transitionState, addTaskError, type TaskState, type TaskStatus } from './task-state';
import { globalEventBus } from './events';
import { TaskLogger } from './logger';
import type { AgentName } from '../agents/agent-registry';
import { agentRegistry } from '../agents/agent-registry';
import type { PlannerAgentConfig } from '../agents/planner-agent';
import type { EditorAgentConfig } from '../agents/editor-agent';
import type { ReviewerAgentConfig } from '../agents/reviewer-agent';
import { ProviderRouter } from '../router/provider-router';
import type { RdtConfig } from '../config/schema';
import { loadConfig, resolveConfigPath } from '../config/load-config';
import { loadInstructions } from '../project-context/load-instructions';
import { detectProject } from '../project-context/detect-project';
import { scanRepo } from '../project-context/repo-scanner';
import { buildContext } from '../project-context/context-builder';
import { ProviderStateStore } from '../storage/provider-state-store';
import { TaskLogStore } from '../storage/task-log-store';
import { gitDiffTool } from '../tools/git-diff';
import { Sandbox } from '../tools/sandbox';

// ── Types ────────────────────────────────────────────────────────

export interface TaskRunnerConfig {
  projectRoot: string;
  rdtConfig?: RdtConfig;
  providerRouter?: ProviderRouter;
  stateStore?: ProviderStateStore;
  logStore?: TaskLogStore;
  logger?: TaskLogger;
}

export interface TaskResult {
  success: boolean;
  taskId: string;
  state: TaskState;
  summary: string;
  diff?: string;
  error?: string;
  providerSummary: string;
}

// ── Task Runner ──────────────────────────────────────────────────

export class TaskRunner {
  private config: TaskRunnerConfig;
  private router?: ProviderRouter;
  private stateStore: ProviderStateStore;
  private logStore: TaskLogStore;
  private logger: TaskLogger;

  constructor(config: TaskRunnerConfig) {
    this.config = config;
    this.stateStore = config.stateStore ?? new ProviderStateStore();
    this.logStore = config.logStore ?? new TaskLogStore(resolve(config.projectRoot, '.rdt', 'tasks.db'));
    this.logger = config.logger ?? new TaskLogger();
    // Initialize provider router from config if not provided externally
    if (!config.providerRouter && config.rdtConfig) {
      const router = new ProviderRouter(config.rdtConfig);
      router.initFromConfig(config.rdtConfig);
      this.router = router;
    } else {
      this.router = config.providerRouter;
    }
  }

  /**
   * Run a coding task through the full state machine.
   */
  async run(request: string): Promise<TaskResult> {
    const state = createTaskState(
      request,
      this.config.rdtConfig?.runtime.max_edit_passes ?? 3,
      this.config.rdtConfig?.runtime.rollback_on_failed_task ?? true,
    );

    this.logger.setTaskId(state.id);
    this.logger.info('Task created', { id: state.id, request });
    globalEventBus.emit('task:created', state.id, { request });

    const originalCwd = process.cwd();
    const sandbox = new Sandbox(this.config.projectRoot, state.id);
    let sandboxInitialized = false;
    let result: TaskResult;

    try {
      // ── STEP 1: CAPTURE BASELINE ────────────────────────────────
      // Captured on host workspace first
      await this.executeStep(state, 'capturing_baseline', async () => {
        this.logger.info('Capturing git baseline...');
        await this.captureBaseline(state);
        this.logger.info('Baseline captured', {
          hasGit: !!state.baselines?.headHash,
          dirtyFiles: state.baselines?.dirtyFiles.length ?? 0,
        });
      });

      // Initialize isolated sandbox
      this.logger.info('Initializing isolated shadow sandbox...');
      await sandbox.init();
      sandboxInitialized = true;
      process.chdir(sandbox.sandboxPath);
      this.logger.info(`Sandbox active. Temporary workspace: ${sandbox.sandboxPath}`);

      // ── STEP 2: LOAD CONTEXT ────────────────────────────────────
      await this.executeStep(state, 'loading_context', async () => {
        this.logger.info('Loading project context...');
        await this.loadProjectContext(state);
        this.logger.info('Context loaded');
      });

      // ── STEP 3: SCAN REPO ───────────────────────────────────────
      await this.executeStep(state, 'scanning_repo', async () => {
        this.logger.info('Scanning repository...');
        await this.scanRepository(state);
        this.logger.info('Repository scanned');
      });

      // ── STEP 4: SELECT FILES ────────────────────────────────────
      await this.executeStep(state, 'selecting_files', async () => {
        this.logger.info('Selecting relevant files...');
        await this.selectFiles(state);
        this.logger.info('Files selected', { count: state.selectedFilesCount });
      });

      // ── STEP 5: PLAN ────────────────────────────────────────────
      await this.executeStep(state, 'planning', async () => {
        this.logger.info('Creating plan...');
        await this.createPlan(state);
        this.logger.info('Plan created', { summary: state.planSummary });
      });

      // ── STEP 6-8: EDIT/REVIEW LOOP ──────────────────────────────
      let approved = false;
      while (state.editPass < state.maxEditPasses && !approved) {
        state.editPass++;

        // EDIT
        await this.executeStep(state, 'editing', async () => {
          this.logger.info(`Edit pass ${state.editPass}/${state.maxEditPasses}...`);
          await this.editFiles(state);
        });

        // REVIEW
        await this.executeStep(state, 'reviewing', async () => {
          this.logger.info(`Reviewing pass ${state.editPass}/${state.maxEditPasses}...`);
          approved = await this.reviewChanges(state);
        });

        // Check if we need another pass
        if (!approved && state.editPass < state.maxEditPasses) {
          transitionState(state, 'fixing');
          this.logger.info(`Edit pass ${state.editPass} not approved — moving to fixing`, {
            issues: state.errors.length,
          });
        } else if (approved) {
          this.logger.info('Review approved');
        } else {
          this.logger.warn('Max edit passes reached without approval');
        }
      }

      // ── STEP 9: FINALIZE ────────────────────────────────────────
      await this.executeStep(state, 'finalizing', async () => {
        this.logger.info('Finalizing task...');
        await this.finalize(state);
      });

      // Restore directory back to host before writing back files
      process.chdir(originalCwd);

      if (sandboxInitialized) {
        this.logger.info('Applying sandboxed edits back to host workspace...');
        const appliedFiles = await sandbox.applyToHost(state.changedFiles);
        this.logger.info(`Applied ${appliedFiles.length} file(s) back to host workspace.`);
      }

      // Git Auto Commit if configured
      if (this.config.rdtConfig?.runtime.git_auto_commit && state.baselines?.headHash && state.changedFiles.length > 0) {
        try {
          this.logger.info('Performing Git auto-commit...');
          for (const file of state.changedFiles) {
            spawnSync('git', ['add', file], { cwd: this.config.projectRoot });
          }
          const commitMsg = `rdt: ${state.request}`;
          const commitRes = spawnSync('git', ['commit', '-m', commitMsg], { cwd: this.config.projectRoot });
          if (commitRes.status === 0) {
            this.logger.info('Git auto-commit succeeded');
          } else {
            this.logger.warn(`Git auto-commit failed with exit code ${commitRes.status}: ${commitRes.stderr?.toString()}`);
          }
        } catch (commitErr) {
          const errMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
          this.logger.warn(`Git auto-commit failed: ${errMsg}`);
        }
      }

      // ── SUCCESS ─────────────────────────────────────────────────
      transitionState(state, 'done');
      this.logger.info('Task completed successfully');

      result = this.buildResult(state, true);
    } catch (err) {
      // Ensure host directory is restored on failure before executing failure handling
      process.chdir(originalCwd);
      result = await this.handleFailure(state, err);
    } finally {
      if (sandboxInitialized) {
        this.logger.info('Cleaning up shadow sandbox...');
        await sandbox.destroy();
      }
    }

    return result;
  }

  // ── Step Executor ──────────────────────────────────────────────

  private async executeStep(
    state: TaskState,
    targetState: TaskStatus,
    fn: () => Promise<void>,
  ): Promise<void> {
    const from = state.status;
    transitionState(state, targetState);
    globalEventBus.emitStateChange(state.id, from, targetState);
    try {
      await fn();
      globalEventBus.emitProgress(state.id, targetState, state.editPass / state.maxEditPasses);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof Error && 'code' in err ? (err as Error & { code: string }).code : 'STEP_ERROR';
      addTaskError(state, message, code, 'fatal');
      throw err; // Re-throw to be caught by run()
    }
  }

  // ── Step Implementations ───────────────────────────────────────

  private async captureBaseline(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;

    try {
      const headHash = execSync('git rev-parse HEAD', {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();
      state.baselines = { headHash, dirtyFiles: [], rdtTouchedFiles: [] };
    } catch {
      // Not a git repo — that's ok if require_git_repo is false
      state.baselines = { dirtyFiles: [], rdtTouchedFiles: [] };
    }

    // Capture dirty files
    if (state.baselines) {
      try {
        const status = execSync('git status --porcelain', {
          cwd: projectRoot,
          encoding: 'utf-8',
        }).trim();
        if (status) {
          state.baselines.dirtyFiles = status.split('\n')
            .filter((l) => l.trim())
            .map((l) => l.slice(3).trim());
        }
      } catch {
        // No git status available
      }
    }
  }

  private async loadProjectContext(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;
    const configResult = loadConfig(projectRoot);
    const instructions = loadInstructions(projectRoot);
    const projectInfo = detectProject(projectRoot);
    const repoMap = scanRepo(projectRoot);

    // Store the loaded config
    this.config.rdtConfig = configResult.config;
  }

  private async scanRepository(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;
    const repoMap = scanRepo(projectRoot);

    this.logger.info(`Found ${repoMap.totalFiles} files in ${repoMap.totalDirs} directories`);

    try {
      const { VectorSearch } = await import('../project-context/vector-search');
      const vectorSearch = new VectorSearch(projectRoot, this.router);
      await vectorSearch.init();
      this.logger.info('Indexing repository for vector search...');
      const indexedCount = await vectorSearch.indexRepository(repoMap);
      this.logger.info(`Vector search indexing complete. Indexed/updated ${indexedCount} files.`);
    } catch (err) {
      this.logger.warn('Failed to build vector search index, falling back to heuristics only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async selectFiles(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;
    const projectInfo = detectProject(projectRoot);
    const instructions = loadInstructions(projectRoot);
    const repoMap = scanRepo(projectRoot);
    const context = buildContext(projectInfo, instructions, repoMap, state.request);

    // Use the file picker agent
    const filePicker = agentRegistry.get('file_picker');
    if (!filePicker) {
      addTaskError(state, 'File picker agent not found', 'AGENT_NOT_FOUND', 'fatal');
      return;
    }

    const filePickerConfig = {
      router: this.router,
      policyName: this.config.rdtConfig?.agents?.file_picker?.model_policy ?? 'cheap_fast',
    };
    const result = await filePicker.execute({
      task: state,
      project: context,
    }, filePickerConfig);

    if (result.success && result.result) {
      const selection = result.result as { files: Array<{ path: string; reason: string; priority: 'high' | 'medium' | 'low' }> };
      state.selectedFilesCount = selection.files.length;
      state.selectedFiles = selection.files;
      this.logger.info(`Selected ${selection.files.length} files`, {
        high: selection.files.filter((f: { priority: string }) => f.priority === 'high').length,
        medium: selection.files.filter((f: { priority: string }) => f.priority === 'medium').length,
      });
    } else {
      this.logger.warn('File picker returned no results', { error: result.error?.message });
      state.selectedFilesCount = 0;
    }
  }

  private async createPlan(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;
    const projectInfo = detectProject(projectRoot);
    const instructions = loadInstructions(projectRoot);
    const repoMap = scanRepo(projectRoot);
    const context = buildContext(projectInfo, instructions, repoMap, state.request);

    const planner = agentRegistry.get('planner');
    if (!planner) {
      addTaskError(state, 'Planner agent not found', 'AGENT_NOT_FOUND', 'fatal');
      return;
    }

    const router = this.router;
    const plannerConfig: PlannerAgentConfig = {
      router: router ?? {} as ProviderRouter,
      policyName: this.config.rdtConfig?.agents?.planner?.model_policy ?? 'smart_reasoning',
      tools: [],
    };

    const result = await planner.execute({
      task: state,
      project: context,
      files: state.selectedFiles,
    }, plannerConfig);

    if (result.success && result.result) {
      const plan = result.result as {
        summary: string;
        steps: Array<{ id: string; description: string; targetFiles: string[]; risk: 'low' | 'medium' | 'high' }>;
        testPlan: string[];
        risks: string[];
      };
      state.planSummary = plan.summary.substring(0, 200);
      state.plan = plan;
      this.logger.info(`Plan: ${plan.summary}`, {
        steps: plan.steps.length,
      });
    } else {
      addTaskError(state, 'Planner agent failed', 'PLANNER_FAILED', 'recoverable');
    }
  }

  private async editFiles(state: TaskState): Promise<void> {
    const projectRoot = this.config.projectRoot;
    const projectInfo = detectProject(projectRoot);
    const instructions = loadInstructions(projectRoot);
    const repoMap = scanRepo(projectRoot);
    const context = buildContext(projectInfo, instructions, repoMap, state.request);

    const editor = agentRegistry.get('editor');
    if (!editor) {
      addTaskError(state, 'Editor agent not found', 'AGENT_NOT_FOUND', 'fatal');
      return;
    }

    const editorConfig: EditorAgentConfig = {
      router: this.router ?? {} as ProviderRouter,
      policyName: this.config.rdtConfig?.agents?.editor?.model_policy ?? 'code_strong',
      tools: [],
    };

    const result = await editor.execute({
      task: state,
      plan: state.plan,
      project: context,
    }, editorConfig);

    if (result.success && result.result) {
      const editResult = result.result as { changedFiles: string[]; diff: string; needsReview: boolean; summary: string };
      state.changedFiles = [...new Set([...state.changedFiles, ...editResult.changedFiles])];

      // Track RDT-touched files for rollback
      if (state.baselines) {
        state.baselines.rdtTouchedFiles = [
          ...new Set([...state.baselines.rdtTouchedFiles, ...editResult.changedFiles]),
        ];
      }

      this.logger.info('Edit complete', {
        files: editResult.changedFiles.length,
        needsReview: editResult.needsReview,
      });
    } else {
      addTaskError(state, 'Editor agent failed', 'EDITOR_FAILED', 'recoverable');
    }
  }

  private async reviewChanges(state: TaskState): Promise<boolean> {
    const projectRoot = this.config.projectRoot;
    const projectInfo = detectProject(projectRoot);
    const instructions = loadInstructions(projectRoot);
    const repoMap = scanRepo(projectRoot);
    const context = buildContext(projectInfo, instructions, repoMap, state.request);

    // Capture diff
    const diffResult = await gitDiffTool.execute({});
    if (diffResult.success && diffResult.data) {
      state.diff = diffResult.data.diff;
    }

    const reviewer = agentRegistry.get('reviewer');
    if (!reviewer) {
      this.logger.warn('Reviewer agent not found — auto-approving');
      return true;
    }

    const reviewerConfig: ReviewerAgentConfig = {
      router: this.router ?? {} as ProviderRouter,
      policyName: this.config.rdtConfig?.agents?.reviewer?.model_policy ?? 'smart_reasoning',
    };

    const result = await reviewer.execute({
      task: state,
      plan: state.plan as any,
      project: context,
      diff: state.diff,
    }, reviewerConfig);

    if (result.success && result.result) {
      const review = result.result as any;

      // Save review results onto the state for dynamic agent feedback loops
      if (!state.reviewResults) {
        state.reviewResults = [];
      }
      state.reviewResults.push(review);

      if (review.issues.length > 0) {
        for (const issue of review.issues) {
          this.logger.warn(`Review issue: ${issue}`);
        }
      }

      this.logger.info(`Review: ${review.approved ? 'APPROVED' : 'NOT APPROVED'}`, {
        issues: review.issues.length,
        summary: review.finalSummary,
      });

      return review.approved;
    }

    this.logger.warn('Reviewer agent failed — auto-approving');
    return true;
  }

  private async finalize(state: TaskState): Promise<void> {
    // Get final diff
    const diffResult = await gitDiffTool.execute({});
    if (diffResult.success && diffResult.data) {
      state.diff = diffResult.data.diff;
    }

    // Save task log
    await this.saveTaskLog(state);
  }

  // ── Failure Handling ───────────────────────────────────────────

  private async handleFailure(state: TaskState, err: unknown): Promise<TaskResult> {
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error(`Task failed: ${message}`);
    globalEventBus.emitError(state.id, message, 'TASK_FAILURE');

    // Ensure the error is recorded on the state (which auto-transitions to 'failed' if needed)
    if (!state.errors.some(e => e.message === message)) {
      const code = err instanceof Error && 'code' in err ? (err as any).code : 'TASK_FAILURE';
      addTaskError(state, message, code, 'fatal');
    }

    // Rollback if configured
    if (state.rollbackOnFailed && state.baselines?.rdtTouchedFiles.length) {
      try {
        transitionState(state, 'rolling_back');
        this.logger.info('Rolling back RDT-touched files...');
        await this.rollback(state);
        transitionState(state, 'failed_clean');
        this.logger.info('Rollback succeeded — state is FAILED_CLEAN');
      } catch (rollbackErr) {
        const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        this.logger.error(`Rollback failed: ${rollbackMsg}`);
        transitionState(state, 'failed_dirty');
      }
    } else if (state.rollbackOnFailed) {
      // No files to rollback or no baseline
      transitionState(state, 'failed_clean');
    } else {
      transitionState(state, 'failed_dirty');
    }

    // Save failed state
    await this.saveTaskLog(state);
    // Save failed diff
    await this.saveFailedPatch(state);

    return this.buildResult(state, false, message);
  }

  private async rollback(state: TaskState): Promise<void> {
    if (!state.baselines?.rdtTouchedFiles.length) return;
    if (!state.baselines?.headHash) return;

    const projectRoot = this.config.projectRoot;
    const touched = state.baselines.rdtTouchedFiles;

    // Restore each touched file from git
    for (const file of touched) {
      const filePath = resolve(projectRoot, file);
      if (existsSync(filePath)) {
        try {
          execSync(`git checkout -- "${file}"`, { cwd: projectRoot, encoding: 'utf-8' });
          this.logger.debug(`Rolled back: ${file}`);
        } catch {
          this.logger.warn(`Could not rollback: ${file}`);
        }
      }
    }
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
      writeFileSync(patchPath, `# Failed task patch: ${state.id}\n# Request: ${state.request}\n${diff}`, 'utf-8');
      this.logger.info(`Failed patch saved: ${patchPath}`);
    }
  }

  // ── Logging ────────────────────────────────────────────────────

  private async saveTaskLog(state: TaskState): Promise<void> {
    try {
      this.logStore.createLog(state.request);
      this.logStore.updateLog(state.id, {
        status: state.status === 'done' ? 'success' : 'failed',
        finishedAt: state.finishedAt ?? new Date().toISOString(),
        selectedFiles: state.changedFiles,
        planSummary: state.planSummary,
        changedFiles: state.changedFiles,
        providersUsed: state.providerUsage.map((p) => `${p.providerId}/${p.modelId}`),
        finalSummary: `Task ${state.status}: ${state.changedFiles.length} file(s) changed`,
        errorMessage: state.errors.map((e) => e.message).join('; '),
      });
    } catch (err) {
      this.logger.warn('Failed to save task log', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Result Builder ─────────────────────────────────────────────

  private buildResult(state: TaskState, success: boolean, errorMessage?: string): TaskResult {
    const isFailedClean = state.status === 'failed_clean';
    const isFailedDirty = state.status === 'failed_dirty';

    // Build provider summary
    const providerSummary = state.providerUsage.length > 0
      ? state.providerUsage
        .map((p) => `${p.agentName}: ${p.providerId}/${p.modelId}${p.error ? ` — ${p.error}` : ''}`)
        .join('\n')
      : 'No provider calls recorded';

    // Build summary text
    const summaryParts: string[] = [];
    if (success) {
      summaryParts.push('Task completed successfully');
    } else if (isFailedClean) {
      summaryParts.push('Task failed — changes rolled back (FAILED_CLEAN)');
    } else if (isFailedDirty) {
      summaryParts.push('Task failed — repository may have uncommitted changes (FAILED_DIRTY)');
    } else {
      summaryParts.push('Task failed');
    }

    if (state.changedFiles.length > 0) {
      summaryParts.push(`Modified ${state.changedFiles.length} file(s)`);
    }

    if (errorMessage) {
      summaryParts.push(`Error: ${errorMessage}`);
    }

    // Log provider usage
    for (const usage of state.providerUsage) {
      this.logger.info(`Provider: ${usage.agentName} -> ${usage.providerId}/${usage.modelId}`, {
        duration: `${usage.durationMs}ms`,
        tokens: usage.promptTokens ? `${usage.promptTokens} in / ${usage.completionTokens} out` : undefined,
        error: usage.error,
      });
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
