# Gateway Trio 20-Task Run: Issue Categories, Solutions, and Plan

## Goal
Make gateway-trio reliably complete large task batches without stalling, while preserving correct work/review/QA loops and resilient recovery.

## Issue Categories and Root Causes
1. **CLI task input handling**
   - Root cause: `--task` arguments can be passed as newline-delimited strings and are treated as a single key.
   - Impact: zero tasks attempted, confusing “Task not found” messages.

2. **Job lifecycle visibility and recovery**
   - Root cause: CLI run can end while the job remains `running`, without a local watch/resume loop or explicit guidance.
   - Impact: users think the run is done while jobs continue or become stranded.

3. **Stale task locks**
   - Root cause: locks persist after a run exits early; no automatic cleanup on resume.
   - Impact: tasks are blocked from retries.

4. **Agent output quality (missing_patch/patch_failed/no_changes)**
   - Root cause: work agents return plans/prose or invalid patches; no automatic escalation to stronger agents in those cases.
   - Impact: tasks are blocked early even when recoverable.

5. **Test failures and run-all tests enforcement**
   - Root cause: tests_failed blocks tasks, but there is no additional retry strategy or stronger agent escalation.
   - Impact: tasks stall after a single failed attempt.

6. **Review changes_requested loop is blocked by long-running work**
   - Root cause: a long-running work step blocks the queue, so follow-up work is never executed.
   - Impact: review feedback never applied, tasks remain `in_progress`.

7. **Long-running work steps block the entire batch**
   - Root cause: no strict per-step timeout preemption and no early exit routing.
   - Impact: a single task can halt the entire batch.
8. **Iteration caps should be opt-in**
   - Root cause: default iteration/cycle limits can prematurely stop long-running, multi-pass work.
   - Impact: review/QA feedback loops can stop before work stabilizes.
9. **Agent evaluation not visible in gateway-trio output**
   - Root cause: agent rating/complexity updates are not surfaced in logs or summaries.
   - Impact: hard to confirm poor-performing agents are penalized and recovery attempts are explored.

## Solution Approach
- **Input validation:** Normalize `--task` values (split on newlines/whitespace), de-duplicate, and warn/fail when no valid tasks are left.
- **Resume guidance:** After starting a gateway-trio job, print the resume command and job ID. Add a local `--watch` option to wait on job completion when desired.
- **Lock cleanup:** Add automatic stale-lock cleanup on gateway-trio start/resume (expired locks only), and document a manual cleanup command.
- **Agent escalation:** Treat `missing_patch`, `patch_failed`, and `no_changes` as escalation reasons by default; rotate to stronger agents when repeat failures occur.
- **Test retries:** Allow a configurable retry on `tests_failed` with a stronger agent and add log guidance.
- **Step timeouts + heartbeats:** Keep timeouts optional (disabled by default) but keep checkpoint heartbeats; allow explicit `--max-agent-seconds` to enforce timeouts when desired.
- **Review/QA loop scheduling:** Ensure the state machine reprioritizes tasks that have `changes_requested`/`fix_required` so fixes are not starved by long-running tasks.
- **Iteration caps are optional:** Leave `maxIterations`/`maxCycles` unset by default; allow explicit caps via CLI flags when desired.
- **Agent evaluation visibility:** Emit rating/complexity updates (or explicit “rating disabled”) in gateway-trio summaries for each step.

## Implementation Plan
### Phase 1: CLI and orchestration safety
- Normalize and validate task keys in `GatewayTrioCommand` and `WorkOnTasksCommand`.
- Add `--task-file` support for large task lists.
- Print job-resume instructions on start.

### Phase 2: Job recovery and lock handling
- Add stale-lock cleanup on gateway-trio start/resume.
- Add a local `mcoda locks cleanup` or `gateway-trio --cleanup-locks` helper.

### Phase 3: Resilience and escalation
- Expand escalation reasons to include `no_changes` (default on).
- Add retry strategy for `tests_failed` (one re-run with stronger agent).
- Keep per-step heartbeat checkpoints; per-step timeouts remain opt-in via `--max-agent-seconds`.
- Keep `maxIterations` and `maxCycles` unset by default; allow explicit CLI caps for long runs.
- Add gateway-trio summary lines for agent rating/complexity updates when `--rate-agents` is enabled.

### Phase 4: Scheduling fairness
- Reprioritize tasks with review/QA feedback so they are reworked before new tasks in the same cycle.

## Validation
- Unit tests for CLI task parsing and lock cleanup.
- GatewayTrioService tests for timeouts, escalation, and reprioritization.
- End-to-end run on 20 tasks in `<WORKSPACE_ROOT>`, tracking completion and blocked reasons.
