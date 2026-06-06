import type { ModelPolicyConfig, ProviderModelConfig } from '../config/schema';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface CompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  model: string;
  messages: CompletionMessage[];
  tools?: ToolDefinition[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompletionResponse {
  content: string;
  model: string;
  provider: string;
  usage?: CompletionUsage;
  tool_calls?: ToolCall[];
  finish_reason?: 'stop' | 'length' | 'tool_calls';
}

export interface ProviderErrorDetails {
  code: string;
  message: string;
  status?: number;
  retryable: boolean;
  cooldownMs?: number;
}

export interface ProviderConfigForClient {
  id: string;
  type: 'openai_compatible' | 'ollama';
  baseUrl: string;
  apiKeyEnv?: string;
  enabled: boolean;
  models: ProviderModelConfig[];
}

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfigForClient;
  isAvailable(): boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  embed?(model: string, text: string): Promise<number[]>;
}

export interface ProviderModelState {
  providerId: string;
  modelId: string;
  /** The actual model name sent to the API (e.g. "openrouter/free"). Falls back to modelId. */
  modelName?: string;
  enabled: boolean;
  rpmLimit?: number;
  dailyLimit?: number;
  requestsThisMinute: number;
  requestsToday: number;
  lastRequestAt?: string;
  lastErrorAt?: string;
  lastErrorCode?: string;
  cooldownUntil?: string;
  supportsTools: boolean | 'auto';
  supportsJson: boolean | 'auto';
  contextWindow?: number | 'auto';
  quality: 'low' | 'medium' | 'high';
  cost: 'free' | 'low' | 'medium' | 'high';
}

export type ModelPolicyMatchResult = {
  policy: ModelPolicyConfig;
  candidates: ProviderModelState[];
};
