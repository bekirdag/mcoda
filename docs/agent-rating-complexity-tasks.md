# Tasks: Agent Rating + Dynamic Complexity Evaluation

Each task includes a slug, title, detailed description, tests to write, files to touch, dependencies, and acceptance criteria. Tests are listed by type (unit/component/integration/api) where relevant.

## Task 1
Slug: arcx-01-global-schema-agent-fields  
Title: Add agent rating + complexity fields to global schema  
Description:  
- Extend the global `agents` table with `max_complexity`, `rating_samples`, `rating_last_score`, `rating_updated_at`, `complexity_samples`, `complexity_updated_at`.  
- Update `GlobalMigrations` to add columns when missing and set defaults (`max_complexity = 5`, `rating_samples = 0`, `complexity_samples = 0`).  
- Update shared OpenAPI types (`Agent`, `CreateAgentInput`, `UpdateAgentInput`) to surface new fields.  
- Update `GlobalRepository` mapping and update logic to include new columns.  
Unit tests:  
- `packages/db/src/__tests__/GlobalMigrations.test.ts`: ensure new columns exist after migration.  
- `packages/db/src/__tests__/GlobalRepository.test.ts` (new if missing): create/update agent with new fields and verify persisted values.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/db/src/migrations/global/GlobalMigrations.ts`  
- `packages/db/src/repositories/global/GlobalRepository.ts`  
- `packages/shared/src/openapi/OpenApiTypes.ts`  
- `packages/db/src/__tests__/GlobalMigrations.test.ts`  
- `packages/db/src/__tests__/GlobalRepository.test.ts` (create if not present)  
Dependencies:  
- None  
Acceptance criteria:  
- New columns are added and backfilled with defaults.  
- Agent CRUD returns and persists new fields.  
- Tests pass for migration and repository updates.

## Task 2
Slug: arcx-02-global-agent-run-ratings  
Title: Add agent run ratings table + repository methods  
Description:  
- Add `agent_run_ratings` table to global DB with per-run metrics and reviewer results.  
- Add repository methods: `insertAgentRunRating`, `listAgentRunRatings(agentId, limit)`.  
- Add unit test coverage for insert/list behavior.  
Unit tests:  
- `packages/db/src/__tests__/GlobalRepository.test.ts`: insert + list agent run ratings.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/db/src/migrations/global/GlobalMigrations.ts`  
- `packages/db/src/repositories/global/GlobalRepository.ts`  
- `packages/db/src/__tests__/GlobalRepository.test.ts`  
Dependencies:  
- Task 1  
Acceptance criteria:  
- `agent_run_ratings` exists in global DB.  
- Repository can persist and read run ratings.  
- Tests pass.

## Task 3
Slug: arcx-03-rating-formula-module  
Title: Add rating formula and normalization helpers  
Description:  
- Implement a reusable scoring module with:  
  - normalization against budgets (cost, time, iterations).  
  - score formula with weights.  
  - EMA update helper for ratings.  
- Provide defaults and allow override via config (optional for now).  
Unit tests:  
- `packages/core/src/services/agents/__tests__/AgentRatingFormula.test.ts` (new) to validate score boundaries and EMA updates.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/agents/AgentRatingFormula.ts` (new)  
- `packages/core/src/services/agents/__tests__/AgentRatingFormula.test.ts` (new)  
Dependencies:  
- Task 1  
Acceptance criteria:  
- Formula outputs are stable and bounded (0-10).  
- EMA update matches expected alpha behavior.  
- Tests pass.

## Task 4
Slug: arcx-04-rating-service-core  
Title: Implement AgentRatingService  
Description:  
- Build `AgentRatingService` to:  
  - Load token usage totals for a job/task/command run (sum, not average).  
  - Compute total duration from `command_runs` or job timestamps.  
  - Derive iterations from token usage metadata (`phase`/`action`) and/or task logs.  
  - Calculate total cost using `cost_per_million`.  
  - Call reviewer agent (default system agent) to produce a `quality_score`.  
  - Compute run score and update `agents.rating`/`reasoning_rating`, `rating_samples`, `rating_last_score`.  
  - Update `max_complexity` with promotion/demotion logic and apply a cooldown to prevent oscillation.  
  - Write a `rating.json` artifact under `<workspace-dir>/jobs/<jobId>/`.  
  - Persist `agent_run_ratings` record.  
- Use `RoutingService` with command name `agent-rating` to resolve reviewer agent, fallback to default.  
Unit tests:  
- `packages/core/src/services/agents/__tests__/AgentRatingService.test.ts` (new):  
  - aggregates token usage, duration, and iterations.  
  - updates ratings and max complexity.  
  - stores run rating record.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/agents/AgentRatingService.ts` (new)  
- `packages/core/src/services/agents/__tests__/AgentRatingService.test.ts` (new)  
- `packages/core/src/services/agents/AgentRatingFormula.ts`  
- `packages/core/src/services/jobs/JobService.ts` (if helper needed to read token usage)  
- `packages/core/src/services/telemetry/TelemetryService.ts` (if helper needed)  
Dependencies:  
- Tasks 1-3  
Acceptance criteria:  
- Rating service computes and persists rating outputs.  
- Reviewer agent is invoked and parsed.  
- Agent record updated with rating + complexity fields.  
- Tests pass.

## Task 13
Slug: arcx-13-agent-ratings-cli  
Title: Add `mcoda agent ratings` CLI view  
Description:  
- Add `AgentsApi.listAgentRunRatings(agentSlug, limit)` to fetch recent ratings.  
- Extend `mcoda agent` CLI with a `ratings` subcommand that prints a table (or JSON with `--json`).  
- Support `--agent <slug>` and `--last <N>` (default 50).  
Unit tests:  
- `packages/cli/src/__tests__/AgentsCommands.test.ts`: seed an agent run rating and verify the output includes the command/task keys.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/api/AgentsApi.ts`  
- `packages/cli/src/commands/agents/AgentsCommands.ts`  
- `packages/cli/src/__tests__/AgentsCommands.test.ts`  
Dependencies:  
- Task 2  
Acceptance criteria:  
- `mcoda agent ratings --agent <slug>` renders recent ratings.  
- JSON output works with `--json`.  
- Tests pass.

## Task 5
Slug: arcx-05-reviewer-prompt  
Title: Add default reviewer prompt and command metadata  
Description:  
- Add a default prompt template for `agent-rating` reviewers (similar to other prompts).  
- Ensure the prompt is stored/loaded from `<workspace-dir>/prompts/agent-rating.md`.  
- Add `agent-rating` to command metadata/capabilities (fallback list and/or OpenAPI extension).  
Unit tests:  
- `packages/shared/src/__tests__/CommandMetadata.test.ts`: ensure `agent-rating` is recognized.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/shared/src/metadata/CommandMetadata.ts`  
- `packages/shared/src/__tests__/CommandMetadata.test.ts`  
- `packages/core/src/services/agents/AgentRatingService.ts` (prompt creation)  
Dependencies:  
- Task 4  
Acceptance criteria:  
- Reviewer prompt file is created if missing.  
- `agent-rating` command resolves required capabilities.  
- Tests pass.

## Task 6
Slug: arcx-06-cli-flag-rate-agents  
Title: Add `--rate-agents` flag to all agent-driven commands  
Description:  
- Extend CLI argument parsing for:  
  - `docs` (pdr/sds/openapi from docs)  
  - `create-tasks`, `refine-tasks`, `order-tasks`  
  - `work-on-tasks`, `code-review`, `qa-tasks`  
  - `gateway-agent`, `gateway-trio`  
- Propagate `rateAgents` into service APIs.  
- Document flag in `docs/usage.md`.  
Unit tests:  
- Update CLI parse tests for each command to include `--rate-agents`.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/cli/src/commands/**` (all agent-driven commands)  
- `packages/cli/src/__tests__/*` (parse tests)  
- `docs/usage.md`  
Dependencies:  
- Task 4  
Acceptance criteria:  
- All commands accept `--rate-agents`.  
- Parsed arguments propagate to core services.  
- CLI tests pass.

## Task 7
Slug: arcx-07-service-hook-work-on-tasks  
Title: Rate agents after work-on-tasks completion  
Description:  
- Hook `AgentRatingService` into `WorkOnTasksService` when `rateAgents` is true.  
- Rate per task run (agent that performed the task).  
- Ensure rating uses aggregated token usage for that task run.  
- Write rating artifacts and store `agent_run_ratings` rows.  
Unit tests:  
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`: verify rating is invoked and updates agent record.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/execution/WorkOnTasksService.ts`  
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`  
Dependencies:  
- Tasks 4, 6  
Acceptance criteria:  
- Ratings are recorded after work-on-tasks runs.  
- Agent rating/complexity updates persist.  
- Tests pass.

## Task 8
Slug: arcx-08-service-hook-code-review  
Title: Rate agents after code-review completion  
Description:  
- Hook `AgentRatingService` into `CodeReviewService` when `rateAgents` is true.  
- Use reviewer output + QA results (if any) in rating context.  
Unit tests:  
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`: verify rating hook triggers and updates agent record.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/review/CodeReviewService.ts`  
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`  
Dependencies:  
- Tasks 4, 6  
Acceptance criteria:  
- Rating recorded after code-review runs.  
- Tests pass.

## Task 9
Slug: arcx-09-service-hook-qa  
Title: Rate agents after QA completion  
Description:  
- Hook `AgentRatingService` into `QaTasksService` when `rateAgents` is true.  
- Use QA outcome details in rating context (pass/fail/infra issue).  
Unit tests:  
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`: verify rating hook triggers.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/execution/QaTasksService.ts`  
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`  
Dependencies:  
- Tasks 4, 6  
Acceptance criteria:  
- Rating recorded after QA runs.  
- Tests pass.

## Task 10
Slug: arcx-10-service-hook-docs-planning  
Title: Rate agents after docs/planning jobs  
Description:  
- Add rating hooks to:  
  - `DocsService` (PDR/SDS generation)  
  - `CreateTasksService`, `RefineTasksService`, `OpenApiService`  
- Use command-level rating for non-task jobs.  
Unit tests:  
- `packages/core/src/services/docs/__tests__/DocsService.test.ts`  
- `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`  
- `packages/core/src/services/planning/__tests__/RefineTasksService.test.ts`  
- `packages/core/src/services/openapi/__tests__/OpenApiService.test.ts`  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/docs/DocsService.ts`  
- `packages/core/src/services/planning/CreateTasksService.ts`  
- `packages/core/src/services/planning/RefineTasksService.ts`  
- `packages/core/src/services/openapi/OpenApiService.ts`  
- Related test files  
Dependencies:  
- Tasks 4, 6  
Acceptance criteria:  
- Ratings recorded for docs/planning jobs when enabled.  
- Tests pass.

## Task 11
Slug: arcx-11-gateway-max-complexity  
Title: Add max complexity gating and exploration to gateway selection  
Description:  
- Extend gateway candidate selection to filter by `max_complexity`.  
- Implement epsilon-greedy exploration:  
  - Redemption run for low-rated agents on low complexity.  
  - Stretch run for high-rated agents at `max_complexity + 1`.  
- Log rationale and exploration choice in gateway analysis.  
Unit tests:  
- `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts` to verify:  
  - filtering by `max_complexity`.  
  - exploration selection path.  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `packages/core/src/services/agents/GatewayAgentService.ts`  
- `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts`  
Dependencies:  
- Task 1  
Acceptance criteria:  
- Gateway uses max complexity limits.  
- Exploration path is executed with expected probability.  
- Tests pass.

## Task 12
Slug: arcx-12-documentation  
Title: Update docs for rating + complexity  
Description:  
- Document `--rate-agents` flag and rating behavior in `docs/usage.md`.  
- Add summary of agent rating + complexity logic to `docs/sds/sds.md`.  
- Mention new reviewer prompt in `README.md` or package READMEs if needed.  
Unit tests:  
- N/A  
Component tests:  
- N/A  
Integration tests:  
- N/A  
API tests:  
- N/A  
Files to touch:  
- `docs/usage.md`  
- `docs/sds/sds.md`  
- `README.md` (optional)  
Dependencies:  
- Tasks 6, 11  
Acceptance criteria:  
- Docs describe rating mechanism, exploration, and complexity gating.
