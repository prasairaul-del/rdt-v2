import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  ProviderConfigForClient,
  ProviderErrorDetails,
} from './types';

/**
 * Native Anthropic (Claude) provider adapter.
 * Uses the Anthropic Messages API: https://docs.anthropic.com/messages
 */
export interface AnthropicConfig {
  apiKey: string | null;
  baseUrl?: string;
  anthropicVersion?: string;
}

interface AnthropicContent {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicErrorBody {
  type?: string;
  error?: { type?: string; message?: string };
}

function parseError(status: number, bodyText: string): ProviderErrorDetails {
  let parsed: AnthropicErrorBody = {};
  try {
    parsed = JSON.parse(bodyText) as AnthropicErrorBody;
  } catch {
    /* ignore */
  }
  const message = parsed.error?.message ?? bodyText;
  const code = parsed.error?.type ?? `HTTP_${status}`;
  let retryable = false;
  let cooldownMs = 0;
  if (status === 429) {
    retryable = true;
    cooldownMs = 60_000;
  }
  if (status >= 500) {
    retryable = true;
    cooldownMs = 5_000;
  }
  return { message, code, status, retryable, cooldownMs };
}

export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly config: ProviderConfigForClient;
  private anthropicConfig: AnthropicConfig;

  constructor(
    id: string,
    config: AnthropicConfig,
    providerConfig: ProviderConfigForClient,
  ) {
    this.name = id;
    this.anthropicConfig = config;
    this.config = providerConfig;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const baseUrl = this.anthropicConfig.baseUrl ?? 'https://api.anthropic.com';
    const apiKey = this.anthropicConfig.apiKey;
    const anthropicVersion =
      this.anthropicConfig.anthropicVersion ?? '2023-06-01';

    // Anthropic separates system prompt from messages
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const nonSystemMessages = request.messages.filter(
      (m) => m.role !== 'system',
    );
    const systemPrompt = systemMessages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
      .trim();

    const body: Record<string, unknown> = {
      model: request.model,
      messages: nonSystemMessages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content:
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      })),
      max_tokens: request.max_tokens ?? 4096,
    };
    if (systemPrompt) body.system = systemPrompt;
    if (request.temperature !== undefined)
      body.temperature = request.temperature;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': anthropicVersion,
    };
    if (apiKey) headers['x-api-key'] = apiKey;

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const bodyText = await response.text();
    if (!response.ok) {
      const err = parseError(response.status, bodyText);
      throw Object.assign(new Error(err.message), err);
    }

    const data = JSON.parse(bodyText) as {
      content?: AnthropicContent[];
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string;
      model?: string;
    };

    const textContent = (data.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    const promptTokens = data.usage?.input_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? 0;

    return {
      content: textContent,
      model: data.model ?? request.model,
      provider: this.name,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      finish_reason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
    };
  }

  isAvailable(): boolean {
    return !!this.anthropicConfig.apiKey;
  }
}
