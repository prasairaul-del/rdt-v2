import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDashboardCommand } from '../../src/cli/commands/dashboard';

// Mock bun:sqlite since vitest can't resolve Bun built-in modules.
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

// Mock TaskLogStore to avoid touching actual DB
type MockTaskLog = {
  id: string;
  status: string;
  request?: string;
  startedAt?: string;
  errorMessage?: string;
};

type MockTaskLogUpdate = Partial<Omit<MockTaskLog, 'id'>>;

type DashboardServeOptions = {
  port: number;
  fetch: (req: Request) => Response | Promise<Response>;
};

const mockLogs: MockTaskLog[] = [{ id: 'test-1', status: 'completed' }];
vi.mock('../../src/storage/task-log-store', () => {
  return {
    TaskLogStore: class MockTaskLogStore {
      getRecentLogs() {
        return mockLogs;
      }
      getLog(id: string) {
        return mockLogs.find((l) => l.id === id) || null;
      }
      createLog(request: string) {
        const log = {
          id: `task_mock_${Date.now()}`,
          request,
          status: 'created',
          startedAt: new Date().toISOString(),
        };
        mockLogs.push(log);
        return log;
      }
      updateLog(id: string, updates: MockTaskLogUpdate) {
        const log = mockLogs.find((l) => l.id === id);
        if (log) {
          Object.assign(log, updates);
        }
      }
    },
  };
});

// Mock loadConfig
vi.mock('../../src/config/load-config', () => {
  return {
    loadConfig: () => ({
      config: {
        version: 1,
        project: { name: 'test-project' },
      },
    }),
  };
});

// Mock repo-scanner
vi.mock('../../src/project-context/repo-scanner', () => {
  return {
    scanRepo: () => ({
      root: '/mock/root',
      entries: [
        { type: 'file', path: 'src/index.ts' },
        { type: 'directory', path: 'src' },
      ],
    }),
  };
});

// Mock TaskRunner
let mockRunPromiseResolve: (() => void) | null = null;
vi.mock('../../src/core/task-runner', () => {
  return {
    TaskRunner: class MockTaskRunner {
      run = vi.fn().mockImplementation(() => {
        return new Promise<void>((resolve) => {
          mockRunPromiseResolve = resolve;
        });
      });
    },
  };
});

describe('Dashboard Server API', () => {
  let serveOptions: DashboardServeOptions | null = null;
  let projectRoot = '';
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;
  const originalEnv = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  beforeEach(async () => {
    mockRunPromiseResolve = null;
    mockLogs.length = 0;
    mockLogs.push({ id: 'test-1', status: 'completed' });
    serveOptions = null;
    projectRoot = mkdtempSync(join(tmpdir(), 'rdt-dashboard-'));
    mkdirSync(join(projectRoot, '.rdt'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'demo-readiness',
          packageManager: 'bun@1.1.0',
          scripts: {
            test: 'vitest run',
            typecheck: 'tsc --noEmit',
            lint: 'biome check .',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(join(projectRoot, 'AGENTS.md'), '# agents');
    writeFileSync(join(projectRoot, 'knowledge.md'), '# knowledge');
    writeFileSync(join(projectRoot, '.rdt', 'config.yaml'), 'version: 1');
    writeFileSync(join(projectRoot, 'bun.lockb'), '');
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    const testGlobal = globalThis as unknown as {
      Bun: {
        serve: (options: DashboardServeOptions) => { stop: () => void };
      };
    };
    testGlobal.Bun = {
      serve: (options: DashboardServeOptions) => {
        serveOptions = options;
        return {
          stop: () => {},
        };
      },
    };

    const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const command = createDashboardCommand(silentLogger);
    // Parse arguments to trigger action callback
    await command.parseAsync(['node', 'rdt', 'dashboard', '--port', '3000']);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    process.env.OPENROUTER_API_KEY = originalEnv.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = originalEnv.GEMINI_API_KEY;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function fetchDashboard(req: Request): Promise<Response> {
    if (!serveOptions) {
      throw new Error('Dashboard server was not registered');
    }
    return serveOptions.fetch(req);
  }

  it('should register Bun.serve with port 3000', () => {
    expect(serveOptions).not.toBeNull();
    expect(serveOptions?.port).toBe(3000);
  });

  it('should support OPTIONS preflight request', async () => {
    const req = new Request('http://localhost:3000/api/status', {
      method: 'OPTIONS',
    });
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('GET /api/status should return running: false initially', async () => {
    const req = new Request('http://localhost:3000/api/status');
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.running).toBe(false);
  });

  it('GET /api/config should return workspace config', async () => {
    const req = new Request('http://localhost:3000/api/config');
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.project.name).toBe('test-project');
  });

  it('GET /api/readiness should return safe readiness metadata', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-openrouter-secret';
    process.env.ANTHROPIC_API_KEY = '';
    process.env.GEMINI_API_KEY = 'gemini-secret-value';

    const req = new Request('http://localhost:3000/api/readiness');
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.projectName).toBe('demo-readiness');
    expect(json.packageManager).toBe('bun');
    expect(json.scripts).toEqual({
      test: 'bun run test',
      typecheck: 'bun run typecheck',
      lint: 'bun run lint',
      build: null,
    });
    expect(json.providers).toEqual({
      openrouter: true,
      anthropic: false,
      gemini: true,
    });
    expect(json.rules).toEqual({
      agents: true,
      knowledge: true,
      config: true,
    });
    expect(json.level).toBe('ready');

    const raw = JSON.stringify(json);
    expect(raw).not.toContain('sk-openrouter-secret');
    expect(raw).not.toContain('gemini-secret-value');
    expect(
      Object.values(json.providers).every(
        (value) => typeof value === 'boolean',
      ),
    ).toBe(true);
  });

  it('GET /api/files should return repository files list', async () => {
    const req = new Request('http://localhost:3000/api/files');
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toContain('src/index.ts');
  });

  it('GET /api/tasks should return recent tasks log list', async () => {
    const req = new Request('http://localhost:3000/api/tasks');
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toBeInstanceOf(Array);
    expect(json[0].id).toBe('test-1');
  });

  it('GET /api/tasks/:id should return single task details', async () => {
    const req = new Request('http://localhost:3000/api/tasks/test-1');
    const res = await fetchDashboard(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('test-1');

    const reqNotFound = new Request(
      'http://localhost:3000/api/tasks/non-existent',
    );
    const resNotFound = await fetchDashboard(reqNotFound);
    expect(resNotFound.status).toBe(404);
  });

  it('POST /api/tasks should queue subsequent tasks instead of rejecting them', async () => {
    // 1. Success case (first task runs immediately)
    const req1 = new Request('http://localhost:3000/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'fix divide by zero error' }),
    });
    const res1 = await fetchDashboard(req1);
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.success).toBe(true);

    // 2. Lock status check
    const statusReq1 = new Request('http://localhost:3000/api/status');
    const statusRes1 = await fetchDashboard(statusReq1);
    const statusJson1 = await statusRes1.json();
    expect(statusJson1.running).toBe(true);

    // 3. Queue parallel run
    const req2 = new Request('http://localhost:3000/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'another task' }),
    });
    const res2 = await fetchDashboard(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();
    expect(json2.success).toBe(true);
    expect(json2.status).toBe('queued');

    // 4. Verify queueCount is updated
    const statusReq2 = new Request('http://localhost:3000/api/status');
    const statusRes2 = await fetchDashboard(statusReq2);
    const statusJson2 = await statusRes2.json();
    expect(statusJson2.queueCount).toBe(1);

    // Resolve the first task so that test does not hang/leak
    if (mockRunPromiseResolve) {
      mockRunPromiseResolve();
    }
  });

  it('POST /api/tasks with empty request should return 400', async () => {
    // Resolve the first task if it is blocked to avoid hanging other tests
    if (mockRunPromiseResolve) {
      mockRunPromiseResolve();
      mockRunPromiseResolve = null;
    }
    const req = new Request('http://localhost:3000/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: '' }),
    });
    const res = await fetchDashboard(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('cannot be empty');
  });
});
