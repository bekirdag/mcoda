# Gateway Trio Command Plan

## Goal
Introduce a new CLI command that runs a full task lifecycle for every task in the tasks DB:
1) work-on-tasks (implementation),
2) code-review,
3) qa-tasks,
all routed through the gateway agent for each step, and iterated until each task passes QA or hits a stop condition.

## Command
Name: `mcoda gateway-trio`

Rationale: aligns with the gateway router requirement and makes the 3-step pipeline explicit.

### CLI usage
```
mcoda gateway-trio \
  [--workspace-root <PATH>] \
  [--project <PROJECT_KEY>] \
  [--task <TASK_KEY> ... | --epic <EPIC_KEY> | --story <STORY_KEY>] \
  [--status <CSV>] \
  [--limit N] \
  [--max-iterations N] \
  [--max-cycles N] \
  [--gateway-agent <NAME>] \
  [--max-docs N] \
  [--no-commit] \
  [--dry-run] \
  [--review-base <BRANCH>] \
  [--qa-profile <NAME>] \
  [--qa-level <LEVEL>] \
  [--qa-test-command "<CMD>"] \
  [--qa-mode auto|manual] \
  [--qa-followups auto|none|prompt] \
  [--agent-stream <true|false>] \
  [--resume <JOB_ID>] \
  [--json]
```

Defaults:
- `--status` defaults to `not_started,in_progress,ready_to_review,ready_to_qa` (exclude completed/cancelled/failed).
- `--max-iterations` defaults to 3 per task (avoid infinite loops).
- `--max-cycles` defaults to 5 full passes (handles newly created follow-ups).

### Flag surface (initial)
Gateway router flags:
- `--gateway-agent <NAME>`: override the gateway router agent for all steps.
- `--max-docs <N>`: cap docdex documents per gateway call.
- `--agent-stream <true|false>`: controls streaming for gateway and downstream agents.

Task selection flags:
- `--project <PROJECT_KEY>`, `--task <TASK_KEY>`, `--epic <EPIC_KEY>`, `--story <STORY_KEY>`, `--status <CSV>`, `--limit N`.

Work step flags:
- `--no-commit`: skip commit/push in work step.
- `--dry-run`: dry-run for work/review/QA steps.

Review step flags:
- `--review-base <BRANCH>`: base ref for code-review.

QA step flags:
- `--qa-profile <NAME>`, `--qa-level <LEVEL>`, `--qa-test-command "<CMD>"`.
- `--qa-mode auto|manual` (default auto).
- `--qa-followups auto|none|prompt` (default auto).

Pipeline control flags:
- `--max-iterations <N>`, `--max-cycles <N>`, `--resume <JOB_ID>`.

## High-Level Flow
1) Select tasks from the workspace DB (ordered by dependency/prio) using `TaskSelectionService`.
2) For each task, run a per-task loop:
   - Gateway -> Work
   - Gateway -> Review
   - Gateway -> QA
3) If any step reports issues, return to Work for that task and iterate.
4) After a full pass, re-load tasks to catch new follow-ups or tasks unblocked by dependencies.
5) Stop when all selected tasks are completed or all remaining are blocked/failed/at max-iterations.

## Detailed Orchestration Logic
### Task selection
- Use `TaskSelectionService.selectTasks` with filters: `projectKey/epicKey/storyKey/taskKeys/statusFilter/limit`.
- Capture both `ordered` and `blocked` lists.
- Skip tasks that are already `completed` or `cancelled` unless explicitly requested.
- If `projectKey` is not provided, selection spans all projects; each task run uses the task's project key when available.
- For explicit `--task` selections, dynamically include the task’s current status in the filter so TaskSelectionService does not drop it (unless the task is completed/cancelled).

### Per-task pipeline (single task at a time)
For each task key (sequential order):
1) **Gateway Work Step**
   - Call `GatewayAgentService.run` with `job = "work-on-tasks"` and `taskKeys = [taskKey]`.
   - Build a handoff file from the gateway analysis and set `MCODA_GATEWAY_HANDOFF_PATH`.
   - Call `WorkOnTasksService.workOnTasks` with `taskKeys = [taskKey]`, `projectKey = task.projectKey` (if known), `agentName = chosenAgentSlug`.
   - If result status is not `succeeded`, record issue and either retry or mark blocked.

2) **Gateway Review Step**
   - Call `GatewayAgentService.run` with `job = "code-review"` and the same `taskKeys`.
   - Build handoff and set `MCODA_GATEWAY_HANDOFF_PATH`.
   - Call `CodeReviewService.reviewTasks` with `taskKeys = [taskKey]`, `statusFilter = ["ready_to_review"]`, `agentName = chosenAgentSlug`.
   - If decision is not `approve` or review result has an error, treat as issue and return to Work.

3) **Gateway QA Step**
   - Call `GatewayAgentService.run` with `job = "qa-tasks"` and the same `taskKeys`.
   - Build handoff and set `MCODA_GATEWAY_HANDOFF_PATH`.
   - Call `QaTasksService.run` (via `QaTasksApi` or direct service) with `taskKeys = [taskKey]`, `statusFilter = ["ready_to_qa"]`, `agentName = chosenAgentSlug`.
   - If outcome is not `pass`, treat as issue and return to Work.

### Issue detection and iteration
Treat these as "issues" and loop back to Work:
- Work step result status is `failed` or `blocked`.
- Review decision is `changes_requested` or `block`, or review result has `error`.
- QA outcome is `fix_required` or `unclear`.

Stop conditions (per task):
- `max-iterations` reached.
- QA reports `infra_issue` (mark blocked; do not loop).
- Task is blocked due to dependency (skip and revisit in next cycle).

### Cross-cycle behavior
- After each full pass across ordered tasks, re-run `TaskSelectionService`.
- If new tasks were created (review/QA follow-ups), they appear in the next cycle automatically.
- If an entire cycle attempts zero tasks (all remaining tasks are blocked/terminal), stop and report to avoid infinite loops.

## Proposed Code Structure
### Core service
Add `packages/core/src/services/execution/GatewayTrioService.ts`:
- Dependencies: `GatewayAgentService`, `WorkOnTasksService`, `CodeReviewService`, `QaTasksService`, `TaskSelectionService`, `JobService`.
- Methods:
  - `run(request)` returns summary (per-task attempts, final outcomes, warnings).
  - `runTaskCycle(task)` for the per-task loop.
  - `buildGatewayHandoff(result)` helper (extract from current CLI implementation).
  - `withGatewayHandoff(fn)` helper to set/reset `MCODA_GATEWAY_HANDOFF_PATH`.
- Persist state at `.mcoda/jobs/<job_id>/gateway-trio/state.json` to support resume and debugging.

### CLI command
Add `packages/cli/src/commands/work/GatewayTrioCommand.ts`:
- Parse args, resolve workspace, call `GatewayTrioService.run`.
- JSON output should include jobId, commandRunId, per-task summary (attempts, final status), warnings, blocked list.
- Human output should list each task with final outcome and iteration count.

### Entrypoint
Update `packages/cli/src/bin/McodaEntrypoint.ts`:
- Add `gateway-trio` to usage string.
- Route `gateway-trio` to the new command.

### Shared helpers (optional but recommended)
Extract helper(s) from `GatewayAgentCommand`:
- `buildHandoffContent()` and the `MCODA_GATEWAY_HANDOFF_PATH` usage into a small shared module (core or shared).
- Use the same format for consistent handoff injection.

## Data and Status Handling
### Status transitions expected (existing behavior)
- Work: marks task `ready_to_review`.
- Review: `approve` -> `ready_to_qa`, `changes_requested` -> `in_progress`, `block` -> `blocked`.
- QA: `pass` -> `completed`, `fix_required` -> `in_progress`, `infra_issue` -> `blocked`.

### Status gating matrix (pipeline decisions)
Step | Outcome | Task status after step | Pipeline action
--- | --- | --- | ---
Work | succeeded | ready_to_review | proceed to review
Work | failed/blocked | blocked or failed | loop back to work until max-iterations
Review | approve | ready_to_qa | proceed to QA
Review | changes_requested | in_progress | loop back to work
Review | block | blocked | stop (blocked)
QA | pass | completed | task complete
QA | fix_required | in_progress | loop back to work
QA | unclear | in_progress | loop back to work
QA | infra_issue | blocked | stop (blocked)

### Task ordering and dependencies
- Respect `TaskSelectionService` ordering and blocked list.
- Skip blocked tasks unless explicitly requested with `--task`.

## Observability
Record a pipeline job and command run:
- `jobService.startCommandRun("gateway-trio", projectKey)`
- `jobService.startJob("gateway-trio", commandRunId, projectKey, payload)`
Artifacts:
- `.mcoda/jobs/<job_id>/gateway-trio/`:
  - `state.json` (per-task attempts, last step, last error)
  - `handoffs/` (optional copies of handoff files by step)

## Testing Plan
### Core unit tests
Add `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`:
- Handles work->review->qa success path.
- Loops on review changes_requested and QA fix_required.
- Stops after `max-iterations`.
- Skips blocked tasks unless explicitly requested.
- Rescans tasks and picks up new follow-up tasks.

### CLI tests
Add `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`:
- Requires a job name / validates args.
- Runs with `--json` and returns structured output.
- Rejects invalid combinations (e.g., --task with --epic).

## Docs Updates
- Add a short usage blurb to `docs/usage.md` under task execution.
- Add a short section to `docs/sds/sds.md` in routing/execution describing gateway-trio behavior.

## Decisions (locked)
- Command name: `gateway-trio`.
- Default status filter includes `ready_to_review` and `ready_to_qa`.
- QA `infra_issue` stops the task and marks it blocked (no retries).
- Follow-up tasks are picked up on the next cycle after re-selection.
