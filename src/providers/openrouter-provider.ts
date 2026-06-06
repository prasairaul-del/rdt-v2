import { createOpenAIProvider } from './openai-compatible-provider';
import type { Provider, ProviderConfigForClient } from './types';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';

/**
 * Creates an OpenRouter provider instance.
 *
 * OpenRouter uses the OpenAI-compatible API, so this is a thin preset
 * wrapper around `createOpenAIProvider`. Additional OpenRouter-specific
 * headers (e.g. HTTP-Referer, X-Title) can be added later if needed.
 */
export function createOpenRouterProvider(
  config: ProviderConfigForClient,
): Provider {
  const envVar = config.apiKeyEnv ?? OPENROUTER_API_KEY_ENV;
  const apiKey = process.env[envVar] ?? null;

  return createOpenAIProvider(
    config.id,
    {
      ...config,
      baseUrl: config.baseUrl || OPENROUTER_BASE_URL,
      apiKeyEnv: envVar,
    },
    apiKey,
  );
}
