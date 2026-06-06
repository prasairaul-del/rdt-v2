import type { ModelPolicyConfig } from '../config/schema';
import type { ProviderModelState } from '../providers/types';

export interface RouterRequirements {
  needsTools: boolean;
  needsJson: boolean;
}

const COST_ORDER: Record<string, number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/**
 * Filter candidates by policy cost ceiling, then sort by policy preference order.
 * Also filters by required capabilities (tools, JSON mode).
 */
export function matchModels(
  policy: ModelPolicyConfig,
  candidates: ProviderModelState[],
  requirements: RouterRequirements,
): ProviderModelState[] {
  // 1. Filter by cost ceiling
  const withinBudget = candidates.filter((m) => {
    const costLevel = COST_ORDER[m.cost] ?? 99;
    const maxCost = COST_ORDER[policy.max_cost] ?? 99;
    return costLevel <= maxCost;
  });

  // 2. Filter by capabilities
  const capable = withinBudget.filter((m) => {
    if (requirements.needsTools) {
      if (m.supportsTools === false) return false;
      // 'auto' = assume capable (will be marked false on error)
    }
    if (requirements.needsJson) {
      if (m.supportsJson === false) return false;
    }
    return true;
  });

  // 3. Sort by preference order
  return sortByPreference(policy.prefer, capable);
}

/**
 * Sort candidates by the policy's preference list.
 * Models matching earlier preference entries come first.
 * Models not matching any preference entry come last.
 */
function sortByPreference(
  prefer: string[],
  candidates: ProviderModelState[],
): ProviderModelState[] {
  const scored = candidates.map((m) => {
    const idx = prefer.findIndex((p) => matchPreference(p, m));
    return { model: m, score: idx === -1 ? 999 : idx };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.model);
}

/**
 * Match a preference pattern like "openrouter/free" or "local/small" or "paid/strong"
 * against a provider model state.
 *
 * Patterns:
 *   "openrouter/free"   - exact match on providerId/modelId
 *   "local/small"       - matches any local provider (type ollama) with quality low
 *   "paid/strong"       - matches any paid (cost >= medium) with quality high
 *   "openrouter/*"      - matches any model from openrouter provider
 *   "star/free"         - matches any provider's model with id "free"
 */
function matchPreference(pattern: string, state: ProviderModelState): boolean {
  const [left, right] = pattern.split('/', 2);

  const wildcardLeft = left === '*';
  const wildcardRight = right === '*';

  if (!right || (wildcardLeft && wildcardRight)) {
    // Single token or wildcard - match against providerId only
    return left === state.providerId;
  }

  if (left === 'local') {
    // "local/*" - matches any ollama provider
    // "local/small" - matches ollama with quality low
    return (
      state.providerId === 'ollama' &&
      (wildcardRight || right === state.quality)
    );
  }

  if (left === 'paid') {
    // "paid/*" or "paid/strong" etc.
    const costLevel = COST_ORDER[state.cost] ?? 0;
    return costLevel >= 2 && (wildcardRight || right === state.quality);
  }

  if (left === 'free') {
    // "free/*" or "free/..."
    return state.cost === 'free' && (wildcardRight || right === state.quality);
  }

  // Exact or wildcard match
  const leftMatch = left === state.providerId || left === '*';
  const rightMatch = right === state.modelId || right === '*';

  return leftMatch && rightMatch;
}

/**
 * Check whether a provider model can theoretically handle a capability.
 * Returns false ONLY when the capability is explicitly disabled.
 */
export function hasCapability(
  state: ProviderModelState,
  capability: 'tools' | 'json',
): boolean {
  const val = capability === 'tools' ? state.supportsTools : state.supportsJson;
  return val !== false;
}
