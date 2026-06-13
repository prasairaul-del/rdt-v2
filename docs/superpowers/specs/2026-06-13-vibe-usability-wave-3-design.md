# Vibe Usability Wave 3 Design

## Goal

Make Vibe Mode feel like a serious power workflow for experienced developers: fast to enter, transparent about commands and checks, and clear about task history and decisions. Wave 3 should add reusable recipes, command/check visibility, and a readable task timeline without rewriting the task runner.

## Audience Order

1. Experienced developers need speed, repeatability, and direct visibility into what RDT is doing.
2. Junior developers benefit from clearer execution traces and decision points.
3. Non-technical users still need the flow to stay understandable and not noisy.

Wave 3 should optimize for power users while keeping the existing Vibe Mode approachable.

## Current System Fit

RDT already exposes most of the data needed for a stronger power workflow:

- dashboard entry flow in `src/cli/commands/dashboard.ts`
- browser dashboard UI in `src/cli/dashboard/ui/app.js`
- task state and status data in `src/core/task-state.ts`
- task execution history through the existing task store and task details view
- current tests in `tests/unit/dashboard.test.ts`

The implementation should surface this data more clearly instead of changing task execution semantics.

## Feature Slice

### 1. Reusable Recipes

Add a small recipe system in Vibe Mode for repeatable expert workflows:

- bugfix
- feature work
- refactor
- test or verify
- review or harden

Each recipe should prefill a structured prompt with:

- a short intent
- suggested focus files or areas
- expected checks
- a reminder to keep the scope narrow

Recipes must be editable before queueing and must not auto-run.

### 2. Command and Check Transparency

Expose what RDT is about to run and what it already ran:

- show planned checks before the task starts when scripts or known commands exist
- show executed checks after the task runs
- separate command text from result status
- keep the presentation compact and deterministic

This view should make it obvious whether the task is using `test`, `typecheck`, `lint`, `build`, or a custom command path, without exposing secrets or hidden environment values.

### 3. Task Timeline

Add a readable timeline for each task in Vibe Mode:

- queued
- planning
- file selection
- editing
- review
- checks
- complete or failed

Each timeline item should show:

- the stage label
- a short plain-English description
- the most relevant timestamp or order indicator available

The timeline should help users understand where the task spent time and what happened in sequence.

### 4. Decision Visibility

Show the important decisions RDT made during a task:

- why a recipe or prompt structure was chosen
- why files were selected
- why a check was preferred or skipped
- why a review or undo step happened

Use existing task data only. If a decision is not recorded, say that it was not captured instead of inventing one.

## Data Flow

1. User opens Vibe Mode and chooses a recipe or writes a prompt.
2. UI builds a local, editable task draft with suggested checks and focus areas.
3. User queues the task through the existing API unchanged.
4. Task detail view renders the command/check history, timeline, and decision notes from stored task data.
5. Existing Keep/Undo and task status behavior remain intact.

## UI Rules

- No LLM calls.
- No new dependencies.
- No task-runner rewrite.
- No raw log dump in the default view.
- Keep recipe selection, check visibility, and timeline scannable.
- Use deterministic labels and short helper text.
- Do not expose secrets, env values, or token text.

## Error Handling

- If a recipe cannot infer checks, show "No default checks inferred" and let the user edit manually.
- If timeline data is incomplete, render only the known stages.
- If command history is missing, explain that the task store did not capture it.
- If detail rendering fails, keep the task list and queueing flow usable.

## Tests

Update dashboard coverage for:

- recipe selection fills a deterministic prompt draft
- command and check sections render planned and executed values separately
- timeline renders known task stages without crashing on partial data
- decision visibility handles missing fields safely
- existing task queue behavior remains unchanged

Keep the verification aligned with the current project style:

- `node --check src/cli/dashboard/ui/app.js`
- `bun run test`
- `bun run typecheck`
- `bun run build`

## Out Of Scope

- No task runner rewrite.
- No new dependency.
- No backend storage migration.
- No provider routing changes.
- No auto-generated agent decisions.
- No command execution sandbox redesign.

## Acceptance Criteria

- Vibe Mode offers reusable recipes for expert workflows.
- Users can see planned and executed checks separately.
- Task details show a readable timeline of the task lifecycle.
- Important task decisions are visible when data exists.
- Existing queueing, Keep, and Undo behavior remains unchanged.
- Secrets and env values are never exposed.
- Tests, typecheck, and build pass or any failure is explained.
