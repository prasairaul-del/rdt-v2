# Phase 1: Architecture & Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modularize core monoliths and implement type-safe Agent I/O validation using `zod`.

**Architecture:** Decompose `TaskRunner` into a functional state machine with extracted step handlers. Split the Dashboard SPA into a multi-file component structure. Introduce `zod` schemas for all Agent communication.

**Tech Stack:** TypeScript, Bun, Zod, Vanilla CSS/JS.

---

### Task 1: Utility Consolidation

**Files:**
- Create: `src/utils/json.ts`
- Create: `src/utils/paths.ts`
- Create: `src/utils/format.ts`

- [ ] **Step 1: Implement robust JSON parsing utility**
(Extracted from `editor-agent.ts` and `reviewer-agent.ts`)

```typescript
export function safeParseJson<T>(text: string): T | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch { /* ... */ }
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(stripped.slice(first, last + 1)) as T;
    } catch { /* ... */ }
  }
  return null;
}
```

- [ ] **Step 2: Implement path normalization utility**

```typescript
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').trim();
}
```

- [ ] **Step 3: Commit**

```bash
git add src/utils/
git commit -m "chore: setup shared utilities"
```

---

### Task 2: Swarm Hardening with Zod

**Files:**
- Create: `src/agents/schemas.ts`
- Modify: `src/agents/editor-agent.ts`
- Modify: `src/agents/reviewer-agent.ts`

- [ ] **Step 1: Define Zod schemas for all agent outputs**

```typescript
import { z } from 'zod';

export const FileSelectionSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    reason: z.string(),
    priority: z.enum(['high', 'medium', 'low'])
  })),
  confidence: z.number()
});

export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(z.object({
    description: z.string(),
    targetFiles: z.array(z.string()),
    risk: z.enum(['low', 'medium', 'high'])
  })),
  testPlan: z.array(z.string()),
  risks: z.array(z.string())
});

export const EditResultSchema = z.object({
  summary: z.string(),
  edits: z.array(z.object({
    file: z.string(),
    patch: z.string().optional(),
    content: z.string().optional()
  }))
});

export const ReviewResultSchema = z.object({
  approved: z.boolean(),
  summary: z.string(),
  issues: z.array(z.string()),
  requiredFixes: z.array(z.string())
});
```

- [ ] **Step 2: Refactor Editor Agent to use schema validation**

- [ ] **Step 3: Refactor Reviewer Agent to use schema validation**

- [ ] **Step 4: Commit**

```bash
git add src/agents/
git commit -m "feat: implement zod validation for agent swarm"
```

---

### Task 3: TaskRunner Decomposition - Core

**Files:**
- Create: `src/core/runner/state-machine.ts`
- Create: `src/core/runner/execution-context.ts`
- Create: `src/core/runner/types.ts`

- [ ] **Step 1: Define Runner types and interfaces**
- [ ] **Step 2: Extract State Machine logic (transitions, events)**
- [ ] **Step 3: Extract Execution Context (sandbox, git baselines)**
- [ ] **Step 4: Commit**

```bash
git add src/core/runner/
git commit -m "refactor: extract task runner core components"
```

---

### Task 4: TaskRunner Decomposition - Steps

**Files:**
- Create: `src/core/runner/steps/pick.ts`
- Create: `src/core/runner/steps/plan.ts`
- Create: `src/core/runner/steps/edit.ts`
- Create: `src/core/runner/steps/review.ts`
- Modify: `src/core/task-runner.ts`

- [ ] **Step 1: Extract File Selection step**
- [ ] **Step 2: Extract Planning step**
- [ ] **Step 3: Extract Editing step (with parallel trials)**
- [ ] **Step 4: Extract Reviewing step**
- [ ] **Step 5: Refactor TaskRunner to use extracted steps**
- [ ] **Step 6: Verify all 237 tests pass**

Run: `bun run test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/
git commit -m "refactor: modularize task runner steps"
```

---

### Task 5: Dashboard SPA Refactoring

**Files:**
- Create: `src/cli/dashboard/ui/styles.css`
- Create: `src/cli/dashboard/ui/app.js`
- Create: `src/cli/dashboard/ui/components/TaskList.js`
- Create: `src/cli/dashboard/ui/components/TaskNode.js`
- Modify: `src/cli/dashboard/index.html`

- [ ] **Step 1: Extract CSS to styles.css**
- [ ] **Step 2: Extract core app logic to app.js**
- [ ] **Step 3: Modularize TaskList and TaskNode components**
- [ ] **Step 4: Update index.html to load modular assets**
- [ ] **Step 5: Verify dashboard still launches and renders correctly**

Run: `rdt dashboard`
Manual Check: Dashboard loads at http://localhost:3000

- [ ] **Step 6: Commit**

```bash
git add src/cli/dashboard/
git commit -m "refactor: split dashboard SPA monolith"
```
