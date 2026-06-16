import type { TaskContext } from '../project-context/context-builder';
import type { CompletionUsage } from '../providers/types';

// ── Re-export canonical types from core ──────────────────────────
export type { TaskStatus } from '../core/runner/types';
export type { TaskState } from '../core/runner/types';
export type { ReviewResult } from '../core/runner/types';

// Import for local use in AgentInput
import type { TaskState } from '../core/runner/types';

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
