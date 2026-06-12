# Task 3: TaskRunner Decomposition - Core Plan

Extract the monolithic state machine and execution context from `src/core/task-runner.ts`.

## Context
`TaskRunner` is currently a monolithic class that handles everything from state transitions to gathering project context and orchestrating agents. This makes it hard to test and maintain.

## Goal
Decompose `TaskRunner` into smaller, focused components: `StateMachine` and `ExecutionContext`.

## Tasks

### 1. Research & Analysis
- [x] Read `src/core/task-runner.ts` to identify candidates for extraction.
- [ ] Read `src/core/task-state.ts` to understand existing state logic.

### 2. Extract State Machine
- [ ] Create `src/core/runner/state-machine.ts`.
- [ ] Implement `StateMachine` class to handle:
    - `executeStep` logic (with cancellation check).
    - Event emission for state changes.
    - Error handling for steps.
- [ ] Move `TaskStatus` flow enforcement logic if necessary.

### 3. Extract Execution Context
- [ ] Create `src/core/runner/execution-context.ts`.
- [ ] Implement `ExecutionContext` class/functions to handle:
    - Loading project config, instructions, and info.
    - Scanning the repository.
    - Initializing and using Vector Search.
    - Building the project context used by agents (`buildContext`).
    - Managing sandbox paths.

### 4. Refactor TaskRunner
- [ ] Update `TaskRunner` to use `StateMachine` and `ExecutionContext`.
- [ ] Simplify `TaskRunner` methods by delegating to the new components.
- [ ] Ensure public API of `TaskRunner` is preserved.

### 5. Verification
- [ ] Run `bun run test` to ensure no regressions.
- [ ] Verify `TaskStatus` flow is still strictly enforced.

## Verification
- `bun run test` (237 tests should pass).
