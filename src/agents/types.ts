import type { TaskContext } from '../project-context/context-builder';
import type { CompletionUsage } from '../providers/types';

// ── Agent Input / Output base types ──────────────────────────────

export interface AgentInput {
  task: TaskState;
  project: TaskContext;
  files?: SelectedFile[];
  plan?: Plan;
  diff?: string;
}

export interface AgentOutput<T = unknown> {
  success: boolean;
  result?: T;
  error?: AgentError;
  modelUsed: string;
  providerUsed: string;
  toolCalls: ToolCallRecord[];
}

export interface AgentError {
  message: string;
  code: string;
  recoverable: boolean;
}

export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  durationMs: number;
}

// ── Task State (shared with core) ────────────────────────────────

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

export interface TaskState {
  id: string;
  request: string;
  status: TaskStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  errorMessage?: string;
  editPass: number;
  maxEditPasses: number;
  baselines?: {
    headHash?: string;
    dirtyFiles: string[];
    rdtTouchedFiles: string[];
  };
  selectedFiles?: SelectedFile[];
  planSummary?: string;
  plan?: Plan;
  editResults?: EditResult[];
  reviewResults?: ReviewResult[];
  providerUsage: ProviderUsageEntry[];
}

export interface ProviderUsageEntry {
  agentName: string;
  providerId: string;
  modelId: string;
  usage?: CompletionUsage;
  error?: string;
  durationMs: number;
}

// ── File Selection ───────────────────────────────────────────────

export interface SelectedFile {
  path: string;
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

export interface FileSelection {
  files: SelectedFile[];
  searchQueries: string[];
  confidence: number;
}

// ── Plan ─────────────────────────────────────────────────────────

export interface PlanStep {
  id: string;
  description: string;
  targetFiles: string[];
  risk: 'low' | 'medium' | 'high';
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
  testPlan: string[];
  risks: string[];
}

// ── Edit Result ──────────────────────────────────────────────────

export interface EditResult {
  changedFiles: string[];
  summary: string;
  diff: string;
  needsReview: boolean;
}

// ── Review Result ────────────────────────────────────────────────

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
