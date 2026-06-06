import type { ProjectInfo } from './detect-project';
import type { Instructions } from './load-instructions';
import type { RepoMap } from './repo-map';

export interface TaskContext {
  project: ProjectInfo;
  instructions: Instructions;
  repoMap: RepoMap;
  request: string;
  truncatedFiles: string[];
}

export function buildContext(
  project: ProjectInfo,
  instructions: Instructions,
  repoMap: RepoMap,
  request: string,
): TaskContext {
  return {
    project,
    instructions,
    repoMap,
    request,
    truncatedFiles: [],
  };
}
