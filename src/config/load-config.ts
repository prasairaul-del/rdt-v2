import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { createDefaultConfig } from './defaults';
import type { RdtConfig } from './schema';

export interface ConfigResult {
  config: RdtConfig;
  path: string;
  loaded: boolean;
}

export function resolveConfigPath(projectRoot: string): string {
  return resolve(projectRoot, '.rdt', 'config.yaml');
}

export function loadConfig(projectRoot: string): ConfigResult {
  const configPath = resolveConfigPath(projectRoot);

  if (!existsSync(configPath)) {
    return {
      config: createDefaultConfig(),
      path: configPath,
      loaded: false,
    };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = load(raw) as RdtConfig;

    // Merge loaded config with defaults to fill missing fields
    const defaults = createDefaultConfig();
    const merged = mergeConfig(defaults, parsed);

    return {
      config: merged,
      path: configPath,
      loaded: true,
    };
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
