import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  ProviderConfigForClient,
  ProviderErrorDetails,
} from './types';

export interface GoogleConfig {
  apiKey: string | null;
  baseUrl?: string;
}

interface GeminiContentPart {
  text?: string;
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiContentPart[];
}

interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

function parseError(status: number, bodyText: string): ProviderErrorDetails {
  let parsed: GeminiErrorBody = {};
  try {
    parsed = JSON.parse(bodyText) as GeminiErrorBody;
  } catch {
    /* ignore */
  }
  const message = parsed.error?.message ?? bodyText;
  const code = parsed.error?.status ?? `HTTP_${status}`;
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

export class GoogleProvider implements Provider {
  readonly name: string;
  readonly config: ProviderConfigForClient;
  private googleConfig: GoogleConfig;

  constructor(
    id: string,
    config: GoogleConfig,
    providerConfig: ProviderConfigForClient,
  ) {
    this.name = id;
    this.googleConfig = config;
    this.config = providerConfig;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const apiKey =
      this.googleConfig.apiKey ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      '';
    if (!apiKey) {
      throw new Error(
        `API Key for Google Provider '${this.name}' is missing. Please set api_key_env or GEMINI_API_KEY.`,
      );
    }

    const defaultBaseUrl = 'https://generativelanguage.googleapis.com';
    const baseUrl =
      this.googleConfig.baseUrl || this.config.baseUrl || defaultBaseUrl;

    // Formulate final URL with key query param (standard Google AI Studio format)
    const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${request.model}:generateContent?key=${apiKey}`;

    // Separate system messages
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const systemPrompt = systemMessages
      .map((m) => m.content)
      .join('\n')
      .trim();

    // Map non-system messages
    const nonSystemMessages = request.messages.filter(
      (m) => m.role !== 'system',
    );
    const contents: GeminiContent[] = nonSystemMessages.map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = {
      contents,
    };

    if (systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: systemPrompt }],
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.max_tokens !== undefined) {
      generationConfig.maxOutputTokens = request.max_tokens;
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const response = await fetch(url, {
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
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
        finishReason?: string;
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      };
    };

    const firstCandidate = data.candidates?.[0];
    const textContent =
      firstCandidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const finishReason = firstCandidate?.finishReason;

    const promptTokens = data.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

    return {
      content: textContent,
      model: request.model,
      provider: this.name,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      finish_reason: finishReason === 'MAX_TOKENS' ? 'length' : 'stop',
    };
  }

  isAvailable(): boolean {
    return (
      this.config.enabled &&
      !!(
        this.googleConfig.apiKey ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY
      )
    );
  }
}
