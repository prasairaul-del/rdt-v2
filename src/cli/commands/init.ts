import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';
import { detectProject } from '../../project-context/detect-project';
import { writeConfig } from '../../config/load-config';
import { createDefaultConfig } from '../../config/defaults';

const AGENTS_MD_CONTENT = `# AGENTS.md

## Project Overview
RDT v2 is a terminal-first AI coding assistant.
It coordinates specialized agents to understand a repo, plan changes, apply patches, and verify results.

## Setup Commands
- Install: \`bun install\`
- Run tests: \`bun run test\`
- Build: \`bun build src/cli/index.ts --outfile dist/rdt.js --target bun\`
- Run: \`bun run src/cli/index.ts\`

## Code Style
- TypeScript strict mode always on
- Use Result types, not exceptions, for agent outputs
- Agents must not access the filesystem directly — use tools only
- Every tool must return \`ToolResult<T>\`

## Important Files
- \`src/cli/index.ts\` — CLI entrypoint
- \`src/core/task-runner.ts\` — main task state machine
- \`src/agents/\` — four core agents
- \`src/tools/\` — all filesystem and shell tools
- \`src/router/\` — provider routing and fallback logic
- \`.rdt/config.yaml\` — runtime configuration

## Agent Rules
- Do not rewrite large files unnecessarily
- Run tests before claiming success
- Preserve existing code style
- Apply patches, not full-file overwrites
- Always inspect git diff after edits
`;

const KNOWLEDGE_MD_CONTENT = `# Project Knowledge

## Architecture
RDT v2 uses four specialized agents: File Picker, Planner, Editor, Reviewer.
Each agent receives a task context and returns a typed output schema.
Agents never touch the filesystem directly — all operations go through tools.

## Technology Decisions
- **TypeScript + Bun**: fast startup, good typing, easy CLI packaging
- **SQLite**: simple local persistence for task logs and provider state
- **Markdown memory**: knowledge.md and AGENTS.md before vector DB
- **One task runner**: no competing execution paths

## Provider Strategy
- OpenRouter free tier as default
- Groq as fallback
- Ollama for local models
- Router handles cooldowns, rate limits, and fallback

## Avoid
- Do not add dashboard before MVP is stable
- Do not add ChromaDB until knowledge.md is insufficient
- Do not add swarm until single-agent workflow is rock solid
- Never retry endlessly after rate limits — cooldown and fallback only
`;

export function createInitCommand(): Command {
  return new Command('init')
    .description('Initialize RDT configuration for this project')
    .option('-f, --force', 'Overwrite existing files')
    .action((options: { force?: boolean }) => {
      const projectRoot = process.cwd();
      const rdtDir = resolve(projectRoot, '.rdt');

      // Create .rdt directory
      mkdirSync(rdtDir, { recursive: true });
      mkdirSync(resolve(rdtDir, 'tasks'), { recursive: true });
      mkdirSync(resolve(rdtDir, 'cache'), { recursive: true });
      mkdirSync(resolve(rdtDir, 'logs'), { recursive: true });

      // Detect project info
      console.log('Scanning project...');
      const info = detectProject(projectRoot);
      console.log(`  Project: ${info.name}`);
      console.log(`  Language: ${info.language}`);
      console.log(`  Package manager: ${info.packageManager || 'unknown'}`);
      console.log(`  Test command: ${info.testCommand || 'none detected'}`);
      console.log(`  Git repo: ${info.hasGit ? 'yes' : 'no'}`);

      // Write config
      const configPath = resolve(rdtDir, 'config.yaml');
      if (existsSync(configPath) && !options.force) {
        console.log(`\n${configPath} already exists. Use --force to overwrite.`);
      } else {
        const config = createDefaultConfig();
        config.project.name = info.name;
        config.project.language = info.language;
        config.project.package_manager = info.packageManager || 'auto';
        config.project.test_command = info.testCommand || 'auto';
        writeConfig(projectRoot, config);
        console.log(`  Config: ${configPath}`);
      }

      // Write AGENTS.md
      const agentsPath = resolve(projectRoot, 'AGENTS.md');
      if (!existsSync(agentsPath) || options.force) {
        writeFileSync(agentsPath, AGENTS_MD_CONTENT, 'utf-8');
        console.log(`  AGENTS.md: ${agentsPath}`);
      } else {
        console.log(`  AGENTS.md: exists (use --force to overwrite)`);
      }

      // Write knowledge.md
      const knowledgePath = resolve(projectRoot, 'knowledge.md');
      if (!existsSync(knowledgePath) || options.force) {
        writeFileSync(knowledgePath, KNOWLEDGE_MD_CONTENT, 'utf-8');
        console.log(`  knowledge.md: ${knowledgePath}`);
      } else {
        console.log(`  knowledge.md: exists (use --force to overwrite)`);
      }

      console.log('\nRDT initialized successfully.');
    });
}
