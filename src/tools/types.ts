import type { ToolResult } from '../core/result';

export type ToolName =
  | 'list_files'
  | 'read_file'
  | 'search_files'
  | 'write_file'
  | 'apply_patch'
  | 'git_diff'
  | 'run_shell'
  | 'test_runner';

export interface Tool<Input = unknown, Output = unknown> {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Input): Promise<ToolResult<Output>>;
}
