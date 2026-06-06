#!/usr/bin/env bun

import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInitCommand } from './commands/init';
import { createStatusCommand } from './commands/status';
import { createRunCommand } from './commands/run';
import { createProvidersCommand } from './commands/providers';
import { createDashboardCommand } from './commands/dashboard';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJsonPath = resolve(__dirname, '../../package.json');

function loadVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('rdt')
    .description('RDT v2 — Terminal-first AI coding agent')
    .version(loadVersion())
    .showHelpAfterError();

  program.addCommand(createInitCommand());
  program.addCommand(createStatusCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createProvidersCommand());
  program.addCommand(createDashboardCommand());

  return program;
}

// Run directly (skip when imported by tests — VITEST env is set by Vitest)
if (!process.env.VITEST) {
  const program = createProgram();
  program.parse(process.argv);
}
