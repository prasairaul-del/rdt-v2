import { Command } from 'commander';
import { loadConfig } from '../../config/load-config';
import type { ProviderModelState } from '../../providers/types';
import { checkCooldown } from '../../router/cooldown';
import { ProviderRouter } from '../../router/provider-router';
import { checkRateLimit } from '../../router/rate-limit-state';

export function createProvidersCommand(): Command {
  return new Command('providers')
    .description(
      'Show provider configuration, runtime state, and test connectivity',
    )
    .option('-t, --test', 'Test each provider by listing models via API')
    .option('-v, --verbose', 'Show detailed model-level state')
    .action(async (options: { test?: boolean; verbose?: boolean }) => {
      const projectRoot = process.cwd();

      console.log('RDT v2 — Providers');
      console.log('─'.repeat(50));

      // Load config
      const configResult = loadConfig(projectRoot);
      if (!configResult.loaded) {
        console.log('\n  No .rdt/config.yaml found. Run `rdt init` first.');
        return;
      }

      const cfg = configResult.config;
      const providers = cfg.providers;

      if (providers.length === 0) {
        console.log('\n  No providers configured.');
        return;
      }

      // Create router + state store to get runtime state for enabled providers
      let router: ProviderRouter | undefined;
      try {
        router = new ProviderRouter(cfg);
        router.initFromConfig(cfg);
      } catch {
        // Router init is best-effort for display purposes
      }

      const stateStore = router?.stateStore;
      const allModelStates = stateStore?.getAll() ?? [];

      for (const p of providers) {
        const apiKey = p.api_key_env ? process.env[p.api_key_env] : null;

        console.log(`\n  ${p.id}:`);
        console.log(`    Type:          ${p.type}`);
        console.log(`    Base URL:      ${p.base_url}`);
        console.log(`    Enabled:       ${p.enabled ? 'yes' : 'no'}`);

        if (p.api_key_env) {
          if (apiKey) {
            console.log(
              `    API key (${p.api_key_env}): ${apiKey.slice(0, 8)}...`,
            );
          } else {
            console.log(
              `    API key (${p.api_key_env}): \x1b[31mNOT SET\x1b[0m`,
            );
          }
        } else {
          console.log('    API key:       none required');
        }

        // Show models
        if (p.models.length > 0) {
          console.log('    Models:');
          for (const m of p.models) {
            const state = allModelStates.find(
              (s) => s.modelId === m.id && s.providerId === p.id,
            );
            const statusBadge = getModelStatusBadge(
              p.enabled,
              m.tier !== 'disabled',
              state,
            );
            console.log(`      - ${m.id} (${m.model})${statusBadge}`);
            console.log(
              `        Quality: ${m.quality}, Cost: ${m.cost}, Tier: ${m.tier}`,
            );

            if (options.verbose && state) {
              const cooldown = checkCooldown(state);
              const rateLimit = checkRateLimit(state);

              console.log('        Runtime state:');
              console.log(
                `          Requests/min:  ${state.requestsThisMinute}`,
              );
              console.log(`          Requests/day:  ${state.requestsToday}`);
              console.log(
                `          RPM limit:     ${state.rpmLimit ?? 'unlimited'}`,
              );
              console.log(
                `          Daily limit:   ${state.dailyLimit ?? 'unlimited'}`,
              );

              if (cooldown.inCooldown) {
                const secs = Math.round((cooldown.remainingMs ?? 0) / 1000);
                console.log(
                  `          Cooldown:      \x1b[33m${secs}s remaining\x1b[0m`,
                );
              } else {
                console.log('          Cooldown:      none');
              }

              if (state.lastErrorAt) {
                console.log(
                  `          Last error:    ${state.lastErrorCode ?? 'UNKNOWN'} at ${state.lastErrorAt}`,
                );
              }

              if (rateLimit.withinLimits) {
                console.log('          Rate limit:    OK');
              } else {
                console.log(
                  `          Rate limit:    \x1b[33m${rateLimit.reason}\x1b[0m`,
                );
              }
            }
          }
        } else {
          console.log('    Models:        (none configured)');
        }
      }

      // Test connectivity
      if (options.test) {
        console.log(`\n  ${'─'.repeat(50)}`);
        console.log('  Testing provider connectivity...\n');

        for (const p of providers) {
          if (!p.enabled) {
            console.log(`  ${p.id}: \x1b[33mskipped (disabled)\x1b[0m`);
            continue;
          }

          if (p.type === 'ollama') {
            console.log(`  ${p.id}: \x1b[33mskipped (local provider)\x1b[0m`);
            continue;
          }

          const apiKey = p.api_key_env ? process.env[p.api_key_env] : null;
          if (p.api_key_env && !apiKey) {
            console.log(
              `  ${p.id}: \x1b[31mNO API KEY\x1b[0m — set ${p.api_key_env} env var`,
            );
            continue;
          }

          process.stdout.write(`  ${p.id}: testing... `);

          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };
          if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
          }

          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);

            const response = await fetch(`${p.base_url}/models`, {
              method: 'GET',
              headers,
              signal: controller.signal,
            });
            clearTimeout(timeout);

            if (response.ok) {
              const data = (await response.json()) as {
                data?: Array<{ id: string }>;
              };
              const modelCount = data.data?.length ?? 0;
              console.log(`\x1b[32mOK\x1b[0m (${modelCount} models available)`);
            } else if (response.status === 401) {
              console.log(
                `\x1b[31mUNAUTHORIZED\x1b[0m (HTTP ${response.status})`,
              );
            } else if (response.status === 429) {
              console.log(
                `\x1b[33mRATE LIMITED\x1b[0m (HTTP ${response.status})`,
              );
            } else {
              console.log(`\x1b[31mFAILED\x1b[0m (HTTP ${response.status})`);
            }
          } catch (err) {
            if ((err as Error).name === 'AbortError') {
              console.log('\x1b[31mTIMEOUT\x1b[0m (10s)');
            } else {
              console.log(`\x1b[31mERROR\x1b[0m (${(err as Error).message})`);
            }
          }
        }
      }

      // Summary
      const enabled = providers.filter((p) => p.enabled).length;
      const withKeys = providers.filter(
        (p) => !p.api_key_env || process.env[p.api_key_env],
      ).length;
      console.log(`\n  ${'─'.repeat(50)}`);
      console.log(`  ${providers.length} providers configured`);
      console.log(`  ${enabled} enabled, ${withKeys} with valid API keys`);
      console.log('');

      if (!options.test) {
        console.log('  Tip: use --test to test connectivity');
      }
      console.log('');
    });
}

function getModelStatusBadge(
  providerEnabled: boolean,
  modelEnabled: boolean,
  state: ProviderModelState | undefined,
): string {
  if (!providerEnabled || !modelEnabled) {
    return ' \x1b[90m[disabled]\x1b[0m';
  }

  if (!state) return '';

  const cooldown = checkCooldown(state);
  if (cooldown.inCooldown) {
    return ' \x1b[33m[cooldown]\x1b[0m';
  }

  const rateLimit = checkRateLimit(state);
  if (!rateLimit.withinLimits) {
    return ' \x1b[33m[rate limited]\x1b[0m';
  }

  if (state.lastErrorAt) {
    return ` \x1b[91m[last error: ${state.lastErrorCode}]\x1b[0m`;
  }

  return ' \x1b[32m[ok]\x1b[0m';
}
