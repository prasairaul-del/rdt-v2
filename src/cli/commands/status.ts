import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../../config/load-config';
import { detectProject } from '../../project-context/detect-project';

export function createStatusCommand(): Command {
  return new Command('status')
    .description('Show RDT system status')
    .action(() => {
      const projectRoot = process.cwd();

      // Detect project
      const info = detectProject(projectRoot);

      console.log('RDT v2 — System Status');
      console.log('─'.repeat(40));

      // Project info
      console.log('\nProject:');
      console.log(`  Name:            ${info.name}`);
      console.log(`  Language:        ${info.language}`);
      console.log(`  Package manager: ${info.packageManager || 'unknown'}`);
      console.log(`  Test command:    ${info.testCommand || 'none'}`);
      console.log(`  Lint command:    ${info.lintCommand || 'none'}`);
      console.log(`  Build command:   ${info.buildCommand || 'none'}`);
      console.log(`  Git repo:        ${info.hasGit ? 'yes' : 'no'}`);
      console.log(`  Source dirs:     ${info.sourceDirs.join(', ')}`);

      // RDT config
      const hasRdtDir = existsSync(resolve(projectRoot, '.rdt'));
      const configResult = hasRdtDir ? loadConfig(projectRoot) : null;

      console.log('\nRDT:');
      console.log(`  Initialized:     ${configResult?.loaded ? 'yes' : 'no'}`);
      console.log(`  Config:          ${configResult?.path || 'not found'}`);

      if (configResult?.loaded) {
        const cfg = configResult.config;

        // Providers
        console.log('\nProviders:');
        for (const p of cfg.providers) {
          const apiKey = p.api_key_env ? process.env[p.api_key_env] : null;
          console.log(`  ${p.id}:`);
          console.log(`    Type:          ${p.type}`);
          console.log(`    Enabled:       ${p.enabled ? 'yes' : 'no'}`);
          console.log(
            `    API key:       ${apiKey ? `${apiKey.slice(0, 8)}...` : 'not set'}`,
          );
        }

        // Agent policies
        console.log('\nAgent policies:');
        for (const [name, agent] of Object.entries(cfg.agents)) {
          console.log(`  ${name}: ${agent.model_policy}`);
        }
      }

      console.log('');
    });
}
