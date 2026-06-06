import type { ProviderStateStore } from '../storage/provider-state-store';
import type { ProviderModelState } from '../providers/types';

export interface RateLimitCheck {
  withinLimits: boolean;
  reason?: string;
  resetsAt?: string;
}

/**
 * Check whether a provider model is within its RPM and daily limits.
 */
export function checkRateLimit(
  state: ProviderModelState,
): RateLimitCheck {
  // Check daily limit
  if (state.dailyLimit !== undefined && state.dailyLimit > 0) {
    if (state.requestsToday >= state.dailyLimit) {
      return {
        withinLimits: false,
        reason: `Daily limit (${state.dailyLimit}) reached`,
        resetsAt: nextMidnightISO(),
      };
    }
  }

  // Check RPM limit
  if (state.rpmLimit !== undefined && state.rpmLimit > 0) {
    if (state.requestsThisMinute >= state.rpmLimit) {
      return {
        withinLimits: false,
        reason: `RPM limit (${state.rpmLimit}) reached`,
        resetsAt: nextMinuteISO(),
      };
    }
  }

  return { withinLimits: true };
}

/**
 * Filter out all models that have exceeded their rate limits.
 */
export function filterRateLimited(
  store: ProviderStateStore,
  models: ProviderModelState[],
): { available: ProviderModelState[]; limited: Array<{ model: ProviderModelState; reason: string }> } {
  const available: ProviderModelState[] = [];
  const limited: Array<{ model: ProviderModelState; reason: string }> = [];

  for (const model of models) {
    const check = checkRateLimit(model);
    if (check.withinLimits) {
      available.push(model);
    } else {
      limited.push({ model, reason: check.reason ?? 'Rate limited' });
    }
  }

  return { available, limited };
}

function nextMidnightISO(): string {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  return midnight.toISOString();
}

function nextMinuteISO(): string {
  const now = Date.now();
  const nextMinute = Math.ceil(now / 60_000) * 60_000;
  return new Date(nextMinute).toISOString();
}
