# AGENTS.md

## Project Overview
RDT v2 is a terminal-first AI coding assistant.
It coordinates specialized agents to understand a repo, plan changes, apply patches, and verify results.

The MVP command is:
```bash
rdt "fix the failing test in the fixture repo"
```

## Setup Commands
- Install: `bun install`
- Run tests: `bun run test` (255 tests across 19 suites)
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`
- Build: `bun run build`
- Run: `bun run src/cli/index.ts`
- Web Dashboard: `bun run src/cli/index.ts dashboard`

## Code Style
- TypeScript strict mode always on
- Use Result types, not exceptions, for agent outputs
- Agents must not access the filesystem directly — use tools only
- Every tool must return `ToolResult<T>`
- Prefer patches over full-file rewrites
- Use Zod schemas for runtime validation of agent outputs

## Important Files
- `docs/contributor-guide.md` — Comprehensive architecture and execution guide
- `src/cli/index.ts` — CLI entrypoint with 7 commands (init, status, run, providers, dashboard, explain, undo)
- `src/cli/commands/dashboard.ts` — CLI Command action and API endpoints (GET status, files, POST tasks)
- `src/cli/dashboard/index.html` — Glassmorphic SPA Dashboard Frontend
- `src/core/task-runner.ts` — 13-state deterministic task state machine with Sandbox CWD redirection
- `src/core/task-state.ts` — TaskState and state transition definitions (emits events on fatal transitions)
- `src/core/errors.ts` — StateTransitionError for invalid state transitions
- `src/agents/` — four core agents (file-picker, planner, editor, reviewer)
- `src/agents/types.ts` — AgentInput/AgentOutput base contracts (re-exports canonical types from core)
- `src/agents/schemas.ts` — Zod validation schemas for agent outputs
- `src/tools/` — 11 tools returning ToolResult<T> (filesystem, shell, git, test, sandbox)
- `src/tools/sandbox.ts` — User-space shadow workspace with parallel async file copy
- `src/tools/types.ts` — ToolResult<T> type with typed error codes
- `src/providers/` — Provider interface + 4 adapters (mock, OpenAI-compatible, OpenRouter, Ollama)
- `src/router/provider-router.ts` — 12-step routing with fallback, cooldown, quotas
- `src/router/model-policy.ts` — cheap_fast / smart_reasoning / code_strong policies
- `src/project-context/detect-project.ts` — Language, package manager, command detection
- `src/project-context/command-detector.ts` — Test/lint/build command detection (JS + Python)
- `src/project-context/vector-search.ts` — Local Hybrid Search (Dense embeddings + offline TF-IDF fallback)
- `src/storage/` — SQLite stores with indexes for task logs, provider states, projects, and vector caches
- `src/config/load-config.ts` — Config loader with mtime-based caching
- `.rdt/config.yaml` — Runtime configuration with agent budgets, provider settings, and git auto-commit

## Test Fixtures
- `tests/fixtures/ts-basic/` — TypeScript project with bun/vitest (8 passing tests)
- `tests/fixtures/failing-test/` — TypeScript project with 3 failing tests (multiply uses + instead of *)
- `tests/fixtures/python-basic/` — Python project with pytest (8 passing tests, src-layout)

## Agent Rules
- Do not rewrite large files unnecessarily
- Run tests before claiming success
- Preserve existing code style
- Apply patches, not full-file overwrites
- Always inspect git diff after edits
- Each agent uses only its approved tool list from config
- Validate agent outputs with Zod schemas when available
