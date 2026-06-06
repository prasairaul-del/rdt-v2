import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from '../../config/load-config';
import { ProviderRouter } from '../../router/provider-router';
import { ProviderStateStore } from '../../storage/provider-state-store';

export function createExplainCommand(): Command {
  return new Command('explain')
    .description('Explain the purpose, structure, and details of a file')
    .argument('<file>', 'The file path to explain')
    .action(async (filePath: string) => {
      const projectRoot = process.cwd();
      const absolutePath = resolve(projectRoot, filePath);

      if (!existsSync(absolutePath)) {
        console.error(`Error: File '${filePath}' does not exist.`);
        process.exit(1);
      }

      console.log(`\n  RDT v2 — Explaining File: ${filePath}`);
      console.log(`  ${'─'.repeat(50)}`);
      console.log('  Loading context and calling planner policy...\n');

      try {
        const configResult = loadConfig(projectRoot);
        const stateStore = new ProviderStateStore();
        const router = new ProviderRouter(configResult.config, stateStore);
        router.initFromConfig(configResult.config);

        const content = readFileSync(absolutePath, 'utf-8');
        const fileContentExcerpt = content.slice(0, 16000); // safety cap

        const systemPrompt = `You are an expert AI software developer explaining files.
Provide a clear, detailed, structured markdown explanation of the target file's purpose, main functionality, API/exports, key functions, and its external/internal dependencies.
Highlight any potential architectural or code quality issues if visible.`;

        const userPrompt = `File Path: ${filePath}

File Contents:
\`\`\`
${fileContentExcerpt}
\`\`\``;

        const messages = [
          { role: 'system' as const, content: systemPrompt },
          { role: 'user' as const, content: userPrompt },
        ];

        const routerResult = await router.route(
          configResult.config.agents?.planner?.model_policy ??
            'smart_reasoning',
          {
            model: '',
            messages,
            max_tokens: 3000,
            temperature: 0.2,
          },
          { needsTools: false, needsJson: false },
        );

        if (routerResult.success && routerResult.response) {
          console.log(routerResult.response.content);
        } else {
          console.error('Error: Failed to get explanation from AI model.');
          if (routerResult.error) {
            console.error(routerResult.error.message);
          }
          process.exit(1);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n  Fatal error: ${message}`);
        process.exit(1);
      }
    });
}
