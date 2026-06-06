export interface RdtConfig {
  version: number;
  project: ProjectConfig;
  runtime: RuntimeConfig;
  context_budget: ContextBudgetConfig;
  providers: ProviderConfig[];
  model_policies: Record<string, ModelPolicyConfig>;
  agents: Record<string, AgentConfig>;
}

export interface ProjectConfig {
  name: string;
  language: 'auto' | string;
  package_manager: 'auto' | string;
  test_command: 'auto' | string;
  lint_command: 'auto' | string;
}

export interface RuntimeConfig {
  max_agent_steps: number;
  max_edit_passes: number;
  require_git_repo: boolean;
  allow_shell_commands: boolean;
  allow_destructive_commands: boolean;
  rollback_on_failed_task: boolean;
  preserve_user_changes: boolean;
  git_auto_commit?: boolean;
  git_feature_branch?: boolean;
}

export interface ContextBudgetConfig {
  default_max_input_tokens: number;
  reserved_output_tokens: number;
  repo_map_max_tokens: number;
  file_picker_max_tokens: number;
  planner_max_tokens: number;
  editor_max_tokens: number;
  reviewer_max_tokens: number;
  max_file_read_tokens: number;
  max_total_file_tokens_per_step: number;
  truncation_strategy: 'summarize_then_select' | string;
  never_truncate: string[];
}

export interface ProviderConfig {
  id: string;
  type:
    | 'openai_compatible'
    | 'ollama'
    | 'anthropic'
    | 'google'
    | 'google_vertex';
  base_url: string;
  api_key_env?: string;
  enabled: boolean;
  models: ProviderModelConfig[];
}

export interface ProviderModelConfig {
  id: string;
  model: string;
  tier: 'free' | string;
  quality: 'low' | 'medium' | 'high';
  cost: 'free' | 'low' | 'medium' | 'high';
  rpm_limit?: number;
  daily_limit?: number;
  supports_tools: boolean | 'auto';
  supports_json: boolean | 'auto';
  context_window: number | 'auto';
}

export interface ModelPolicyConfig {
  prefer: string[];
  max_cost: 'low' | 'medium' | 'high';
}

export interface AgentConfig {
  model_policy: string;
  tools: string[];
}
