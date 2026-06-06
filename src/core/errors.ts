/**
 * Custom error types for the RDT v2 task runner.
 */

export class TaskError extends Error {
  public code: string;
  public recoverable: boolean;
  public details?: Record<string, unknown>;

  constructor(message: string, code: string, recoverable = false, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

export class ProviderError extends Error {
  public code: string;
  public retryable: boolean;
  public cooldownMs?: number;

  constructor(message: string, code: string, retryable = false, cooldownMs?: number) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.cooldownMs = cooldownMs;
  }
}

export class ToolExecutionError extends Error {
  public toolName: string;
  public errorType: string;
  public suggestions?: string[];

  constructor(toolName: string, message: string, errorType: string, suggestions?: string[]) {
    super(message);
    this.name = 'ToolExecutionError';
    this.toolName = toolName;
    this.errorType = errorType;
    this.suggestions = suggestions;
  }
}

export class StateTransitionError extends Error {
  public from: string;
  public to: string;
  public allowedTransitions: string[];

  constructor(from: string, to: string, allowedTransitions: string[]) {
    super(
      `Invalid state transition: ${from} -> ${to}. ` +
      `Allowed transitions from ${from}: [${allowedTransitions.join(', ')}]`,
    );
    this.name = 'StateTransitionError';
    this.from = from;
    this.to = to;
    this.allowedTransitions = allowedTransitions;
  }
}

export class AgentError extends Error {
  public agentName: string;
  public code: string;
  public toolCalls?: Array<{ toolName: string; durationMs: number }>;

  constructor(agentName: string, message: string, code: string, toolCalls?: Array<{ toolName: string; durationMs: number }>) {
    super(message);
    this.name = 'AgentError';
    this.agentName = agentName;
    this.code = code;
    this.toolCalls = toolCalls;
  }
}
