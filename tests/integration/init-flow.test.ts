import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createInitCommand } from '../../src/cli/commands/init';
import { createStatusCommand } from '../../src/cli/commands/status';

// ── Setup ─────────────────────────────────────────────────────────

const FIXTURES_DIR = resolve(process.cwd(), 'tests', 'fixtures');
const TS_BASIC_FIXTURE = resolve(FIXTURES_DIR, 'ts-basic');
const TEMP_DIR = resolve(process.cwd(), 'tmp-int-init-flow');
const ORIGINAL_CWD = process.cwd();

let logOutput: string[] = [];

function captureLog(msg: string) {
  logOutput.push(String(msg));
}

beforeAll(() => {
  // Create a minimal project in temp dir (for init tests)
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });
  mkdirSync(join(TEMP_DIR, 'src'));
  mkdirSync(join(TEMP_DIR, 'tests'));

  writeFileSync(
    join(TEMP_DIR, 'package.json'),
    JSON.stringify(
      {
        name: 'test-project',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          test: 'vitest run',
          typecheck: 'tsc --noEmit',
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(TEMP_DIR, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
        },
        include: ['src/**/*.ts', 'tests/**/*.ts'],
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(TEMP_DIR, 'src', 'index.ts'),
    'export const greet = (name: string) => `Hello, ${name}!`;\n',
  );

  writeFileSync(
    join(TEMP_DIR, 'tests', 'greet.test.ts'),
    `import { describe, it, expect } from 'vitest';
import { greet } from '../src/index';

describe('greet', () => {
  it('should greet by name', () => {
    expect(greet('World')).toBe('Hello, World!');
  });
});
`,
  );
});

afterAll(() => {
  process.chdir(ORIGINAL_CWD);
  if (existsSync(TEMP_DIR)) rmSync(TEMP_DIR, { recursive: true });
});

// ── rdt init ───────────────────────────────────────────────────────

describe('rdt init — fixture integration', () => {
  beforeEach(() => {
    process.chdir(TEMP_DIR);
    logOutput = [];
    vi.spyOn(console, 'log').mockImplementation(captureLog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(ORIGINAL_CWD);
  });

  it('should create .rdt directory structure', async () => {
    // Ensure clean state — remove any previous .rdt
    const rdtDir = join(TEMP_DIR, '.rdt');
    if (existsSync(rdtDir)) rmSync(rdtDir, { recursive: true });

    const cmd = createInitCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    // Verify core directory
    expect(existsSync(rdtDir)).toBe(true);

    // Verify subdirectories
    const contents = readdirSync(rdtDir);
    expect(contents).toContain('config.yaml');
    expect(contents).toContain('tasks');
    expect(contents).toContain('cache');
    expect(contents).toContain('logs');
  });

  it('should create AGENTS.md and knowledge.md', async () => {
    const cmd = createInitCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    expect(existsSync(join(TEMP_DIR, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(TEMP_DIR, 'knowledge.md'))).toBe(true);
  });

  it('should generate valid YAML config with all sections', async () => {
    const cmd = createInitCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    const configPath = join(TEMP_DIR, '.rdt', 'config.yaml');
    const content = readFileSync(configPath, 'utf-8');

    // Should read as YAML — check for key sections
    expect(content).toContain('version: 1');
    expect(content).toContain('project:');
    expect(content).toContain('runtime:');
    expect(content).toContain('context_budget:');
    expect(content).toContain('providers:');
    expect(content).toContain('model_policies:');
    expect(content).toContain('agents:');
    expect(content).toContain('file_picker:');
    expect(content).toContain('planner:');
    expect(content).toContain('editor:');
    expect(content).toContain('reviewer:');
  });

  it('should include detected project name in config', async () => {
    const cmd = createInitCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    const { loadConfig } = await import('../../src/config/load-config');
    const result = loadConfig(TEMP_DIR);
    expect(result.config.project.name).toBe('test-project');
  });

  it('should include detected TypeScript language', async () => {
    const cmd = createInitCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    const { loadConfig } = await import('../../src/config/load-config');
    const result = loadConfig(TEMP_DIR);
    expect(result.config.project.language).toBe('typescript');
  });

  it('should log progress to console', async () => {
    const cmd = createInitCommand();
    cmd.exitOverride();
    await cmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    const output = logOutput.join('\n');
    expect(output).toContain('Scanning project');
    expect(output).toContain('test-project');
    expect(output).toContain('RDT initialized');
  });

  it('should not overwrite existing files without --force', async () => {
    // First init
    const cmd1 = createInitCommand();
    cmd1.exitOverride();
    await cmd1.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    // Modify AGENTS.md
    const agentsPath = join(TEMP_DIR, 'AGENTS.md');
    writeFileSync(agentsPath, '# Custom AGENTS.md content\n');

    // Re-init without --force
    logOutput = [];
    const cmd2 = createInitCommand();
    cmd2.exitOverride();
    await cmd2.parseAsync(['node', 'test', 'init'], { from: 'user' });

    // Verify AGENTS.md was NOT overwritten
    const content = readFileSync(agentsPath, 'utf-8');
    expect(content).toContain('Custom AGENTS.md');
    const output = logOutput.join('\n');
    expect(output).toContain('exists');
  });
});

// ── rdt status ─────────────────────────────────────────────────────

describe('rdt status — fixture integration', () => {
  beforeEach(() => {
    process.chdir(TEMP_DIR);
    logOutput = [];
    vi.spyOn(console, 'log').mockImplementation(captureLog);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(ORIGINAL_CWD);
  });

  it('should show project info after init', async () => {
    // Ensure init has been run
    const initCmd = createInitCommand();
    initCmd.exitOverride();
    await initCmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    logOutput = [];
    const statusCmd = createStatusCommand();
    statusCmd.exitOverride();
    await statusCmd.parseAsync(['node', 'test', 'status'], { from: 'user' });

    const output = logOutput.join('\n');
    expect(output).toContain('RDT v2');
    expect(output).toContain('System Status');
    expect(output).toContain('test-project');
    expect(output).toContain('typescript');
    expect(output).toContain('Initialized:     yes');
  });

  it('should detect test and build commands', async () => {
    const initCmd = createInitCommand();
    initCmd.exitOverride();
    await initCmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    logOutput = [];
    const statusCmd = createStatusCommand();
    statusCmd.exitOverride();
    await statusCmd.parseAsync(['node', 'test', 'status'], { from: 'user' });

    const output = logOutput.join('\n');
    expect(output).toContain('Test command');
    expect(output).toContain('Lint command');
  });

  it('should show provider configuration', async () => {
    const initCmd = createInitCommand();
    initCmd.exitOverride();
    await initCmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    logOutput = [];
    const statusCmd = createStatusCommand();
    statusCmd.exitOverride();
    await statusCmd.parseAsync(['node', 'test', 'status'], { from: 'user' });

    const output = logOutput.join('\n');
    expect(output).toContain('Providers:');
    expect(output).toContain('openrouter');
    expect(output).toContain('groq');
    expect(output).toContain('ollama');
  });

  it('should show agent policies', async () => {
    const initCmd = createInitCommand();
    initCmd.exitOverride();
    await initCmd.parseAsync(['node', 'test', 'init', '--force'], { from: 'user' });

    logOutput = [];
    const statusCmd = createStatusCommand();
    statusCmd.exitOverride();
    await statusCmd.parseAsync(['node', 'test', 'status'], { from: 'user' });

    const output = logOutput.join('\n');
    expect(output).toContain('Agent policies');
    expect(output).toContain('file_picker');
    expect(output).toContain('planner');
    expect(output).toContain('editor');
    expect(output).toContain('reviewer');
  });

  it('should show not initialized when .rdt is missing', async () => {
    // Remove .rdt directory
    const rdtDir = join(TEMP_DIR, '.rdt');
    if (existsSync(rdtDir)) rmSync(rdtDir, { recursive: true });

    logOutput = [];
    const statusCmd = createStatusCommand();
    statusCmd.exitOverride();
    await statusCmd.parseAsync(['node', 'test', 'status'], { from: 'user' });

    const output = logOutput.join('\n');
    expect(output).toContain('Initialized:     no');
  });
});
