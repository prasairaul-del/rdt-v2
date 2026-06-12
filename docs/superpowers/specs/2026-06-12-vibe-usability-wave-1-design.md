# Vibe Usability Wave 1 Design

## Goal

Make RDT easier to start and safer to trust for non-technical vibe coders, while preserving enough detail for junior and experienced developers. Wave 1 focuses on the dashboard entry flow: task templates, project readiness, and a plain-English preview before a task is queued.

## Audience Order

1. Non-technical vibe coders need clear choices, plain language, and visible safety.
2. Junior developers need a bridge from plain language to actual checks and files.
3. Experienced developers need fast controls without losing command transparency.

Wave 1 serves all three by improving task launch confidence without changing the task runner.

## Current System Fit

RDT already has strong backend primitives:

- Local dashboard server in `src/cli/commands/dashboard.ts`.
- Vanilla dashboard UI in `src/cli/dashboard/ui/app.js`.
- Styling in `src/cli/dashboard/ui/styles.css`.
- Queue-based task execution through `POST /api/tasks`.
- Status endpoint through `GET /api/status`.
- Config endpoint through `GET /api/config`.
- File context selector through `GET /api/files`.
- Existing dashboard tests in `tests/unit/dashboard.test.ts`.

The implementation should wrap these primitives in better guidance instead of replacing them.

## Feature Slice

### 1. Readiness Checklist

Add a dashboard API route that returns a lightweight readiness object:

- project name
- detected package manager
- detected scripts for test, typecheck, lint, and build
- provider key presence as booleans only, never secret values
- project rules presence for `AGENTS.md`, `knowledge.md`, and `.rdt/config.yaml`
- readiness level: `ready`, `partial`, or `needs_setup`

The dashboard should render this in Vibe Mode as a compact checklist so users can see whether RDT is ready before running a task.

### 2. Vibe Task Templates

Add template buttons near the task input:

- Fix a bug
- Add a feature
- Improve the UI
- Production-ready check

Clicking a template fills the prompt box with a concise structured starter prompt. The user can edit it before running.

### 3. Plan Preview

Before queueing a task, Vibe Mode should show a preview panel with:

- the final prompt that will be sent
- selected focus files, if any
- expected safety steps: baseline, plan, patch, review, tests, keep or undo
- expected checks based on readiness scripts

The preview should be local and deterministic. It must not call an LLM or start the task. The user can either run the task or keep editing.

## Data Flow

1. Dashboard loads config, files, tasks, and readiness.
2. User selects a template or writes a prompt.
3. UI builds a local preview from the prompt, selected files, and readiness.
4. User confirms by clicking Run.
5. Existing `POST /api/tasks` queues the task unchanged.

## API Shape

`GET /api/readiness`

```json
{
  "projectName": "rdt-v2",
  "packageManager": "bun",
  "scripts": {
    "test": "bun run test",
    "typecheck": "bun run typecheck",
    "lint": "bun run lint",
    "build": "bun run build"
  },
  "providers": {
    "openrouter": true,
    "anthropic": false,
    "gemini": false
  },
  "rules": {
    "agents": true,
    "knowledge": true,
    "config": true
  },
  "level": "ready"
}
```

Provider values must be derived from presence only. No API key value is returned.

## UI Behavior

- In Vibe Mode, render readiness and templates on the welcome panel.
- In Dev Mode, keep the existing dense dashboard behavior.
- Template clicks should not immediately run tasks.
- Preview should appear after the user clicks a preview/run control or when the prompt has content in Vibe Mode.
- Existing queue behavior remains unchanged.

## Error Handling

- If readiness API fails, show "Readiness unavailable" and keep task entry usable.
- If `package.json` is missing or unreadable, return missing scripts instead of failing the endpoint.
- If provider keys are absent, show setup guidance without blocking local/mock workflows.

## Tests

Add or update dashboard tests for:

- `GET /api/readiness` returns booleans for provider presence and no secret values.
- readiness reports scripts from mocked config/package data where practical.
- empty task prompt validation still returns `400`.
- queued task behavior remains unchanged.

## Out Of Scope

- No task runner rewrite.
- No new provider.
- No new dependency.
- No cloud service.
- No real security scanner in Wave 1.
- No subagent runtime inside RDT in Wave 1.

## Acceptance Criteria

- Vibe Mode has template buttons.
- Vibe Mode has a readiness checklist.
- Vibe Mode shows a deterministic plain-English preview before queueing.
- Existing `POST /api/tasks` behavior remains compatible.
- Secrets are never exposed through readiness data.
- `bun run test`, `bun run typecheck`, and `bun run lint` pass or any failure is explained.
