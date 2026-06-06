import { describe, it, expect, vi } from 'vitest';
import { editorAgent } from '../../src/agents/editor-agent';
import { ProviderRouter } from '../../src/router/provider-router';
import { MockProvider } from '../../src/providers/mock-provider';
import type { TaskState, ReviewResult } from '../../src/core/task-state';
import type { AgentInput } from '../../src/agents/types';
import type { RdtConfig } from '../../src/config/schema';

// Mock bun:sqlite since vitest runs in Node.js
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

vi.mock('../../src/tools/read-file', () => ({
  readFileTool: {
    name: 'read_file',
    execute: async (args: { path: string }) => ({
      success: true,
      data: `content of ${args.path}`,
    }),
  },
}));

vi.mock('../../src/tools/write-file', () => ({
  writeFileTool: {
    name: 'write_file',
    execute: async () => ({ success: true }),
  },
}));

vi.mock('../../src/tools/git-diff', () => ({
  gitDiffTool: {
    name: 'git_diff',
    execute: async () => ({
      success: true,
      data: { diff: 'mock diff', filesChanged: 1, hasChanges: true },
    }),
  },
}));

const testConfig: RdtConfig = {
  version: 1,
  project: { name: 'test-project', language: 'typescript', package_manager: 'bun', test_command: 'bun test', lint_command: '' },
  runtime: { max_agent_steps: 10, max_edit_passes: 3, require_git_repo: false, allow_shell_commands: true, allow_destructive_commands: false, rollback_on_failed_task: true, preserve_user_changes: true },
  context_budget: {
    default_max_input_tokens: 1000, reserved_output_tokens: 100, repo_map_max_tokens: 100, file_picker_max_tokens: 100,
    planner_max_tokens: 100, editor_max_tokens: 100, reviewer_max_tokens: 100, max_file_read_tokens: 100, max_total_file_tokens_per_step: 100,
    truncation_strategy: 'summarize', never_truncate: [],
  },
  providers: [
    { id: 'mock-provider', type: 'openai_compatible', base_url: 'http://mock', enabled: true, models: [{ id: 'mock-model', model: 'mock-model', tier: 'free', quality: 'high', cost: 'free', supports_tools: false, supports_json: true, context_window: 8000 }] },
  ],
  model_policies: {
    code_strong: { prefer: ['mock-provider/mock-model'], max_cost: 'low' },
  },
  agents: {},
};

describe('Swarm Consensus — Reviewer to Editor Feedback Loop', () => {
  it('should not include feedback block in Editor prompt on the first pass (no reviews)', async () => {
    const router = new ProviderRouter(testConfig);
    const mockProvider = new MockProvider('mock-provider', {
      enabled: true,
      models: [{ id: 'mock-model', model: 'mock-model', tier: 'free', quality: 'high', cost: 'free', supports_tools: false, supports_json: true, context_window: 8000 }],
    });
    let capturedMessages: any[] = [];
    mockProvider.complete = async (req) => {
      capturedMessages = req.messages;
      return {
        content: JSON.stringify({ summary: 'applied edits', edits: [] }),
        model: 'mock-model',
        provider: 'mock-provider',
      };
    };
    router.registerProvider(mockProvider);

    const taskState: TaskState = {
      id: 'task-123',
      request: 'fix the bug',
      status: 'editing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxEditPasses: 3,
      editPass: 1,
      rollbackOnFailed: true,
      errors: [],
      changedFiles: [],
      providerUsage: [],
    };

    const input: AgentInput = {
      task: taskState as any,
      plan: {
        summary: 'my plan',
        steps: [{ id: 'step_1', description: 'change file', targetFiles: ['src/index.ts'], risk: 'low' }],
        testPlan: [],
        risks: [],
      },
      project: {
        project: { name: 'test', language: 'typescript', packageManager: 'bun', testCommand: 'bun test', lintCommand: '', buildCommand: '', hasGit: false, sourceDirs: ['src'] },
        instructions: { agentsMd: null, knowledgeMd: null, readme: null },
        repoMap: { root: 'C:/mock', entries: [], totalFiles: 0, totalDirs: 0, ignoredPatterns: [] },
        request: 'fix the bug',
        truncatedFiles: [],
      },
    };

    await editorAgent(input, {
      router,
      policyName: 'code_strong',
      tools: [],
    });

    const userMessage = capturedMessages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    expect(userMessage.content).not.toContain('### FEEDBACK FROM PREVIOUS REVIEW PASS');
  });

  it('should format and inject review failures and test output into Editor prompt on subsequent passes', async () => {
    const router = new ProviderRouter(testConfig);
    const mockProvider = new MockProvider('mock-provider', {
      enabled: true,
      models: [{ id: 'mock-model', model: 'mock-model', tier: 'free', quality: 'high', cost: 'free', supports_tools: false, supports_json: true, context_window: 8000 }],
    });
    let capturedMessages: any[] = [];
    mockProvider.complete = async (req) => {
      capturedMessages = req.messages;
      return {
        content: JSON.stringify({ summary: 'applied edits', edits: [] }),
        model: 'mock-model',
        provider: 'mock-provider',
      };
    };
    router.registerProvider(mockProvider);

    // Set up previous failed review
    const failedReview: ReviewResult = {
      approved: false,
      issues: ['Function multiply is missing parameters', 'Type error at line 12'],
      requiredFixes: ['Add parameters a and b', 'Fix typecast error'],
      testsRun: [
        { command: 'bun test', passed: false, outputSummary: 'Expected 10 to equal 20' },
        { command: 'bun run typecheck', passed: true, outputSummary: 'Typecheck passed' },
      ],
      finalSummary: 'Checks failed',
    };

    const taskState: TaskState = {
      id: 'task-123',
      request: 'fix the bug',
      status: 'editing',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      maxEditPasses: 3,
      editPass: 2,
      rollbackOnFailed: true,
      errors: [],
      changedFiles: [],
      providerUsage: [],
      reviewResults: [failedReview],
    };

    const input: AgentInput = {
      task: taskState as any,
      plan: {
        summary: 'my plan',
        steps: [{ id: 'step_1', description: 'change file', targetFiles: ['src/index.ts'], risk: 'low' }],
        testPlan: [],
        risks: [],
      },
      project: {
        project: { name: 'test', language: 'typescript', packageManager: 'bun', testCommand: 'bun test', lintCommand: '', buildCommand: '', hasGit: false, sourceDirs: ['src'] },
        instructions: { agentsMd: null, knowledgeMd: null, readme: null },
        repoMap: { root: 'C:/mock', entries: [], totalFiles: 0, totalDirs: 0, ignoredPatterns: [] },
        request: 'fix the bug',
        truncatedFiles: [],
      },
    };

    await editorAgent(input, {
      router,
      policyName: 'code_strong',
      tools: [],
    });

    const userMessage = capturedMessages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();
    
    // Check that feedback structure is injected
    expect(userMessage.content).toContain('### FEEDBACK FROM PREVIOUS REVIEW PASS');
    expect(userMessage.content).toContain('Function multiply is missing parameters');
    expect(userMessage.content).toContain('Type error at line 12');
    expect(userMessage.content).toContain('Add parameters a and b');
    expect(userMessage.content).toContain('Fix typecast error');
    expect(userMessage.content).toContain('[FAIL] Command: bun test');
    expect(userMessage.content).toContain('Expected 10 to equal 20');
    expect(userMessage.content).toContain('[PASS] Command: bun run typecheck');
  });
});
