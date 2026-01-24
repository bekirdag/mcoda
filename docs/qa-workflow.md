# QA Workflow

This document describes the current `qa-tasks` command flow as implemented in `QaTasksService` (`packages/core/src/services/execution/QaTasksService.ts`).

## Overview
`qa-tasks` runs automated QA checks using a selected QA profile (CLI/browser/etc.). It uses a routing agent to decide which profiles to run, then records a deterministic QA summary from the runner outputs. Optional agent interpretation can be enabled by setting `MCODA_QA_AGENT_INTERPRETATION=1`.

## Inputs and defaults
- Task scope: `projectKey`, `epicKey`, `storyKey`, `taskKeys`, `statusFilter`.
  - Default status filter: `ready_to_qa`.
- Mode: `mode=auto` (default) or `mode=manual`.
- QA profile: `profileName`, `level`, `testCommand` override.
- Output options: `agentName`, `agentStream`, `createFollowupTasks`, `dryRun`, `rateAgents`.
- Resume: `resumeJobId` (checkpoint-based resume).

## High-level phases
1. Init + selection (including resume handling)
2. Per-task QA run (auto or manual)
3. Finalize and report

## Detailed workflow

### 1) Init + selection
1. Select tasks with `TaskSelectionService` (or use resume payload).
2. If `dryRun`:
   - Resolve QA profile per task when possible.
   - Return planned results without running tests.
3. Ensure `.mcoda/` exists and is in `.gitignore`.
4. If resuming:
   - Load checkpoints to skip completed tasks.

### 2) Per-task QA run (auto mode)

#### 2.1 Task run setup
1. Create a `task_run` row (status: `running`).
2. Resolve QA profiles using the QA routing agent:
   - If `profileName` is provided, run only that profile (explicit override).
   - Otherwise, the routing agent chooses profiles per task based on task content and available profiles.
   - If the routing output is invalid, fall back to the default CLI profile.
3. If the latest code review indicates an empty diff (no code changes) and the decision is `approve`/`info_only`, skip QA and mark the task as passed.

#### 2.2 Adapter selection and install check
1. Pick adapter by profile runner:
   - `cli`, `chromium` (headless Chromium via docdex), or `maestro`.
2. Call `ensureInstalled` on each adapter.
3. If install/preflight fails:
   - Record an `infra_issue` result for that run.
   - Continue running other profiles if available.

#### 2.3 Execute QA tests
1. Resolve test command (per CLI profile + optional override).
2. Build QA context (workspace root, job id, task key, env).
3. Run each adapter (`invoke`) and collect outputs.
4. Normalize outcomes:
   - CLI adapter may treat “no tests found / skipping tests” as `infra_issue`.
   - If `tests/all.js` is used, it must emit `MCODA_RUN_ALL_TESTS_COMPLETE`; missing markers are treated as `infra_issue`.
5. Aggregate multiple runs into a single combined QA result for summary (and optional agent interpretation when enabled).

#### 2.4 Optional agent interpretation (disabled by default)
Agent interpretation runs only when `MCODA_QA_AGENT_INTERPRETATION=1`.
1. Load project guidance and docdex context.
2. Build a QA interpretation prompt with:
   - Task metadata + acceptance criteria
   - Comment backlog (unresolved slugs)
   - Test stdout/stderr + artifacts
3. Invoke QA agent and parse strict JSON:
   - If parsing fails, retry once with stricter JSON instruction.
   - If still invalid, record `unclear` and capture the raw output for manual QA follow-up.

#### 2.5 Apply results
1. Combine raw test outcome (and agent recommendation when enabled):
   - `infra_issue` dominates.
   - `fix_required` dominates if either side requests it.
   - `unclear` is preserved if the agent requests it.
2. Apply state transition:
   - `pass` → `completed`
   - `fix_required` → `in_progress`
   - `infra_issue` → `failed` with `qa_infra_issue`
   - `unclear` → `failed` with `qa_unclear`
3. Resolve QA comment slugs:
   - Mark `resolvedSlugs`, reopen `unresolvedSlugs`.
   - Create new QA comment(s) for failures.
4. Create a QA run record with artifacts and token usage.
5. Create follow‑up tasks if `fix_required` (or invalid JSON) and follow‑ups are enabled.
   - Follow‑ups are deduplicated via a stable `qa_followup_slug` in task metadata.

#### 2.6 Rating
If agent interpretation is enabled and `rateAgents` is set, record an agent rating for the QA interpretation run.

### 2) Per-task QA run (manual mode)
1. Create a `task_run` row.
2. Use `result`/`notes` from the request instead of executing tests.
3. Apply the same state transitions and follow‑up task logic.
4. Create QA comments and a QA run record.

### 3) Finalize and report
1. Update job progress counters and checkpoints.
2. Finish the command run.

## Gateway-trio integration notes
- `gateway-trio` treats `pass` as completion and loops back on `fix_required` or `unclear`.
- `qa_infra_issue` fails the task; failed QA tasks can be retried on resume when allowed.
- Feedback tasks (QA fix requests) are prioritized in subsequent cycles.

## Mermaid diagram
```mermaid
flowchart TD
  A[Start qa-tasks] --> B[Select tasks]
  B --> C{dryRun?}
  C -->|Yes| C1[Plan QA results]
  C -->|No| D[Ensure .mcoda + resume checkpoints]
  D --> E{For each task}
  E --> F[Create task_run]
  F --> G[Resolve QA profile]
  G --> H[Pick adapter + ensureInstalled]
  H --> I{Install ok?}
  I -->|No| I1[Fail qa_infra_issue + comment]
  I -->|Yes| J[Run tests via adapter]
  J --> K[Normalize outcome]
  K --> P[Combine outcome + recommendation (optional)]
  P --> Q[Apply state transition]
  Q --> R[Resolve comment slugs + create QA comment]
  R --> S[Create QA run + followups]
  S --> T[Next task]
```
