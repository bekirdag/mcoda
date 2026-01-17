# Tasks: Gateway Trio Reliability Improvements

Each task includes a slug, title, detailed description, dependencies, acceptance criteria, tests to write (unit/component/integration/api where relevant), files to touch, and priority. Tasks are ordered by highest priority.

## P0 tasks

### Task 1
- slug: gateway-trio-task-arg-normalize
- title: Normalize and validate --task inputs
- priority: P0
- description: Normalize task keys supplied via `--task` by splitting on newlines/whitespace, trimming, and de-duplicating. Reject empty values and warn on invalid keys; if no valid tasks remain, exit with an error. Also normalize when `--task` is passed multiple times.
- dependencies: None
- acceptance criteria:
  - Newline-delimited inputs are split into distinct task keys.
  - Duplicate task keys are removed.
  - When no valid tasks remain, the command exits with a clear error.
  - Unit tests cover newline input and duplicates.
- tests to write:
  - unit: `GatewayTrioCommand` parsing normalizes task keys.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
  - `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`

### Task 2
- slug: gateway-trio-task-file
- title: Add --task-file support
- priority: P0
- description: Add a `--task-file <PATH>` option to load task keys from a file (one key per line, comments starting with `#` ignored). Merge with `--task` arguments and de-duplicate.
- dependencies: gateway-trio-task-arg-normalize
- acceptance criteria:
  - `--task-file` reads task keys and ignores comments/blank lines.
  - Task list is merged with `--task` and de-duplicated.
  - Unit tests cover file parsing and merging behavior.
- tests to write:
  - unit: `GatewayTrioCommand` parses `--task-file` contents.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
  - `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`

### Task 3
- slug: gateway-trio-lock-cleanup
- title: Cleanup stale task locks on start/resume
- priority: P0
- description: Add a stale-lock cleanup pass (expired locks only) on gateway-trio start and resume. Log how many locks were cleared and which tasks were affected.
- dependencies: None
- acceptance criteria:
  - Expired task locks are removed on gateway-trio start/resume.
  - Logs include lock cleanup summary.
  - Unit test covers lock cleanup with expired locks.
- tests to write:
  - unit: lock cleanup removes expired locks only.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/db/src/repositories/workspace/WorkspaceRepository.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`

### Task 4
- slug: gateway-trio-escalate-no-changes
- title: Escalate on no_changes by default
- priority: P0
- description: Treat `no_changes` as an escalation reason by default in gateway-trio. When work returns `no_changes`, pick a stronger agent on the next attempt. Allow opt-out with `--no-escalate-on-no-change` or config flag.
- dependencies: None
- acceptance criteria:
  - `no_changes` triggers escalation unless explicitly disabled.
  - Tests show a different agent is chosen after a no-change failure.
- tests to write:
  - unit: `GatewayTrioService` escalates on `no_changes` by default.
  - component: CLI flag parsing to disable.
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`

### Task 5
- slug: gateway-trio-iteration-defaults
- title: Keep iteration/cycle caps optional by default
- priority: P0
- description: Ensure gateway-trio leaves `maxIterations` and `maxCycles` unset unless explicitly provided. Document that long-running work can run without caps by default and encourage explicit caps only when needed.
- dependencies: None
- acceptance criteria:
  - `maxIterations` and `maxCycles` are undefined unless CLI flags are provided.
  - Default maxAgentSeconds remains disabled unless explicitly set.
  - Unit tests confirm `maxIterations`/`maxCycles` remain undefined when omitted.
- tests to write:
  - unit: `GatewayTrioService` preserves undefined caps when omitted.
  - component: CLI help/usage notes reflect optional caps.
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
  - `docs/usage.md`

## P1 tasks

### Task 6
- slug: gateway-trio-retry-tests-failed
- title: Retry tests_failed with stronger agent
- priority: P1
- description: When work returns `tests_failed`, attempt one retry with a stronger agent before blocking the task. Update failure history and logs accordingly.
- dependencies: gateway-trio-escalate-no-changes
- acceptance criteria:
  - `tests_failed` retries once with stronger agent.
  - Failure history records the retry attempt.
  - Unit test covers retry behavior.
- tests to write:
  - unit: `GatewayTrioService` retries tests_failed once.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`

### Task 7
- slug: gateway-trio-review-qa-priority
- title: Prioritize review/QA feedback tasks within cycles
- priority: P1
- description: When a task receives `changes_requested` or `fix_required`, schedule it ahead of new tasks in the next cycle to avoid starvation behind long-running work.
- dependencies: None
- acceptance criteria:
  - Tasks with feedback are re-attempted before new tasks in the cycle.
  - Unit test demonstrates prioritization.
- tests to write:
  - unit: `GatewayTrioService` prioritizes feedback tasks.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`

### Task 8
- slug: gateway-trio-watch-resume-guidance
- title: Add watch/resume guidance for long runs
- priority: P1
- description: Print a resume command after job start, and add an optional `--watch` flag that waits for job completion with periodic status logs.
- dependencies: gateway-trio-task-arg-normalize
- acceptance criteria:
  - CLI prints resume command on start.
  - `--watch` waits for job completion and prints periodic updates.
  - Unit test covers watch-mode parsing and output.
- tests to write:
  - unit: `GatewayTrioCommand` parses `--watch` and emits guidance.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
  - `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`

### Task 9
- slug: gateway-trio-rating-visibility
- title: Surface agent rating/complexity updates in gateway-trio output
- priority: P1
- description: When `--rate-agents` is enabled, emit summary lines showing rating/complexity updates for the work/review/qa agents used per task. If rating is disabled, print a single warning to make it explicit.
- dependencies: None
- acceptance criteria:
  - Gateway-trio summary includes agent rating/complexity update lines when rating is enabled.
  - When rating is disabled, a single warning is logged (not per task).
  - Unit test covers summary output formatting.
- tests to write:
  - unit: `GatewayTrioService` summary includes rating lines.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`

## P2 tasks

### Task 10
- slug: gateway-trio-docs
- title: Document gateway-trio recovery and escalation behaviors
- priority: P2
- description: Update command docs to describe task normalization, `--task-file`, retry/escalation behavior, and resume/watch guidance.
- dependencies: gateway-trio-task-arg-normalize, gateway-trio-task-file, gateway-trio-escalate-no-changes
- acceptance criteria:
  - Docs explain task list handling, retry/escalation, and resume/watch usage.
  - Examples included.
- tests to write:
  - unit: N/A
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `docs/usage.md`
  - `docs/work-on-tasks-workflow.md`
  - `docs/code-review-workflow.md`
  - `docs/qa-workflow.md`
