# Design Spec: Phase 4 (Polish & Best Practices)

- **Date:** 2026-06-12
- **Author:** Antigravity CLI Agent
- **Status:** Proposed

## Overview
Phase 4 focusing on Polish & Best Practices aims to complete the following:
1. **Large-scale repository performance indexing**: Optimize vector index caches for larger workspaces by using file size and modification time (`mtimeMs`) metadata. This avoids reading and hashing every file in the repository on startup.
2. **Telemetry**: Profile and report LLM token cost and latency. Standardize token tracking across all agents (including the LLM fallback for file-picking) and aggregate the results into a detailed telemetry summary.
3. **Documentation**: Write a comprehensive developer guide (`docs/contributor-guide.md`) detailing agent communication contracts (AgentInput, AgentOutput, ToolResult) and the runner state machine steps.

## Detailed Specifications

### 1. Large-scale repository performance indexing
- **Repo Scanner & Map**:
  - Update `RepoMapEntry` in `src/project-context/repo-map.ts` to include optional `mtimeMs?: number`.
  - Update `walk` in `src/project-context/repo-scanner.ts` to populate `mtimeMs: stat.mtimeMs`.
- **Vector Search Cache**:
  - In `src/project-context/vector-search.ts`, modify `init()` to execute migrations adding `size` (INTEGER) and `mtime_ms` (REAL) columns to the `files_index` table if they do not exist:
    ```sql
    ALTER TABLE files_index ADD COLUMN size INTEGER;
    ALTER TABLE files_index ADD COLUMN mtime_ms REAL;
    ```
  - In `indexRepository()`, query `files_index` for `hash, size, mtime_ms` using the file path.
  - If a cached record is found and both `size` and `mtime_ms` match the scanned entry, skip reading and indexing that file.
  - When writing/updating the cache, include the file `size` and `mtimeMs` values.

### 2. Telemetry
- **Standardize Agent Usage Types**:
  - Update `ProviderUsageEntry` in `src/agents/types.ts` to include `promptTokens?: number` and `completionTokens?: number`.
- **Enable Usage Tracking for All Agents**:
  - Add `providerUsage` logging to `src/agents/file-picker-agent.ts` (currently missing).
  - Update `editor-agent.ts`, `planner-agent.ts`, and `reviewer-agent.ts` to populate `promptTokens` and `completionTokens` from `routerResult.response.usage`.
- **Aggregate Reporting**:
  - Implement a `calculateEstimatedCost(providerId, modelId, promptTokens, completionTokens)` helper in `src/core/task-runner.ts` using typical OpenRouter/Anthropic/Google/Ollama rates.
  - In `buildResult()` inside `src/core/task-runner.ts`, construct a multi-line telemetry report in `providerSummary`:
    ```
    Provider Usage Telemetry:
    - planner: openrouter/google/gemini-2.5-pro (3500ms, 4500 tokens (4000 in / 500 out), Cost: $0.0090)
    - editor: openrouter/anthropic/claude-3.5-sonnet (8200ms, 12000 tokens (10000 in / 2000 out), Cost: $0.0420)
    Total Latency: 11700ms | Total Tokens: 16500 (14000 in / 2500 out) | Est. Cost: $0.0510
    ```

### 3. Contributor Guide
- Create `docs/contributor-guide.md` containing:
  - High-level overview of the four-agent flow (File Picker -> Planner -> Editor -> Reviewer).
  - Data contracts: `AgentInput`, `AgentOutput`, `ToolResult`.
  - Step-by-step description of the 13-state deterministic runner pipeline.
  - Instructions on how to add a new tool or customized agent.

## Verification
- Add a new unit test suite inside `tests/unit/phase4.test.ts` checking:
  - The vector index cache skips indexing when size and mtimeMs are unchanged.
  - Telemetry estimates costs correctly and formats the output summary accurately.
- Run `bun run test` to verify all 257+ tests pass.
