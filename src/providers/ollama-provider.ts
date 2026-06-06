import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  ProviderConfigForClient,
  ProviderErrorDetails,
} from './types';

interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  message?: {
    role: string;
    content: string;
  };
  done: boolean;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaErrorBody {
  error?: string;
}

function buildOllamaRequest(
  request: CompletionRequest,
): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    stream: false,
    options: {
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.max_tokens !== undefined
        ? { num_predict: request.max_tokens }
        : {}),
    },
  };
}

export function createOllamaProvider(
  config: ProviderConfigForClient,
): Provider {
  const baseUrl = (config.baseUrl || 'http://localhost:11434').replace(
    /\/+$/,
    '',
  );

  const provider: Provider = {
    name: config.id || 'ollama',
    config,

    isAvailable(): boolean {
      return config.enabled;
    },

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const url = `${baseUrl}/api/chat`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildOllamaRequest(request)),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && err.name === 'TimeoutError';
        throw Object.assign(
          new Error(
            isTimeout
              ? 'Ollama request timed out after 120s'
              : `Ollama network error: ${(err as Error).message}`,
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
        let parsed: OllamaErrorBody = {};
        try {
          parsed = JSON.parse(bodyText) as OllamaErrorBody;
        } catch {
          // ignore
        }

        const msg =
          parsed?.error ?? `HTTP ${response.status}: Ollama request failed`;

        if (response.status === 404) {
          throw Object.assign(
            new Error(
              `Model "${request.model}" not found. Pull it first: ollama pull ${request.model}`,
            ),
            {
              code: 'MODEL_NOT_FOUND',
              retryable: false,
              status: 404,
            } as ProviderErrorDetails,
          );
        }

        throw Object.assign(new Error(msg), {
          code: response.status >= 500 ? 'SERVER_ERROR' : 'REQUEST_FAILED',
          retryable: response.status >= 500,
          status: response.status,
        } as ProviderErrorDetails);
      }

      const json = (await response.json()) as OllamaGenerateResponse;

      if (!json.message?.content && json.done) {
        return {
          content: '',
          model: json.model,
          provider: provider.name,
          finish_reason: 'stop',
        };
      }

      const result: CompletionResponse = {
        content: json.message?.content ?? '',
        model: json.model,
        provider: provider.name,
        finish_reason: 'stop',
      };

      if (
        json.prompt_eval_count !== undefined ||
        json.eval_count !== undefined
      ) {
        result.usage = {
          prompt_tokens: json.prompt_eval_count ?? 0,
          completion_tokens: json.eval_count ?? 0,
          total_tokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0),
        };
      }

      return result;
    },

    async embed(model: string, text: string): Promise<number[]> {
      const url = `${baseUrl}/api/embeddings`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: text,
          }),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        const isTimeout =
          err instanceof DOMException && err.name === 'TimeoutError';
        throw Object.assign(
          new Error(
            isTimeout
              ? 'Ollama embedding timed out after 30s'
              : `Ollama embedding network error: ${(err as Error).message}`,
          ),
          {
            code: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
            retryable: !isTimeout,
          },
        );
      }

      if (!response.ok) {
        // Try the alternative /api/embed endpoint
        const altUrl = `${baseUrl}/api/embed`;
        try {
          const altResponse = await fetch(altUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              input: text,
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (altResponse.ok) {
            const json = (await altResponse.json()) as {
              embeddings?: number[][];
            };
            if (json.embeddings?.[0]) {
              return json.embeddings[0];
            }
          }
        } catch {
          // ignore alt error, let it fall through to original error
        }

        const bodyText = await response.text().catch(() => '');
        throw Object.assign(
          new Error(
            `Ollama embedding failed with status ${response.status}: ${bodyText}`,
          ),
          {
            code: 'EMBEDDING_FAILED',
            retryable: response.status >= 500,
            status: response.status,
          },
        );
      }

      const json = (await response.json()) as { embedding?: number[] };
      const embedding = json.embedding;
      if (!embedding) {
        throw Object.assign(
          new Error('No embedding returned from Ollama provider'),
          { code: 'EMPTY_EMBEDDING', retryable: true },
        );
      }

      return embedding;
    },
  };

  return provider;
}
