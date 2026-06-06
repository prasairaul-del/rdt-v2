import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../src/providers/mock-provider';
import { createOpenAIProvider } from '../../src/providers/openai-compatible-provider';
import { createOllamaProvider } from '../../src/providers/ollama-provider';
import { ProviderStateStore } from '../../src/storage/provider-state-store';

// ── Mock Provider ────────────────────────────────────────────────

describe('MockProvider', () => {
  it('should return default content', async () => {
    const p = new MockProvider('test');
    const res = await p.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.content).toBe('Mock response');
    expect(res.model).toBe('mock-model');
    expect(res.provider).toBe('test');
  });

  it('should return configured response', async () => {
    const p = new MockProvider('test', undefined, {
      content: 'Hello!',
      model: 'custom-model',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const res = await p.complete({
      model: 'x',
      messages: [{ role: 'user', content: 'hey' }],
    });
    expect(res.content).toBe('Hello!');
    expect(res.usage?.total_tokens).toBe(15);
  });

  it('should return tool calls when configured', async () => {
    const p = new MockProvider('test', undefined, {
      content: '',
      toolCalls: [{ name: 'read_file', args: { path: 'foo.ts' } }],
    });
    const res = await p.complete({
      model: 'x',
      messages: [{ role: 'user', content: 'read file' }],
    });
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls?.[0].function.name).toBe('read_file');
    expect(res.finish_reason).toBe('tool_calls');
  });

  it('should record call history', async () => {
    const p = new MockProvider('test');
    await p.complete({ model: 'm1', messages: [{ role: 'user', content: 'a' }] });
    await p.complete({ model: 'm2', messages: [{ role: 'user', content: 'b' }] });
    expect(p.callHistory).toHaveLength(2);
    expect(p.callHistory[0].request.model).toBe('m1');
    expect(p.callHistory[1].request.model).toBe('m2');
  });

  it('should report availability based on enabled flag', () => {
    const p1 = new MockProvider('enabled', { enabled: true });
    expect(p1.isAvailable()).toBe(true);

    const p2 = new MockProvider('disabled', { enabled: false });
    expect(p2.isAvailable()).toBe(false);
  });

  it('should reset call history', async () => {
    const p = new MockProvider('test');
    await p.complete({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(p.callHistory).toHaveLength(1);
    p.reset();
    expect(p.callHistory).toHaveLength(0);
  });
});

// ── OpenAI-Compatible Provider ───────────────────────────────────

describe('OpenAI-compatible provider', () => {
  it('should report unavailable when disabled', () => {
    const p = createOpenAIProvider('test', {
      id: 'test',
      type: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      enabled: false,
      models: [],
    }, 'sk-test');
    expect(p.isAvailable()).toBe(false);
  });

  it('should report unavailable without API key', () => {
    const p = createOpenAIProvider('test', {
      id: 'test',
      type: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      enabled: true,
      models: [],
    }, null);
    expect(p.isAvailable()).toBe(false);
  });

  it('should throw MISSING_API_KEY when no key and complete called', async () => {
    const p = createOpenAIProvider('test', {
      id: 'test',
      type: 'openai_compatible',
      baseUrl: 'http://localhost:9999',
      enabled: true,
      models: [],
    }, null);

    try {
      await p.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as Error & { code: string };
      expect(e.code).toBe('MISSING_API_KEY');
      expect(e.message).toContain('API key');
    }
  });

  it('should handle network errors gracefully', async () => {
    const p = createOpenAIProvider('test', {
      id: 'test',
      type: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:1',
      enabled: true,
      models: [],
    }, 'sk-test');

    try {
      await p.complete({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as Error & { code: string };
      // Connection refused on port 1 — expect NETWORK_ERROR or similar
      expect(['NETWORK_ERROR', 'REQUEST_FAILED']).toContain(e.code);
    }
  });
});

// ── Ollama Provider ──────────────────────────────────────────────

describe('Ollama provider', () => {
  it('should report unavailable when disabled', () => {
    const p = createOllamaProvider({
      id: 'ollama',
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      enabled: false,
      models: [],
    });
    expect(p.isAvailable()).toBe(false);
  });

  it('should report available when enabled', () => {
    const p = createOllamaProvider({
      id: 'ollama',
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      enabled: true,
      models: [],
    });
    expect(p.isAvailable()).toBe(true);
  });

  it('should handle connection refused gracefully', async () => {
    const p = createOllamaProvider({
      id: 'ollama',
      type: 'ollama',
      baseUrl: 'http://127.0.0.1:1',
      enabled: true,
      models: [],
    });

    try {
      await p.complete({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as Error & { code: string };
      expect(['NETWORK_ERROR', 'TIMEOUT']).toContain(e.code);
    }
  });
});

// ── Provider State Store ─────────────────────────────────────────

describe('ProviderStateStore', () => {
  it('should register and retrieve model states', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'openrouter', modelId: 'free', enabled: true, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    const state = store.get('openrouter', 'free');
    expect(state).toBeDefined();
    expect(state?.enabled).toBe(true);
    expect(state?.quality).toBe('low');
  });

  it('should return enabled states excluding cooldown', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
      { providerId: 'p2', modelId: 'm2', enabled: false, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    const enabled = store.getEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0].providerId).toBe('p1');
  });

  it('should exclude models in cooldown from getEnabled', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    // Put in cooldown
    store.recordError('p1', 'm1', 'RATE_LIMITED', 60_000);
    expect(store.getEnabled()).toHaveLength(0);

    // Clear cooldown
    store.clearCooldown('p1', 'm1');
    expect(store.getEnabled()).toHaveLength(1);
  });

  it('should track request counts', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'p1', modelId: 'm1', enabled: true, rpmLimit: 10, dailyLimit: 100, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    store.recordSuccess('p1', 'm1');
    store.recordSuccess('p1', 'm1');

    const state = store.get('p1', 'm1');
    expect(state?.requestsThisMinute).toBe(2);
    expect(state?.requestsToday).toBe(2);
  });

  it('should record error with cooldown', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    store.recordError('p1', 'm1', 'RATE_LIMITED', 30_000);

    const state = store.get('p1', 'm1');
    expect(state?.lastErrorCode).toBe('RATE_LIMITED');
    expect(state?.cooldownUntil).toBeDefined();
  });

  it('should clear cooldown on success', () => {
    const store = new ProviderStateStore();
    store.register([
      { providerId: 'p1', modelId: 'm1', enabled: true, quality: 'low', cost: 'free', supportsTools: true, supportsJson: true },
    ]);

    store.recordError('p1', 'm1', 'RATE_LIMITED', 60_000);
    store.recordSuccess('p1', 'm1');

    const state = store.get('p1', 'm1');
    expect(state?.cooldownUntil).toBeUndefined();
    expect(state?.lastErrorCode).toBeUndefined();
  });
});
