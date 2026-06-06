import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  ProviderConfigForClient,
} from './types';

export interface MockResponseConfig {
  content?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class MockProvider implements Provider {
  readonly name: string;
  readonly config: ProviderConfigForClient;
  private responseConfig: MockResponseConfig;
  public callHistory: Array<{ request: CompletionRequest; timestamp: number }> =
    [];

  constructor(
    name: string,
    config?: Partial<ProviderConfigForClient>,
    responseConfig?: MockResponseConfig,
  ) {
    this.name = name;
    this.config = {
      id: name,
      type: 'openai_compatible',
      baseUrl: 'http://mock',
      enabled: true,
      models: [],
      ...config,
    };
    this.responseConfig = {
      content: 'Mock response',
      model: 'mock-model',
      ...responseConfig,
    };
  }

  setResponse(config: MockResponseConfig): void {
    this.responseConfig = { ...this.responseConfig, ...config };
  }

  isAvailable(): boolean {
    return this.config.enabled;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.callHistory.push({ request, timestamp: Date.now() });

    const { content, toolCalls, model, usage } = this.responseConfig;

    const response: CompletionResponse = {
      content: content ?? '',
      model: model ?? 'mock-model',
      provider: this.name,
    };

    if (usage) {
      response.usage = {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      };
    }

    if (toolCalls && toolCalls.length > 0) {
      response.tool_calls = toolCalls.map((tc, i) => ({
        id: `call_mock_${i}`,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      }));
      response.finish_reason = 'tool_calls';
    }

    return response;
  }

  /** Reset call history and optionally update response. */
  reset(responseConfig?: MockResponseConfig): void {
    this.callHistory = [];
    if (responseConfig) {
      this.responseConfig = { ...responseConfig };
    }
  }

  async embed(model: string, text: string): Promise<number[]> {
    const vec: number[] = [];
    // Generate a simple deterministic 1536-dimensional float vector based on the input text
    for (let i = 0; i < 1536; i++) {
      const charCode = text.charCodeAt(i % text.length) || 1;
      vec.push(Math.sin(charCode + i) * 0.1);
    }
    return vec;
  }
}
