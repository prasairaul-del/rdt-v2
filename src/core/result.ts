export type ToolErrorType =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'COMMAND_FAILED'
  | 'INTERNAL_ERROR';

export interface ToolError {
  type: ToolErrorType;
  message: string;
  suggestions?: string[];
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: ToolError;
}

export function successResult<T>(data: T): ToolResult<T> {
  return { success: true, data };
}

export function errorResult<T = never>(
  type: ToolErrorType,
  message: string,
  suggestions?: string[],
): ToolResult<T> {
  return { success: false, error: { type, message, suggestions } };
}
