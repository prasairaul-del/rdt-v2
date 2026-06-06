import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { TaskRunner } from '../../src/core/task-runner';
import { ProviderRouter } from '../../src/router/provider-router';
import { MockProvider } from '../../src/providers/mock-provider';
import type { RdtConfig } from '../../src/config/schema';

// ── Mocks ─────────────────────────────────────────────────────────

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

vi.mock('../../src/tools/git-diff', () => ({
  gitDiffTool: {
    name: 'git_diff',
    description: 'Mocked git diff',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      success: true,
      data: { diff: '', filesChanged: 0, hasChanges: false },
    }),
  },
}));

vi.mock('../../src/tools/test-runner', () => ({
  testRunnerTool: {
    name: 'test_runner',
    description: 'Mocked test runner',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({
      success: true,
      data: { command: 'echo mocked', stdout: 'Tests passed', stderr: '', exitCode: 0, passed: true },
    }),
  },
}));

const TEST_DIR = resolve(process.cwd(), 'tmp-test-robustness');

beforeAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'src/multiply.ts'), 'export function multiply(a: number, b: number) { return a + b; }\n');
});

afterAll(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
});

// ── Test Configuration ───────────────────────────────────────────

const testConfig: RdtConfig = {
  version: 1,
  project: { name: 'test-robustness', language: 'typescript', package_manager: 'bun', test_command: 'bun run test', lint_command: 'bun run lint' },
  runtime: { max_agent_steps: 20, max_edit_passes: 1, require_git_repo: false, allow_shell_commands: true, allow_destructive_commands: false, rollback_on_failed_task: true, preserve_user_changes: true },
  context_budget: {
    default_max_input_tokens: 32_000, reserved_output_tokens: 4_000, repo_map_max_tokens: 6_000,
    file_picker_max_tokens: 12_000, planner_max_tokens: 20_000, editor_max_tokens: 28_000, reviewer_max_tokens: 28_000,
    max_file_read_tokens: 8_000, max_total_file_tokens_per_step: 18_000,
    truncation_strategy: 'summarize_then_select', never_truncate: [],
  },
  providers: [
    { id: 'openrouter-1', type: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] },
    { id: 'openrouter-2', type: 'openai_compatible', base_url: 'https://openrouter.ai/api/v1', enabled: true, models: [{ id: 'free', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] },
  ],
  model_policies: {
    cheap_fast: { prefer: ['openrouter-1/free', 'openrouter-2/free'], max_cost: 'high' },
    smart_reasoning: { prefer: ['openrouter-1/free', 'openrouter-2/free'], max_cost: 'high' },
    code_strong: { prefer: ['openrouter-1/free', 'openrouter-2/free'], max_cost: 'high' },
  },
  agents: {
    file_picker: { model_policy: 'cheap_fast', tools: [] },
    planner: { model_policy: 'smart_reasoning', tools: [] },
    editor: { model_policy: 'code_strong', tools: [] },
    reviewer: { model_policy: 'smart_reasoning', tools: [] },
  },
};

// ── Robustness Tests ─────────────────────────────────────────────

describe('TaskRunner Robustness & Failures', () => {
  it('should fall back to a secondary provider if the primary provider goes offline mid-task', async () => {
    const router = new ProviderRouter(testConfig);
    
    // Primary provider: succeeds during planning, fails during editing
    const provider1 = new MockProvider('openrouter-1', { enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] });
    let p1Calls = 0;
    provider1.complete = async (request) => {
      p1Calls++;
      if (p1Calls === 1) {
        // Planner request -> Success
        return {
          content: JSON.stringify({
            summary: "Plan to fix multiply",
            steps: [{ id: "step_1", description: "fix the bug", targetFiles: ["src/multiply.ts"], risk: "low" }],
            testPlan: [],
            risks: []
          }),
          model: 'mistral-7b',
          provider: 'openrouter-1'
        };
      }
      // Editor request -> Throws error
      throw Object.assign(new Error('Provider went offline'), { code: 'SERVER_ERROR', retryable: false });
    };

    // Secondary provider: succeeds when called as fallback
    const provider2 = new MockProvider('openrouter-2', { enabled: true, models: [{ id: 'free', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] });
    provider2.complete = async (request) => {
      // Editor fallback request -> Success
      return {
        content: JSON.stringify({
          summary: "Fixed multiply",
          edits: [{ file: "src/multiply.ts", content: "export function multiply(a: number, b: number) { return a * b; }\n" }]
        }),
        model: 'llama3-8b',
        provider: 'openrouter-2'
      };
    };

    router.registerProvider(provider1);
    router.registerProvider(provider2);

    const runner = new TaskRunner({
      projectRoot: TEST_DIR,
      rdtConfig: testConfig,
      providerRouter: router,
    });

    const result = await runner.run('fix the multiply bug');

    expect(result.success).toBe(true);
    expect(result.state.status).toBe('done');
    
    // Check provider usage to verify both were recorded
    const plannerCall = result.state.providerUsage.find(u => u.agentName === 'planner');
    const editorCall = result.state.providerUsage.find(u => u.agentName === 'editor');
    
    expect(plannerCall).toBeDefined();
    expect(plannerCall?.providerId).toBe('openrouter-1'); // Planner used openrouter-1
    
    expect(editorCall).toBeDefined();
    expect(editorCall?.providerId).toBe('openrouter-2'); // Editor fell back to openrouter-2
  });

  it('should cool down a provider on rate limiting (429) and route subsequent requests past it', async () => {
    const router = new ProviderRouter(testConfig);

    // Primary provider: rate limited immediately
    const provider1 = new MockProvider('openrouter-1', { enabled: true, models: [{ id: 'free', model: 'mistral-7b', tier: 'free', quality: 'low', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] });
    provider1.complete = async () => {
      throw Object.assign(new Error('Too Many Requests'), { code: 'RATE_LIMITED', retryable: false, status: 429, cooldownMs: 10_000 });
    };

    // Secondary provider: succeeds
    const provider2 = new MockProvider('openrouter-2', { enabled: true, models: [{ id: 'free', model: 'llama3-8b', tier: 'free', quality: 'high', cost: 'free', supports_tools: true, supports_json: true, context_window: 8_000 }] });
    let p2Calls = 0;
    provider2.complete = async (request) => {
      p2Calls++;
      if (p2Calls === 1) {
        // Planner request -> Success
        return {
          content: JSON.stringify({
            summary: "Plan to fix multiply",
            steps: [{ id: "step_1", description: "fix the bug", targetFiles: ["src/multiply.ts"], risk: "low" }],
            testPlan: [],
            risks: []
          }),
          model: 'llama3-8b',
          provider: 'openrouter-2'
        };
      }
      // Editor request -> Success
      return {
        content: JSON.stringify({
          summary: "Fixed multiply",
          edits: [{ file: "src/multiply.ts", content: "export function multiply(a: number, b: number) { return a * b; }\n" }]
        }),
        model: 'llama3-8b',
        provider: 'openrouter-2'
      };
    };

    router.registerProvider(provider1);
    router.registerProvider(provider2);

    const runner = new TaskRunner({
      projectRoot: TEST_DIR,
      rdtConfig: testConfig,
      providerRouter: router,
    });

    const result = await runner.run('fix the multiply bug');

    expect(result.success).toBe(true);
    
    // Planner should list openrouter-1 as failed and openrouter-2 as success
    const plannerUsage = result.state.providerUsage.filter(u => u.agentName === 'planner');
    expect(plannerUsage.length).toBe(1); // TaskRunner state only records successful model usages or final attempts
    expect(plannerUsage[0].providerId).toBe('openrouter-2');
    
    // Editor should directly use openrouter-2 (without trying openrouter-1, since it is in cooldown)
    const editorUsage = result.state.providerUsage.filter(u => u.agentName === 'editor');
    expect(editorUsage.length).toBe(2);
    expect(editorUsage[0].providerId).toBe('openrouter-2');
    expect(editorUsage[1].providerId).toBe('openrouter-2');

    // Confirm that openrouter-1 state store entry is marked in cooldown
    const modelState = router.stateStore.get('openrouter-1', 'free');
    expect(modelState?.cooldownUntil).toBeDefined();
    const cooldownActive = new Date(modelState!.cooldownUntil!) > new Date();
    expect(cooldownActive).toBe(true);
  });
});
