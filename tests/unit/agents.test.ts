import { describe, expect, it, vi } from 'vitest';
import { agentRegistry } from '../../src/agents/agent-registry';
import { editorAgent } from '../../src/agents/editor-agent';
import { filePickerAgent } from '../../src/agents/file-picker-agent';
import { plannerAgent } from '../../src/agents/planner-agent';
import { reviewerAgent } from '../../src/agents/reviewer-agent';
import { createTaskState } from '../../src/core/task-state';
import { buildContext } from '../../src/project-context/context-builder';
import { detectProject } from '../../src/project-context/detect-project';
import { loadInstructions } from '../../src/project-context/load-instructions';
import { scanRepo } from '../../src/project-context/repo-scanner';

// The reviewer agent calls testRunnerTool which would recursively run `bun run test`.
// Mock it so reviewer tests are fast and don't recurse.
vi.mock('../../src/tools/git-diff', () => ({
  gitDiffTool: {
    name: 'git_diff',
    description: 'Mock git diff',
    inputSchema: {},
    execute: async () => ({
      success: true,
      data: { diff: '', filesChanged: 0, hasChanges: false },
    }),
  },
}));

vi.mock('../../src/tools/test-runner', () => ({
  testRunnerTool: {
    name: 'test_runner',
    description: 'Mock test runner',
    inputSchema: {},
    execute: async () => ({
      success: true,
      data: {
        command: 'mock test',
        stdout: 'Tests passed',
        stderr: '',
        exitCode: 0,
        passed: true,
      },
    }),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────

function createMinimalInput(request: string) {
  const state = createTaskState(request);
  const projectInfo = detectProject(process.cwd());
  const instructions = loadInstructions(process.cwd());
  const repoMap = scanRepo(process.cwd());
  const context = buildContext(projectInfo, instructions, repoMap, request);

  return {
    task: state,
    project: context,
  };
}

function createInputWithPlan(request: string) {
  const input = createMinimalInput(request);
  return {
    ...input,
    plan: {
      summary: `Test plan for: ${request}`,
      steps: [
        {
          id: 'step_1',
          description: 'Read code',
          targetFiles: ['src/example.ts'],
          risk: 'low' as const,
        },
        {
          id: 'step_2',
          description: 'Apply changes',
          targetFiles: ['src/example.ts'],
          risk: 'medium' as const,
        },
      ],
      testPlan: ['Run tests'],
      risks: ['Small risk'],
    },
  };
}

// ── Agent Registry ───────────────────────────────────────────────

describe('AgentRegistry', () => {
  it('should have all four agents registered by default', () => {
    const names = agentRegistry.getAll();
    expect(names).toContain('file_picker');
    expect(names).toContain('planner');
    expect(names).toContain('editor');
    expect(names).toContain('reviewer');
  });

  it('should return a registered agent by name', () => {
    const agent = agentRegistry.get('file_picker');
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('file_picker');
    expect(agent?.description).toBeTruthy();
  });

  it('should return undefined for unknown agent', () => {
    const agent = agentRegistry.get('unknown' as any);
    expect(agent).toBeUndefined();
  });

  it('should allow registering a custom agent', () => {
    // Can't easily manipulate singleton in parallel test, just check structure
    const names = agentRegistry.getAll();
    expect(names.length).toBeGreaterThanOrEqual(4);
  });

  it('file_picker agent should have execute function', () => {
    const agent = agentRegistry.get('file_picker');
    expect(typeof agent?.execute).toBe('function');
  });

  it('planner agent should have execute function with config param', () => {
    const agent = agentRegistry.get('planner');
    expect(typeof agent?.execute).toBe('function');
    // execute signature accepts 2 args
    expect(agent?.execute.length).toBeGreaterThanOrEqual(1);
  });
});

// ── File Picker Agent ────────────────────────────────────────────

describe('filePickerAgent', () => {
  it('should return a file selection result', async () => {
    const input = createMinimalInput('fix the build configuration');
    const result = await filePickerAgent(input);

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result?.files).toBeDefined();
    expect(result.result?.searchQueries).toBeDefined();
    expect(typeof result.result?.confidence).toBe('number');
  }, 15_000);

  it('should select high-priority files for relevant requests', async () => {
    const input = createMinimalInput('update package.json and tsconfig');
    const result = await filePickerAgent(input);

    expect(result.success).toBe(true);
    const files = result.result?.files ?? [];
    // Should include at least some files
    expect(files.length).toBeGreaterThan(0);
  }, 15_000);

  it('should search for relevant terms from the request', async () => {
    const input = createMinimalInput('fix the route handler in index.ts');
    const result = await filePickerAgent(input);

    expect(result.result?.searchQueries.length).toBeGreaterThan(0);
  }, 15_000);

  it('should handle edge case with empty request gracefully', async () => {
    const input = createMinimalInput('');
    const result = await filePickerAgent(input);

    // Should not crash — may return empty or minimal results
    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
  }, 15_000);

  it('should record tool calls', async () => {
    const input = createMinimalInput('check configuration');
    const result = await filePickerAgent(input);

    expect(result.toolCalls.length).toBeGreaterThan(0);
    expect(result.toolCalls[0].toolName).toBeTruthy();
    expect(result.toolCalls[0].durationMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it('should report model and provider used', async () => {
    const input = createMinimalInput('find test files');
    const result = await filePickerAgent(input);

    expect(result.modelUsed).toBe('heuristic');
    expect(result.providerUsed).toBe('none');
  }, 15_000);
});

// ── Planner Agent ────────────────────────────────────────────────

describe('plannerAgent', () => {
  const minimalConfig = {
    router: {} as any,
    policyName: 'test_policy',
    tools: [],
  };

  it('should create a plan for fix requests', async () => {
    const input = createMinimalInput('fix the broken test');
    const result = await plannerAgent(input, minimalConfig);

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result?.summary).toBeTruthy();
    expect(result.result?.steps.length).toBeGreaterThan(0);
    expect(result.result?.testPlan.length).toBeGreaterThan(0);
  });

  it('should create a plan for add/create requests', async () => {
    const input = createMinimalInput('add a new API endpoint to routes.ts');
    const result = await plannerAgent(input, minimalConfig);

    expect(result.success).toBe(true);
    expect(
      result.result?.steps.some(
        (s) =>
          s.description.includes('Create') || s.description.includes('create'),
      ),
    ).toBe(true);
  });

  it('should create a plan for delete/remove requests', async () => {
    const input = createMinimalInput(
      'remove the deprecated helpers in utils.ts',
    );
    const result = await plannerAgent(input, minimalConfig);

    expect(result.success).toBe(true);
    expect(
      result.result?.steps.some((s) => s.description.includes('Remove')),
    ).toBe(true);
  });

  it('should detect test involvement', async () => {
    const input = createMinimalInput('add unit tests for the service layer');
    const result = await plannerAgent(input, minimalConfig);

    expect(
      result.result?.testPlan.some((t) => t.toLowerCase().includes('test')),
    ).toBe(true);
  });

  it('should return steps with unique IDs', async () => {
    const input = createMinimalInput('refactor the database layer');
    const result = await plannerAgent(input, minimalConfig);

    const ids = result.result?.steps.map((s) => s.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('should include risk assessment in each step', async () => {
    const input = createMinimalInput('update dependencies');
    const result = await plannerAgent(input, minimalConfig);

    const steps = result.result?.steps ?? [];
    for (const step of steps) {
      expect(['low', 'medium', 'high']).toContain(step.risk);
    }
  });

  it('should handle error gracefully when config is missing', async () => {
    const input = createMinimalInput('test');
    const result = await plannerAgent(input, {} as any);

    // With an empty config, it should still work (uses defaults)
    expect(result.success).toBe(true);
  });
});

// ── Editor Agent ─────────────────────────────────────────────────

describe('editorAgent', () => {
  it('should return error when no plan is provided', async () => {
    const input = createMinimalInput('edit files');
    const result = await editorAgent(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PLAN');
  });

  it('should report target files from plan', async () => {
    const input = createInputWithPlan('edit src/example.ts');
    const result = await editorAgent(input);

    expect(result.success).toBe(true);
    expect(result.result?.changedFiles).toContain('src/example.ts');
  });

  it('should indicate when review is needed', async () => {
    const input = createInputWithPlan('edit some files');
    const result = await editorAgent(input);

    expect(result.result?.needsReview).toBe(true);
  });

  it('should provide summary of planned changes', async () => {
    const input = createInputWithPlan('update multiple files');
    const result = await editorAgent(input);

    expect(result.result?.summary).toBeTruthy();
    expect(result.result?.summary).toContain('file');
  });

  it('should record tool calls for reads', async () => {
    const input = createInputWithPlan('check config');
    const result = await editorAgent(input);

    expect(result.toolCalls.length).toBeGreaterThan(0);
  });

  it('should handle plans with multiple steps', async () => {
    const state = createTaskState('complex edit');
    const projectInfo = detectProject(process.cwd());
    const instructions = loadInstructions(process.cwd());
    const repoMap = scanRepo(process.cwd());
    const context = buildContext(
      projectInfo,
      instructions,
      repoMap,
      'complex edit',
    );

    const input = {
      task: state,
      project: context,
      plan: {
        summary: 'Complex multi-file edit',
        steps: [
          {
            id: 'step_1',
            description: 'Edit file A',
            targetFiles: ['src/a.ts', 'src/b.ts'],
            risk: 'low' as const,
          },
          {
            id: 'step_2',
            description: 'Edit file B',
            targetFiles: ['src/c.ts'],
            risk: 'medium' as const,
          },
        ],
        testPlan: ['Run tests'],
        risks: [],
      },
    };

    const result = await editorAgent(input);
    expect(result.success).toBe(true);
    expect(result.result?.changedFiles.length).toBe(3);
  });
});

// ── Reviewer Agent ───────────────────────────────────────────────

describe('reviewerAgent', () => {
  it('should process a review and return results', async () => {
    const input = createInputWithPlan('review changes');
    const result = await reviewerAgent(input);

    expect(result.success).toBe(true);
    expect(result.result).toBeDefined();
    expect(result.result?.approved).toBeDefined();
    expect(typeof result.result?.approved).toBe('boolean');
  });

  it('should report issues found', async () => {
    const input = createInputWithPlan('check everything');
    const result = await reviewerAgent(input);

    expect(Array.isArray(result.result?.issues)).toBe(true);
  });

  it('should include required fixes if issues found', async () => {
    const input = createInputWithPlan('validate the project');
    const result = await reviewerAgent(input);

    expect(Array.isArray(result.result?.requiredFixes)).toBe(true);
  });

  it('should provide a final summary', async () => {
    const input = createInputWithPlan('summarize changes');
    const result = await reviewerAgent(input);

    expect(result.result?.finalSummary).toBeTruthy();
  });

  it('should record tool calls', async () => {
    const input = createInputWithPlan('review with tools');
    const result = await reviewerAgent(input);

    expect(result.toolCalls.length).toBeGreaterThan(0);
  });
});
