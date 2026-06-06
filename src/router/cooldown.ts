export interface CooldownInfo {
  inCooldown: boolean;
  until?: string;
  remainingMs?: number;
}

/**
 * Check whether a provider model is currently in cooldown.
 */
export function checkCooldown(state: {
  cooldownUntil?: string;
}): CooldownInfo {
  if (!state.cooldownUntil) {
    return { inCooldown: false };
  }

  const untilMs = new Date(state.cooldownUntil).getTime();
  const now = Date.now();

  if (untilMs <= now) {
    return { inCooldown: false };
  }

  return {
    inCooldown: true,
    until: state.cooldownUntil,
    remainingMs: untilMs - now,
  };
}

/**
 * Calculate cooldown duration based on error code and attempt count.
 * Uses exponential backoff: base * 2^attempt, capped at maxMs.
 */
export function calculateCooldownMs(
  errorCode: string,
  attempt: number,
): number {
  const base = errorCode === 'RATE_LIMITED' ? 30_000 : 10_000; // 30s for 429, 10s for others
  const maxMs = 300_000; // 5 min cap

  const duration = Math.min(base * Math.pow(2, attempt), maxMs);
  return duration;
}

/**
 * Filter out all models currently in cooldown, returning
 * the available and cooldown-separated lists.
 */
export function filterCooldown<T extends { cooldownUntil?: string }>(
  models: T[],
): { available: T[]; cooling: Array<{ model: T; remainingMs: number }> } {
  const available: T[] = [];
  const cooling: Array<{ model: T; remainingMs: number }> = [];

  for (const model of models) {
    const info = checkCooldown(model);
    if (info.inCooldown) {
      cooling.push({ model, remainingMs: info.remainingMs! });
    } else {
      available.push(model);
    }
  }

  return { available, cooling };
}
