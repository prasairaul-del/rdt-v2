# Rahul Dev Tools v2 — Complete Project Documentation

## 0. Purpose of This Document

This document is the source of truth for the clean rebuild of **Rahul Dev Tools v2**, shortened as **RDT v2**.

The agent working on this project must read this document before writing code. The goal is to avoid repeating the mistakes of the old RDT project: too many subsystems too early, too much architecture before proven reliability, and complex swarm/memory/dashboard features before the core coding loop worked consistently.

RDT v2 must start small, terminal-first, reliable, testable, and easy to reason about.

---

## 1. Final Verdict and Direction

We are starting over clean.

The previous RDT architecture had strong ambition but became too wide too early. It included CLI, TUI, FastAPI bridge, PWA dashboard, ChromaDB RAG, memory, skills, swarm orchestration, self-evolution, LangGraph, many tools, feature flags, and multiple execution paths.

That is not the right foundation for the rebuild.

The new version must focus on one proven flow:

```text
User asks coding task
  -> understand repository
  -> choose relevant files
  -> create plan
  -> edit files
  -> run checks/tests
  -> review diff
  -> explain result
```

Everything else is secondary.

---

## 2. Product Vision

RDT v2 is a **terminal-first AI coding assistant** inspired by the workflow philosophy of Codebuff.

It should feel like a practical local developer agent that can work inside a real codebase, understand files, make surgical edits, run tests, and explain what changed.

The key idea is not to build one giant agent. The key idea is to coordinate a few specialized agents that each do one job well.

Primary user experience:

```bash
rdt "fix the login bug"
rdt "add tests for the auth middleware"
rdt "refactor this module without changing behavior"
rdt "explain why pytest is failing and fix it"
```

RDT v2 should behave like a focused coding teammate, not a general chatbot with tools attached.

---

## 3. Non-Negotiable Build Principles

### 3.1 Build the core before the ecosystem

Do not start with dashboard, swarm, advanced memory, vector DB, self-evolution, or browser UI.

The first working version must only prove that RDT can safely modify a repository from the terminal.

### 3.2 Terminal first

The CLI is the product. Everything else comes later.

No web dashboard in MVP.
No FastAPI bridge in MVP.
No PWA in MVP.
No TUI until the core loop is stable.

### 3.3 Provider routing is resilience, not abuse

The project may support OpenRouter and other free-tier inference providers, but it must respect provider rate limits and terms.

Do not build anything that tries to bypass limits using multiple fake accounts, key farming, hidden rotation, or quota abuse.

Allowed:

```text
- use the user’s legitimate API keys
- track rate limits
- cooldown providers after 429 errors
- fallback to another compatible provider
- prefer local models when possible
- use cheap/free models for low-risk steps
- use stronger models for planning/editing when needed
```

Not allowed:

```text
- evade provider limits
- retry endlessly after rate limits
- hide quota failures from the user
- assume free models are reliable enough for production work
```

### 3.4 One path through the system

Do not create three competing execution engines.

Old RDT had too many paths: legacy loop, middleware pipeline, LangGraph, swarm. RDT v2 must have one clear task runner.

### 3.5 Every agent step must be inspectable

The system must log:

```text
- task id
- user request
- selected files
- agent chosen
- model/provider used
- prompt summary
- tool calls
- files edited
- tests run
- final result
- errors and fallbacks
```

A failed task must be debuggable after the fact.

### 3.6 Done means verified

A task is not done because code was generated.

A task is done only when:

```text
1. the stated goal is addressed
2. the plan was followed or deviations were explained
3. edits are visible in git diff
4. tests/checks were run when available
5. failures are reported honestly
6. the final response summarizes exact changes
```

---

## 4. Recommended Technical Stack

### 4.1 Language

Recommended: **TypeScript**

Reason:

```text
- strong typing for agents, tools, provider adapters, and workflow state
- good fit for CLI tools
- easy config and plugin structure
- aligns well with Codebuff-style custom agents
- easier packaging for terminal usage than a complex Python app
```

### 4.2 Runtime

Recommended: **Bun**

Alternative: Node.js with pnpm

Use Bun only if the agent can keep the project simple and stable. If package compatibility becomes an issue, switch to Node.js + pnpm.

### 4.3 CLI Framework

Recommended options:

```text
- commander
- cac
- clipanion
```

Keep it simple. Do not over-engineer the CLI.

### 4.4 Storage

Use **SQLite** for local task logs, provider status, project metadata, and history.

Do not start with ChromaDB.
Do not start with vector memory.

### 4.5 Project Memory

Use markdown files first:

```text
knowledge.md
AGENTS.md
.rdt/tasks/*.json
.rdt/summaries/*.md
```

Vector memory can come later after the system proves the simple workflow.

---

## 5. MVP Scope

The MVP is one reliable command:

```bash
rdt "<coding task>"
```

The MVP must support this workflow:

```text
1. Load project instructions
2. Scan repository tree
3. Build compact project context
4. Pick relevant files
5. Plan the change
6. Apply edits
7. Run tests/checks if available
8. Review git diff
9. Produce final report
```

MVP must include:

```text
- CLI entrypoint
- provider abstraction
- provider router with fallback/cooldown
- basic file tools
- shell/test runner tool
- edit tool
- file picker agent
- planner agent
- editor agent
- reviewer agent
- task state logging
- AGENTS.md support
- knowledge.md support
```

MVP must not include:

```text
- dashboard
- FastAPI bridge
- PWA
- Textual TUI
- ChromaDB
- LangGraph
- self-evolution
- autonomous background daemon
- parallel swarm
- remote code execution service
- plugin marketplace
```

---

## 6. Core Architecture

### 6.1 High-Level Flow

```text
User CLI Request
  |
  v
Command Parser
  |
  v
Task Runner
  |
  +--> Instruction Loader
  |      - AGENTS.md
  |      - knowledge.md
  |      - package metadata
  |
  +--> Repository Scanner
  |      - file tree
  |      - package files
  |      - test commands
  |      - ignored files
  |
  +--> File Picker Agent
  |      - selects likely relevant files
  |
  +--> Planner Agent
  |      - creates step-by-step plan
  |
  +--> Editor Agent
  |      - reads files
  |      - applies patches
  |
  +--> Reviewer Agent
  |      - checks diff
  |      - runs tests
  |      - decides if another edit pass is needed
  |
  v
Final Report
```

### 6.2 Package Structure

```text
rdt-v2/
  package.json
  tsconfig.json
  README.md
  AGENTS.md
  knowledge.md

  src/
    cli/
      index.ts
      commands/
        run.ts
        init.ts
        status.ts
        providers.ts

    core/
      task-runner.ts
      task-state.ts
      events.ts
      errors.ts
      logger.ts
      result.ts

    agents/
      types.ts
      file-picker-agent.ts
      planner-agent.ts
      editor-agent.ts
      reviewer-agent.ts
      agent-registry.ts

    providers/
      types.ts
      openrouter-provider.ts
      openai-compatible-provider.ts
      ollama-provider.ts
      mock-provider.ts

    router/
      provider-router.ts
      rate-limit-state.ts
      cooldown.ts
      model-policy.ts
      retry-policy.ts

    tools/
      types.ts
      list-files.ts
      read-file.ts
      write-file.ts
      apply-patch.ts
      search-files.ts
      run-shell.ts
      git-diff.ts
      test-runner.ts

    project-context/
      load-instructions.ts
      repo-scanner.ts
      repo-map.ts
      detect-project.ts
      command-detector.ts
      context-builder.ts

    storage/
      sqlite.ts
      task-log-store.ts
      provider-state-store.ts
      project-store.ts

    config/
      load-config.ts
      schema.ts
      defaults.ts

    utils/
      paths.ts
      tokens.ts
      json.ts
      text.ts
      process.ts

  tests/
    unit/
    integration/
    fixtures/

  .rdt/
    config.yaml
    tasks/
    cache/
    logs/
```

---

## 7. Commands

### 7.1 `rdt init`

Creates project-specific RDT files.

```bash
rdt init
```

Expected output files:

```text
AGENTS.md
knowledge.md
.rdt/config.yaml
.rdt/tasks/
.rdt/logs/
```

`rdt init` should inspect the repo and generate an initial project summary.

It should detect:

```text
- package manager
- language/framework
- test commands
- lint commands
- source directories
- ignored directories
- existing README instructions
```

### 7.2 `rdt "task"`

Runs the main coding workflow.

Example:

```bash
rdt "fix failing pytest test in tests/test_auth.py"
```

### 7.3 `rdt status`

Shows system health.

Must show:

```text
- configured providers
- available API keys
- recent rate limit status
- current project type
- detected test command
- last task result
```

### 7.4 `rdt providers`

Shows provider configuration and current cooldown state.

### 7.5 `rdt task show <id>`

Shows full saved task trace.

This is important for debugging.

---

## 8. Configuration

### 8.1 `.rdt/config.yaml`

Example:

```yaml
version: 1

project:
  name: auto
  language: auto
  package_manager: auto
  test_command: auto
  lint_command: auto

runtime:
  max_agent_steps: 20
  max_edit_passes: 3
  require_git_repo: true
  allow_shell_commands: true
  allow_destructive_commands: false
  rollback_on_failed_task: true
  preserve_user_changes: true

context_budget:
  default_max_input_tokens: 32000
  reserved_output_tokens: 4000
  repo_map_max_tokens: 6000
  file_picker_max_tokens: 12000
  planner_max_tokens: 20000
  editor_max_tokens: 28000
  reviewer_max_tokens: 28000
  max_file_read_tokens: 8000
  max_total_file_tokens_per_step: 18000
  truncation_strategy: summarize_then_select
  never_truncate:
    - AGENTS.md
    - knowledge.md
    - .rdt/config.yaml

providers:
  - id: openrouter
    type: openai_compatible
    base_url: https://openrouter.ai/api/v1
    api_key_env: OPENROUTER_API_KEY
    enabled: true
    models:
      - id: openrouter/free
        model: openrouter/free
        tier: free
        quality: low
        cost: free
        rpm_limit: 20
        daily_limit: 50
        supports_tools: auto
        supports_json: auto
        context_window: auto

  - id: groq
    type: openai_compatible
    base_url: https://api.groq.com/openai/v1
    api_key_env: GROQ_API_KEY
    enabled: false
    models: []

  - id: ollama
    type: ollama
    base_url: http://localhost:11434
    enabled: false
    models: []

model_policies:
  cheap_fast:
    prefer:
      - openrouter/free
      - local/small
    max_cost: low

  smart_reasoning:
    prefer:
      - paid/strong
      - openrouter/free
      - local/medium
    max_cost: medium

  code_strong:
    prefer:
      - paid/code
      - openrouter/free
      - local/code
    max_cost: medium

agents:
  file_picker:
    model_policy: cheap_fast
    tools:
      - list_files
      - read_file
      - search_files

  planner:
    model_policy: smart_reasoning
    tools:
      - read_file
      - search_files

  editor:
    model_policy: code_strong
    tools:
      - read_file
      - apply_patch
      - git_diff

  reviewer:
    model_policy: smart_reasoning
    tools:
      - read_file
      - git_diff
      - run_shell
      - test_runner
      - git_status_snapshot
```

---

## 9. Provider Router

### 9.1 Purpose

The provider router decides which model/provider should handle each agent step.

It must support:

```text
- provider fallback
- retry on transient errors
- cooldown after rate limits
- daily quota tracking
- RPM tracking
- capability filtering
- model policy selection
- honest failure reporting
```

### 9.2 Provider State

Each provider/model must track:

```ts
type ProviderModelState = {
  providerId: string;
  modelId: string;
  enabled: boolean;
  rpmLimit?: number;
  dailyLimit?: number;
  requestsThisMinute: number;
  requestsToday: number;
  lastRequestAt?: string;
  lastErrorAt?: string;
  lastErrorCode?: string;
  cooldownUntil?: string;
  supportsTools: boolean | 'auto';
  supportsJson: boolean | 'auto';
  contextWindow?: number | 'auto';
  quality: 'low' | 'medium' | 'high';
  cost: 'free' | 'low' | 'medium' | 'high';
};
```

### 9.3 Routing Algorithm

```text
Input: model policy + request requirements

1. Load all enabled provider models
2. Remove models in cooldown
3. Remove models over daily limit
4. Remove models over RPM limit
5. Remove models missing required capability
6. Sort by policy preference
7. Attempt request
8. On success: save usage and return
9. On 429: set cooldown, save error, try next compatible model
10. On transient network error: retry with backoff, then fallback
11. On model capability error: mark capability false if auto, fallback
12. If all fail: return honest error with provider states
```

### 9.4 Important Rule

The router must not silently burn through free quotas.

Every task report should include provider usage summary:

```text
Models used:
- file_picker: openrouter/free
- planner: openrouter/free
- editor: groq/...
- reviewer: smart_reasoning/provider-name

Provider issues:
- openrouter/free cooldown after 429 until 18:25
```

### 9.5 Token Budget and Context Truncation

Large repositories must never be blindly pushed into an agent prompt.

Every model call must receive an explicit context budget from `.rdt/config.yaml`.

Required rules:

```text
- Count or estimate tokens before every model call.
- Reserve output tokens before building input context.
- Never exceed the selected model context window.
- Prefer summaries over raw full files when context is tight.
- Prefer relevant file excerpts over entire files.
- Never truncate AGENTS.md, knowledge.md, or .rdt/config.yaml silently.
- If a required file is too large, summarize sections and tell the agent what was omitted.
- If the task cannot fit safely, stop and ask for narrower scope instead of guessing.
```

Agent-specific budget intent:

```text
file_picker:
  Needs repo map, file names, package metadata, and task wording.
  Should not receive full source files unless search results require snippets.

planner:
  Needs selected file summaries, relevant snippets, AGENTS.md, knowledge.md, and test command.

editor:
  Needs the approved plan and only the specific files or excerpts it will modify.

reviewer:
  Needs git diff, changed file snippets, test output summary, and plan. It must use smart_reasoning minimum.
```

If budget is exceeded:

```text
1. Drop low-priority repo map sections.
2. Replace large files with summaries.
3. Include only relevant functions/classes from selected files.
4. Preserve exact diff and test output for reviewer.
5. Fail safely if still too large.
```

---

## 10. Agents

### 10.1 Agent Contract

Each agent must follow this shape:

```ts
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

Agents must not directly access the filesystem. They must use tools.

### 10.2 File Picker Agent

Purpose:

```text
Select the smallest useful set of files for the task.
```

Inputs:

```text
- user request
- repo tree
- package metadata
- AGENTS.md
- knowledge.md summary
```

Outputs:

```ts
type FileSelection = {
  files: Array<{
    path: string;
    reason: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  searchQueries: string[];
  confidence: number;
};
```

Rules:

```text
- prefer fewer files
- explain why each file matters
- do not include huge/generated files
- include tests when relevant
- include config files when task concerns tooling/build/test
```

### 10.3 Planner Agent

Purpose:

```text
Create a clear, minimal implementation plan before edits.
```

Outputs:

```ts
type Plan = {
  summary: string;
  steps: Array<{
    id: string;
    description: string;
    targetFiles: string[];
    risk: 'low' | 'medium' | 'high';
  }>;
  testPlan: string[];
  risks: string[];
};
```

Rules:

```text
- no vague plans
- no huge rewrites unless explicitly required
- prefer surgical changes
- include test/check strategy
- identify risks before editing
```

### 10.4 Editor Agent

Purpose:

```text
Apply the plan using safe patches.
```

Tools:

```text
- read_file
- apply_patch
- git_diff
```

Rules:

```text
- edit only files in the approved plan unless it explains why
- use patches, not blind full-file rewrites
- preserve existing style
- avoid unrelated formatting changes
- after editing, always inspect diff
```

Outputs:

```ts
type EditResult = {
  changedFiles: string[];
  summary: string;
  diff: string;
  needsReview: boolean;
};
```

### 10.5 Reviewer Agent

Purpose:

```text
Review the diff, run checks, and decide whether another edit pass is needed.
```

Tools:

```text
- git_diff
- run_shell
- test_runner
- read_file
```

Outputs:

```ts
type ReviewResult = {
  approved: boolean;
  issues: string[];
  testsRun: Array<{
    command: string;
    passed: boolean;
    outputSummary: string;
  }>;
  requiredFixes: string[];
  finalSummary: string;
};
```

Rules:

```text
- do not approve if tests clearly fail from the edit
- report unrelated pre-existing failures separately
- do not hide failures
- if another edit pass is needed, provide exact fix instructions
```

---

## 11. Tool System

### 11.1 Tool Contract

All tools return a consistent result.

```ts
type ToolResult<T> = {
  success: boolean;
  data?: T;
  error?: {
    type:
      | 'VALIDATION_ERROR'
      | 'NOT_FOUND'
      | 'PERMISSION_DENIED'
      | 'TIMEOUT'
      | 'COMMAND_FAILED'
      | 'INTERNAL_ERROR';
    message: string;
    suggestions?: string[];
  };
};
```

### 11.2 Required MVP Tools

```text
list_files
  Lists project files while respecting ignore rules.

read_file
  Reads a file safely with size limits.

search_files
  Searches filenames and optionally contents.

apply_patch
  Applies unified diffs or structured patches.

write_file
  Only allowed for new files or explicitly approved full rewrites.

git_diff
  Shows current diff.

git_restore
  Restores only RDT-touched paths during rollback when a task fails and rollback_on_failed_task is enabled.

run_shell
  Runs safe shell commands with timeout.

test_runner
  Runs detected test/lint/typecheck command.
```

### 11.3 Shell Safety Rules

Blocked commands by default:

```text
rm -rf /
rm -rf .
del /s
format
shutdown
reboot
mkfs
curl | sh
wget | sh
sudo destructive commands
```

Risky commands require explicit user confirmation later:

```text
package install
migration apply
database delete/drop
force push
git reset --hard
git clean -fd
```

For MVP, do not implement interactive confirmation unless needed. Instead, block risky commands and explain why.

---

## 12. Project Context System

### 12.1 `AGENTS.md`

Purpose:

```text
Instructions for AI coding agents working in this repo.
```

RDT must read `AGENTS.md` before task execution.

Generated example:

```md
# AGENTS.md

## Project Overview
This repository contains ...

## Setup Commands
- Install dependencies: ...
- Run tests: ...
- Run lint: ...

## Code Style
- ...

## Important Files
- ...

## Agent Rules
- Do not rewrite large files unnecessarily.
- Run tests before claiming success.
- Preserve existing style.
```

### 12.2 `knowledge.md`

Purpose:

```text
Human-readable project memory.
```

Use it for stable project facts, not temporary task logs.

Example:

```md
# Project Knowledge

## Architecture
...

## Known Issues
...

## Decisions
- We use TypeScript and Bun.
- Provider routing respects rate limits.

## Avoid
- Do not add dashboard before MVP is stable.
```

### 12.3 `.rdt/tasks/<task-id>.json`

Stores complete task trace.

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

---

## 13. Task Runner State Machine

The task runner should be deterministic and easy to test.

```text
CREATED
  -> CAPTURING_BASELINE
  -> LOADING_CONTEXT
  -> SCANNING_REPO
  -> SELECTING_FILES
  -> PLANNING
  -> EDITING
  -> REVIEWING
  -> FIXING optional loop
  -> FINALIZING
  -> DONE

Failure path:

CREATED / any active state
  -> FAILED
  -> ROLLING_BACK if rollback_on_failed_task=true
  -> FAILED_CLEAN or FAILED_DIRTY
```

Maximum edit/review loop:

```text
max_edit_passes = 3
```

If still failing after 3 passes, stop and report honestly.

---

## 14. Error Handling

### 14.1 Provider Errors

Handle:

```text
- missing API key
- invalid API key
- 429 rate limit
- model unavailable
- malformed response
- tool support missing
- JSON mode unsupported
- network timeout
```

Do not crash the whole task if another provider can continue.

### 14.2 Tool Errors

Tool errors must be shown to the agent with suggestions.

Example:

```json
{
  "success": false,
  "error": {
    "type": "NOT_FOUND",
    "message": "File src/auth.ts does not exist",
    "suggestions": ["Search for auth-related files", "Refresh repo map"]
  }
}
```

### 14.3 User-Facing Failures

If the task fails, final output should say:

```text
- what was attempted
- what failed
- whether files were changed
- how to recover
- exact command/log to inspect
```

---

### 14.4 Rollback and Dirty State Strategy

RDT must never leave the repository dirty by accident after a failed task.

Before the first edit, Task Runner must capture a baseline:

```text
- git status --porcelain
- current HEAD commit
- list of existing dirty files
- list of files RDT is allowed to modify
```

Rollback rules:

```text
- Only rollback files that RDT changed during the task.
- Never overwrite user changes that existed before the task began.
- If a file had pre-existing user edits, mark it protected unless the user explicitly allowed editing it.
- On FAILED after max edit passes, run rollback if rollback_on_failed_task=true.
- Prefer targeted restore of RDT-touched paths over whole-repo reset.
- Never run git reset --hard automatically in MVP.
- Save failed diff before rollback to .rdt/tasks/<task-id>/failed.patch.
```

Failure states:

```text
FAILED_CLEAN
  Task failed, rollback succeeded, repository was restored for RDT-touched paths.

FAILED_DIRTY
  Task failed, rollback was skipped or incomplete, and the final report must list dirty files and manual recovery commands.
```

Required rollback tools:

```text
git_status_snapshot
  Captures baseline and final dirty state.

git_restore_touched
  Restores only files changed by RDT after baseline capture.

save_failed_patch
  Saves the failed diff before rollback for inspection or manual recovery.
```

## 15. Prompting Standards

### 15.1 General Agent System Prompt Rules

Every agent must receive:

```text
- its specific role
- allowed tools
- task goal
- project instructions
- current state
- output schema
- strict rule to avoid unrelated changes
```

### 15.2 File Picker Prompt Must Emphasize

```text
Select only relevant files. Do not select the whole repo. Prefer source files, tests, configs, and entrypoints related to the task.
```

### 15.3 Planner Prompt Must Emphasize

```text
Create a minimal plan. Do not edit. Do not invent files unless needed. Include test strategy.
```

### 15.4 Editor Prompt Must Emphasize

```text
Apply only the approved plan. Use patches. Preserve style. Inspect diff after editing.
```

### 15.5 Reviewer Prompt Must Emphasize

```text
Review the actual diff. Run tests/checks when available. Do not approve broken work. Separate pre-existing failures from new failures.
```

---

## 16. Testing Strategy

### 16.1 Unit Tests

Required unit tests:

```text
provider-router.test.ts
  - chooses first available provider
  - skips cooldown provider
  - respects daily limit
  - falls back after 429
  - filters by capability

repo-scanner.test.ts
  - ignores node_modules, .git, dist, build
  - detects package manager
  - detects test commands

tool-result.test.ts
  - all tools return consistent result shape

apply-patch.test.ts
  - applies valid patch
  - rejects invalid patch
  - preserves unrelated content

task-runner.test.ts
  - full happy path with mock provider
  - failure path when all providers unavailable
  - max edit pass stop condition
```

### 16.2 Integration Tests

Use fixture repositories.

```text
tests/fixtures/ts-basic/
tests/fixtures/python-basic/
tests/fixtures/failing-test/
```

Integration test examples:

```text
- RDT fixes a simple TypeScript bug
- RDT adds a test file
- RDT detects failing command and reports failure
- RDT does not edit ignored/generated files
```

### 16.3 Smoke Tests

Before claiming MVP works:

```bash
rdt init
rdt status
rdt "explain this project"
rdt "fix the sample failing test"
```

### 16.4 Definition of Test Done

```text
- unit tests pass
- integration tests pass against fixtures
- manual smoke test passes in a real repo
- no unhandled promise rejections
- task logs are created
- failures are readable
```

---

## 17. Implementation Phases

### Phase 0 — Repository Setup

Goal: create clean TypeScript project.

Tasks:

```text
- initialize package
- configure TypeScript
- configure formatter/linter
- create src structure
- create test framework
- add README
- add AGENTS.md
- add knowledge.md
```

Acceptance criteria:

```text
- npm/bun install works
- tests run
- CLI prints version/help
```

### Phase 1 — CLI and Project Detection

Tasks:

```text
- implement rdt init
- implement rdt status
- detect package manager
- detect test command
- generate .rdt/config.yaml
- generate initial knowledge.md if missing
```

Acceptance criteria:

```text
- running rdt init creates required files
- running rdt status shows project info
```

### Phase 2 — Tool Layer

Tasks:

```text
- implement list_files
- implement read_file
- implement search_files
- implement git_diff
- implement apply_patch
- implement run_shell/test_runner
```

Acceptance criteria:

```text
- all tools have unit tests
- all tools return ToolResult
- shell tool blocks dangerous commands
```

### Phase 3 — Provider Layer

Tasks:

```text
- implement provider interface
- implement mock provider
- implement OpenAI-compatible provider
- implement OpenRouter config support
- implement Ollama placeholder or adapter
```

Acceptance criteria:

```text
- mock provider can complete test tasks
- missing API key gives readable error
- OpenAI-compatible request path is isolated and testable
```

### Phase 4 — Provider Router

Tasks:

```text
- implement model policies
- implement cooldowns
- implement fallback
- implement 429 handling
- implement provider state persistence
```

Acceptance criteria:

```text
- router skips providers in cooldown
- router tracks daily and minute usage
- router reports all failures clearly
```

### Phase 5 — Agents

Tasks:

```text
- implement agent base types
- implement file picker
- implement planner
- implement editor
- implement reviewer
- enforce output schemas
```

Acceptance criteria:

```text
- each agent works with mock provider
- malformed model outputs are handled
- no direct filesystem access from agents
```

### Phase 6 — Task Runner

Tasks:

```text
- implement state machine
- connect agents
- save task logs
- implement edit/review loop
- generate final report
```

Acceptance criteria:

```text
- full fixture task passes end-to-end
- failed tasks produce useful report
- git diff is included in task log
```

### Phase 7 — Real-World Smoke Test

Tasks:

```text
- run RDT on its own repo
- ask it to fix a tiny known bug
- ask it to add a simple test
- inspect diff
- verify final report
```

Acceptance criteria:

```text
- no crashes
- edits are surgical
- tests/checks are attempted
- provider usage is logged
```

---

## 18. What to Avoid From Old RDT

Do not reintroduce these too early:

```text
- FastAPI bridge
- PWA dashboard
- Textual TUI
- ChromaDB-backed memory
- complicated swarm orchestration
- self-evolution prompt mutation
- too many feature flags
- multiple execution engines
- large LangChain dependency surface
- background daemon behavior
- huge tool registry
```

Old RDT failed because complexity grew faster than reliability.

RDT v2 must prove reliability first.

---

## 19. Future Features After MVP

Only consider these after MVP is stable.

### 19.1 Custom Agents

Add `.agents/` folder.

Example:

```text
.agents/
  security-reviewer.yaml
  test-writer.yaml
  refactor-planner.yaml
```

Each custom agent can define:

```yaml
name: security-reviewer
description: Reviews code for security issues
tools:
  - read_file
  - search_files
  - git_diff
model_policy: smart_reasoning
prompt: |
  You are a security reviewer...
```

### 19.2 TUI

Only after CLI is reliable.

Purpose:

```text
- show task steps
- show selected files
- show diff
- show provider status
```

### 19.3 Vector Memory

Only after `knowledge.md` becomes insufficient.

Possible use:

```text
- retrieve previous task summaries
- find recurring project decisions
- search large documentation
```

### 19.4 Swarm

Only after single workflow is rock solid.

Swarm should not mean uncontrolled parallel agents. It should mean bounded subtask execution with clear merge rules.

---

## 20. First Prompt for the Coding Agent

Use this as the first instruction to the agent building RDT v2:

```text
You are building RDT v2 from scratch.

Read this documentation first and follow it exactly.

Goal: build a terminal-first AI coding assistant inspired by Codebuff-style specialized agents.

Do not recreate old RDT complexity. Do not add dashboard, FastAPI bridge, PWA, ChromaDB, LangGraph, swarm, or self-evolution in MVP.

Start with a clean TypeScript project. Implement the CLI, project detection, tool layer, provider abstraction, provider router, four core agents, and deterministic task runner.

The MVP command is:

rdt "<coding task>"

The required agent flow is:

File Picker -> Planner -> Editor -> Reviewer -> Final Report

Every step must be logged. Every provider call must go through the router. Every tool must return ToolResult. Every file edit must be visible in git diff. Tests/checks must be run when available. Failures must be reported honestly.

Start by creating the repository structure, package config, TypeScript config, test framework, README, AGENTS.md, knowledge.md, and a placeholder CLI that supports rdt init and rdt status.

After each phase, run tests and update the task log.
```

---

## 21. Initial Build Checklist

The agent should execute in this order:

```text
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

## 22. Final Definition of MVP Done

MVP is done only when this works:

```bash
rdt init
rdt status
rdt "fix the failing test in the fixture repo"
```

And all of this is true:

```text
- RDT selects relevant files
- RDT creates a plan
- RDT applies a patch
- RDT runs tests/checks
- RDT reviews the diff
- RDT produces a final report
- task log is saved
- provider usage is saved
- rate limits are respected
- token budgets are enforced
- reviewer uses smart_reasoning minimum
- failed edits are rolled back or clearly reported as dirty
- failures are honest and readable
```

If any of these are missing, MVP is not done.

---

## 23. One-Line Product Rule

RDT v2 is not an AI dashboard, not a swarm lab, and not a memory experiment.

RDT v2 is a reliable terminal coding agent that understands a repo, edits code safely, runs checks, and explains exactly what changed.

