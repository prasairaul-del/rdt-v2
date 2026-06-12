import { execSync } from 'node:child_process';
import { loadConfig } from '../../config/load-config';
import type { RdtConfig } from '../../config/schema';
import { buildContext, type ProjectContext } from '../../project-context/context-builder';
import { detectProject } from '../../project-context/detect-project';
import { loadInstructions } from '../../project-context/load-instructions';
import { scanRepo, type RepoMap } from '../../project-context/repo-scanner';
import type { ProviderRouter } from '../../router/provider-router';
import { TaskLogger } from '../logger';
import type { TaskBaselines } from '../task-state';

/**
 * ExecutionContext manages project-level data, repository scanning,
 * and context building for agents.
 */
export class ExecutionContext {
  private _config?: RdtConfig;
  private _repoMap?: RepoMap;

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
  buildAgentContext(request: string): ProjectContext {
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
}
