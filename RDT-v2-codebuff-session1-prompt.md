You are building RDT v2 from scratch.

RDT v2 is a terminal-first AI coding agent inspired by Codebuff-style specialized agents.
It is written in TypeScript and runs on Bun.

---

## PRODUCT RULE

RDT v2 is not a dashboard, not a swarm lab, and not a memory experiment.
RDT v2 is a reliable terminal coding agent that understands a repo, edits code safely, runs checks, and explains exactly what changed.

---

## MVP COMMAND

```bash
rdt "fix the failing test in the fixture repo"
```

The agent flow is:

```
File Picker → Planner → Editor → Reviewer → Final Report
```

---

## TECH STACK

- Language: TypeScript (strict mode)
- Runtime: Bun (fallback: Node + pnpm)
- CLI framework: commander or cac
- Storage: SQLite (no ChromaDB, no vector DB in MVP)
- Project memory: knowledge.md + AGENTS.md (markdown files)
- Test framework: Vitest or Bun test

---

## DO NOT BUILD IN MVP

Do not add any of the following — they are post-MVP only:

- Dashboard or PWA
- FastAPI bridge
- Textual TUI
- ChromaDB or vector memory
- LangGraph
- Swarm orchestration
- Self-evolution
- Background daemon
- Parallel multi-agent execution

---

## PACKAGE STRUCTURE

Create this exact directory structure:

```
rdt-v2/
  package.json
  tsconfig.json
  biome.json (or .eslintrc)
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

## PHASE 0 SCOPE — THIS SESSION ONLY

Build only Phase 0. Do not implement agents, tools, or providers yet.

### Tasks for Phase 0

1. Initialize the Bun/TypeScript project
   - package.json with bun as runtime
   - tsconfig.json with strict: true
   - Biome config for formatting and linting (preferred over ESLint)

2. Create the full src/ directory structure above (empty placeholder files are fine)

3. Implement a working CLI entrypoint
   - `rdt --help` prints usage
   - `rdt --version` prints version
   - Placeholder commands: init, status, run, providers (print "not yet implemented")

4. Add test framework
   - Vitest or Bun test
   - One passing smoke test to verify setup

5. Create project files
   - README.md with project description and setup instructions
   - AGENTS.md with project overview and agent rules
   - knowledge.md with architecture decisions

### AGENTS.md content to generate:

```md
# AGENTS.md

## Project Overview
RDT v2 is a terminal-first AI coding assistant.
It coordinates specialized agents to understand a repo, plan changes, apply patches, and verify results.

## Setup Commands
- Install: bun install
- Run tests: bun test
- Build: bun build src/cli/index.ts
- Run: bun run src/cli/index.ts

## Code Style
- TypeScript strict mode always on
- Use Result types, not exceptions, for agent outputs
- Agents must not access the filesystem directly — use tools only
- Every tool must return ToolResult<T>

## Important Files
- src/cli/index.ts — CLI entrypoint
- src/core/task-runner.ts — main task state machine
- src/agents/ — four core agents
- src/tools/ — all filesystem and shell tools
- src/router/ — provider routing and fallback logic
- .rdt/config.yaml — runtime configuration

## Agent Rules
- Do not rewrite large files unnecessarily
- Run tests before claiming success
- Preserve existing code style
- Apply patches, not full-file overwrites
- Always inspect git diff after edits
```

### knowledge.md content to generate:

```md
# Project Knowledge

## Architecture
RDT v2 uses four specialized agents: File Picker, Planner, Editor, Reviewer.
Each agent receives a task context and returns a typed output schema.
Agents never touch the filesystem directly — all operations go through tools.

## Technology Decisions
- TypeScript + Bun: fast startup, good typing, easy CLI packaging
- SQLite: simple local persistence for task logs and provider state
- Markdown memory: knowledge.md and AGENTS.md before vector DB
- One task runner: no competing execution paths

## Provider Strategy
- OpenRouter free tier as default
- Groq as fallback
- Ollama for local models
- Router handles cooldowns, rate limits, and fallback

## Avoid
- Do not add dashboard before MVP is stable
- Do not add ChromaDB until knowledge.md is insufficient
- Do not add swarm until single-agent workflow is rock solid
- Never retry endlessly after rate limits — cooldown and fallback only
```

---

## ACCEPTANCE CRITERIA FOR PHASE 0

Phase 0 is done when:

- `bun install` completes without errors
- `bun test` runs and passes
- `bun run src/cli/index.ts --help` prints correct usage
- `bun run src/cli/index.ts --version` prints a version
- Full src/ directory structure exists
- README.md, AGENTS.md, knowledge.md all exist with meaningful content

---

## WHAT COMES NEXT (do not build yet)

After Phase 0 is confirmed working, the next sessions will be:

- Phase 1: rdt init + rdt status + project detection
- Phase 2: Tool layer (list_files, read_file, apply_patch, git tools, shell runner)
- Phase 3: Provider interface + mock provider + OpenRouter adapter
- Phase 4: Provider router with cooldown, fallback, and token budgets
- Phase 5: Four agents (File Picker, Planner, Editor, Reviewer)
- Phase 6: Task runner state machine + task logs + rollback
- Phase 7: Integration tests + real-world smoke test

Build only what is listed for Phase 0. Save everything else for later sessions.
