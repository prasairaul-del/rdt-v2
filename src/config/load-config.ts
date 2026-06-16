import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { createDefaultConfig } from './defaults';
import type { RdtConfig } from './schema';

export interface ConfigResult {
  config: RdtConfig;
  path: string;
  loaded: boolean;
}

interface CacheEntry {
  result: ConfigResult;
  mtimeMs: number;
}

const configCache = new Map<string, CacheEntry>();
const DEFAULT_CONFIG = createDefaultConfig();

export function resolveConfigPath(projectRoot: string): string {
  return resolve(projectRoot, '.rdt', 'config.yaml');
}

export function loadConfig(projectRoot: string): ConfigResult {
  const configPath = resolveConfigPath(projectRoot);

  if (!existsSync(configPath)) {
    return {
      config: DEFAULT_CONFIG,
      path: configPath,
      loaded: false,
    };
  }

  // Check cache with mtime invalidation
  const stat = statSync(configPath);
  const cached = configCache.get(configPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.result;
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = load(raw) as RdtConfig;

    // Merge loaded config with defaults to fill missing fields
    const merged = mergeConfig(DEFAULT_CONFIG, parsed);

    const result: ConfigResult = {
      config: merged,
      path: configPath,
      loaded: true,
    };

    configCache.set(configPath, { result, mtimeMs: stat.mtimeMs });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load config at ${configPath}: ${message}`);
  }
}

export function writeConfig(projectRoot: string, config: RdtConfig): void {
  const configPath = resolveConfigPath(projectRoot);
  const yaml = dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  writeFileSync(configPath, yaml, 'utf-8');
  // Invalidate cache after write
  configCache.delete(configPath);
}

function mergeConfig(
  defaults: RdtConfig,
  loaded: Partial<RdtConfig>,
): RdtConfig {
  return {
    ...defaults,
    ...loaded,
    project: { ...defaults.project, ...(loaded.project || {}) },
    runtime: { ...defaults.runtime, ...(loaded.runtime || {}) },
    context_budget: {
      ...defaults.context_budget,
      ...(loaded.context_budget || {}),
    },
    providers: loaded.providers || defaults.providers,
    model_policies: {
      ...defaults.model_policies,
      ...(loaded.model_policies || {}),
    },
    agents: { ...defaults.agents, ...(loaded.agents || {}) },
  };
}
