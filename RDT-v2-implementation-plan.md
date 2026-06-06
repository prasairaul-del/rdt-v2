# RDT v2 — Implementation Plan

> Terminal-first AI coding agent · TypeScript + Bun · Codebuff free tier

---

## Overview

**The one rule:** Prove reliability before adding features. Core loop first. Everything else later.

**MVP command:**
```bash
rdt "fix the failing test in the fixture repo"
```

**Core agent flow:**
```
File Picker → Planner → Editor → Reviewer → Final Report
```

---

## Tech Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | Strong typing for agents, tools, state |
| Runtime | Bun | Fallback: Node + pnpm |
| CLI | `commander` or `cac` | Keep it simple |
| Storage | SQLite | No ChromaDB in MVP |
| Memory | `knowledge.md` + `AGENTS.md` | Vector memory post-MVP |
| Providers | OpenRouter → Groq → Ollama | Router with cooldown/fallback |
| Testing | Vitest + fixture repos | Unit + integration |

---

## NOT in MVP

```
❌ FastAPI bridge       ❌ Dashboard / PWA
❌ ChromaDB             ❌ LangGraph
❌ Swarm orchestration  ❌ Textual TUI
❌ Self-evolution        ❌ Background daemon
```

---

## Phase 0 — Repo Setup

**Spec:** §4, §6.2, §17 Phase 0  
**Sessions:** 1  
**Goal:** Clean TypeScript project scaffold

### Tasks
- [ ] Init package.json + tsconfig.json (strict mode)
- [ ] Configure Biome or ESLint + Prettier
- [ ] Create full `src/` directory structure from §6.2
- [ ] Add Vitest or Bun test framework
- [ ] Create README, AGENTS.md, knowledge.md
- [ ] Placeholder CLI: `rdt --help`, `rdt --version`

### Acceptance Criteria
- `bun install` works
- `bun run test` passes (zero tests is fine)
- CLI prints help/version

---

## Phase 1 — CLI + Project Detection

**Spec:** §7, §12  
**Sessions:** 2  
**Goal:** `rdt init` and `rdt status` working end-to-end

### Tasks
- [ ] Implement `rdt init` — creates AGENTS.md, knowledge.md, .rdt/config.yaml
- [ ] Implement `rdt status` — shows providers, project type, last task
- [ ] Detect package manager (npm / bun / pnpm / yarn)
- [ ] Detect test/lint commands from package.json
- [ ] Generate `.rdt/config.yaml` with defaults from §8.1
- [ ] Load and validate config schema

### Acceptance Criteria
- `rdt init` creates all required files
- `rdt status` shows correct project info

---

## Phase 2 — Tool Layer

**Spec:** §11  
**Sessions:** 2  
**Goal:** All filesystem and shell tools returning consistent `ToolResult<T>`

### Tasks
- [ ] Define `ToolResult<T>` type with all error codes (VALIDATION_ERROR, NOT_FOUND, PERMISSION_DENIED, TIMEOUT, COMMAND_FAILED, INTERNAL_ERROR)
- [ ] `list_files` — respects .gitignore, node_modules, dist
- [ ] `read_file` — size limit guard, token estimation
- [ ] `search_files` — filename regex + content grep
- [ ] `apply_patch` — unified diff format, rejects invalid patches
- [ ] `git_diff` — current working diff
- [ ] `git_status_snapshot` — baseline before first edit
- [ ] `git_restore_touched` — rollback only RDT-touched files
- [ ] `run_shell` — with timeout, blocked commands list
- [ ] `test_runner` — detects and runs test command
- [ ] `save_failed_patch` — saves failed diff to `.rdt/tasks/<id>/`

### Blocked Shell Commands (default)
```
rm -rf /    rm -rf .    del /s    format
shutdown    reboot      mkfs      curl | sh
wget | sh   sudo destructive commands
```

### Acceptance Criteria
- All tools return `ToolResult` shape
- Unit tests for `apply_patch` (valid patch, invalid patch, preserves unrelated content)
- Shell tool blocks dangerous commands and explains why

---

## Phase 3 — Provider Layer

**Spec:** §9.1–9.2  
**Sessions:** 2  
**Goal:** Provider interface, adapters, and mock provider for testing

### Tasks
- [ ] Define `Provider` interface
- [ ] Define `ProviderModelState` type (all fields from §9.2)
- [ ] Implement mock provider — deterministic responses for testing
- [ ] Implement OpenAI-compatible adapter (base class)
- [ ] OpenRouter config path with `OPENROUTER_API_KEY` env var
- [ ] Groq adapter (extends OpenAI-compatible)
- [ ] Ollama placeholder adapter
- [ ] SQLite store for provider states

### Acceptance Criteria
- Mock provider completes test tasks
- Missing API key gives readable error message
- OpenAI-compatible request path is isolated and testable

---

## Phase 4 — Provider Router

**Spec:** §9.3–9.5  
**Sessions:** 2  
**Goal:** Smart routing with fallback, cooldown, quota tracking, token budgets

### Tasks
- [ ] Implement 12-step routing algorithm from §9.3
- [ ] Cooldown state: set on 429, auto-expire
- [ ] RPM counter (requests per minute)
- [ ] Daily quota counter per provider/model
- [ ] Capability filtering (tools support, JSON mode)
- [ ] Model policies: `cheap_fast` / `smart_reasoning` / `code_strong`
- [ ] Provider state persistence in SQLite
- [ ] Token counter utility (`countTokens(text): number`)
- [ ] Per-agent context budgets from config (§9.5)
- [ ] Truncation strategy: drop low-priority → summarize large files → excerpt relevant functions
- [ ] Never truncate AGENTS.md / knowledge.md silently

### Routing Algorithm Summary
```
1. Load all enabled provider models
2. Remove models in cooldown
3. Remove models over daily limit
4. Remove models over RPM limit
5. Remove models missing required capability
6. Sort by policy preference
7. Attempt request
8. On success: save usage and return
9. On 429: set cooldown, try next
10. On transient error: retry with backoff, then fallback
11. On capability error: mark capability false if auto, fallback
12. If all fail: return honest error with provider states
```

### Acceptance Criteria
- Router skips providers in cooldown
- Unit tests: 429 → fallback → success
- Daily + minute usage tracked per provider
- All failures reported clearly in output

---

## Phase 5 — Four Agents

**Spec:** §10, §15  
**Sessions:** 3  
**Goal:** All four agents working with mock provider, correct types, enforced schemas

### Agent Base Types
```typescript
type AgentInput = {
  task: TaskState;
  project: ProjectContext;
  files?: SelectedFile[];
  plan?: Plan;
  diff?: string;
};

type AgentOutput<T> = {
  success: boolean;
  result?: T;
  error?: AgentError;
  modelUsed: string;
  providerUsed: string;
  toolCalls: ToolCallRecord[];
};
```

### File Picker Agent
- Returns `FileSelection` with per-file reasons and priority
- Prefer fewer files — never the whole repo
- Tools: `list_files`, `read_file`, `search_files`
- Model policy: `cheap_fast`
- System prompt emphasis (§15.2): select only relevant files

### Planner Agent
- Returns `Plan` with steps, risks, testPlan
- No edits — planning only
- Tools: `read_file`, `search_files`
- Model policy: `smart_reasoning`
- System prompt emphasis (§15.3): minimal plan, surgical changes, test strategy

### Editor Agent
- Returns `EditResult` with changedFiles, diff, needsReview
- `apply_patch` only — no blind full-file rewrites
- Inspect diff after every edit
- Only edits files in approved plan
- Tools: `read_file`, `apply_patch`, `git_diff`
- Model policy: `code_strong`
- System prompt emphasis (§15.4): follow plan, preserve style

### Reviewer Agent
- Returns `ReviewResult` with approved bool, issues, testsRun, requiredFixes
- Must use `smart_reasoning` minimum — hard enforced
- Runs tests, separates pre-existing failures from new ones
- Does NOT approve broken work
- Tools: `git_diff`, `run_shell`, `test_runner`, `read_file`
- System prompt emphasis (§15.5): review actual diff, don't hide failures

### Tasks
- [ ] Define `AgentInput` / `AgentOutput` base types
- [ ] Implement File Picker with `FileSelection` output schema
- [ ] Implement Planner with `Plan` output schema
- [ ] Implement Editor with `apply_patch` only, diff inspection
- [ ] Implement Reviewer with `smart_reasoning` enforcement
- [ ] System prompts for all four agents from §15
- [ ] Output schema validation — reject malformed model responses
- [ ] Agents do not call filesystem directly (tools only)

### Acceptance Criteria
- Each agent works with mock provider
- Malformed model output handled gracefully (retry or fail with explanation)
- No direct filesystem access from agents

---

## Phase 6 — Task Runner

**Spec:** §13, §14  
**Sessions:** 2  
**Goal:** Deterministic state machine connecting all agents, with rollback and task logging

### State Machine
```
CREATED
  → CAPTURING_BASELINE
  → LOADING_CONTEXT
  → SCANNING_REPO
  → SELECTING_FILES
  → PLANNING
  → EDITING
  → REVIEWING
  → FIXING (optional loop, max 3 passes)
  → FINALIZING
  → DONE

Failure path:
  → FAILED
  → ROLLING_BACK (if rollback_on_failed_task=true)
  → FAILED_CLEAN or FAILED_DIRTY
```

### Tasks
- [ ] Implement all 13 states
- [ ] Capture git baseline before first edit (HEAD, dirty files, RDT-allowed files)
- [ ] Connect File Picker → Planner → Editor → Reviewer in sequence
- [ ] Edit/review loop: max 3 passes (`max_edit_passes`)
- [ ] On max passes exceeded: stop and report honestly
- [ ] Save task log to `.rdt/tasks/<id>.json` with full trace
- [ ] Rollback: only restore RDT-touched files — never `git reset --hard`
- [ ] Save failed diff to `.rdt/tasks/<id>/failed.patch` before rollback
- [ ] Generate final report with provider usage summary (which model per agent)
- [ ] `rdt task show <id>` command for debugging

### Rollback Rules
```
- Only rollback files RDT changed during the task
- Never overwrite pre-existing user edits
- Prefer git_restore_touched over whole-repo reset
- Save failed.patch before rollback
- FAILED_CLEAN: rollback succeeded
- FAILED_DIRTY: rollback skipped/incomplete — list dirty files + recovery commands
```

### Task Log Schema
```json
{
  "id": "task_001",
  "request": "fix failing test",
  "startedAt": "...",
  "finishedAt": "...",
  "status": "success",
  "selectedFiles": [],
  "plan": {},
  "edits": [],
  "tests": [],
  "providersUsed": [],
  "finalSummary": "..."
}
```

### Acceptance Criteria
- Full fixture task passes end-to-end
- Failed tasks produce readable report with recovery steps
- Git diff included in task log
- Provider usage logged per agent step

---

## Phase 7 — Real-World Smoke Test

**Spec:** §16, §22  
**Sessions:** 1  
**Goal:** Run RDT on a real repo. Validate every item in §22.

### Tasks
- [ ] Create `tests/fixtures/ts-basic/` — simple TypeScript project
- [ ] Create `tests/fixtures/failing-test/` — project with known failing test
- [ ] Integration test: RDT fixes TypeScript bug
- [ ] Integration test: RDT does not touch ignored/generated files
- [ ] Run all unit tests
- [ ] Run `rdt init` on real repo
- [ ] Run `rdt status` — verify all green
- [ ] Run `rdt "fix the failing test in the fixture repo"`
- [ ] Inspect git diff — must be surgical
- [ ] Verify task log in `.rdt/tasks/`
- [ ] Verify provider usage in final report

### Acceptance Criteria
- No crashes or unhandled Promise rejections
- Edits are surgical — no unrelated formatting changes
- Tests/checks attempted and result logged
- Provider usage shown in output

---

## Session Breakdown (Codebuff Free Tier)

> Each session: feed only the relevant spec section. Never paste the full 32KB doc.

### Session Start Template
```
We are building RDT v2.
A terminal-first AI coding agent in TypeScript/Bun.
Continuing from last session.
Today's focus: [PHASE NAME]
Spec sections: [SECTION NUMBERS]

Here is the relevant spec:
[PASTE ONLY RELEVANT SECTION]
```

| Session | Focus | Feed Spec Sections | Deliverable |
|---|---|---|---|
| S1 | Scaffold + CLI shell | §4, §6.2 | Working project + `rdt --help` |
| S2 | `rdt init` + `rdt status` | §7.1, §7.3, §12, §8.1 | Config generated, project detected |
| S3 | File + search tools | §11.1, §11.2 (file tools only) | `list_files`, `read_file`, `search_files` + tests |
| S4 | Patch + git + shell tools | §11.2 (patch/git), §11.3, §14.4 | `apply_patch`, git tools, shell safety |
| S5 | Provider interface + mock | §9.1, §9.2 | Provider types + mock provider |
| S6 | OpenRouter + Groq + Ollama | §8.1 (providers section) | Real provider adapters |
| S7 | Provider router core | §9.3 | 12-step routing algorithm + unit tests |
| S8 | Model policies + token budget | §9.4, §9.5 | Policies, truncation, token counter |
| S9 | File Picker + Planner agents | §10.1–10.3, §15.2–15.3 | Two agents with schema validation |
| S10 | Editor + Reviewer agents | §10.4–10.5, §15.4–15.5 | Two agents, smart_reasoning enforced |
| S11 | Task runner state machine | §13, §14.4 | 13-state machine, rollback path |
| S12 | Task logs + final report | §12.3, §9.4 | `.rdt/tasks/<id>.json`, `rdt task show` |
| S13 | Integration tests | §16.1, §16.2 | Fixture repos, all unit tests passing |
| S14 | Real-world smoke test | §17 Phase 7, §22 | MVP gate fully passed |

---

## Build Checklist (§21)

```
[ ] Create clean repo structure
[ ] Add package.json
[ ] Add tsconfig.json
[ ] Add test framework
[ ] Add formatter/linter
[ ] Add CLI entrypoint
[ ] Implement rdt --help
[ ] Implement rdt init
[ ] Implement rdt status
[ ] Add config schema
[ ] Add project detector
[ ] Add repository scanner
[ ] Add ToolResult type
[ ] Implement file tools
[ ] Implement shell/test tools
[ ] Implement provider types
[ ] Implement mock provider
[ ] Implement OpenAI-compatible provider
[ ] Implement OpenRouter config path
[ ] Implement provider router
[ ] Add provider cooldown/quota tracking
[ ] Add token budget and truncation rules
[ ] Add baseline git status capture
[ ] Add rollback-on-failure path
[ ] Implement agent base contract
[ ] Implement file picker agent
[ ] Implement planner agent
[ ] Implement editor agent
[ ] Implement reviewer agent
[ ] Implement task state machine
[ ] Save task logs
[ ] Run fixture integration test
[ ] Run real smoke test
```

---

## MVP Gate (§22) — Zero Exceptions

MVP is done only when **all of these are true:**

```
✓ RDT selects relevant files
✓ RDT creates a plan
✓ RDT applies a patch
✓ RDT runs tests/checks
✓ RDT reviews the diff
✓ RDT produces a final report
✓ Task log is saved
✓ Provider usage is saved
✓ Rate limits are respected
✓ Token budgets are enforced
✓ Reviewer uses smart_reasoning minimum
✓ Failed edits rolled back or clearly reported as dirty
✓ Failures are honest and readable
```

**The three-command test:**
```bash
rdt init
rdt status
rdt "fix the failing test in the fixture repo"
```

---

## Post-MVP Roadmap (§19)

Only after MVP gate is fully passed.

| Feature | Trigger | Spec Section |
|---|---|---|
| TUI | CLI is stable and reliable | §19.2 |
| Custom agents (`.agents/`) | Need domain-specific workflows | §19.1 |
| Vector memory | `knowledge.md` becomes insufficient | §19.3 |
| Bounded swarm | Single workflow rock solid | §19.4 |

---

## Error Handling Reference

### Provider Errors to Handle
```
- missing / invalid API key
- 429 rate limit → cooldown + fallback
- model unavailable → fallback
- malformed response → retry or fail
- tool support missing → mark capability false
- JSON mode unsupported → adjust prompt
- network timeout → retry with backoff
```

### User-Facing Failure Format
```
What was attempted: ...
What failed: ...
Files changed: yes/no
How to recover: ...
Inspect with: rdt task show <id>
```

---

## One-Line Product Rule (§23)

> RDT v2 is a reliable terminal coding agent that understands a repo, edits code safely, runs checks, and explains exactly what changed.
