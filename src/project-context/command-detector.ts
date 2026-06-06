import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DetectedCommands {
  testCommand: string | null;
  lintCommand: string | null;
  buildCommand: string | null;
  packageManager: string | null;
}

export function detectCommands(projectRoot: string): DetectedCommands {
  const pm = detectPackageManager(projectRoot);
  const pkgScripts = readPackageScripts(projectRoot);

  const testCommand =
    findScript(pkgScripts, ['test', 'vitest', 'jest', 'mocha', 'ava'], pm) ??
    detectPythonTestCommand(projectRoot);
  const lintCommand = findScript(
    pkgScripts,
    ['lint', 'biome check', 'eslint', 'tsc --noEmit', 'typecheck'],
    pm,
  );
  const buildCommand = findScript(pkgScripts, ['build', 'compile'], pm);

  return { testCommand, lintCommand, buildCommand, packageManager: pm };
}

/**
 * Detect a Python test command when pyproject.toml exists with pytest configuration.
 * Returns 'python -m pytest' if pytest is configured, otherwise null.
 */
function detectPythonTestCommand(projectRoot: string): string | null {
  const tomlPath = resolve(projectRoot, 'pyproject.toml');
  if (!existsSync(tomlPath)) return null;
  try {
    const content = readFileSync(tomlPath, 'utf-8');
    // Check if pytest is configured in pyproject.toml (e.g. [tool.pytest.ini_options])
    if (/\[tool\.pytest/i.test(content)) {
      return 'python -m pytest';
    }
    return null;
  } catch {
    return null;
  }
}

function detectPackageManager(projectRoot: string): string | null {
  if (existsSync(resolve(projectRoot, 'bun.lock'))) return 'bun';
  if (existsSync(resolve(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(resolve(projectRoot, 'package-lock.json'))) return 'npm';
  return null;
}

function readPackageScripts(projectRoot: string): Record<string, string> {
  const pkgPath = resolve(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return {};

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.scripts || {};
  } catch {
    return {};
  }
}

function findScript(
  scripts: Record<string, string>,
  candidates: string[],
  pm: string | null,
): string | null {
  for (const key of candidates) {
    if (scripts[key]) {
      const executor = pm || 'npm';
      return `${executor} run ${key}`;
    }
  }
  return null;
}
