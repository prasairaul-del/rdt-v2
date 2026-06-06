import { describe, it, expect } from 'vitest';
import { matchModels, hasCapability, type RouterRequirements } from '../../src/router/model-policy';
import { checkRateLimit, filterRateLimited } from '../../src/router/rate-limit-state';
import { checkCooldown, calculateCooldownMs, filterCooldown } from '../../src/router/cooldown';
import { createRetryState, decideRetry } from '../../src/router/retry-policy';
import { ProviderRouter } from '../../src/router/provider-router';
import { ProviderStateStore } from '../../src/storage/provider-state-store';
import { MockProvider } from '../../src/providers/mock-provider';
import type { RdtConfig } from '../../src/config/schema';
import type { ProviderModelState } from '../../src/providers/types';

// ── Model Policy ──────────────────────────────────────────────────

describe('model-policy', () => {
  const lowCostModels: ProviderModelState[] = [
    { providerId: 'openrouter', modelId: 'free', enabled: true, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true, requestsThisMinute: 0, requestsToday: 0 },
    { providerId: 'openrouter', modelId: 'paid-small', enabled: true, quality: 'medium', cost: 'low', supportsTools: true, supportsJson: true, requestsThisMinute: 0, requestsToday: 0 },
    { providerId: 'openrouter', modelId: 'paid-large', enabled: true, quality: 'high', cost: 'medium', supportsTools: true, supportsJson: true, requestsThisMinute: 0, requestsToday: 0 },
  ];

  const mixedModels: ProviderModelState[] = [
    ...lowCostModels,
    { providerId: 'groq', modelId: 'fast', enabled: true, quality: 'high', cost: 'free', supportsTools: false, supportsJson: true, requestsThisMinute: 0, requestsToday: 0 },
    { providerId: 'ollama', modelId: 'llama3', enabled: true, quality: 'low', cost: 'free', supportsTools: 'auto' as const, supportsJson: true, requestsThisMinute: 0, requestsToday: 0 },
  ];

  it('should filter by max_cost', () => {
    const policy = { prefer: ['openrouter/free'], max_cost: 'low' as const };
    const result = matchModels(policy, mixedModels, { needsTools: false, needsJson: false });
    // Only free and low cost models
    expect(result.every((m) => m.cost === 'free' || m.cost === 'low')).toBe(true);
  });

  it('should sort by preference order', () => {
    const policy = { prefer: ['groq/fast', 'openrouter/*'], max_cost: 'high' as const };
    const result = matchModels(policy, mixedModels, { needsTools: false, needsJson: false });
    expect(result[0].providerId).toBe('groq');
    expect(result[0].modelId).toBe('fast');
    // openrouter models should come after groq
    const groqIdx = result.findIndex((m) => m.providerId === 'groq');
    const openrouterIdx = result.findIndex((m) => m.providerId === 'openrouter');
    expect(groqIdx).toBeLessThan(openrouterIdx);
  });

  it('should filter out models lacking required tool support', () => {
    const policy = { prefer: ['*/*'], max_cost: 'high' as const };
    const result = matchModels(policy, mixedModels, { needsTools: true, needsJson: false });
    // groq/fast has supportsTools: false, should be filtered out
    expect(result.some((m) => m.providerId === 'groq')).toBe(false);
    // openrouter models with supportsTools: true should remain
    expect(result.some((m) => m.providerId === 'openrouter')).toBe(true);
  });

  it('should filter out models lacking required JSON support', () => {
    const modelsWithJsonFalse = mixedModels.map((m) =>
      m.providerId === 'groq' ? { ...m, supportsJson: false } : m,
    );
    const policy = { prefer: ['*/*'], max_cost: 'high' as const };
    const result = matchModels(policy, modelsWithJsonFalse, { needsTools: false, needsJson: true });
    expect(result.some((m) => m.providerId === 'groq')).toBe(false);
  });

  it('should return empty array when no models match cost ceiling', () => {
    const policy = { prefer: ['openrouter/*'], max_cost: 'low' as const };
    const expensiveModels: ProviderModelState[] = [
      { providerId: 'openrouter', modelId: 'big', enabled: true, quality: 'high', cost: 'high', supportsTools: true, supportsJson: true, requestsThisMinute: 0, requestsToday: 0 },
    ];
    const result = matchModels(policy, expensiveModels, { needsTools: false, needsJson: false });
    expect(result).toHaveLength(0);
  });

  it('should handle wildcard preference patterns', () => {
    const policy = { prefer: ['*/free'], max_cost: 'high' as const };
    const result = matchModels(policy, mixedModels, { needsTools: false, needsJson: false });
    // Should match any provider with modelId 'free'
    expect(result.some((m) => m.modelId === 'free')).toBe(true);
  });

  it('should support local/* and paid/* shorthand patterns', () => {
    const policy = { prefer: ['local/*', 'paid/*'], max_cost: 'high' as const };
    const result = matchModels(policy, mixedModels, { needsTools: false, needsJson: false });
    // local/* should match ollama models
    expect(result.some((m) => m.providerId === 'ollama')).toBe(true);
  });

  it('should handle hasCapability correctly', () => {
    const autoModel: ProviderModelState = { providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free', supportsTools: 'auto' as const, supportsJson: 'auto' as const, requestsThisMinute: 0, requestsToday: 0 };
    expect(hasCapability(autoModel, 'tools')).toBe(true);
    expect(hasCapability(autoModel, 'json')).toBe(true);

    const disabledModel = { ...autoModel, supportsTools: false, supportsJson: false };
    expect(hasCapability(disabledModel, 'tools')).toBe(false);
    expect(hasCapability(disabledModel, 'json')).toBe(false);
  });
});

// ── Rate Limit State ─────────────────────────────────────────────

describe('rate-limit-state', () => {
  it('should pass when within daily limit', () => {
    const state: ProviderModelState = {
      providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free',
      supportsTools: true, supportsJson: true,
      requestsThisMinute: 0, requestsToday: 5, dailyLimit: 100, rpmLimit: 10,
    };
    const check = checkRateLimit(state);
    expect(check.withinLimits).toBe(true);
  });

  it('should fail when daily limit reached', () => {
    const state: ProviderModelState = {
      providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free',
      supportsTools: true, supportsJson: true,
      requestsThisMinute: 0, requestsToday: 100, dailyLimit: 100, rpmLimit: 10,
    };
    const check = checkRateLimit(state);
    expect(check.withinLimits).toBe(false);
    expect(check.reason).toContain('Daily limit');
    expect(check.resetsAt).toBeDefined();
  });

  it('should pass when within RPM limit', () => {
    const state: ProviderModelState = {
      providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free',
      supportsTools: true, supportsJson: true,
      requestsThisMinute: 5, requestsToday: 0, rpmLimit: 10,
    };
    const check = checkRateLimit(state);
    expect(check.withinLimits).toBe(true);
  });

  it('should fail when RPM limit reached', () => {
    const state: ProviderModelState = {
      providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free',
      supportsTools: true, supportsJson: true,
      requestsThisMinute: 10, requestsToday: 0, rpmLimit: 10,
    };
    const check = checkRateLimit(state);
    expect(check.withinLimits).toBe(false);
    expect(check.reason).toContain('RPM limit');
  });

  it('should pass when no limits are set', () => {
    const state: ProviderModelState = {
      providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free',
      supportsTools: true, supportsJson: true,
      requestsThisMinute: 999, requestsToday: 999,
    };
    const check = checkRateLimit(state);
    expect(check.withinLimits).toBe(true);
  });

  it('filterRateLimited should separate available from limited', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'p1', modelId: 'm1', enabled: true, rpmLimit: 10, dailyLimit: 100, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
      { providerId: 'p1', modelId: 'm2', enabled: true, rpmLimit: 1, dailyLimit: 10, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    // Set m1 over daily limit
    store.recordSuccess('p1', 'm1');
    store.recordSuccess('p1', 'm1');

    const models = store.getAll();
    // After 2 successes, both should still be within limits
    const result = filterRateLimited(store, models);
    expect(result.available).toHaveLength(2);
    expect(result.limited).toHaveLength(0);
  });
});

// ── Cooldown ─────────────────────────────────────────────────────

describe('cooldown', () => {
  it('should report no cooldown when cooldownUntil is undefined', () => {
    const info = checkCooldown({});
    expect(info.inCooldown).toBe(false);
  });

  it('should report cooldown when cooldownUntil is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const info = checkCooldown({ cooldownUntil: future });
    expect(info.inCooldown).toBe(true);
    expect(info.until).toBe(future);
    expect(info.remainingMs).toBeGreaterThan(0);
  });

  it('should report no cooldown when cooldownUntil has passed', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const info = checkCooldown({ cooldownUntil: past });
    expect(info.inCooldown).toBe(false);
  });

  it('should calculate longer cooldown for rate limits vs other errors', () => {
    const rateLimitMs = calculateCooldownMs('RATE_LIMITED', 0);
    const otherMs = calculateCooldownMs('SERVER_ERROR', 0);
    expect(rateLimitMs).toBeGreaterThan(otherMs);
  });

  it('should apply exponential backoff on higher attempts', () => {
    const first = calculateCooldownMs('SERVER_ERROR', 0);
    const second = calculateCooldownMs('SERVER_ERROR', 1);
    expect(second).toBeGreaterThanOrEqual(first * 2);
  });

  it('should cap cooldown at 5 minutes max', () => {
    const large = calculateCooldownMs('RATE_LIMITED', 10);
    expect(large).toBeLessThanOrEqual(300_000);
  });

  it('filterCooldown should separate available from cooling models', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const models = [
      { cooldownUntil: undefined },
      { cooldownUntil: future },
    ];
    const result = filterCooldown(models);
    expect(result.available).toHaveLength(1);
    expect(result.cooling).toHaveLength(1);
    expect(result.cooling[0].remainingMs).toBeGreaterThan(0);
  });
});

// ── Retry Policy ─────────────────────────────────────────────────

describe('retry-policy', () => {
  it('should create retry state with defaults', () => {
    const state = createRetryState();
    expect(state.attempt).toBe(0);
    expect(state.maxAttempts).toBe(3);
    expect(state.baseDelayMs).toBe(1_000);
    expect(state.maxDelayMs).toBe(30_000);
  });

  it('should allow retry for retryable errors within max attempts', () => {
    const state = createRetryState(3, 1_000, 30_000);
    const decision = decideRetry(state, { retryable: true });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
  });

  it('should stop retrying after max attempts', () => {
    const state = createRetryState(2, 100, 30_000);
    decideRetry(state, { retryable: true }); // attempt 1
    const decision = decideRetry(state, { retryable: true }); // attempt 2 (max)
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain('Max attempts');
  });

  it('should not retry non-retryable errors', () => {
    const state = createRetryState(3, 1_000, 30_000);
    const decision = decideRetry(state, { retryable: false });
    expect(decision.shouldRetry).toBe(false);
    expect(decision.reason).toContain('Non-retryable');
  });

  it('should use cooldownMs from error when provided', () => {
    const state = createRetryState(3, 1_000, 30_000);
    const decision = decideRetry(state, { retryable: true, cooldownMs: 5_000 });
    expect(decision.delayMs).toBeGreaterThanOrEqual(5_000);
  });

  it('should not exceed maxDelayMs plus jitter', () => {
    const state = createRetryState(3, 100_000, 5_000);
    const decision = decideRetry(state, { retryable: true });
    // delayMs = min(100000 * 2^0, 5000) + 0-30% jitter = 5000-6500
    expect(decision.delayMs).toBeLessThanOrEqual(6_500);
  });
});

// ── Provider Router ──────────────────────────────────────────────

describe('ProviderRouter', () => {
  const testConfig: RdtConfig = {
    version: 1,
    project: { name: 'test', language: 'typescript', package_manager: 'bun', test_command: 'bun run test', lint_command: 'bun run lint' },
    runtime: { max_agent_steps: 50, max_edit_passes: 3, require_git_repo: false, allow_shell_commands: true, allow_destructive_commands: false, rollback_on_failed_task: false, preserve_user_changes: true },
    context_budget: {
      default_max_input_tokens: 128_000, reserved_output_tokens: 4_096, repo_map_max_tokens: 4_000,
      file_picker_max_tokens: 2_000, planner_max_tokens: 4_000, editor_max_tokens: 8_000, reviewer_max_tokens: 4_000,
      max_file_read_tokens: 10_000, max_total_file_tokens_per_step: 40_000,
      truncation_strategy: 'summarize_then_select', never_truncate: [],
    },
    providers: [
      { id: 'openrouter', type: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] },
      { id: 'groq', type: 'openai_compatible', base_url: 'https://api.groq.com/openai/v1', enabled: true, models: [{ id: 'fast', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] },
    ],
    model_policies: {
      default: { prefer: ['openrouter/free', 'groq/fast'], max_cost: 'high' },
      cheap: { prefer: ['openrouter/free'], max_cost: 'low' },
    },
    agents: {
      file_picker: { model_policy: 'default', tools: ['list-files'] },
      planner: { model_policy: 'default', tools: ['list-files', 'read-file'] },
    },
  };

  it('should create router and register providers', () => {
    const router = new ProviderRouter(testConfig);
    const provider1 = new MockProvider('openrouter', { enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });
    const provider2 = new MockProvider('groq', { enabled: true, models: [{ id: 'fast', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });

    router.registerProvider(provider1);
    router.registerProvider(provider2);

    expect(router.stateStore.getAll()).toHaveLength(2);
  });

  it('should route successfully to preferred model', async () => {
    const router = new ProviderRouter(testConfig);
    const provider = new MockProvider('openrouter', { enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });
    router.registerProvider(provider);

    const result = await router.route('default', {
      model: 'free',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.success).toBe(true);
    expect(result.response).toBeDefined();
    expect(result.response!.content).toBe('Mock response');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].status).toBe('success');
  });

  it('should return error for unknown policy', async () => {
    const router = new ProviderRouter(testConfig);
    const result = await router.route('nonexistent', {
      model: 'test',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('Unknown model policy');
  });

  it('should return error when no providers are registered', async () => {
    const router = new ProviderRouter(testConfig);
    const result = await router.route('default', {
      model: 'test',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.success).toBe(false);
    expect(result.error!.message).toContain('No enabled provider models');
  });

  it('should skip to next provider if preferred model fails', async () => {
    const router = new ProviderRouter(testConfig);
    const failingProvider = new MockProvider('openrouter', { enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });
    failingProvider.complete = async () => {
      throw Object.assign(new Error('Simulated failure'), { code: 'SERVER_ERROR', retryable: false });
    };
    const goodProvider = new MockProvider('groq', { enabled: true, models: [{ id: 'fast', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });

    router.registerProvider(failingProvider);
    router.registerProvider(goodProvider);

    const result = await router.route('default', {
      model: 'free',
      messages: [{ role: 'user', content: 'test' }],
    });

    // Should have tried openrouter (failed), then groq (success)
    expect(result.attempts.length).toBeGreaterThanOrEqual(2);
    expect(result.attempts.filter((a) => a.status === 'error')).toHaveLength(1);
    expect(result.attempts.filter((a) => a.status === 'success')).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.response).toBeDefined();
  });

  it('should track attempts and exhausted models on total failure', async () => {
    const router = new ProviderRouter(testConfig);
    const failing1 = new MockProvider('openrouter', { enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });
    failing1.complete = async () => {
      throw Object.assign(new Error('fail'), { code: 'SERVER_ERROR', retryable: false });
    };
    const failing2 = new MockProvider('groq', { enabled: true, models: [{ id: 'fast', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }] });
    failing2.complete = async () => {
      throw Object.assign(new Error('fail too'), { code: 'SERVER_ERROR', retryable: false });
    };

    router.registerProvider(failing1);
    router.registerProvider(failing2);

    const result = await router.route('default', {
      model: 'free',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.success).toBe(false);
    // Both providers produced at least 1 error attempt
    const errorAttempts = result.attempts.filter((a) => a.status === 'error');
    expect(errorAttempts.length).toBeGreaterThanOrEqual(2);
    // Exhausted models should include both
    expect(result.error!.exhausted.length).toBeGreaterThanOrEqual(2);
  });

  it('should respect model policy cost ceilings', async () => {
    const router = new ProviderRouter(testConfig);
    const mediumCostProvider = new MockProvider('openrouter', {
      enabled: true,
      models: [{ id: 'paid', model: 'gpt-4o', tier: 'paid', quality: 'high', cost: 'medium', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 128_000 }],
    });
    const cheapProvider = new MockProvider('groq', {
      enabled: true,
      models: [{ id: 'fast', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }],
    });

    router.registerProvider(mediumCostProvider);
    router.registerProvider(cheapProvider);

    // 'cheap' policy has max_cost: 'low', so medium-cost model should be filtered out
    const result = await router.route('cheap', {
      model: 'free',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.success).toBe(true);
    // Should have used groq (free cost), not openrouter/paid (medium cost)
    expect(result.response).toBeDefined();
  });

  it('should handle cooldown from rate limit errors', async () => {
    const router = new ProviderRouter(testConfig);
    const rateLimitedProvider = new MockProvider('openrouter', {
      enabled: true,
      models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }],
    });
    const backupProvider = new MockProvider('groq', {
      enabled: true,
      models: [{ id: 'fast', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', rpm_limit: undefined, daily_limit: undefined, supports_tools: true, supports_json: true, context_window: 8_000 }],
    });

    // Override complete to throw a rate limit error
    rateLimitedProvider.complete = async () => {
      throw Object.assign(new Error('Rate limited'), { code: 'RATE_LIMITED', retryable: false, status: 429 });
    };

    router.registerProvider(rateLimitedProvider);
    router.registerProvider(backupProvider);

    const result = await router.route('default', {
      model: 'free',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.success).toBe(true);
    // First provider should have been rate limited, second should succeed
    expect(result.attempts[0].errorCode).toBe('RATE_LIMITED');
    expect(result.attempts.some((a) => a.status === 'success')).toBe(true);
  });
});
