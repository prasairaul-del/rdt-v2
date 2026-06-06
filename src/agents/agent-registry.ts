import type { AgentInput, AgentOutput, FileSelection, Plan, EditResult, ReviewResult, AgentError } from './types';
import { filePickerAgent } from './file-picker-agent';
import { plannerAgent, type PlannerAgentConfig } from './planner-agent';
import { editorAgent, type EditorAgentConfig } from './editor-agent';
import { reviewerAgent, type ReviewerAgentConfig } from './reviewer-agent';

export type AgentName = 'file_picker' | 'planner' | 'editor' | 'reviewer';

export interface AgentDefinition<I, O> {
  name: AgentName;
  description: string;
  execute: (input: I, config?: unknown) => Promise<AgentOutput<O>>;
}

export class AgentRegistry {
  private agents = new Map<AgentName, AgentDefinition<unknown, unknown>>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register({
      name: 'file_picker',
      description: 'Selects relevant files for a task based on the request and repo structure',
      execute: async (input: AgentInput, config?: unknown) => {
        const filePickerConfig = config as any;
        return filePickerAgent(input, filePickerConfig);
      },
    });

    this.register({
      name: 'planner',
      description: 'Creates a step-by-step implementation plan',
      execute: async (input: AgentInput, config?: unknown) => {
        const plannerConfig = config as PlannerAgentConfig | undefined;
        if (!plannerConfig) {
          return {
            success: false,
            error: { message: 'Planner agent requires a router configuration', code: 'MISSING_CONFIG', recoverable: true },
            modelUsed: 'none',
            providerUsed: 'none',
            toolCalls: [],
          };
        }
        return plannerAgent(input, plannerConfig);
      },
    });

    this.register({
      name: 'editor',
      description: 'Applies patches to implement the approved plan',
      execute: async (input: AgentInput, config?: unknown) => {
        const editorConfig = config as EditorAgentConfig | undefined;
        return editorAgent(input, editorConfig);
      },
    });

    this.register({
      name: 'reviewer',
      description: 'Reviews diffs, runs tests, and decides if another edit pass is needed',
      execute: async (input: AgentInput, config?: unknown) => {
        const reviewerConfig = config as ReviewerAgentConfig | undefined;
        return reviewerAgent(input, reviewerConfig);
      },
    });
  }

  register<I, O>(definition: AgentDefinition<I, O>): void {
    this.agents.set(definition.name, definition as AgentDefinition<unknown, unknown>);
  }

  get<I = unknown, O = unknown>(name: AgentName): AgentDefinition<I, O> | undefined {
    return this.agents.get(name) as AgentDefinition<I, O> | undefined;
  }

  getAll(): AgentName[] {
    return Array.from(this.agents.keys());
  }
}

// Singleton instance
export const agentRegistry = new AgentRegistry();
