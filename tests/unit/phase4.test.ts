import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { RdtConfig } from '../../src/config/schema';
import type { TaskResult } from '../../src/core/runner/types';
import { TaskRunner } from '../../src/core/task-runner';
import type { TaskState } from '../../src/core/task-state';
import { VectorSearch } from '../../src/project-context/vector-search';

// Mock bun:sqlite
interface MockDbRow {
  path?: string;
  hash?: string;
  terms_freq?: string;
  dense_vector?: string | null;
  size?: number | null;
  mtime_ms?: number | null;
}

type TaskRunnerInternals = {
  calculateEstimatedCost: (
    providerId: string,
    modelId: string,
    promptTokens: number,
    completionTokens: number,
  ) => number;
  buildResult: (
    state: TaskState,
    success: boolean,
    error?: string,
  ) => TaskResult;
};

const minimalRdtConfig = {
  runtime: {
    max_edit_passes: 3,
    rollback_on_failed_task: true,
  },
  providers: [],
} as unknown as RdtConfig;

const mockDbStore = new Map<string, MockDbRow>();
const mockExecCalls: string[] = [];
let mockTableColumns = [
  { name: 'path' },
  { name: 'hash' },
  { name: 'terms_freq' },
  { name: 'dense_vector' },
  { name: 'last_indexed_at' },
];

vi.mock('bun:sqlite', () => {
  class MockDatabase {
    exec(sql: string) {
      mockExecCalls.push(sql);
    }

    run(sql: string, ...params: unknown[]) {
      if (sql.includes('INSERT OR REPLACE')) {
        const [path, hash, terms_freq, dense_vector, size, mtime_ms] = params;
        mockDbStore.set(String(path), {
          path: String(path),
          hash: String(hash),
          terms_freq: String(terms_freq),
          dense_vector: typeof dense_vector === 'string' ? dense_vector : null,
          size: typeof size === 'number' ? size : null,
          mtime_ms: typeof mtime_ms === 'number' ? mtime_ms : null,
        });
      } else if (sql.includes('UPDATE files_index')) {
        const [size, mtime_ms, path] = params;
        const existing = mockDbStore.get(String(path)) || {};
        mockDbStore.set(String(path), {
          ...existing,
          size: typeof size === 'number' ? size : null,
          mtime_ms: typeof mtime_ms === 'number' ? mtime_ms : null,
        });
      } else if (sql.includes('DELETE FROM')) {
        const [path] = params;
        mockDbStore.delete(String(path));
      }
    }

    query(sql: string) {
      return {
        get: (path: string) => {
          const val = mockDbStore.get(path);
          if (!val) return null;
          return { hash: val.hash, size: val.size, mtime_ms: val.mtime_ms };
        },
        all: () => {
          if (sql.includes('PRAGMA table_info')) {
            return mockTableColumns;
          }
          if (sql.includes('SELECT path FROM')) {
            return Array.from(mockDbStore.values()).map((v) => ({
              path: v.path,
            }));
          }
          return [];
        },
      };
    }

    close() {}
  }
  return { Database: MockDatabase };
});

describe('Phase 4: Telemetry Profiling', () => {
  it('correctly calculates costs for Sonnet/GPT-4o, mini, and fallback models', () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
      rdtConfig: minimalRdtConfig,
    });
    const runnerInternals = runner as unknown as TaskRunnerInternals;

    // Claude 3.5 Sonnet / GPT-4o: $3/$15 per M
    const costSonnet = runnerInternals.calculateEstimatedCost(
      'anthropic',
      'claude-3-5-sonnet',
      1000000,
      1000000,
    );
    expect(costSonnet).toBe(18.0); // $3 + $15

    // Mini models: $0.15/$0.6 per M
    const costMini = runnerInternals.calculateEstimatedCost(
      'openai',
      'gpt-4o-mini',
      1000000,
      1000000,
    );
    expect(costMini).toBe(0.75); // $0.15 + $0.6

    // Fallback models: $1.5/$7.5 per M
    const costFallback = runnerInternals.calculateEstimatedCost(
      'provider',
      'custom-model',
      1000000,
      1000000,
    );
    expect(costFallback).toBe(9.0); // $1.5 + $7.5
  });

  it('formats detailed telemetry summary with aggregated totals', () => {
    const runner = new TaskRunner({
      projectRoot: process.cwd(),
      rdtConfig: minimalRdtConfig,
    });
    const runnerInternals = runner as unknown as TaskRunnerInternals;

    const state: TaskState = {
      id: 'task_telemetry_test',
      request: 'test request',
      status: 'done',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxEditPasses: 3,
      editPass: 1,
      rollbackOnFailed: true,
      errors: [],
      changedFiles: [],
      providerUsage: [
        {
          agentName: 'editor',
          providerId: 'anthropic',
          modelId: 'claude-3-5-sonnet',
          promptTokens: 1000,
          completionTokens: 500,
          durationMs: 1500,
        },
        {
          agentName: 'reviewer',
          providerId: 'openai',
          modelId: 'gpt-4o-mini',
          promptTokens: 2000,
          completionTokens: 1000,
          durationMs: 800,
        },
      ],
    };

    const result = runnerInternals.buildResult(state, true);
    expect(result.providerSummary).toContain(
      'editor (anthropic/claude-3-5-sonnet):',
    );
    expect(result.providerSummary).toContain('Latency: 1500ms');
    expect(result.providerSummary).toContain(
      'Tokens: 1000 prompt, 500 completion',
    );
    expect(result.providerSummary).toContain('Cost: $0.010500');

    expect(result.providerSummary).toContain('reviewer (openai/gpt-4o-mini):');
    expect(result.providerSummary).toContain('Latency: 800ms');
    expect(result.providerSummary).toContain(
      'Tokens: 2000 prompt, 1000 completion',
    );
    expect(result.providerSummary).toContain('Cost: $0.000900');

    expect(result.providerSummary).toContain('Aggregated Totals:');
    expect(result.providerSummary).toContain('Total Latency: 2300ms');
    expect(result.providerSummary).toContain(
      'Total Tokens: 4500 (3000 prompt, 1500 completion)',
    );
    expect(result.providerSummary).toContain('Total Estimated Cost: $0.011400');
  });
});

describe('Phase 4: Vector Search Caching & Migration', () => {
  const TEST_DIR = resolve(process.cwd(), 'tmp-test-phase4');

  beforeAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
  });

  afterAll(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true });
    }
  });

  beforeEach(() => {
    mockDbStore.clear();
    mockExecCalls.length = 0;
    mockTableColumns = [
      { name: 'path' },
      { name: 'hash' },
      { name: 'terms_freq' },
      { name: 'dense_vector' },
      { name: 'last_indexed_at' },
    ];
  });

  it('runs backwards-compatible migrations when size or mtime_ms are missing', async () => {
    const search = new VectorSearch(TEST_DIR);
    await search.init();

    expect(
      mockExecCalls.some((c) =>
        c.includes('ALTER TABLE files_index ADD COLUMN size'),
      ),
    ).toBe(true);
    expect(
      mockExecCalls.some((c) =>
        c.includes('ALTER TABLE files_index ADD COLUMN mtime_ms'),
      ),
    ).toBe(true);
  });

  it('skips reading file and hashing when cached size and mtimeMs match', async () => {
    mockTableColumns.push({ name: 'size' }, { name: 'mtime_ms' });

    const filePath = join(TEST_DIR, 'src/test-file.ts');
    fs.writeFileSync(filePath, 'content', 'utf-8');
    const stat = fs.statSync(filePath);

    // Seed cache
    mockDbStore.set('src/test-file.ts', {
      path: 'src/test-file.ts',
      hash: 'fake-hash',
      terms_freq: '{}',
      dense_vector: null,
      size: stat.size,
      mtime_ms: stat.mtimeMs,
    });

    const search = new VectorSearch(TEST_DIR);
    await search.init();

    const repoMap = {
      root: TEST_DIR,
      entries: [
        {
          path: 'src/test-file.ts',
          type: 'file' as const,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
      ],
      totalFiles: 1,
      totalDirs: 0,
      ignoredPatterns: [],
    };

    const indexedCount = await search.indexRepository(repoMap);

    // Should skip (returns 0)
    expect(indexedCount).toBe(0);
  });

  it('updates metadata and skips full indexing when hash matches but metadata differs', async () => {
    mockTableColumns.push({ name: 'size' }, { name: 'mtime_ms' });

    const filePath = join(TEST_DIR, 'src/test-file.ts');
    fs.writeFileSync(filePath, 'content', 'utf-8');
    const stat = fs.statSync(filePath);

    const contentHash = require('node:crypto')
      .createHash('sha256')
      .update('content')
      .digest('hex');

    // Seed cache with matching hash but mismatched/null size & mtimeMs
    mockDbStore.set('src/test-file.ts', {
      path: 'src/test-file.ts',
      hash: contentHash,
      terms_freq: '{}',
      dense_vector: null,
      size: null,
      mtime_ms: null,
    });

    const search = new VectorSearch(TEST_DIR);
    await search.init();

    const repoMap = {
      root: TEST_DIR,
      entries: [
        {
          path: 'src/test-file.ts',
          type: 'file' as const,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        },
      ],
      totalFiles: 1,
      totalDirs: 0,
      ignoredPatterns: [],
    };

    const indexedCount = await search.indexRepository(repoMap);

    // Should skip full indexing (returns 0)
    expect(indexedCount).toBe(0);

    // But metadata in DB should be updated to match the scanned file
    const cached = mockDbStore.get('src/test-file.ts');
    expect(cached).toBeDefined();
    if (!cached) {
      throw new Error('Expected cached metadata for src/test-file.ts');
    }
    expect(cached.size).toBe(stat.size);
    expect(cached.mtime_ms).toBe(stat.mtimeMs);
  });
});
