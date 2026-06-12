import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface Instructions {
  agentsMd: string | null;
  knowledgeMd: string | null;
  readme: string | null;
  customInstructions?: string | null;
}

export function loadInstructions(projectRoot: string): Instructions {
  const instructionsDir = resolve(projectRoot, '.rdt/instructions');
  let customInstructions: string | null = null;

  if (existsSync(instructionsDir)) {
    try {
      const files = readdirSync(instructionsDir);
      const mdFiles = files.filter((f) => f.endsWith('.md')).sort();
      if (mdFiles.length > 0) {
        const contents: string[] = [];
        for (const file of mdFiles) {
          const content = readIfExists(join(instructionsDir, file));
          if (content) {
            contents.push(content);
          }
        }
        if (contents.length > 0) {
          customInstructions = contents.join('\n\n');
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    agentsMd: readIfExists(resolve(projectRoot, 'AGENTS.md')),
    knowledgeMd: readIfExists(resolve(projectRoot, 'knowledge.md')),
    readme: readIfExists(resolve(projectRoot, 'README.md')),
    customInstructions,
  };
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}
