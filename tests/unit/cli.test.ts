import { describe, expect, it, vi } from 'vitest';
import { createInitCommand } from '../../src/cli/commands/init';
import { createStatusCommand } from '../../src/cli/commands/status';
import { createProgram } from '../../src/cli/index';
import { createDefaultConfig } from '../../src/config/defaults';

// Mock bun:sqlite since vitest can't resolve Bun built-in modules.
// The CLI tests don't actually use SQLite — they just need the import chain to load.
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {
    exec(_sql: string) {}
    run(_sql: string, ..._params: unknown[]) {}
    query(_sql: string) {
      return { get: () => null, all: () => [] };
    }
    close() {}
  },
}));

describe('CLI program', () => {
  it('should create a program with correct name', () => {
    const program = createProgram();
    expect(program.name()).toBe('rdt');
  });

  it('should have all registered commands', () => {
    const program = createProgram();
    const commands = program.commands.map((c) => c.name());
    expect(commands).toContain('init');
    expect(commands).toContain('status');
    expect(commands).toContain('run');
    expect(commands).toContain('providers');
    expect(commands).toContain('dashboard');
    expect(commands).toContain('explain');
    expect(commands).toContain('undo');
  });

  it('should output help text containing all commands', () => {
    const program = createProgram();
    const helpOutput = program.helpInformation();
    expect(helpOutput).toContain('rdt');
    expect(helpOutput).toContain('init');
    expect(helpOutput).toContain('status');
    expect(helpOutput).toContain('run');
    expect(helpOutput).toContain('providers');
    expect(helpOutput).toContain('dashboard');
    expect(helpOutput).toContain('explain');
    expect(helpOutput).toContain('undo');
  });
});

describe('init command', () => {
  it('should create a command with correct name and description', () => {
    const cmd = createInitCommand();
    expect(cmd.name()).toBe('init');
    expect(cmd.description()).toContain('Initialize');
  });

  it('should accept --force flag', () => {
    const cmd = createInitCommand();
    const opts = cmd.options.map((o) => o.attributeName());
    expect(opts).toContain('force');
  });
});

describe('status command', () => {
  it('should create a command with correct name and description', () => {
    const cmd = createStatusCommand();
    expect(cmd.name()).toBe('status');
    expect(cmd.description()).toContain('Show');
  });
});

describe('dashboard command', () => {
  it('should create a command with correct name and description', async () => {
    const { createDashboardCommand } = await import(
      '../../src/cli/commands/dashboard'
    );
    const cmd = createDashboardCommand();
    expect(cmd.name()).toBe('dashboard');
    expect(cmd.description()).toContain('dashboard');
  });

  it('should accept --port option', async () => {
    const { createDashboardCommand } = await import(
      '../../src/cli/commands/dashboard'
    );
    const cmd = createDashboardCommand();
    const opt = cmd.options.find((o) => o.attributeName() === 'port');
    expect(opt).toBeDefined();
  });

  it('should accept --open-vscode option', async () => {
    const { createDashboardCommand } = await import(
      '../../src/cli/commands/dashboard'
    );
    const cmd = createDashboardCommand();
    const opt = cmd.options.find((o) => o.attributeName() === 'openVscode');
    expect(opt).toBeDefined();
  });
});

describe('config defaults', () => {
  it('should create default config with all required sections', () => {
    const config = createDefaultConfig();
    expect(config.version).toBe(1);
    expect(config.project).toBeDefined();
    expect(config.runtime).toBeDefined();
    expect(config.context_budget).toBeDefined();
    expect(config.providers.length).toBeGreaterThan(0);
    expect(config.model_policies).toBeDefined();
    expect(config.agents).toBeDefined();
  });

  it('should have three providers configured', () => {
    const config = createDefaultConfig();
    const providerIds = config.providers.map((p) => p.id);
    expect(providerIds).toContain('openrouter');
    expect(providerIds).toContain('groq');
    expect(providerIds).toContain('ollama');
  });

  it('should have four agent policies', () => {
    const config = createDefaultConfig();
    const agentNames = Object.keys(config.agents);
    expect(agentNames).toContain('file_picker');
    expect(agentNames).toContain('planner');
    expect(agentNames).toContain('editor');
    expect(agentNames).toContain('reviewer');
  });
});

describe('project detection', () => {
  it('should detect source directories from project root', async () => {
    const { detectProject } = await import(
      '../../src/project-context/detect-project'
    );
    const info = detectProject(process.cwd());
    expect(info.name).toBeTruthy();
    expect(info.language).toBe('typescript');
    expect(info.sourceDirs).toContain('src');
    expect(typeof info.hasGit).toBe('boolean');
  });

  it('should detect commands from package.json', async () => {
    const { detectCommands } = await import(
      '../../src/project-context/command-detector'
    );
    const cmds = detectCommands(process.cwd());
    expect(cmds.testCommand).toBeTruthy();
    expect(cmds.packageManager).toBe('bun');
  });
});

describe('repo scanner', () => {
  it('should scan project root without crashing', async () => {
    const { scanRepo } = await import('../../src/project-context/repo-scanner');
    const map = scanRepo(process.cwd());
    expect(map.root).toBe(process.cwd());
    expect(map.totalFiles).toBeGreaterThan(0);
    expect(map.entries.length).toBeGreaterThan(0);
  });
});

describe('explain command', () => {
  it('should create a command with correct name and description', async () => {
    const { createExplainCommand } = await import(
      '../../src/cli/commands/explain'
    );
    const cmd = createExplainCommand();
    expect(cmd.name()).toBe('explain');
    expect(cmd.description()).toContain('Explain');
  });
});

describe('undo command', () => {
  it('should create a command with correct name and description', async () => {
    const { createUndoCommand } = await import('../../src/cli/commands/undo');
    const cmd = createUndoCommand();
    expect(cmd.name()).toBe('undo');
    expect(cmd.description()).toContain('Undo');
  });
});
