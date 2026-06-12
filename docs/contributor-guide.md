# RDT-v2 Contributor Guide

Welcome to the **RDT v2** Contributor Guide! RDT v2 is a terminal-first AI coding assistant that coordinates specialized agents to understand repositories, plan resolutions, apply patches, and verify results.

This guide details the codebase architecture, key data structures, agent contracts, and the core 13+ state machine execution pipeline.

---

## 1. Codebase Architecture

The codebase is organized into modular layers separating CLI concerns, core state orchestration, specialized agents, provider adapters, local tools, context generation, and storage.

```
src/
├── agents/             # Core agents: file-picker, planner, editor, reviewer
├── cli/                # CLI entry points, dashboard server, and frontend SPA
├── config/             # YAML parsing and config validation schema
├── core/               # Main runner, logging, and state machine transitions
├── project-context/    # Context builders, command detector, and vector search
├── providers/          # Adapter interfaces for OpenAI, Anthropic, OpenRouter, Ollama
├── router/             # Policy routing, model matching, cooldowns, and retries
├── storage/            # SQLite-backed storage for logs, vectors, and provider states
└── tools/              # Filesystem, shell, git, sandbox, and test-runner tools
```

---

## 2. Core Agent Contracts

All agents communicate using strictly typed inputs, outputs, and tool responses. This design ensures predictability, error recovery, and ease of testing.

### AgentInput
Passed to agents to provide context about the task, repository, plan, and current files:

```typescript
export interface AgentInput {
  task: TaskState;
  project: TaskContext;
  files?: SelectedFile[];
  plan?: Plan;
  diff?: string;
}
```

### AgentOutput
Returned by agents upon completion of their execution step:

```typescript
export interface AgentOutput<T = unknown> {
  success: boolean;
  result?: T;
  error?: AgentError;
  modelUsed: string;
  providerUsed: string;
  toolCalls: ToolCallRecord[];
}
```

### ToolResult & ToolError
Agents must not access the filesystem or shell directly. Instead, they interact via tools that return a `ToolResult`:

```typescript
export type ToolErrorType =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'COMMAND_FAILED'
  | 'INTERNAL_ERROR';

export interface ToolError {
  type: ToolErrorType;
  message: string;
  suggestions?: string[];
}

export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: ToolError;
}
```

---

## 3. The 13+ State Machine Execution Pipeline

The core task execution in `TaskRunner` is modeled as a deterministic state machine managed by `StateMachine` in `src/core/runner/state-machine.ts`.

### State Diagram

```mermaid
stateDiagram-v2
    [*] --> created : Task Initialized
    created --> capturing_baseline : Start Run
    capturing_baseline --> loading_context : Baseline Captured
    loading_context --> scanning_repo : Setup Sandbox/Git Branch
    scanning_repo --> selecting_files : Repo Map Ready
    selecting_files --> planning : Files Selected
    planning --> editing : Plan Prepared
    editing --> reviewing : Patch Applied
    
    reviewing --> finalizing : Review Approved
    reviewing --> fixing : Review Rejected
    
    fixing --> planning : Re-plan (Edit Pass < Max)
    fixing --> rolling_back : Max Edit Passes Reached
    
    finalizing --> done : Changes Saved & Merged
    
    rolling_back --> failed_clean : Rollback Successful
    rolling_back --> failed_dirty : Rollback Failed
    
    done --> [*]
    failed_clean --> [*]
    failed_dirty --> [*]
```

### State Breakdown

1. **`created`**: The initial state when a task request is accepted.
2. **`capturing_baseline`**: Computes the baseline hash of the repo and checks for dirty (uncommitted) files.
3. **`loading_context`**: Loads instructions (e.g., custom `.rdt/config.yaml` or user-defined guidelines).
4. **`scanning_repo`**: Walk the repository workspace, respecting ignore patterns, to build an in-memory `RepoMap`.
5. **`selecting_files`**: Uses vector similarity searches and keywords to rank and select files. Runs an LLM fallback if heuristic confidence is low.
6. **`planning`**: Formulates a structured list of edit steps, risks, and verification paths.
7. **`editing`**: Applies target edits using patches.
8. **`reviewing`**: Runs typechecks, linters, and verification test suites on the changes.
9. **`fixing`**: Increments edit pass count and triggers re-planning if the review detects issues.
10. **`finalizing`**: Merges changes from the sandbox back to the host workspace, updates logs, and commits.
11. **`rolling_back`**: Restores the workspace to the baseline if the task fails or is aborted.
12. **`failed_clean`**: Terminal failure state where the workspace was successfully restored to its original state.
13. **`failed_dirty`**: Terminal failure state where the workspace was left in an uncommitted/dirty state because rollback failed.

---

## 4. Key Execution Features

- **User-space Sandboxing**: Executions are performed inside a shadow workspace (sandbox CWD redirection) to prevent destructive side-effects on host files.
- **Copy-on-Write / Junctions**: Sandbox uses NTFS directory junctions and Copy-on-Write file copies for subsecond initialization.
- **Provider Policy Routing**: Adapts to rate limits, cooldowns, and fallbacks transparently.
