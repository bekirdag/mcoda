# Task Ordering Priority Plan

## Goals
- Ensure `mcoda order-tasks` produces an imperative, stable priority list (1..N) where the earliest tasks are true setup/foundation work.
- Make ordering deterministic across epics and stories while still honoring dependencies and blockers.
- Enable agent-assisted dependency inference so foundational tasks become prerequisites for all non-foundation tasks.
- Guarantee `work-on-tasks` and `gateway-trio` pick the first prioritized task.

## Scope
- Task ordering logic in `packages/core/src/services/backlog/TaskOrderingService.ts`.
- Task creation/refinement services in `packages/core/src/services/planning/CreateTasksService.ts` and `packages/core/src/services/planning/RefineTasksService.ts`.
- Dependency persistence in `task_dependencies` and priority fields in `tasks`.
- Selection logic in `WorkOnTasksService` and `GatewayTrioService` (use task priority).
- CLI flags for order-tasks and refine/create flows.

## Non-Goals
- Rewriting the entire planning workflow or agent stack.
- Changing the semantics of task status states beyond ordering behavior.

## Data Model Updates
- Add `metadata.stage` (string) and `metadata.foundation` (boolean) on tasks.
- Optional: add a `stage` column to tasks if metadata becomes too opaque (keep in metadata first for minimal schema change).
- Store inferred dependencies in `task_dependencies` with `relation_type` = `inferred_foundation` or `inferred_agent`.

## Ordering Strategy (Core Changes)
1. **Foundation-first rank**: in `compareTasks`, compute `foundationScore` before dependency impact:
   - True if `type=chore` or keywords in title/description: initialize, scaffold, setup, install, configure, express, server, openapi, spec, sds.
   - Foundation tasks always sort before non-foundation tasks.
2. **Stage rank**: use `metadata.stage` with ordering: `foundation` -> `backend` -> `frontend` -> `other`.
   - Stage rank applied before dependency impact.
3. **Blocked detection**: treat tasks with open `missing_context` comments as blocked.
   - Query `task_comments` for category `missing_context` + status `open`, add to blocked set and `blockedBy`.
4. **Dependency impact and existing tiebreakers**: keep dependency impact, then priority, then story points, then created_at, then status rank.

## Auto-Inject Dependencies (Foundation)
1. Identify foundation tasks for the project (stage=foundation or foundationScore=true).
2. For every non-foundation task, create dependencies on the foundation task set if missing.
3. Persist as `inferred_foundation` dependencies in `task_dependencies`.
4. Protect against cycles: if a dependency would create a cycle, skip and log a warning.

## Agent-Assisted Dependency Inference
1. Add an `order-tasks --infer-deps --apply` mode.
2. Agent reads all tasks, grouped by epic and story, and emits JSON dependencies:
   - Output format: `{ "dependencies": [ { "task_key": "...", "depends_on": ["..."] } ] }`.
3. Validate agent output:
   - Task keys must exist.
   - No self-deps.
   - Avoid cycles (detect and reject edges that introduce cycles).
4. Persist inferred edges with `relation_type = inferred_agent`.
5. Re-run ordering after dependency injection.

## Create/Refine Priority Seeding
1. During `create-tasks`, compute initial `metadata.stage` and `foundation` flags via keyword/type heuristics.
2. Seed priority values using the ordering engine right after task creation.
3. During `refine-tasks`, re-evaluate stage/foundation metadata for new or edited tasks and re-seed priorities.
4. If `--apply` is used in refine, persist stage metadata and re-run ordering with injected dependencies.

## Work-On-Tasks + Gateway-Trio Alignment
- Update selection logic to prefer the lowest `priority` task from the ordered list.
- If priorities are missing, rely on the fallback ordering while create/refine seeding eliminates new NULLs.

## CLI/UX Additions
- `mcoda order-tasks --infer-deps [--apply]` to generate and persist dependencies.
- `mcoda order-tasks --stage-order foundation,backend,frontend,other` to allow overrides.
- Priority seeding runs automatically during create/refine (no flags required).

## Risks & Mitigations
- **Token limits for agent inference**: chunk by epic/story, then merge; fallback to heuristics.
- **Cycles introduced by inference**: detect and skip edges; report warnings.
- **Over-blocking**: only treat `missing_context` with status `open` as blocked.

## Validation
- Unit tests for foundationScore and stageRank ordering.
- Unit tests for blocked-by-missing-context.
- Integration test for auto-injected dependencies and topological order.
- CLI tests for `order-tasks` new flags.
