import { execSync, spawnSync } from 'node:child_process';
import { loadConfig } from '../../config/load-config';
import type { RdtConfig } from '../../config/schema';
import { buildContext, type TaskContext } from '../../project-context/context-builder';
import { detectProject } from '../../project-context/detect-project';
import { loadInstructions } from '../../project-context/load-instructions';
import { scanRepo } from '../../project-context/repo-scanner';
import type { RepoMap } from '../../project-context/repo-map';
import type { ProviderRouter } from '../../router/provider-router';
import { Sandbox } from '../../tools/sandbox';
import { TaskLogger } from '../logger';
import type { TaskBaselines, TaskState } from '../task-state';

/**
 * ExecutionContext manages project-level data, repository scanning,
 * and context building for agents.
 */
export class ExecutionContext {
  private _config?: RdtConfig;
  private _repoMap?: RepoMap;
  private _sandbox?: Sandbox;
  private _originalBranch: string | null = null;

  constructor(
    private projectRoot: string,
    private logger: TaskLogger,
    private router?: ProviderRouter,
  ) {}

  /**
   * Load initial project context (config, instructions, project info).
   */
  async load(): Promise<void> {
    const configResult = loadConfig(this.projectRoot);
    this._config = configResult.config;
    this.logger.debug('Project config loaded');
  }

  /**
   * Capture the current git baseline (HEAD hash and dirty files).
   */
  async captureBaseline(): Promise<TaskBaselines> {
    let baselines: TaskBaselines;

    try {
      const headHash = execSync('git rev-parse HEAD', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
      }).trim();
      baselines = { headHash, dirtyFiles: [], rdtTouchedFiles: [] };
    } catch {
      // Not a git repo
      baselines = { dirtyFiles: [], rdtTouchedFiles: [] };
    }

    // Capture dirty files
    try {
      const status = execSync('git status --porcelain', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
      }).trim();
      if (status) {
        baselines.dirtyFiles = status
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => l.slice(3).trim());
      }
    } catch {
      // No git status available
    }

    return baselines;
  }

  /**
   * Setup Git feature branch if configured.
   */
  async setupFeatureBranch(state: TaskState): Promise<void> {
    if (
      this._config?.runtime.git_feature_branch &&
      state.baselines?.headHash
    ) {
      try {
        this._originalBranch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: this.projectRoot,
          encoding: 'utf-8',
        }).trim();

        this.logger.info(
          `Creating Git feature branch 'rdt/task-${state.id}'...`,
        );
        execSync(`git checkout -b "rdt/task-${state.id}"`, {
          cwd: this.projectRoot,
          encoding: 'utf-8',
        });
        this.logger.info(`Switched to feature branch 'rdt/task-${state.id}'`);
      } catch (err) {
        this.logger.warn(
          `Failed to setup Git feature branch: ${err instanceof Error ? err.message : String(err)}`,
        );
        this._originalBranch = null;
      }
    }
  }

  /**
   * Restore original Git branch.
   */
  async restoreBranch(state: TaskState, force = false): Promise<void> {
    if (this._originalBranch) {
      try {
        this.logger.info(
          `Checking back out to original branch '${this._originalBranch}'...`,
        );
        execSync(`git checkout ${force ? '-f ' : ''}"${this._originalBranch}"`, {
          cwd: this.projectRoot,
          encoding: 'utf-8',
        });
        
        if (force) {
          // If forced (failure), delete the feature branch
          execSync(`git branch -D "rdt/task-${state.id}"`, {
            cwd: this.projectRoot,
            encoding: 'utf-8',
          });
          this.logger.info(
            `Deleted temporary feature branch 'rdt/task-${state.id}'`,
          );
        } else {
          this.logger.info(
            `Switched back to branch '${this._originalBranch}'. Changes are preserved on 'rdt/task-${state.id}'.`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Failed to restore branch: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Commit changes to Git if configured.
   */
  async commitChanges(state: TaskState): Promise<void> {
    const shouldCommit =
      this._config?.runtime.git_auto_commit || this._originalBranch;
    
    if (
      shouldCommit &&
      state.baselines?.headHash &&
      state.changedFiles.length > 0
    ) {
      try {
        this.logger.info('Performing Git commit...');
        for (const file of state.changedFiles) {
          spawnSync('git', ['add', file], { cwd: this.projectRoot });
        }
        
        const fileList =
          state.changedFiles.slice(0, 5).join(', ') +
          (state.changedFiles.length > 5
            ? ` (+${state.changedFiles.length - 5} more)`
            : '');
        const planLine = state.planSummary
          ? `\nPlan: ${state.planSummary}`
          : '';
        const commitMsg = `rdt [${state.id}]: ${state.request}${planLine}\nFiles: ${fileList}`;
        
        const commitRes = spawnSync('git', ['commit', '-m', commitMsg], {
          cwd: this.projectRoot,
        });
        
        if (commitRes.status === 0) {
          this.logger.info('Git commit succeeded');
        } else {
          this.logger.warn(
            `Git commit failed with exit code ${commitRes.status}: ${commitRes.stderr?.toString()}`,
          );
        }
      } catch (commitErr) {
        const errMsg =
          commitErr instanceof Error ? commitErr.message : String(commitErr);
        this.logger.warn(`Git commit failed: ${errMsg}`);
      }
    }
  }

  /**
   * Initialize sandbox for the task.
   */
  async initSandbox(taskId: string): Promise<string> {
    this._sandbox = new Sandbox(this.projectRoot, taskId);
    this.logger.info('Initializing isolated shadow sandbox...');
    await this._sandbox.init();
    this.logger.info(`Sandbox active. Temporary workspace: ${this._sandbox.sandboxPath}`);
    return this._sandbox.sandboxPath;
  }

  /**
   * Apply changes from sandbox back to host.
   */
  async applySandboxChanges(files: string[]): Promise<string[]> {
    if (!this._sandbox) return [];
    this.logger.info('Applying sandboxed edits back to host workspace...');
    const appliedFiles = await this._sandbox.applyToHost(files);
    this.logger.info(
      `Applied ${appliedFiles.length} file(s) back to host workspace.`,
    );
    return appliedFiles;
  }

  /**
   * Destroy the sandbox.
   */
  async destroySandbox(): Promise<void> {
    if (this._sandbox) {
      this.logger.info('Cleaning up shadow sandbox...');
      await this._sandbox.destroy();
      this._sandbox = undefined;
    }
  }

  /**
   * Scan the repository to build a map of files and directories.
   */
  async scan(): Promise<RepoMap> {
    this._repoMap = scanRepo(this.projectRoot);
    this.logger.info(
      `Found ${this._repoMap.totalFiles} files in ${this._repoMap.totalDirs} directories`,
    );
    return this._repoMap;
  }

  /**
   * Initialize and run vector search indexing.
   */
  async indexForSearch(): Promise<number> {
    if (!this._repoMap) await this.scan();
    
    try {
      const { VectorSearch } = await import('../../project-context/vector-search');
      const vectorSearch = new VectorSearch(this.projectRoot, this.router);
      await vectorSearch.init();
      
      this.logger.info('Indexing repository for vector search...');
      const indexedCount = await vectorSearch.indexRepository(this._repoMap!);
      this.logger.info(
        `Vector search indexing complete. Indexed/updated ${indexedCount} files.`,
      );
      return indexedCount;
    } catch (err) {
      this.logger.warn(
        'Failed to build vector search index, falling back to heuristics only',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
      return 0;
    }
  }

  /**
   * Build the project context used by agents.
   */
  buildAgentContext(request: string): TaskContext {
    const projectInfo = detectProject(this.projectRoot);
    const instructions = loadInstructions(this.projectRoot);
    const repoMap = this._repoMap ?? scanRepo(this.projectRoot);

    return buildContext(
      projectInfo,
      instructions,
      repoMap,
      request,
    );
  }

  get config(): RdtConfig | undefined {
    return this._config;
  }

  get repoMap(): RepoMap | undefined {
    return this._repoMap;
  }

  get sandboxPath(): string | undefined {
    return this._sandbox?.sandboxPath;
  }

  get originalBranch(): string | null {
    return this._originalBranch;
  }
}
