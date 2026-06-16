# RDT v2 — Terminal-first AI Coding Agent

RDT v2 is a **terminal-first AI coding assistant** that understands a repository, edits code safely, runs checks, and explains exactly what changed.

It coordinates four specialized agents — File Picker, Planner, Editor, and Reviewer — through a deterministic state machine with a provider router that handles fallback, cooldowns, and rate limits.

---

## Quickstart

```bash
bun install
bun run src/cli/index.ts --help
```

---

## Commands

| Command | Status | Description |
|---|---|---|
| `rdt --help` | ✅ Implemented | Shows CLI options and commands |
| `rdt --version` | ✅ Implemented | Shows application version |
| `rdt init` | ✅ Implemented | Creates `.rdt/`, `AGENTS.md`, `knowledge.md`, detects project |
| `rdt status` | ✅ Implemented | Shows project info, providers, agent policies |
| `rdt run <task>` | ✅ Implemented | Full pipeline: pick → plan → edit → review → report |
| `rdt providers` | ✅ Implemented | Shows provider configuration and cooldown state |
| `rdt dashboard` | ✅ Implemented | Launches local Web UI console and task monitor |
| `rdt explain <file>` | ✅ Implemented | Explains purpose, structure, and details of a file |
| `rdt undo <taskId>` | ✅ Implemented | Rollback / undo changes made by a task |

---

## Three-Command Test

```bash
rdt init          # Set up RDT in any repo
rdt status        # Verify project detection
rdt dashboard     # Launch the interactive Web dashboard
```

---

## Development

```bash
bun install          # Install dependencies
bun run test         # Run 255 tests across all suites
bun run typecheck    # Type-check the project
bun run lint         # Lint with Biome
bun run format       # Format with Biome
bun run build        # Build and bundle the CLI application
```

Biome linting intentionally ignores generated output and nested fixture repos
(`dist/`, `node_modules/`, `.agent-backups/`, and `tests/fixtures/`) so
`bun run lint` reports first-party source, tests, and documentation debt rather
than build artifacts or embedded sample projects.

For a comprehensive guide to codebase design, agent protocols, and task execution pipelines, see the [Contributor Guide](file:///C:/Long-run%20Project/RDT-v2/docs/contributor-guide.md).

---

## Architecture

```
User Request → File Picker → Planner → Editor → Reviewer → Final Report
                        ↓
                  Provider Router
              (fallback · cooldown · quotas)
                        ↓
                    Tool Layer
          (filesystem · shell · git · test)
```

---

### What's Built

- **7 CLI commands** — `init`, `status`, `run`, `providers`, `dashboard`, `explain`, `undo` — built with Commander.
- **Sequential Task Queue** — SQLite task queue replacing the single-task execution lock, allowing background sequencing of tasks.
- **Native Provider Adapters** — Custom adapters for Google Gemini and Anthropic Claude messages APIs.
- **Interactive Local Dashboard Web UI** — A beautiful dark/light-mode glassmorphic interface styled with custom Vanilla CSS variables. Features a dual-mode toggle switch between "Dev Mode" (displaying real-time task nodes, cost estimators, token trackers, parsed code diffs, timelines, and decision tabs) and "Vibe Mode" (providing readiness checks, deterministic plan previews, Learn Mode explanations, power recipes, command/check transparency, action templates, API key managers, and one-click Keep/Undo controls).
- **Task Console and Queue Control** — Allows triggering coding tasks directly from the dashboard UI, backed by background execution queues.
- **Context File Selector** — Includes an interactive workspace file checklist to let users manually include/exclude file contexts before launching a task.
- **User-Space Shadow Sandbox** — A lightweight, zero-install workspace sandboxing mechanism that uses NTFS junctions/symlinks to expose dependencies (like `node_modules` and `.venv`) in 0 extra bytes of storage. All edits and test runs are isolated in the sandbox, copying back only successfully approved files to the host. Parallel async file copy for fast initialization.
- **Quiet Test Logging Support** — `TaskLogger` supports an opt-in silent mode used by tests, preserving log entries and event behavior while suppressing noisy runner/tool console output.
- **VS Code Integration** — Launches the dashboard natively inside a VS Code Simple Browser pane using the `--open-vscode` flag.
- **Git Auto-Commits** — Configurable `git_auto_commit` setting that automatically stages and commits successful task edits to git.
- **Local Hybrid Context Scaling** — Uses SQLite database caches for file content hashes and terms, providing dense embeddings search (OpenAI/Ollama) with a zero-cost local TF-IDF vector similarity fallback.
- **Swarm Consensus Loop** — Editor and Reviewer cooperation loop that funnels detailed test outputs and code review issues back to the Editor.
- **Runtime Config Caching** — Config loader uses mtime-based caching to avoid re-parsing YAML on every call.
- **Zod Schema Validation** — Agent outputs are validated against Zod schemas to catch malformed LLM responses early.
- **Dashboard Performance Caching** — TTL cache for filesystem reads (readiness, files) to reduce I/O overhead.
- **SQLite Indexes** — Optimized queries with indexes on task_logs (started_at, status) and project_info (detected_at).

---

### Test Suite

**255 tests passing** across 19 unit and integration suites:

| Suite | What it covers |
|---|---|
| `unit/core.test.ts` | Results, events, logger, config |
| `unit/router.test.ts` | Cooldown, fallback, quotas, policies |
| `unit/providers.test.ts` | Provider types, mock, OpenAI-compatible, Google |
| `unit/tools.test.ts` | All tools return correct ToolResult |
| `unit/agents.test.ts` | Agent schemas, tool access enforcement |
| `unit/task-runner.test.ts` | State machine, edit loops, rollback, dates |
| `unit/cli.test.ts` | CLI option parsing and commands |
| `unit/dashboard.test.ts` | API status, readiness metadata, file listings, locks, background runs |
| `unit/sandbox.test.ts` | Sandbox cloning, edit isolation, safe cleanup |
| `unit/phase3.test.ts` | Phase 3 filesystem tools, custom instructions, async logs |
| `unit/phase4.test.ts` | Phase 4 database migrations, caching, telemetry cost/summary |
| `integration/init-flow.test.ts` | End-to-end init + status flow |
| `integration/run-flow.test.ts` | End-to-end task runner on mock projects |

---

## File Structure

```
src/
  cli/              CLI entrypoint + 7 commands (init, status, run, providers, dashboard, explain, undo)
  cli/dashboard/    Single Page App Web UI assets (HTML + Vanilla CSS/JS)
  core/             Task runner state machine, event system, logger
  agents/           4 agents (file-picker, planner, editor, reviewer)
  providers/        Mock, OpenAI-compatible, OpenRouter, Ollama
  router/           Provider routing with fallback/cooldown/quotas
  tools/            11 tools (filesystem, shell, git, test, sandbox)
  project-context/  Repo scanner, project detector, context builder, vector search
  storage/          SQLite stores for tasks, providers, projects, vector caches
  config/           Config schema, loader, defaults
  utils/            Paths, tokens, JSON, text, process helpers

tests/
  unit/             9 unit test files
  unit/utils/       test-only helpers such as createSilentTestLogger()
  integration/      2 integration test files
  fixtures/         3 fixture repos (ts-basic, failing-test, python-basic)
```

---

## License

MIT
