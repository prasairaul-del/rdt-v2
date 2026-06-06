import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  ProviderConfigForClient,
  ProviderErrorDetails,
} from './types';

export interface OpenAIConfig {
  baseUrl: string;
  apiKey: string | null;
}

interface OpenAIChatChoice {
  index: number;
  message: {
    role: string;
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
  finish_reason: 'stop' | 'length' | 'tool_calls' | null;
}

interface OpenAIErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

function buildOpenAIRequest(
  request: CompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
  };

  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools;
  }
  if (request.max_tokens !== undefined) {
    body.max_tokens = request.max_tokens;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }

  return body;
}

function parseError(status: number, bodyText: string): ProviderErrorDetails {
  let parsed: OpenAIErrorBody = {};
  try {
    parsed = JSON.parse(bodyText) as OpenAIErrorBody;
  } catch {
    // ignore parse failure; use fallback message
  }

  const msg = parsed?.error?.message ?? `HTTP ${status}: request failed`;

  switch (status) {
    case 401:
      return {
        code: 'INVALID_API_KEY',
        message: msg,
        status,
        retryable: false,
      };
    case 402:
      return {
        code: 'INSUFFICIENT_QUOTA',
        message: msg,
        status,
        retryable: false,
      };
    case 429:
      return {
        code: 'RATE_LIMITED',
        message: msg,
        status,
        retryable: true,
        cooldownMs: 30_000,
      };
    case 503:
      return {
        code: 'SERVICE_UNAVAILABLE',
        message: msg,
        status,
        retryable: true,
        cooldownMs: 10_000,
      };
    default:
      if (status >= 500) {
        return {
          code: 'SERVER_ERROR',
          message: msg,
          status,
          retryable: true,
          cooldownMs: 5_000,
        };
      }
      return { code: 'REQUEST_FAILED', message: msg, status, retryable: false };
  }
}

export function createOpenAIProvider(
  id: string,
  config: ProviderConfigForClient,
  apiKey: string | null,
): Provider {
  const openAIConfig: OpenAIConfig = {
    baseUrl: config.baseUrl.replace(/\/+$/, ''),
    apiKey,
  };

  const provider: Provider = {
    name: id,
    config,

    isAvailable(): boolean {
      return (
        config.enabled &&
        (config.type !== 'openai_compatible' || !!openAIConfig.apiKey)
      );
    },

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      if (!openAIConfig.apiKey) {
        throw Object.assign(
          new Error(
            `Provider "${id}" has no API key. Set ${config.apiKeyEnv ?? 'the appropriate env var'}.`,
          ),
          {
            code: 'MISSING_API_KEY',
            retryable: false,
            status: undefined,
          } as ProviderErrorDetails,
        );
      }

      const url = `${openAIConfig.baseUrl}/chat/completions`;
      const requestBody = buildOpenAIRequest(request);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAIConfig.apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && err.name === 'TimeoutError';
        throw Object.assign(
          new Error(
            isTimeout
              ? 'Request timed out after 60s'
              : `Network error: ${(err as Error).message}`,
          ),
          {
            code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
            retryable: !isTimeout,
            status: undefined,
          } as ProviderErrorDetails,
        );
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const err = parseError(response.status, bodyText);
        throw Object.assign(new Error(err.message), err);
      }

      const json = (await response.json()) as {
        id?: string;
        model: string;
        choices: OpenAIChatChoice[];
        usage?: {
          prompt_tokens: number;
          completion_tokens: number;
          total_tokens: number;
        };
      };

      const choice = json.choices?.[0];
      if (!choice) {
        throw Object.assign(
          new Error('Empty response from provider: no choices returned'),
          { code: 'EMPTY_RESPONSE', retryable: true } as ProviderErrorDetails,
        );
      }

      const result: CompletionResponse = {
        content: choice.message.content ?? '',
        model: json.model,
        provider: id,
        finish_reason: choice.finish_reason ?? 'stop',
      };

      if (json.usage) {
        result.usage = {
          prompt_tokens: json.usage.prompt_tokens,
          completion_tokens: json.usage.completion_tokens,
          total_tokens: json.usage.total_tokens,
        };
      }

      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        result.tool_calls = choice.message.tool_calls;
      }

      return result;
    },

    async embed(model: string, text: string): Promise<number[]> {
      if (!openAIConfig.apiKey) {
        throw Object.assign(
          new Error(
            `Provider "${id}" has no API key. Set ${config.apiKeyEnv ?? 'the appropriate env var'}.`,
          ),
          { code: 'MISSING_API_KEY', retryable: false },
        );
      }

      const url = `${openAIConfig.baseUrl}/embeddings`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${openAIConfig.apiKey}`,
          },
          body: JSON.stringify({
            model: model,
            input: text,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && err.name === 'TimeoutError';
        throw Object.assign(
          new Error(
            isTimeout
              ? 'Embedding request timed out after 30s'
              : `Embedding network error: ${(err as Error).message}`,
          ),
          {
            code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
            retryable: !isTimeout,
          },
        );
      }

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw Object.assign(
          new Error(
            `Embedding failed with status ${response.status}: ${bodyText}`,
          ),
          {
            code: 'EMBEDDING_FAILED',
            retryable: response.status >= 500,
            status: response.status,
          },
        );
      }

      const json = (await response.json()) as {
        data?: Array<{ embedding: number[] }>;
      };
      const embedding = json.data?.[0]?.embedding;
      if (!embedding) {
        throw Object.assign(
          new Error('No embedding returned from OpenAI-compatible provider'),
          { code: 'EMPTY_EMBEDDING', retryable: true },
        );
      }

      return embedding;
    },
  };

  return provider;
}
