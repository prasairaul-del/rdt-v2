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
bun run test         # Run 237 tests across 11 suites
bun run typecheck    # Type-check the project
bun run lint         # Lint with Biome
bun run format       # Format with Biome
bun run build        # Build and bundle the CLI application
```

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
- **Interactive Local Dashboard Web UI** — A beautiful dark/light-mode glassmorphic interface styled with custom Vanilla CSS variables, displaying real-time task nodes, cost estimators, token trackers, and side-by-side parsed code diffs.
- **Task Console and Queue Control** — Allows triggering coding tasks directly from the dashboard UI, backed by background execution queues.
- **Context File Selector** — Includes an interactive workspace file checklist to let users manually include/exclude file contexts before launching a task.
- **User-Space Shadow Sandbox** — A lightweight, zero-install workspace sandboxing mechanism that uses NTFS junctions/symlinks to expose dependencies (like `node_modules` and `.venv`) in 0 extra bytes of storage. All edits and test runs are isolated in the sandbox, copying back only successfully approved files to the host.
- **VS Code Integration** — Launches the dashboard natively inside a VS Code Simple Browser pane using the `--open-vscode` flag.
- **Git Auto-Commits** — Configurable `git_auto_commit` setting that automatically stages and commits successful task edits to git.
- **Local Hybrid Context Scaling** — Uses SQLite database caches for file content hashes and terms, providing dense embeddings search (OpenAI/Ollama) with a zero-cost local TF-IDF vector similarity fallback.
- **Swarm Consensus Loop** — Editor and Reviewer cooperation loop that funnels detailed test outputs and code review issues back to the Editor.

---

### Test Suite

**237 tests passing** across 11 suites (~12s):

| Suite | Tests | What it covers |
|---|---|---|
| `unit/core.test.ts` | 39 | Results, events, logger, config |
| `unit/router.test.ts` | 35 | Cooldown, fallback, quotas, policies |
| `unit/providers.test.ts` | 25 | Provider types, mock, OpenAI-compatible, Google |
| `unit/tools.test.ts` | 25 | All tools return correct ToolResult |
| `unit/agents.test.ts` | 30 | Agent schemas, tool access enforcement |
| `unit/task-runner.test.ts` | 17 | State machine, edit loops, rollback, dates |
| `unit/cli.test.ts` | 19 | --help, --version, init, status, dashboard options, explain, undo |
| `unit/dashboard.test.ts` | 9 | API status, file listings, locks, background task runs |
| `unit/sandbox.test.ts` | 3 | Sandbox cloning, edit isolation, safe cleanup |
| `integration/init-flow.test.ts` | 12 | End-to-end init + status |
| `integration/run-flow.test.ts` | 23 | End-to-end run on ts-basic, failing-test, python-basic |

---

## File Structure

```
src/
  cli/              CLI entrypoint + 5 commands (init, status, run, providers, dashboard)
  cli/dashboard/    Single Page App Web UI assets (HTML + Vanilla CSS/JS)
  core/             Task runner state machine, event system, logger
  agents/           4 agents (file-picker, planner, editor, reviewer)
  providers/        Mock, OpenAI-compatible, OpenRouter, Ollama
  router/           Provider routing with fallback/cooldown/quotas
  tools/            9 tools (filesystem, shell, git, test, sandbox)
  project-context/  Repo scanner, project detector, context builder, vector search
  storage/          SQLite stores for tasks, providers, projects, vector caches
  config/           Config schema, loader, defaults
  utils/            Paths, tokens, JSON, text, process helpers

tests/
  unit/             9 unit test files
  integration/      2 integration test files
  fixtures/         3 fixture repos (ts-basic, failing-test, python-basic)
```

---

## License

MIT
