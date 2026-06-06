export interface RetryState {
  attempt: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason?: string;
}

export function createRetryState(
  maxAttempts = 3,
  baseDelayMs = 1_000,
  maxDelayMs = 30_000,
): RetryState {
  return { attempt: 0, maxAttempts, baseDelayMs, maxDelayMs };
}

/**
 * Determine whether to retry after a transient error.
 * Returns the delay before the next attempt.
 */
export function decideRetry(
  state: RetryState,
  error: { retryable: boolean; cooldownMs?: number },
): RetryDecision {
  state.attempt++;

  if (state.attempt >= state.maxAttempts) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: `Max attempts (${state.maxAttempts}) reached`,
    };
  }

  if (!error.retryable) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: 'Non-retryable error',
    };
  }

  // Use cooldown from error if provided (e.g. 429 with Retry-After)
  // Otherwise use exponential backoff with jitter
  const baseDelay = error.cooldownMs ?? state.baseDelayMs;
  const exponential = Math.min(baseDelay * Math.pow(2, state.attempt - 1), state.maxDelayMs);
  const jitter = Math.random() * 0.3 * exponential; // 0-30% jitter
  const delayMs = Math.round(exponential + jitter);

  return { shouldRetry: true, delayMs };
}

/**
 * Wait for the specified delay using a promise.
 */
export function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
