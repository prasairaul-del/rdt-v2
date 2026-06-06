import type { RdtConfig } from './schema';

export function createDefaultConfig(): RdtConfig {
  return {
    version: 1,
    project: {
      name: 'auto',
      language: 'auto',
      package_manager: 'auto',
      test_command: 'auto',
      lint_command: 'auto',
    },
    runtime: {
      max_agent_steps: 20,
      max_edit_passes: 3,
      require_git_repo: true,
      allow_shell_commands: true,
      allow_destructive_commands: false,
      rollback_on_failed_task: true,
      preserve_user_changes: true,
      git_auto_commit: false,
      git_feature_branch: false,
    },
    context_budget: {
      default_max_input_tokens: 32_000,
      reserved_output_tokens: 4_000,
      repo_map_max_tokens: 6_000,
      file_picker_max_tokens: 12_000,
      planner_max_tokens: 20_000,
      editor_max_tokens: 28_000,
      reviewer_max_tokens: 28_000,
      max_file_read_tokens: 8_000,
      max_total_file_tokens_per_step: 18_000,
      truncation_strategy: 'summarize_then_select',
      never_truncate: ['AGENTS.md', 'knowledge.md', '.rdt/config.yaml'],
    },
    providers: [
      {
        id: 'openrouter',
        type: 'openai_compatible',
        base_url: 'https://openrouter.ai/api/v1',
        api_key_env: 'OPENROUTER_API_KEY',
        enabled: true,
        models: [
          {
            id: 'free',
            model: 'openrouter/free',
            tier: 'free',
            quality: 'low',
            cost: 'free',
            rpm_limit: 20,
            daily_limit: 50,
            supports_tools: 'auto',
            supports_json: 'auto',
            context_window: 'auto',
          },
        ],
      },
      {
        id: 'groq',
        type: 'openai_compatible',
        base_url: 'https://api.groq.com/openai/v1',
        api_key_env: 'GROQ_API_KEY',
        enabled: false,
        models: [],
      },
      {
        id: 'ollama',
        type: 'ollama',
        base_url: 'http://localhost:11434',
        enabled: false,
        models: [],
      },
    ],
    model_policies: {
      cheap_fast: {
        prefer: ['openrouter/free', 'local/small'],

        max_cost: 'low',
      },
      smart_reasoning: {
        prefer: ['openrouter/free', 'paid/strong', 'local/medium'],

        max_cost: 'medium',
      },
      code_strong: {
        prefer: ['openrouter/free', 'paid/code', 'local/code'],

        max_cost: 'medium',
      },
    },
    agents: {
      file_picker: {
        model_policy: 'cheap_fast',
        tools: ['list_files', 'read_file', 'search_files'],
      },
      planner: {
        model_policy: 'smart_reasoning',
        tools: ['read_file', 'search_files'],
      },
      editor: {
        model_policy: 'code_strong',
        tools: ['read_file', 'apply_patch', 'git_diff'],
      },
      reviewer: {
        model_policy: 'smart_reasoning',
        tools: [
          'read_file',
          'git_diff',
          'run_shell',
          'test_runner',
          'git_status_snapshot',
        ],
      },
    },
  };
}
