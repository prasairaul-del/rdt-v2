# Design Spec: Phase 3 (UX, Extensibility & Advanced Tooling)

- **Date:** 2026-06-12
- **Author:** Antigravity CLI Agent
- **Status:** Proposed

## Overview
Phase 3 aims to expand RDT v2's capabilities across three areas:
1. **Granular Filesystem Tools**: Explicit tools for directory creation, file deletion, and moving/renaming files.
2. **Real-time Log Streaming**: Refactoring shell/test tools from synchronous execution (`execSync`) to asynchronous streaming (`spawn`), logging output chunks in real-time to the EventSource/Dashboard.
3. **Custom Instructions**: Support loading custom developer rules from `.rdt/instructions/*.md`.

## Detailed Specifications

### 1. Granular Filesystem Tools
Add three new tools returning `ToolResult` under `src/tools/`:
- `make-directory.ts` (tool name: `make_directory`): inputs `{ path, recursive }`
- `delete-file.ts` (tool name: `delete_file`): inputs `{ path, recursive }`
- `move-file.ts` (tool name: `move_file`): inputs `{ sourcePath, destPath, overwrite }`

### 2. Real-time Log Streaming
Modify `src/tools/run-shell.ts` and `src/tools/test-runner.ts` to execute commands via child_process `spawn`.
During execution:
- Capture stdout/stderr data events.
- Stream chunks line-by-line via `defaultLogger.info` or the current task's logger.
- Resolve the Promise with execution output only after the process exits.

### 3. Custom Instructions
Update `src/project-context/load-instructions.ts` to scan `.rdt/instructions/` directory for any `.md` markdown files.
Merge their contents as `customInstructions` in the loaded `Instructions` object, which will be appended to the user instruction prompt context.

## Verification
- Add unit tests for the three new filesystem tools.
- Add unit tests for asynchronous log streaming and custom instructions loading.
- Ensure all 239+ tests pass.
