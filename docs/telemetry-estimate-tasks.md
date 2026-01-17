# Telemetry + Estimate Implementation Tasks

These tasks implement `docs/telemetry-estimate-plan.md`. Each task is intentionally small and decoupled so we can test and ship in increments.

## Task 01

- **Slug:** telemetry-db-token-columns
- **Title:** Add cached token and timing columns to token_usage
- **Description:**  
  Expand the workspace and global `token_usage` tables to persist cached-token data and explicit timing fields. This must cover both fresh DBs (CREATE TABLE) and existing DBs (ALTER TABLE). Add columns for cached token usage (`tokens_cached`, `tokens_cache_read`, `tokens_cache_write`), plus explicit timestamps (`started_at`, `finished_at`, `duration_ms`) and telemetry attributes (`command_name`, `action`, `invocation_kind`, `provider`, `currency`). Keep new columns nullable and additive. Add indexes only if they do not change existing query plans (avoid large migrations). Update migration tests to validate new columns exist.
- **Files to touch:**  
  `packages/db/src/migrations/workspace/WorkspaceMigrations.ts`  
  `packages/db/src/migrations/global/GlobalMigrations.ts`  
  `packages/db/src/__tests__/WorkspaceMigrations.test.ts`  
  `packages/db/src/__tests__/GlobalRepository.test.ts`
- **Unit tests:**  
  `packages/db/src/__tests__/WorkspaceMigrations.test.ts` (assert columns exist)  
  `packages/db/src/__tests__/GlobalRepository.test.ts` (token_usage insert/select with new nullable columns)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** none
- **Acceptance criteria:**  
  - Workspace and global DB migrations include the new nullable token_usage columns.  
  - Migration tests assert the columns are present for new DBs.  
  - Existing inserts remain valid without requiring new fields.

## Task 02

- **Slug:** telemetry-db-job-agent-fields
- **Title:** Add agent attribution fields to jobs and command_runs
- **Description:**  
  Extend workspace `jobs` and `command_runs` to store `agent_id` and `agent_ids_json` (for multi-agent flows). Update schema and migration tests. Ensure columns are nullable and do not require backfill at migration time.
- **Files to touch:**  
  `packages/db/src/migrations/workspace/WorkspaceMigrations.ts`  
  `packages/db/src/__tests__/WorkspaceMigrations.test.ts`
- **Unit tests:**  
  `packages/db/src/__tests__/WorkspaceMigrations.test.ts` (assert columns exist)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Task 01
- **Acceptance criteria:**  
  - `jobs` and `command_runs` tables include nullable agent attribution columns.  
  - Migration tests cover the new columns.

## Task 03

- **Slug:** telemetry-db-task-status-events
- **Title:** Add task_status_events table for status transitions
- **Description:**  
  Introduce a `task_status_events` table in the workspace DB to track status changes with timestamps. Include columns for task/job/command context: `task_id`, `from_status`, `to_status`, `timestamp`, `command_name`, `job_id`, `task_run_id`, `agent_id`, and `metadata_json`. Add a basic index on `(task_id, timestamp)` for query efficiency. Update migration tests to assert table existence.
- **Files to touch:**  
  `packages/db/src/migrations/workspace/WorkspaceMigrations.ts`  
  `packages/db/src/__tests__/WorkspaceMigrations.test.ts`
- **Unit tests:**  
  `packages/db/src/__tests__/WorkspaceMigrations.test.ts` (table exists + index check if covered)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** none
- **Acceptance criteria:**  
  - `task_status_events` table exists with the required columns.  
  - Index on `(task_id, timestamp)` is created (if the test asserts it).  
  - Migration tests confirm table availability.

## Task 04

- **Slug:** telemetry-repo-token-usage-extensions
- **Title:** Extend repository token usage types and inserts
- **Description:**  
  Update `TokenUsageInsert` and `GlobalTokenUsageInsert` to accept cached tokens and explicit timing fields. Update insert queries in `WorkspaceRepository.recordTokenUsage` and `GlobalRepository.recordTokenUsage` to write new columns. Keep all new fields optional and null-safe. Add or extend unit tests to insert and read the new columns. Make sure JSON metadata still works unchanged.
- **Files to touch:**  
  `packages/db/src/repositories/workspace/WorkspaceRepository.ts`  
  `packages/db/src/repositories/global/GlobalRepository.ts`  
  `packages/db/src/__tests__/GlobalRepository.test.ts`  
  `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts`
- **Unit tests:**  
  `packages/db/src/__tests__/GlobalRepository.test.ts`  
  `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts` (extend token usage seed to include cached/timing)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Tasks 01–03
- **Acceptance criteria:**  
  - Repository insert functions accept new optional fields without breaking existing callers.  
  - New fields are written to DB when provided.  
  - Tests validate persistence of cached/timing columns.

## Task 05

- **Slug:** telemetry-jobservice-recording
- **Title:** Extend JobService token usage recording API
- **Description:**  
  Expand `JobService.TokenUsageRecord` and `recordTokenUsage` to accept cached token usage, explicit timing fields (`startedAt`, `finishedAt`, `durationMs`), and telemetry attributes (`commandName`, `action`, `invocationKind`, `provider`, `currency`). Update JSON file logging to include new fields. Ensure conversion to DB columns matches the repository changes and remains backward compatible.
- **Files to touch:**  
  `packages/core/src/services/jobs/JobService.ts`  
  `packages/db/src/repositories/workspace/WorkspaceRepository.ts`
- **Unit tests:**  
  `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts` (validate new fields flow through via JobService)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Task 04
- **Acceptance criteria:**  
  - JobService accepts and passes new token usage fields to the repository.  
  - JSON file telemetry mirrors new fields.  
  - Existing call sites compile without required updates.

## Task 06

- **Slug:** telemetry-agent-usage-extraction
- **Title:** Parse cached token usage from agent responses
- **Description:**  
  Extend `AgentsApi.extractTokenUsage` to parse cached token usage and any timing fields exposed by adapters. Update agent-run/test calls to pass cached tokens and duration fields to JobService when available. Keep parsing tolerant of missing or adapter-specific keys. Add unit tests covering cached token extraction and persistence.
- **Files to touch:**  
  `packages/core/src/api/AgentsApi.ts`  
  `packages/core/src/services/agents/__tests__/AgentRatingService.test.ts`
- **Unit tests:**  
  `packages/core/src/services/agents/__tests__/AgentRatingService.test.ts` (add cached token coverage)  
  `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts` (if needed for cached token visibility)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Task 05
- **Acceptance criteria:**  
  - Cached tokens from agent metadata are parsed and recorded when present.  
  - Tests validate cached token extraction without regressions to existing usage fields.

## Task 07

- **Slug:** telemetry-task-status-events-writer
- **Title:** Record task status transitions on state changes
- **Description:**  
  Add repository support for inserting `task_status_events`. Extend `TaskStateService` to record events for transitions to `in_progress`, `ready_to_review`, `ready_to_qa`, `completed`, and `blocked`. Update call sites (WorkOnTasksService, CodeReviewService, QaTasksService) to supply context: `command_name`, `job_id`, `task_run_id`, `agent_id`. Ensure metadata includes lane-specific details when available.
- **Files to touch:**  
  `packages/db/src/repositories/workspace/WorkspaceRepository.ts`  
  `packages/core/src/services/execution/TaskStateService.ts`  
  `packages/core/src/services/execution/WorkOnTasksService.ts`  
  `packages/core/src/services/review/CodeReviewService.ts`  
  `packages/core/src/services/execution/QaTasksService.ts`  
  `packages/core/src/services/execution/__tests__/TaskStateService.test.ts`
- **Unit tests:**  
  `packages/core/src/services/execution/__tests__/TaskStateService.test.ts` (assert status events are written)  
  `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (if needed to cover context propagation)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Tasks 02–05
- **Acceptance criteria:**  
  - Every status transition writes a `task_status_events` row with correct context.  
  - TaskStateService remains the single place for status updates in execution flows.  
  - Tests cover at least one transition with event verification.

## Task 08

- **Slug:** telemetry-api-contract-update
- **Title:** Update telemetry API contracts and types
- **Description:**  
  Extend Telemetry client/types and OpenAPI definitions to include cached tokens and timing fields in `TokenUsageRow`. Ensure `TokenUsageSummaryRow` remains compatible, but consider adding cached totals if needed. Update shared OpenAPI TypeScript declarations accordingly. Keep backwards compatibility by making new fields optional.
- **Files to touch:**  
  `openapi/mcoda.yaml`  
  `packages/integrations/src/telemetry/TelemetryClient.ts`  
  `packages/shared/src/openapi/OpenApiTypes.d.ts`  
  `packages/shared/dist/openapi/OpenApiTypes.d.ts`
- **Unit tests:** none (type-only)
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Tasks 01–05
- **Acceptance criteria:**  
  - OpenAPI spec includes new telemetry fields.  
  - Shared OpenAPI types compile and match the spec.  
  - TelemetryClient interfaces expose new fields as optional.

## Task 09

- **Slug:** telemetry-service-and-cli-output
- **Title:** Surface cached tokens and duration in telemetry output
- **Description:**  
  Update `TelemetryService.getTokenUsage` mapping to expose cached token fields and explicit timing fields. Extend `mcoda tokens` output to include cached tokens and duration columns. Update job inspect token summaries to include cached usage as well. Add CLI tests to verify new columns render deterministically.
- **Files to touch:**  
  `packages/core/src/services/telemetry/TelemetryService.ts`  
  `packages/cli/src/commands/telemetry/TelemetryCommands.ts`  
  `packages/cli/src/commands/jobs/JobsCommands.ts`  
  `packages/cli/src/__tests__/TelemetryCommands.test.ts` (add if missing)  
  `packages/cli/src/__tests__/JobsCommands.test.ts` (extend existing token summary tests)
- **Unit tests:**  
  `packages/core/src/services/telemetry/__tests__/TelemetryService.test.ts`
- **Component tests:**  
  `packages/cli/src/__tests__/TelemetryCommands.test.ts`  
  `packages/cli/src/__tests__/JobsCommands.test.ts`
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Tasks 04–08
- **Acceptance criteria:**  
  - TelemetryService returns cached token and timing fields.  
  - `mcoda tokens` displays cached token totals and duration.  
  - Job token summaries include cached token data.  
  - CLI tests are updated and deterministic.

## Task 10

- **Slug:** estimate-velocity-from-status-events
- **Title:** Derive lane velocity from status transition history
- **Description:**  
  Update VelocityService to compute lane velocities from `task_status_events` and/or `task_runs` (per task) instead of command-run duration. Use status transitions to measure lane durations: `in_progress→ready_to_review` (work), `ready_to_review→ready_to_qa` (review), `ready_to_qa→completed` (qa). Fall back to task_runs when status events are missing. Keep existing config/empirical modes intact. Add unit tests to validate lane durations and fallback behavior.
- **Files to touch:**  
  `packages/core/src/services/estimate/VelocityService.ts`  
  `packages/core/src/services/estimate/__tests__/VelocityAndEstimate.test.ts`
- **Unit tests:**  
  `packages/core/src/services/estimate/__tests__/VelocityAndEstimate.test.ts`
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Tasks 03 and 07
- **Acceptance criteria:**  
  - Empirical velocity uses status-event durations per lane when available.  
  - Fallback to prior logic occurs when events are missing.  
  - Tests cover per-lane timing and fallback.

## Task 11

- **Slug:** estimate-eta-pipeline
- **Title:** Update ETA calculation to reflect pipeline and WIP
- **Description:**  
  Adjust EstimateService to compute lane ETAs based on per-lane durations and current WIP counts. Use backlog totals split by lane and per-lane velocity to predict the next transition (ready_to_review, ready_to_qa, complete). Where available, include elapsed time already spent in a lane for in-progress tasks. Update tests to cover new ETA output shape/values.
- **Files to touch:**  
  `packages/core/src/services/estimate/EstimateService.ts`  
  `packages/core/src/services/estimate/__tests__/VelocityAndEstimate.test.ts`
- **Unit tests:**  
  `packages/core/src/services/estimate/__tests__/VelocityAndEstimate.test.ts`
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Task 10
- **Acceptance criteria:**  
  - ETA outputs reflect per-lane durations and do not rely solely on max-of-lanes.  
  - In-progress lane time is accounted for when data is available.  
  - Tests validate ETA logic.

## Task 12

- **Slug:** telemetry-estimate-docs-alignment
- **Title:** Update SDS/usage docs for telemetry + estimate changes
- **Description:**  
  Update SDS and usage docs to reflect new telemetry fields, cached token usage, and status-based estimate logic. Ensure documentation matches the schema and CLI output changes, and is explicit about optional fields. Keep changes concise and aligned with the new behavior.
- **Files to touch:**  
  `docs/sds/sds.md`  
  `docs/usage.md`
- **Unit tests:** none
- **Component tests:** none
- **Integration tests:** none
- **API tests:** none
- **Dependencies:** Tasks 01–11
- **Acceptance criteria:**  
  - Docs mention cached token fields and explicit timing fields.  
  - Estimate description references status-event based lane timing.

