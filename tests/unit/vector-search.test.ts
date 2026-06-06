import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { VectorSearch } from '../../src/project-context/vector-search';
import { ProviderRouter } from '../../src/router/provider-router';
import { MockProvider } from '../../src/providers/mock-provider';
import type { RdtConfig } from '../../src/config/schema';
import { Database } from 'bun:sqlite';

// Mock bun:sqlite since vitest runs in Node.js where bun:sqlite is not resolved.
vi.mock('bun:sqlite', () => {
  class MockDatabase {
    static store = new Map<string, any>();

    constructor(_path: string) {}

    exec(_sql: string) {}

    run(sql: string, ...params: any[]) {
      const store = MockDatabase.store;
      if (sql.includes('INSERT OR REPLACE')) {
        const [path, hash, terms_freq, dense_vector, last_indexed_at] = params;
        store.set(path, { path, hash, terms_freq, dense_vector, last_indexed_at });
      } else if (sql.includes('DELETE FROM')) {
        const [path] = params;
        store.delete(path);
      }
    }

    query(sql: string) {
      const store = MockDatabase.store;
      return {
        get: (path: string) => {
          const val = store.get(path);
          return val ? { hash: val.hash } : null;
        },
        run: (...params: any[]) => {
          if (sql.includes('INSERT OR REPLACE')) {
            const [path, hash, terms_freq, dense_vector, last_indexed_at] = params;
            store.set(path, { path, hash, terms_freq, dense_vector, last_indexed_at });
          } else if (sql.includes('DELETE FROM')) {
            const [path] = params;
            store.delete(path);
          }
        },
        all: () => {
          if (sql.includes('SELECT path, dense_vector')) {
            return Array.from(store.values())
              .filter((v) => v.dense_vector !== null)
              .map((v) => ({ path: v.path, dense_vector: v.dense_vector }));
          } else if (sql.includes('SELECT path, terms_freq')) {
            return Array.from(store.values()).map((v) => ({ path: v.path, terms_freq: v.terms_freq }));
          } else if (sql.includes('SELECT path FROM')) {
            return Array.from(store.values()).map((v) => ({ path: v.path }));
          }
          return [];
        },
      };
    }

    close() {}
  }

  return { Database: MockDatabase };
});

const TEST_DIR = resolve(process.cwd(), 'tmp-test-vector-search');

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true });

  // Create test files with distinctive words
  writeFileSync(
    join(TEST_DIR, 'src/multiply.ts'),
    'export function multiply(a: number, b: number) {\n  // Calculates the product of two numbers\n  return a * b;\n}\n'
  );
  writeFileSync(
    join(TEST_DIR, 'src/divide.ts'),
    'export function divide(numerator: number, denominator: number) {\n  // Performs division and returns the quotient\n  if (denominator === 0) throw new Error("Division by zero");\n  return numerator / denominator;\n}\n'
  );
  writeFileSync(
    join(TEST_DIR, 'README.md'),
    '# RDT Project\n\nSetup instructions:\n1. Run bun install\n2. Run bun test to verify execution.\n'
  );
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

beforeEach(() => {
  // Clear the in-memory mock store before each test run
  (Database as any).store?.clear();
});

describe('VectorSearch Local Search Engine', () => {
  const repoMap = {
    root: TEST_DIR,
    entries: [
      { path: 'src/multiply.ts', type: 'file' as const, size: 100 },
      { path: 'src/divide.ts', type: 'file' as const, size: 200 },
      { path: 'README.md', type: 'file' as const, size: 80 },
    ],
    totalFiles: 3,
    totalDirs: 1,
    ignoredPatterns: [],
  };

  it('should initialize SQLite cache and index files via TF-IDF', async () => {
    const vectorSearch = new VectorSearch(TEST_DIR);
    await vectorSearch.init();

    const indexed = await vectorSearch.indexRepository(repoMap);
    expect(indexed).toBe(3);

    // Searching for multiply terms should rank multiply first
    const multResults = await vectorSearch.search('product of two numbers multiply');
    expect(multResults.length).toBeGreaterThan(0);
    expect(multResults[0].path).toBe('src/multiply.ts');
    expect(multResults[0].score).toBeGreaterThan(0);

    // Searching for divide/quotient terms should rank divide first
    const divResults = await vectorSearch.search('division quotient denominator');
    expect(divResults.length).toBeGreaterThan(0);
    expect(divResults[0].path).toBe('src/divide.ts');

    // Searching for readme terms should rank README.md first
    const readmeResults = await vectorSearch.search('setup instructions install tests');
    expect(readmeResults.length).toBeGreaterThan(0);
    expect(readmeResults[0].path).toBe('README.md');

    vectorSearch.close();
  });

  it('should clean obsolete files from index', async () => {
    const vectorSearch = new VectorSearch(TEST_DIR);
    await vectorSearch.init();

    // Index all three first
    await vectorSearch.indexRepository(repoMap);

    // Re-index with one file missing
    const reducedRepoMap = {
      ...repoMap,
      entries: [
        { path: 'src/multiply.ts', type: 'file' as const, size: 100 },
        { path: 'README.md', type: 'file' as const, size: 80 },
      ],
      totalFiles: 2,
    };

    await vectorSearch.indexRepository(reducedRepoMap);

    // Search for division, divide should no longer be in the results
    const divResults = await vectorSearch.search('division quotient denominator');
    const hasDivide = divResults.some((r) => r.path === 'src/divide.ts');
    expect(hasDivide).toBe(false);

    vectorSearch.close();
  });

  it('should leverage dense embeddings when ProviderRouter is configured', async () => {
    const testConfig: RdtConfig = {
      version: 1,
      project: { name: 'test', language: 'typescript', package_manager: 'bun', test_command: '', lint_command: '' },
      runtime: { max_agent_steps: 10, max_edit_passes: 1, require_git_repo: false, allow_shell_commands: true, allow_destructive_commands: false, rollback_on_failed_task: true, preserve_user_changes: true },
      context_budget: {
        default_max_input_tokens: 1000, reserved_output_tokens: 100, repo_map_max_tokens: 100, file_picker_max_tokens: 100,
        planner_max_tokens: 100, editor_max_tokens: 100, reviewer_max_tokens: 100, max_file_read_tokens: 100, max_total_file_tokens_per_step: 100,
        truncation_strategy: 'summarize', never_truncate: [],
      },
      providers: [
        { id: 'mock-provider', type: 'openai_compatible', base_url: 'http://mock', enabled: true, models: [{ id: 'text-embedding-3-small', model: 'text-embedding-3-small', tier: 'free', quality: 'high', cost: 'free', supports_tools: false, supports_json: false, context_window: 8000 }] },
      ],
      model_policies: {
        cheap_fast: { prefer: ['mock-provider/text-embedding-3-small'], max_cost: 'low' },
      },
      agents: {},
    };

    const router = new ProviderRouter(testConfig);
    const mockProvider = new MockProvider('mock-provider', {
      enabled: true,
      models: [{ id: 'text-embedding-3-small', model: 'text-embedding-3-small', tier: 'free', quality: 'high', cost: 'free', supports_tools: false, supports_json: false, context_window: 8000 }],
    });
    router.registerProvider(mockProvider);

    const vectorSearch = new VectorSearch(TEST_DIR, router);
    await vectorSearch.init();

    // Re-index all files with dense embeddings enabled
    const indexed = await vectorSearch.indexRepository(repoMap);
    expect(indexed).toBe(3);

    const results = await vectorSearch.search('any query string for testing embeddings');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].reason).toContain('semantic match');
    expect(results[0].score).toBeGreaterThan(0);

    vectorSearch.close();
  });
});
