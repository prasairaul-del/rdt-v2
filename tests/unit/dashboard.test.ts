import { vi, describe, it, expect, beforeEach } from 'vitest';
import { createDashboardCommand } from '../../src/cli/commands/dashboard';

// Mock bun:sqlite since vitest can't resolve Bun built-in modules.
vi.mock('bun:sqlite', () => ({
  Database: class MockDatabase {
    constructor(_path: string) {}
    exec(_sql: string) {}
    run(_sql: string, ..._params: unknown[]) {}
    query(_sql: string) {
      return { get: () => null, all: () => [] };
    }
    close() {}
  },
}));

// Mock TaskLogStore to avoid touching actual DB
vi.mock('../../src/storage/task-log-store', () => {
  return {
    TaskLogStore: class MockTaskLogStore {
      getRecentLogs() {
        return [{ id: 'test-1', status: 'completed' }];
      }
      getLog(id: string) {
        if (id === 'test-1') {
          return { id: 'test-1', status: 'completed' };
        }
        return null;
      }
    }
  };
});

// Mock loadConfig
vi.mock('../../src/config/load-config', () => {
  return {
    loadConfig: () => ({
      config: {
        version: 1,
        project: { name: 'test-project' }
      }
    })
  };
});

// Mock repo-scanner
vi.mock('../../src/project-context/repo-scanner', () => {
  return {
    scanRepo: () => ({
      root: '/mock/root',
      entries: [
        { type: 'file', path: 'src/index.ts' },
        { type: 'directory', path: 'src' }
      ]
    })
  };
});

// Mock TaskRunner
vi.mock('../../src/core/task-runner', () => {
  return {
    TaskRunner: class MockTaskRunner {
      run = vi.fn().mockResolvedValue(undefined);
    }
  };
});

describe('Dashboard Server API', () => {
  let serveOptions: any = null;

  beforeEach(async () => {
    serveOptions = null;
    globalThis.Bun = {
      serve: (options: any) => {
        serveOptions = options;
        return {
          stop: () => {},
        };
      },
    } as any;

    const command = createDashboardCommand();
    // Parse arguments to trigger action callback
    await command.parseAsync(['node', 'rdt', 'dashboard', '--port', '3000']);
  });

  it('should register Bun.serve with port 3000', () => {
    expect(serveOptions).not.toBeNull();
    expect(serveOptions.port).toBe(3000);
  });

  it('should support OPTIONS preflight request', async () => {
    const req = new Request('http://localhost:3000/api/status', { method: 'OPTIONS' });
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('GET /api/status should return running: false initially', async () => {
    const req = new Request('http://localhost:3000/api/status');
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.running).toBe(false);
  });

  it('GET /api/config should return workspace config', async () => {
    const req = new Request('http://localhost:3000/api/config');
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.project.name).toBe('test-project');
  });

  it('GET /api/files should return repository files list', async () => {
    const req = new Request('http://localhost:3000/api/files');
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toContain('src/index.ts');
  });

  it('GET /api/tasks should return recent tasks log list', async () => {
    const req = new Request('http://localhost:3000/api/tasks');
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toBeInstanceOf(Array);
    expect(json[0].id).toBe('test-1');
  });

  it('GET /api/tasks/:id should return single task details', async () => {
    const req = new Request('http://localhost:3000/api/tasks/test-1');
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.id).toBe('test-1');

    const reqNotFound = new Request('http://localhost:3000/api/tasks/non-existent');
    const resNotFound = await serveOptions.fetch(reqNotFound);
    expect(resNotFound.status).toBe(404);
  });

  it('POST /api/tasks should enforce single task execution lock', async () => {
    // 1. Success case
    const req1 = new Request('http://localhost:3000/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'fix divide by zero error' })
    });
    const res1 = await serveOptions.fetch(req1);
    expect(res1.status).toBe(200);
    const json1 = await res1.json();
    expect(json1.success).toBe(true);

    // 2. Lock status check
    const statusReq = new Request('http://localhost:3000/api/status');
    const statusRes = await serveOptions.fetch(statusReq);
    const statusJson = await statusRes.json();
    expect(statusJson.running).toBe(true);

    // 3. Prevent parallel run
    const req2 = new Request('http://localhost:3000/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: 'another task' })
    });
    const res2 = await serveOptions.fetch(req2);
    expect(res2.status).toBe(400);
    const json2 = await res2.json();
    expect(json2.error).toContain('already running');
  });

  it('POST /api/tasks with empty request should return 400', async () => {
    const req = new Request('http://localhost:3000/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request: '' })
    });
    const res = await serveOptions.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain('cannot be empty');
  });
});
