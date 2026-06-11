# Phase 1 Design: Architecture & Hardening

This phase focuses on modularizing monolithic core components and establishing a type-safe I/O contract for the agent swarm using `zod`.

## 1. Modularize `TaskRunner` (`src/core/task-runner.ts`)

Currently, `TaskRunner` is a 1000+ line monolith handling state, logging, sandbox management, and the execution of all 4 agent steps.

### Proposed Structure:
- **`src/core/runner/state-machine.ts`**: Pure state transition logic and event emission.
- **`src/core/runner/execution-context.ts`**: Sandbox, workspace, and git baseline management.
- **`src/core/runner/steps/`**: Individual step handlers (pick, plan, edit, review) extracted into focused functions.

## 2. Refactor Dashboard Monolith (`src/cli/dashboard/index.html`)

The 62KB `index.html` contains the entire SPA logic (HTML, CSS, JS).

### Proposed Structure:
- **`src/cli/dashboard/ui/`**: 
  - `styles.css`: Glassmorphic theme and layout.
  - `app.js`: Main state and SSE orchestration.
  - `components/`: Logic for TaskList, TaskNode, DiffViewer, and FileSelector.
- **`src/cli/dashboard/server.ts`**: (Refactor `dashboard.ts` command) Extract the Bun server and API routes into a dedicated service class.

## 3. Swarm Hardening with `zod`

Agents currently use loose TypeScript interfaces. We will introduce `zod` schemas to validate LLM outputs before they reach the state machine.

### Targets:
- **`FileSelectionSchema`**: Validate file paths and priority.
- **`PlanSchema`**: Ensure steps are concrete and test plans are present.
- **`EditResultSchema`**: Validate unified diff format.
- **`ReviewResultSchema`**: Strict boolean approval and issue tracking.

## 4. Architectural Improvements

- **`src/utils/`**: Create a utility directory for shared logic like JSON parsing, path normalization, and duration formatting.
- **Dependency Injection**: Refactor `TaskRunner` and `Dashboard` to accept injected dependencies (logStore, stateStore) for better unit test isolation.

---

## User Review

Please review this design. If approved, I will transition to creating the implementation plan.
