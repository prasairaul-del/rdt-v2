import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DetectedCommands } from './command-detector';
import { detectCommands } from './command-detector';

export interface ProjectInfo {
  name: string;
  language: string;
  packageManager: string | null;
  testCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  hasGit: boolean;
  sourceDirs: string[];
}

export function detectProject(projectRoot: string): ProjectInfo {
  const pkg = readPackageJson(projectRoot);
  const commands = detectCommands(projectRoot);
  const hasGit = existsSync(resolve(projectRoot, '.git'));
  const sourceDirs = detectSourceDirs(projectRoot);

  const name =
    typeof pkg?.name === 'string'
      ? pkg.name
      : (readProjectNameFromPyproject(projectRoot) ??
          projectRoot.split(/[/\\]/).pop()) ||
        'unknown';
  const language = detectLanguage(projectRoot, pkg);

  return {
    name,
    language,
    packageManager: commands.packageManager,
    testCommand: commands.testCommand,
    lintCommand: commands.lintCommand,
    buildCommand: commands.buildCommand,
    hasGit,
    sourceDirs,
  };
}

function readPackageJson(projectRoot: string): Record<string, unknown> | null {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readFileSync(pkgPath, 'utf-8'));
  } catch {
    return null;
  }
}

function detectLanguage(
  projectRoot: string,
  pkg: Record<string, unknown> | null,
): string {
  if (existsSync(resolve(projectRoot, 'tsconfig.json'))) return 'typescript';
  if (existsSync(resolve(projectRoot, 'pyproject.toml'))) return 'python';
  if (existsSync(resolve(projectRoot, 'Cargo.toml'))) return 'rust';
  if (existsSync(resolve(projectRoot, 'go.mod'))) return 'go';
  if (pkg?.dependencies || pkg?.devDependencies) return 'javascript';
  return 'unknown';
}

function detectSourceDirs(projectRoot: string): string[] {
  const commonDirs = ['src', 'lib', 'app', 'source'];
  const existing = commonDirs.filter((dir) =>
    existsSync(resolve(projectRoot, dir)),
  );
  if (existing.length > 0) return existing;
  return ['src'];
}

/**
 * Extract the project name from pyproject.toml if it exists.
 * Looks for `name = "..."` or `name = '...'` inside the `[project]` section.
 */
function readProjectNameFromPyproject(projectRoot: string): string | null {
  const tomlPath = resolve(projectRoot, 'pyproject.toml');
  if (!existsSync(tomlPath)) return null;
  try {
    const content = readFileSync(tomlPath, 'utf-8');
    // Find everything within the [project] section (until next section header)
    const projectMatch = content.match(/\[project\]\s*\n([^[]*)/);
    if (!projectMatch) return null;
    const projectSection = projectMatch[1];
    // Match name = "value" or name = 'value'
    const nameMatch = projectSection.match(/^name\s*=\s*['"]([^'"]+)['"]\s*$/m);
    return nameMatch ? nameMatch[1] : null;
  } catch {
    return null;
  }
}
