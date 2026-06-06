# Project Knowledge

## Architecture
RDT v2 uses four specialized agents: File Picker, Planner, Editor, Reviewer.
Each agent receives a task context and returns a typed output schema.
Agents never touch the filesystem directly — all operations go through tools.
All provider calls go through the router (fallback, cooldown, rate limits, model policies).

## Agent Pipeline
```
User Request → File Picker (selects files)
             → Planner (creates step-by-step plan)
             → Editor (applies patches, max 3 passes)
             → Reviewer (reviews diff, runs tests, approves/requests fixes)
             → Final Report (summary + provider usage)
```

## Technology Decisions
- **TypeScript + Bun**: fast startup, good typing, easy CLI packaging
- **Commander**: CLI framework for init/status/run/providers/dashboard commands
- **SQLite**: local persistence for task logs, provider state, project metadata, and local vector indexing caches
- **Vitest**: test framework with 227 tests across 11 suites (unit + integration)
- **Biome**: formatting and linting
- **Markdown memory**: knowledge.md and AGENTS.md before vector DB
- **One task runner**: deterministic 13-state machine, no competing execution paths

## Project Detection
- **TypeScript/JavaScript**: reads `package.json` for name, scripts, dependencies
- **Python**: reads `pyproject.toml` for name, detects `[tool.pytest]` for test command
- **Package managers**: bun > pnpm > yarn > npm
- **Test commands**: JS script → Python pytest → null
- **Languages detected**: TypeScript, JavaScript, Python (with `pyproject.toml`)

## Provider Strategy
- **Mock provider**: deterministic responses for testing (all unit/integration tests)
- **OpenRouter**: free tier as default via `OPENROUTER_API_KEY`
- **Groq**: fallback via `GROQ_API_KEY`
- **Ollama**: local models at `http://localhost:11434`
- **Router**: 12-step algorithm — load → filter cooldown → filter quotas → filter capabilities → sort → attempt → fallback on 429 → retry on transient → report failures

## Model Policies
- **`cheap_fast`**: file picker, fast model, lowest cost
- **`smart_reasoning`**: planner + reviewer, stronger model, medium cost
- **`code_strong`**: editor, code-specialized model, medium cost

## Test Fixtures
- **`failing-test/`**: TypeScript + bun, `multiply.ts` uses `+` instead of `*`, 3 intentional failures
- **`ts-basic/`**: TypeScript + bun, 8 passing tests (add + greet)
- **`python-basic/`**: Python + pytest, 8 passing tests, src-layout with `pyproject.toml`

## Task Runner States (13 states)
```
CREATED → CAPTURING_BASELINE → LOADING_CONTEXT → SCANNING_REPO
→ SELECTING_FILES → PLANNING → EDITING → REVIEWING
→ FIXING (loop, max 3) → FINALIZING → DONE

Failure: → FAILED → ROLLING_BACK → FAILED_CLEAN or FAILED_DIRTY
```

## Isolated Execution & Safety
- **User-Space Shadow Sandbox**: Runs tasks inside `os.tmpdir()/rdt-sandbox-[taskId]`. Exposes workspace dependencies using NTFS directory junctions (Windows) and symbolic links (macOS/Unix) in 0 extra bytes of storage. All agent modifications and test suites run in isolation.
- **Selective Promotion**: Successfully compiled and approved edits are copied back to the host workspace on task completion. Fails leave the host repository completely pristine.
- **VS Code panel launch**: Run `rdt dashboard --open-vscode` to natively launch the dashboard inside a VS Code Simple Browser tab.
- **Git Auto-Commits**: Staging (`git add`) and committing (`git commit`) edits on successful completion via `git_auto_commit` setting.

## Local Hybrid Context Scaling
- **Vector Search Cache**: Content hashes and term counts are stored in `.rdt/vector-cache.db` to prevent re-indexing unmodified files.
- **TF-IDF Fallback**: Local keyword matching algorithm automatically acts as a zero-cost offline fallback if dense embeddings (OpenAI/Ollama) are not configured.

## Current Status
- **227 tests passing** across 11 suites.
- **All 5 CLI commands** implemented (init, status, run, providers, dashboard).
- **Interactive Web UI Dashboard** completed with state transitions, token trackers, cost estimators, file context selection checklist, and parsed diff formatting.
- **Process Redirection Sandbox** implemented and verified.
- **Git auto-commits** and **VS Code integration** supported.
