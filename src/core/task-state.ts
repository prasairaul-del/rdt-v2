/**
 * Task state machine for RDT v2.
 *
 * States (per spec §13):
 *   CREATED -> CAPTURING_BASELINE -> LOADING_CONTEXT -> SCANNING_REPO
 *   -> SELECTING_FILES -> PLANNING -> EDITING -> REVIEWING
 *   -> FIXING (optional loop, max 3 passes) -> FINALIZING -> DONE
 *
 * Failure path:
 *   any state -> FAILED -> ROLLING_BACK -> FAILED_CLEAN | FAILED_DIRTY
 */

export type TaskStatus =
  | 'created'
  | 'capturing_baseline'
  | 'loading_context'
  | 'scanning_repo'
  | 'selecting_files'
  | 'planning'
  | 'editing'
  | 'reviewing'
  | 'fixing'
  | 'finalizing'
  | 'done'
  | 'failed'
  | 'rolling_back'
  | 'failed_clean'
  | 'failed_dirty';

/** Transitions that are valid from each state. */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  created:              ['capturing_baseline', 'failed'],
  capturing_baseline:   ['loading_context', 'failed'],
  loading_context:      ['scanning_repo', 'failed'],
  scanning_repo:        ['selecting_files', 'failed'],
  selecting_files:      ['planning', 'failed'],
  planning:             ['editing', 'failed'],
  editing:              ['reviewing', 'failed', 'done'],
  reviewing:            ['fixing', 'finalizing', 'failed'],
  fixing:               ['editing', 'failed', 'done'],
  finalizing:           ['done', 'failed'],
  done:                 [],
  failed:               ['rolling_back', 'failed_clean', 'failed_dirty'],
  rolling_back:         ['failed_clean', 'failed_dirty'],
  failed_clean:         [],
  failed_dirty:         [],
};

/** Error severity for determining failure path. */
export type ErrorSeverity = 'fatal' | 'recoverable' | 'warning';

export interface TaskError {
  message: string;
  code: string;
  severity: ErrorSeverity;
  state: TaskStatus;
  timestamp: string;
}

export interface TaskBaselines {
  headHash?: string;
  dirtyFiles: string[];
  rdtTouchedFiles: string[];
}

export interface ReviewResult {
  approved: boolean;
  issues: string[];
  testsRun: Array<{
    command: string;
    passed: boolean;
    outputSummary: string;
  }>;
  requiredFixes: string[];
  finalSummary: string;
}

export interface TaskState {
  id: string;
  request: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;

  // Configuration
  maxEditPasses: number;
  editPass: number;
  rollbackOnFailed: boolean;

  // Errors
  errors: TaskError[];

  // Baselines
  baselines?: TaskBaselines;

  // Accumulated results
  selectedFilesCount?: number;
  selectedFiles?: Array<{ path: string; reason: string; priority: 'high' | 'medium' | 'low' }>;
  planSummary?: string;
  plan?: {
    summary: string;
    steps: Array<{ id: string; description: string; targetFiles: string[]; risk: 'low' | 'medium' | 'high' }>;
    testPlan: string[];
    risks: string[];
  };
  changedFiles: string[];
  diff?: string;
  testResults?: string[];
  reviewResults?: ReviewResult[];

  // Provider usage
  providerUsage: Array<{
    agentName: string;
    providerId: string;
    modelId: string;
    promptTokens?: number;
    completionTokens?: number;
    durationMs: number;
    error?: string;
  }>;
}

export function createTaskState(request: string, maxEditPasses = 3, rollbackOnFailed = true): TaskState {
  const now = new Date().toISOString();
  return {
    id: `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    request,
    status: 'created',
    createdAt: now,
    updatedAt: now,
    maxEditPasses,
    editPass: 0,
    rollbackOnFailed,
    errors: [],
    changedFiles: [],
    providerUsage: [],
  };
}

/**
 * Transition the state machine to a new state.
 * Throws if the transition is not valid.
 */
export function transitionState(state: TaskState, to: TaskStatus): void {
  const allowed = TRANSITIONS[state.status];
  if (!allowed.includes(to)) {
    throw new Error(
      `Invalid state transition: ${state.status} -> ${to}. ` +
      `Allowed transitions from ${state.status}: [${allowed.join(', ')}]`,
    );
  }

  // Track timing
  if (to === 'failed' || to === 'failed_clean' || to === 'failed_dirty' || to === 'done') {
    state.finishedAt = new Date().toISOString();
  }

  state.status = to;
  state.updatedAt = new Date().toISOString();
}

/**
 * Add an error to the task state.
 * For fatal errors, transitions to 'failed' automatically.
 */
export function addTaskError(
  state: TaskState,
  message: string,
  code: string,
  severity: ErrorSeverity,
): void {
  state.errors.push({
    message,
    code,
    severity,
    state: state.status,
    timestamp: new Date().toISOString(),
  });
  state.updatedAt = new Date().toISOString();

  // Auto-transition for fatal errors
  if (severity === 'fatal' && state.status !== 'failed' && state.status !== 'failed_clean' && state.status !== 'failed_dirty') {
    transitionState(state, 'failed');
  }
}
