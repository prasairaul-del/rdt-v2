import type { RdtConfig } from '../config/schema';
import { AnthropicProvider } from '../providers/anthropic-provider';
import { GoogleProvider } from '../providers/google-provider';
import { createOllamaProvider } from '../providers/ollama-provider';
import { createOpenAIProvider } from '../providers/openai-compatible-provider';
import { createOpenRouterProvider } from '../providers/openrouter-provider';
import type {
  CompletionRequest,
  CompletionResponse,
  CompletionUsage,
  Provider,
  ProviderConfigForClient,
  ProviderErrorDetails,
} from '../providers/types';
import { ProviderStateStore } from '../storage/provider-state-store';
import { calculateCooldownMs, filterCooldown } from './cooldown';
import {
  type RouterRequirements,
  hasCapability,
  matchModels,
} from './model-policy';
import { filterRateLimited } from './rate-limit-state';
import { createRetryState, decideRetry, waitForRetry } from './retry-policy';

// ── Types ────────────────────────────────────────────────────────

export interface RouterAttempt {
  providerId: string;
  modelId: string;
  status: 'success' | 'error' | 'skipped';
  error?: string;
  errorCode?: string;
  durationMs: number;
  usage?: CompletionUsage;
}

export interface ExhaustedModel {
  providerId: string;
  modelId: string;
  reason: string;
}

export interface RouterError {
  message: string;
  attempts: RouterAttempt[];
  exhausted: ExhaustedModel[];
  providerSnapshot: string;
}

export interface RouterResult {
  success: boolean;
  response?: CompletionResponse;
  error?: RouterError;
  attempts: RouterAttempt[];
}

// ── Router ───────────────────────────────────────────────────────

export class ProviderRouter {
  private providers = new Map<string, Provider>();
  private config: RdtConfig;
  public stateStore: ProviderStateStore;

  constructor(config: RdtConfig, stateStore?: ProviderStateStore) {
    this.config = config;
    this.stateStore = stateStore ?? new ProviderStateStore();
  }

  /**
   * Initialize all enabled providers from the RDT config and register them.
   * Maps config format (snake_case) to internal format (camelCase).
   */
  initFromConfig(config: RdtConfig): void {
    for (const providerCfg of config.providers) {
      if (!providerCfg.enabled) continue;

      const internalConfig: ProviderConfigForClient = {
        id: providerCfg.id,
        type: providerCfg.type,
        baseUrl: providerCfg.base_url,
        apiKeyEnv: providerCfg.api_key_env,
        enabled: providerCfg.enabled,
        models: providerCfg.models,
      };

      let provider: Provider;

      if (providerCfg.id.startsWith('openrouter')) {
        provider = createOpenRouterProvider(internalConfig);
      } else if (providerCfg.type === 'anthropic') {
        // Fix #10 — native Anthropic adapter
        const apiKey = internalConfig.apiKeyEnv
          ? (process.env[internalConfig.apiKeyEnv] ?? null)
          : null;
        provider = new AnthropicProvider(
          providerCfg.id,
          { apiKey },
          internalConfig,
        ) as unknown as Provider;
      } else if (
        providerCfg.type === 'google' ||
        providerCfg.type === 'google_vertex'
      ) {
        const apiKey = internalConfig.apiKeyEnv
          ? (process.env[internalConfig.apiKeyEnv] ?? null)
          : null;
        provider = new GoogleProvider(
          providerCfg.id,
          { apiKey },
          internalConfig,
        ) as unknown as Provider;
      } else if (providerCfg.type === 'openai_compatible') {
        const apiKey = internalConfig.apiKeyEnv
          ? (process.env[internalConfig.apiKeyEnv] ?? null)
          : null;
        provider = createOpenAIProvider(providerCfg.id, internalConfig, apiKey);
      } else if (providerCfg.type === 'ollama') {
        provider = createOllamaProvider(internalConfig);
      } else {
        continue;
      }

      this.registerProvider(provider);
    }
  }

  /**
   * Register a provider instance for routing.
   */
  registerProvider(provider: Provider): void {
    this.providers.set(provider.name, provider);

    // Register each of its models in the state store
    this.stateStore.register(
      provider.config.models.map((m) => ({
        providerId: provider.name,
        modelId: m.id,
        modelName: m.model,
        enabled: provider.config.enabled && m.tier !== 'disabled',
        rpmLimit: m.rpm_limit,
        dailyLimit: m.daily_limit,
        quality: m.quality,
        cost: m.cost,
        supportsTools: m.supports_tools,
        supportsJson: m.supports_json,
        contextWindow:
          m.context_window === 'auto' ? undefined : m.context_window,
      })),
    );
  }

  /**
   * Route a completion request using the named model policy.
   *
   * Algorithm (per spec §9.3):
   * 1. Get all enabled provider models
   * 2. Remove models in cooldown
   * 3. Remove models over daily/RPM limit
   * 4. Remove models missing required capability
   * 5. Sort by policy preference
   * 6. Attempt request, with retry on transient errors
   * 7. On 429: set cooldown, try next
   * 8. On transient error: retry with backoff, then fallback
   * 9. If all fail: return honest error
   */
  async route(
    policyName: string,
    request: CompletionRequest,
    requirements: RouterRequirements = { needsTools: false, needsJson: false },
  ): Promise<RouterResult> {
    const attempts: RouterAttempt[] = [];
    const exhausted: ExhaustedModel[] = [];

    // 1. Resolve policy
    const policy = this.config.model_policies[policyName];
    if (!policy) {
      return {
        success: false,
        error: {
          message: `Unknown model policy: "${policyName}"`,
          attempts: [],
          exhausted: [],
          providerSnapshot: this.stateStore.snapshot().capturedAt,
        },
        attempts: [],
      };
    }

    // 2-3. Get enabled models, filter cooldown + rate limits
    const allEnabled = this.stateStore.getAll().filter((s) => s.enabled);
    const { available: notCooling, cooling } = filterCooldown(allEnabled);
    for (const { model, remainingMs } of cooling) {
      exhausted.push({
        providerId: model.providerId,
        modelId: model.modelId,
        reason: `Cooldown active (${Math.round(remainingMs / 1000)}s remaining)`,
      });
    }

    const { available: notRateLimited, limited } = filterRateLimited(
      this.stateStore,
      notCooling,
    );
    for (const { model, reason } of limited) {
      exhausted.push({
        providerId: model.providerId,
        modelId: model.modelId,
        reason,
      });
    }

    // 4-5. Match policy + sort by preference
    const candidates = matchModels(policy, notRateLimited, requirements);

    if (candidates.length === 0) {
      // Include exhausted models in error message even if no candidates
      const snap = this.stateStore.snapshot();
      const msg =
        candidates.length === 0 && allEnabled.length > 0
          ? 'No provider models match the policy requirements (all filtered by cooldown, rate limits, or capabilities)'
          : 'No enabled provider models available';
      return {
        success: false,
        error: {
          message: msg,
          attempts,
          exhausted,
          providerSnapshot: snap.capturedAt,
        },
        attempts,
      };
    }

    // 6. Try each candidate
    for (const candidate of candidates) {
      const provider = this.providers.get(candidate.providerId);
      if (!provider) {
        attempts.push({
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          status: 'skipped',
          error: `Provider "${candidate.providerId}" not registered`,
          durationMs: 0,
        });
        continue;
      }

      // Fix #12 — per-call token budget: skip model if prompt exceeds its context window
      const modelState = this.stateStore.get(
        candidate.providerId,
        candidate.modelId,
      );
      if (modelState?.contextWindow && modelState.contextWindow !== 'auto') {
        // Rough estimate: 4 chars ≈ 1 token for the request body
        const estimatedPromptTokens = Math.ceil(
          JSON.stringify(request.messages).length / 4,
        );
        const outputReserve = request.max_tokens ?? 2048;
        if (estimatedPromptTokens + outputReserve > modelState.contextWindow) {
          attempts.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            status: 'skipped',
            error: `Prompt (~${estimatedPromptTokens} tokens) + output reserve (${outputReserve}) exceeds model context window (${modelState.contextWindow})`,
            durationMs: 0,
          });
          continue;
        }
      }

      // Try with retries
      const retryState = createRetryState(3, 1_000, 30_000);
      const apiModelName = candidate.modelName ?? candidate.modelId;
      const modelRequest = { ...request, model: apiModelName };

      for (let attempt = 0; attempt < retryState.maxAttempts; attempt++) {
        const start = performance.now();
        let durationMs = 0;

        try {
          const response = await provider.complete(modelRequest);
          durationMs = performance.now() - start;

          // Success — record and return
          this.stateStore.recordSuccess(
            candidate.providerId,
            candidate.modelId,
          );
          attempts.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            status: 'success',
            durationMs: Math.round(durationMs),
            usage: response.usage,
          });

          return {
            success: true,
            response,
            attempts,
          };
        } catch (err) {
          durationMs = performance.now() - start;
          const providerErr = err as Error & ProviderErrorDetails;

          // Determine error code
          const errorCode =
            ((err as Record<string, unknown>).code as string | undefined) ??
            ((err as Record<string, unknown>).errorCode as
              | string
              | undefined) ??
            'UNKNOWN';

          this.stateStore.recordError(
            candidate.providerId,
            candidate.modelId,
            errorCode,
          );

          // Handle 429 rate limit — set cooldown and try next candidate
          if (errorCode === 'RATE_LIMITED') {
            const cooldownMs =
              ((err as Record<string, unknown>).cooldownMs as number) ??
              calculateCooldownMs('RATE_LIMITED', 0);
            this.stateStore.recordError(
              candidate.providerId,
              candidate.modelId,
              'RATE_LIMITED',
              cooldownMs,
            );

            attempts.push({
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              status: 'error',
              error: providerErr.message,
              errorCode,
              durationMs: Math.round(durationMs),
            });

            exhausted.push({
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              reason: `Rate limited — cooldown ${Math.round(cooldownMs / 1000)}s`,
            });

            break; // Skip remaining retries, try next candidate
          }

          // Handle capability errors — mark capability as false if auto
          if (
            errorCode === 'MODEL_CAPABILITY_ERROR' ||
            errorCode === 'INVALID_TOOLS'
          ) {
            const state = this.stateStore.get(
              candidate.providerId,
              candidate.modelId,
            );
            if (state) {
              if (requirements.needsTools && state.supportsTools === 'auto') {
                const record = state as { supportsTools: boolean | 'auto' };
                record.supportsTools = false;
              }
              if (requirements.needsJson && state.supportsJson === 'auto') {
                const record = state as { supportsJson: boolean | 'auto' };
                record.supportsJson = false;
              }
            }

            attempts.push({
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              status: 'error',
              error: providerErr.message,
              errorCode,
              durationMs: Math.round(durationMs),
            });
            break; // Skip retries, try next candidate
          }

          // Handle transient errors — retry with backoff
          if (providerErr.retryable ?? false) {
            const retryDecision = decideRetry(retryState, {
              retryable: true,
              cooldownMs: (err as Record<string, unknown>).cooldownMs as
                | number
                | undefined,
            });

            if (retryDecision.shouldRetry) {
              await waitForRetry(retryDecision.delayMs);
              continue; // Retry
            }
          }

          // Non-retryable or max retries exceeded — mark model exhausted
          exhausted.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            reason: providerErr.message,
          });

          attempts.push({
            providerId: candidate.providerId,
            modelId: candidate.modelId,
            status: 'error',
            error: providerErr.message,
            errorCode,
            durationMs: Math.round(durationMs),
          });
          break; // Move to next candidate
        }
      }
    }

    // All candidates exhausted — return error
    const snap = this.stateStore.snapshot();
    return {
      success: false,
      error: {
        message: `All provider models failed (${attempts.length} attempts, ${exhausted.length} models exhausted)`,
        attempts,
        exhausted,
        providerSnapshot: snap.capturedAt,
      },
      attempts,
    };
  }

  /**
   * Generates a dense embedding for the given text.
   * Finds the first available provider that supports embedding.
   */
  async embed(text: string): Promise<number[]> {
    // 1. Scan registered providers for explicitly configured embedding models
    for (const [providerId, provider] of this.providers.entries()) {
      if (provider.embed && provider.isAvailable()) {
        const embedModel = provider.config.models.find(
          (m) =>
            m.id.toLowerCase().includes('embed') ||
            m.model.toLowerCase().includes('embed'),
        );
        if (embedModel) {
          try {
            return await provider.embed(embedModel.model, text);
          } catch (err) {
            console.warn(
              `[Router] Embedding failed with ${providerId}/${embedModel.model}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }

    // 2. Fall back to trying first provider that implements embed using standard defaults
    for (const [providerId, provider] of this.providers.entries()) {
      if (provider.embed && provider.isAvailable()) {
        const defaultModel =
          provider.config.type === 'ollama'
            ? 'nomic-embed-text'
            : 'text-embedding-3-small';
        try {
          return await provider.embed(defaultModel, text);
        } catch (err) {
          console.warn(
            `[Router] Embedding failed with ${providerId}/${defaultModel}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    throw new Error('No embedding provider available or all failed');
  }
}
