# Vibe Usability Wave 2 Design

## Goal

Add a junior-developer learning layer to Vibe Mode so users understand what RDT did, why each stage matters, what files changed, and what verification means. Wave 2 should make task results teach without hiding the existing Dev Mode detail.

## Research Notes

Current AI coding workflows emphasize scoped tasks, visible plans, review instructions, and explicit verification. Claude Code workflow docs frame everyday work around exploring, planning, fixing, refactoring, and testing. GitHub Copilot code review guidance emphasizes custom instructions, actionable review feedback, and checking AI output rather than blindly accepting it.

## Current System Fit

RDT already records the data needed for a useful learning view:

- task request and status
- plan summary
- selected files and changed files
- tests/checks run
- review results and final summary
- provider/token usage
- state-machine progress

Wave 2 should transform those fields into clear explanations in Vibe Mode. It should not change task execution or storage.

## Feature Slice

### 1. Learn Mode Toggle

Add a lightweight `Learn Mode` toggle inside Vibe Mode task details. It persists in `localStorage` and controls whether educational panels are shown.

Default: enabled for Vibe Mode.

### 2. Friendly State Explanation

In Vibe Mode task details, show a compact "What is happening?" card:

- current stage in plain English
- why the stage matters
- what the user should look at next

Use deterministic mappings based on existing task statuses.

### 3. Changed Files Explanation

For completed or in-progress tasks, explain selected and changed files:

- "Files RDT looked at"
- "Files RDT changed"
- one-sentence meaning for each group
- empty states that explain why a list may be empty

### 4. Checks Explanation

Show a "How RDT checked this" card:

- commands/checks run when available
- pass/fail labels
- plain-English meaning of no checks recorded

### 5. Error Explanation

When a task fails, show a beginner-friendly error card:

- root symptom from `errorMessage`
- likely next action
- reminder that failed tasks may have rollback behavior

This card must not invent root cause beyond available task data.

## Data Flow

1. User selects a task in Vibe Mode.
2. `renderTaskDetails(task)` builds the normal action summary.
3. If Learn Mode is on, deterministic helper functions render learning cards from task fields.
4. Dev Mode remains unchanged.

## UI Rules

- No LLM calls.
- No new dependencies.
- No raw log dumps in Learn Mode.
- Use short explanations and compact cards.
- Keep Keep/Undo actions visible.
- Do not expose secrets or env values.

## Tests

Because the dashboard UI is browser-only vanilla JS, Wave 2 should use the current project verification style:

- dashboard API tests remain green
- `node --check src/cli/dashboard/ui/app.js`
- full `bun run test`
- `bun run typecheck`
- `bun run build`
- live dashboard static smoke where possible

## Out Of Scope

- No task runner changes.
- No new database fields.
- No real tutorial generator.
- No code walkthrough LLM calls.
- No changes to provider routing.

## Acceptance Criteria

- Vibe task details have a Learn Mode toggle.
- Learn Mode explains current stage, files, checks, and errors when data exists.
- Toggle persists across reloads.
- Dev Mode behavior remains unchanged.
- Existing Keep/Undo actions remain accessible.
- Full tests, typecheck, build, and dashboard smoke pass or failures are explained.
