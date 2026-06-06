import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Instructions {
  agentsMd: string | null;
  knowledgeMd: string | null;
  readme: string | null;
}

export function loadInstructions(projectRoot: string): Instructions {
  return {
    agentsMd: readIfExists(resolve(projectRoot, 'AGENTS.md')),
    knowledgeMd: readIfExists(resolve(projectRoot, 'knowledge.md')),
    readme: readIfExists(resolve(projectRoot, 'README.md')),
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
