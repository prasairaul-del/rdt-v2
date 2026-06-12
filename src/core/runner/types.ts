import type { ProviderRouter } from '../../router/provider-router';
import type { ProviderStateStore } from '../../storage/provider-state-store';
import type { TaskLogStore } from '../../storage/task-log-store';
import type { RdtConfig } from '../../config/schema';
import type { TaskLogger } from '../logger';

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
  selectedFiles?: Array<{
    path: string;
    reason: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  planSummary?: string;
  plan?: {
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

export interface TaskRunnerConfig {
  projectRoot: string;
  rdtConfig?: RdtConfig;
  providerRouter?: ProviderRouter;
  stateStore?: ProviderStateStore;
  logStore?: TaskLogStore;
  logger?: TaskLogger;
  checkCancellation?: () => boolean;
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

export interface StepContext {
  state: TaskState;
  config: TaskRunnerConfig;
  executionContext: any; // Using any for now to avoid circular dependency
  router?: ProviderRouter;
  logger: TaskLogger;
  sandboxCwd?: string;
}
