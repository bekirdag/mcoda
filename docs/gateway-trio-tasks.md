# Gateway Trio Implementation Tasks

Tasks below are derived from `docs/gateway-trio-plan.md` and a deeper pass through the current codebase (WorkOnTasksService, CodeReviewService, QaTasksService, GatewayAgentService, TaskSelectionService, JobService). Each task includes a slug, title, detailed description, files to touch, acceptance criteria, and dependencies.

## Planning and Decision Tasks

## Task: gateway-trio-spec
Slug: gateway-trio-spec
Title: Finalize gateway-trio command contract and plan defaults
Description:
Lock the official command name, default status filters, iteration limits, and stop conditions in the plan doc. Decisions must explicitly account for existing behavior: WorkOnTasksService defaults to `not_started,in_progress`, CodeReviewService defaults to `ready_to_review`, and QaTasksService defaults to `ready_to_qa`. If the gateway-trio command needs broader coverage (per requirement: run all tasks), document the new defaults and why.
Files to touch:
- docs/gateway-trio-plan.md
Acceptance criteria:
- Plan doc lists a single official command name and finalized CLI usage.
- Defaults for `--status`, `--max-iterations`, `--max-cycles` are explicit and justified.
- Stop conditions for review failures, QA infra issues, and dependency blocks are defined.
Dependencies:
- None

## Task: gateway-trio-status-matrix
Slug: gateway-trio-status-matrix
Title: Define status transitions and gating for each step
Description:
Write a concise matrix that maps status transitions for each pipeline step. Reference actual behaviors: work sets `ready_to_review`, review sets `ready_to_qa` or `in_progress` or `blocked`, QA sets `completed` or `in_progress` or `blocked`. Use this matrix to define when the pipeline can legally proceed to review or QA, and when it must loop back.
Files to touch:
- docs/gateway-trio-plan.md
Acceptance criteria:
- Plan doc includes a status transition table for work/review/QA.
- Gating rules (when to run review or QA) are explicit.
Dependencies:
- gateway-trio-spec

## Task: gateway-trio-selection-policy
Slug: gateway-trio-selection-policy
Title: Define task selection scope and dependency handling
Description:
Document how gateway-trio should select tasks from the DB (all projects or scoped by `--project`, whether blocked tasks are skipped, and how dependency blocks are revisited across cycles). Note that TaskSelectionService filters by status even when task keys are provided; the selection policy must align status filters to ensure chosen tasks are actually selected.
Files to touch:
- docs/gateway-trio-plan.md
Acceptance criteria:
- Plan doc clarifies default selection scope (all tasks vs per project).
- Dependency handling (skip/return later) is explicitly stated.
- Status filter behavior with TaskSelectionService is called out.
Dependencies:
- gateway-trio-spec

## Task: gateway-trio-flag-surface
Slug: gateway-trio-flag-surface
Title: Decide which per-step flags are exposed
Description:
Decide which flags from existing commands are exposed by gateway-trio and how they map: `--no-commit`/`--dry-run` for work; `--base` for review; `--qa-profile`, `--qa-level`, `--qa-test-command`, `--qa-mode`, `--qa-followups` for QA; `--gateway-agent`/`--max-docs` for the router. Specify which are supported and which are intentionally not exposed to keep the command stable.
Files to touch:
- docs/gateway-trio-plan.md
Acceptance criteria:
- Plan doc lists all supported gateway-trio flags and their mapping to work/review/qa.
- Any excluded flags are explicitly documented with rationale.
Dependencies:
- gateway-trio-spec

## Core Data and Helper Tasks

## Task: gateway-trio-project-key-lookup
Slug: gateway-trio-project-key-lookup
Title: Add project-id to project-key resolution for tasks
Description:
WorkOnTasksService and Docdex lookups are cleaner when a project key is available. TaskSelectionService returns projectId but not projectKey, and WorkspaceRepository has `getProjectByKey` but no `getProjectById`. Add a minimal helper (e.g., `getProjectById`) or extend TaskSelectionService to include projectKey in selected tasks so gateway-trio can route per task without an explicit `--project`.
Files to touch:
- packages/db/src/repositories/workspace/WorkspaceRepository.ts
- packages/core/src/services/execution/TaskSelectionService.ts
- packages/db/src/repositories/workspace/WorkspaceRepository.d.ts (if needed)
Acceptance criteria:
- Gateway-trio can map task.projectId to a stable project key.
- No existing queries regress or break typing.
Dependencies:
- gateway-trio-selection-policy

## Task: gateway-trio-handoff-helper
Slug: gateway-trio-handoff-helper
Title: Extract reusable gateway handoff helper
Description:
Create a shared helper that builds the gateway handoff markdown and manages `MCODA_GATEWAY_HANDOFF_PATH` lifecycle. This should reuse the current handoff content format from `GatewayAgentCommand` so downstream agents see a consistent structure. Update `GatewayAgentCommand` to use the helper to avoid duplication.
Files to touch:
- packages/core/src/services/agents/GatewayHandoff.ts (new, or equivalent shared location)
- packages/cli/src/commands/agents/GatewayAgentCommand.ts
- packages/core/src/index.ts (export helper if needed)
Acceptance criteria:
- Gateway handoff content is generated by a single shared helper.
- `GatewayAgentCommand` output format is unchanged.
- Helper sets and restores env vars via try/finally.
Dependencies:
- gateway-trio-spec

## Task: gateway-trio-handoff-artifacts
Slug: gateway-trio-handoff-artifacts
Title: Store per-step handoff artifacts under the pipeline job
Description:
In addition to the handoff path used for agent injection, persist a copy of each step’s handoff into `.mcoda/jobs/<job_id>/gateway-trio/handoffs/` so the pipeline is auditable. Include step name and attempt number in filenames.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts (new)
Acceptance criteria:
- Each step writes a handoff artifact when it runs.
- Filenames clearly indicate task, step, and attempt.
Dependencies:
- gateway-trio-handoff-helper

## Task: gateway-trio-task-refresh
Slug: gateway-trio-task-refresh
Title: Add a task refresh helper between steps
Description:
Implement a helper that reloads a task by key between work/review/QA steps. This avoids stale status data and ensures gating decisions reflect updates made by WorkOnTasksService/CodeReviewService/QaTasksService.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts (new)
- packages/db/src/repositories/workspace/WorkspaceRepository.ts (use existing getTaskByKey)
Acceptance criteria:
- Pipeline reads fresh task status before review and QA.
- Missing tasks are surfaced as warnings without crashing the run.
Dependencies:
- gateway-trio-project-key-lookup

## Task: gateway-trio-result-mapping
Slug: gateway-trio-result-mapping
Title: Define issue detection from step results
Description:
Create a centralized mapping that interprets results from each step:
- Work: `failed`/`blocked` => issue, `succeeded` => continue.
- Review: `changes_requested`/`block` => issue, `approve` => continue.
- QA: `fix_required`/`unclear` => issue, `pass` => success, `infra_issue` => stop and block.
Use this mapping for loop control and reporting.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts (new)
Acceptance criteria:
- A single mapping function/classifies step outcomes.
- All loop decisions use the same mapping.
Dependencies:
- gateway-trio-status-matrix

## Orchestration Tasks

## Task: gateway-trio-service-skeleton
Slug: gateway-trio-service-skeleton
Title: Add GatewayTrioService skeleton and job tracking
Description:
Create `GatewayTrioService` with dependency construction, job/command-run creation, and a basic run loop that selects tasks and iterates over them. Wire JobService so the pipeline has its own job record distinct from per-step jobs.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts (new)
- packages/core/src/services/jobs/JobService.ts (if a new job type or manifest fields are needed)
- packages/core/src/index.ts
Acceptance criteria:
- Service compiles and can be constructed/closed.
- A pipeline job and command run are created and finalized.
Dependencies:
- gateway-trio-selection-policy
- gateway-trio-project-key-lookup

## Task: gateway-trio-step-work
Slug: gateway-trio-step-work
Title: Integrate gateway-routed work step
Description:
For each task attempt, call `GatewayAgentService.run` with job `work-on-tasks` and the task key, then invoke `WorkOnTasksService` using the chosen agent and handoff context. Ensure status filters allow the task’s current status to be selected even if it is `ready_to_review`/`ready_to_qa`.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
- packages/core/src/services/execution/WorkOnTasksService.ts (only if a helper is needed)
Acceptance criteria:
- Work step runs with a gateway-chosen agent and valid handoff.
- Task selection includes the target task even if status is not default.
Dependencies:
- gateway-trio-service-skeleton
- gateway-trio-handoff-helper
- gateway-trio-result-mapping

## Task: gateway-trio-step-review
Slug: gateway-trio-step-review
Title: Integrate gateway-routed review step
Description:
Call `GatewayAgentService.run` with job `code-review`, then invoke `CodeReviewService.reviewTasks` for the single task using the chosen agent. Ensure review uses the correct base ref if a CLI flag is provided.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
- packages/core/src/services/review/CodeReviewService.ts (only if a helper is needed)
Acceptance criteria:
- Review step runs with a gateway-chosen agent and handoff.
- Review decisions are captured and mapped to loop logic.
Dependencies:
- gateway-trio-step-work
- gateway-trio-task-refresh

## Task: gateway-trio-step-qa
Slug: gateway-trio-step-qa
Title: Integrate gateway-routed QA step
Description:
Call `GatewayAgentService.run` with job `qa-tasks`, then invoke `QaTasksService.run` for the task using the chosen agent. Ensure QA profile/level/test command flags are passed through if configured.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
- packages/core/src/services/execution/QaTasksService.ts (only if a helper is needed)
Acceptance criteria:
- QA step runs with a gateway-chosen agent and handoff.
- QA outcomes are captured and mapped to loop logic.
Dependencies:
- gateway-trio-step-review
- gateway-trio-task-refresh

## Task: gateway-trio-loop-controller
Slug: gateway-trio-loop-controller
Title: Implement per-task iteration and cycle control
Description:
Add iteration logic that loops work->review->QA until success or stop conditions (max iterations, infra issues, blocked dependencies). Add a cycle loop that re-selects tasks after each pass to pick up newly created follow-ups or unblocked tasks. If a full cycle attempts no tasks, exit with a warning.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
Acceptance criteria:
- Per-task attempts stop at max-iterations.
- Full-cycle loop stops when no tasks are attempted.
- New follow-up tasks are visible in subsequent cycles.
Dependencies:
- gateway-trio-step-qa
- gateway-trio-result-mapping
- gateway-trio-selection-policy

## Task: gateway-trio-blocked-dependencies
Slug: gateway-trio-blocked-dependencies
Title: Skip and revisit tasks blocked by dependencies
Description:
Use TaskSelectionService’s blocked list to skip tasks that are blocked by dependencies unless explicitly requested via `--task`. Surface blocked tasks in the summary and revisit them on later cycles.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
Acceptance criteria:
- Blocked tasks are skipped with a clear reason.
- Blocked tasks are retried in later cycles if dependencies clear.
Dependencies:
- gateway-trio-selection-policy
- gateway-trio-loop-controller

## Task: gateway-trio-state-checkpoints
Slug: gateway-trio-state-checkpoints
Title: Persist gateway-trio state and checkpoints
Description:
Write pipeline state to `.mcoda/jobs/<job_id>/gateway-trio/state.json` and add checkpoints via JobService (similar to other services). Capture per-task attempts, last step, last error, and last chosen agent.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
- packages/core/src/services/jobs/JobService.ts (checkpoint helpers, if needed)
Acceptance criteria:
- State file exists and updates after each step.
- Checkpoints are written at least once per task attempt.
Dependencies:
- gateway-trio-service-skeleton

## Task: gateway-trio-resume
Slug: gateway-trio-resume
Title: Add resume support for gateway-trio runs
Description:
Add a `--resume <JOB_ID>` flag and reuse the state file to continue from the last checkpoint. Decide whether to integrate with JobResumeService or handle resume directly in GatewayTrioService.
Files to touch:
- packages/core/src/services/execution/GatewayTrioService.ts
- packages/core/src/services/jobs/JobResumeService.ts (if integrating)
- packages/cli/src/commands/work/GatewayTrioCommand.ts
Acceptance criteria:
- A pipeline can resume from a previous job id.
- Resume validates job type/manifest consistency before running.
Dependencies:
- gateway-trio-state-checkpoints

## CLI Tasks

## Task: gateway-trio-cli-parser
Slug: gateway-trio-cli-parser
Title: Implement gateway-trio argument parsing
Description:
Add a CLI command with argument parsing for task selectors, iteration limits, gateway flags, and per-step pass-through flags (as defined in the plan). Ensure conflicts like `--task` with `--epic` are rejected consistently with existing commands.
Files to touch:
- packages/cli/src/commands/work/GatewayTrioCommand.ts (new)
Acceptance criteria:
- `mcoda gateway-trio --help` prints accurate usage.
- Invalid combinations return non-zero exit code and clear error text.
Dependencies:
- gateway-trio-flag-surface
- gateway-trio-service-skeleton

## Task: gateway-trio-cli-output
Slug: gateway-trio-cli-output
Title: Implement JSON and human summaries for gateway-trio
Description:
Define output shape for `--json` (job id, command run id, per-task attempts, final status, warnings) and a concise human summary. Match the output ergonomics used by work-on-tasks and code-review.
Files to touch:
- packages/cli/src/commands/work/GatewayTrioCommand.ts
Acceptance criteria:
- JSON output is stable and includes per-task iteration counts.
- Human output is concise and includes blocked/failed tasks.
Dependencies:
- gateway-trio-cli-parser
- gateway-trio-loop-controller

## Task: gateway-trio-entrypoint
Slug: gateway-trio-entrypoint
Title: Wire gateway-trio into CLI entrypoint
Description:
Expose the new command in the CLI entrypoint and usage banner.
Files to touch:
- packages/cli/src/bin/McodaEntrypoint.ts
Acceptance criteria:
- `mcoda gateway-trio` routes to the new command.
- Usage string lists `gateway-trio`.
Dependencies:
- gateway-trio-cli-output

## Testing Tasks

## Task: gateway-trio-core-tests-happy
Slug: gateway-trio-core-tests-happy
Title: Add core tests for the success path
Description:
Create unit tests that simulate a full successful pass (work -> review approve -> QA pass). Use fakes/mocks for gateway and per-step services.
Files to touch:
- packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts (new)
Acceptance criteria:
- Tests pass and verify the success path summary.
Dependencies:
- gateway-trio-loop-controller

## Task: gateway-trio-core-tests-loop
Slug: gateway-trio-core-tests-loop
Title: Add tests for review/QA loopbacks
Description:
Add tests that force review `changes_requested` and QA `fix_required` to ensure the service loops back to work and respects max-iterations.
Files to touch:
- packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts
Acceptance criteria:
- Tests pass and verify looping behavior.
Dependencies:
- gateway-trio-loop-controller

## Task: gateway-trio-core-tests-blocked
Slug: gateway-trio-core-tests-blocked
Title: Add tests for blocked and infra cases
Description:
Add tests for blocked dependency selection and QA `infra_issue` outcomes to verify the pipeline stops or defers correctly.
Files to touch:
- packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts
Acceptance criteria:
- Tests pass and verify blocked/infra behavior.
Dependencies:
- gateway-trio-blocked-dependencies

## Task: gateway-trio-cli-tests-args
Slug: gateway-trio-cli-tests-args
Title: Add CLI argument validation tests
Description:
Add CLI tests for invalid combinations, missing required values, and `--help`.
Files to touch:
- packages/cli/src/__tests__/GatewayTrioCommand.test.ts (new)
Acceptance criteria:
- Tests pass and cover common CLI error paths.
Dependencies:
- gateway-trio-cli-parser

## Task: gateway-trio-cli-tests-json
Slug: gateway-trio-cli-tests-json
Title: Add CLI JSON output tests
Description:
Validate the shape and key fields of `--json` output.
Files to touch:
- packages/cli/src/__tests__/GatewayTrioCommand.test.ts
Acceptance criteria:
- Tests pass and validate JSON output shape.
Dependencies:
- gateway-trio-cli-output

## Documentation Tasks

## Task: gateway-trio-docs-usage
Slug: gateway-trio-docs-usage
Title: Document gateway-trio usage
Description:
Add a short usage section with an example invocation, highlighting the work-review-QA loop and key flags.
Files to touch:
- docs/usage.md
Acceptance criteria:
- Usage doc includes at least one gateway-trio example.
Dependencies:
- gateway-trio-entrypoint

## Task: gateway-trio-docs-sds
Slug: gateway-trio-docs-sds
Title: Add gateway-trio to SDS
Description:
Document how gateway-trio uses the gateway router for each step and iterates on failures. Keep the scope limited to routing/execution sections.
Files to touch:
- docs/sds/sds.md
Acceptance criteria:
- SDS mentions gateway-trio and its work-review-QA loop.
Dependencies:
- gateway-trio-entrypoint
