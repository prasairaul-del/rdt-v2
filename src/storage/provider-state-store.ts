import type { ProviderModelState } from '../providers/types';

export interface ProviderStateSnapshot {
  models: ProviderModelState[];
  capturedAt: string;
}

export class ProviderStateStore {
  private states = new Map<string, ProviderModelState>();
  /** Minute-boundary counters — keyed by `${providerId}:${modelId}` */
  private minuteCounters = new Map<string, { windowStart: number; count: number }>();
  /** Daily counters — keyed by `${providerId}:${modelId}` */
  private dailyCounters = new Map<string, { date: string; count: number }>();

  // ── Registration ───────────────────────────────────────────────

  register(configs: Array<{ providerId: string; modelId: string; modelName?: string; enabled: boolean; rpmLimit?: number; dailyLimit?: number; quality: 'low' | 'medium' | 'high'; cost: 'free' | 'low' | 'medium' | 'high'; supportsTools: boolean | 'auto'; supportsJson: boolean | 'auto'; contextWindow?: number | 'auto' }>): void {
    for (const c of configs) {
      const key = this.key(c.providerId, c.modelId);
      if (!this.states.has(key)) {
        this.states.set(key, {
          providerId: c.providerId,
          modelId: c.modelId,
          modelName: c.modelName,
          enabled: c.enabled,
          rpmLimit: c.rpmLimit,
          dailyLimit: c.dailyLimit,
          requestsThisMinute: 0,
          requestsToday: 0,
          supportsTools: c.supportsTools,
          supportsJson: c.supportsJson,
          contextWindow: c.contextWindow,
          quality: c.quality,
          cost: c.cost,
        });
      }
    }
  }

  // ── Queries ────────────────────────────────────────────────────

  get(providerId: string, modelId: string): ProviderModelState | undefined {
    return this.states.get(this.key(providerId, modelId));
  }

  getAll(): ProviderModelState[] {
    return Array.from(this.states.values());
  }

  getEnabled(): ProviderModelState[] {
    return this.getAll().filter((s) => s.enabled && !this.isInCooldown(s));
  }

  snapshot(): ProviderStateSnapshot {
    return {
      models: this.getAll().map((s) => ({ ...s })),
      capturedAt: new Date().toISOString(),
    };
  }

  // ── Updates ────────────────────────────────────────────────────

  recordSuccess(providerId: string, modelId: string): void {
    const s = this.states.get(this.key(providerId, modelId));
    if (!s) return;

    const now = Date.now();
    this.bumpMinuteCounter(providerId, modelId, now);
    this.bumpDailyCounter(providerId, modelId, now);

    s.requestsThisMinute = this.getMinuteCount(providerId, modelId, now);
    s.requestsToday = this.getDailyCount(providerId, modelId, now);
    s.lastRequestAt = new Date(now).toISOString();
    // Clear any prior cooldown on success
    s.cooldownUntil = undefined;
    s.lastErrorAt = undefined;
    s.lastErrorCode = undefined;
  }

  recordError(providerId: string, modelId: string, errorCode: string, cooldownMs?: number): void {
    const s = this.states.get(this.key(providerId, modelId));
    if (!s) return;

    s.lastErrorAt = new Date().toISOString();
    s.lastErrorCode = errorCode;

    if (cooldownMs && cooldownMs > 0) {
      s.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
    }
  }

  clearCooldown(providerId: string, modelId: string): void {
    const s = this.states.get(this.key(providerId, modelId));
    if (s) {
      s.cooldownUntil = undefined;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  private key(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`;
  }

  private isInCooldown(s: ProviderModelState): boolean {
    if (!s.cooldownUntil) return false;
    return new Date(s.cooldownUntil).getTime() > Date.now();
  }

  private minuteCounterKey(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`;
  }

  private getMinuteCount(providerId: string, modelId: string, now: number): number {
    const entry = this.minuteCounters.get(this.minuteCounterKey(providerId, modelId));
    if (!entry || now - entry.windowStart > 60_000) return 0;
    return entry.count;
  }

  private bumpMinuteCounter(providerId: string, modelId: string, now: number): void {
    const key = this.minuteCounterKey(providerId, modelId);
    const entry = this.minuteCounters.get(key);
    if (!entry || now - entry.windowStart > 60_000) {
      this.minuteCounters.set(key, { windowStart: now, count: 1 });
    } else {
      entry.count++;
    }
  }

  private getDailyCount(providerId: string, modelId: string, now: number): number {
    const today = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
    const entry = this.dailyCounters.get(this.minuteCounterKey(providerId, modelId));
    if (!entry || entry.date !== today) return 0;
    return entry.count;
  }

  private bumpDailyCounter(providerId: string, modelId: string, now: number): void {
    const key = this.minuteCounterKey(providerId, modelId);
    const today = new Date(now).toISOString().slice(0, 10);
    const entry = this.dailyCounters.get(key);
    if (!entry || entry.date !== today) {
      this.dailyCounters.set(key, { date: today, count: 1 });
    } else {
      entry.count++;
    }
  }
}
