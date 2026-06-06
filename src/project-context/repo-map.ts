export interface RepoMapEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
}

export interface RepoMap {
  root: string;
  entries: RepoMapEntry[];
  totalFiles: number;
  totalDirs: number;
  ignoredPatterns: string[];
}
