# Task Ordering Priority Tasks

This document enumerates implementation tasks for the ordering changes in `docs/order-tasks-priority-plan.md`.

---

## Task: ot-01-heuristics-module

**Title**: Add reusable foundation/stage classification helpers  
**Description**:  
Create a small helper module that classifies tasks into `stage` (foundation/backend/frontend/other) and flags `foundation=true` based on type + keyword heuristics. This must be reusable by `TaskOrderingService`, `CreateTasksService`, and `RefineTasksService`.  
Details:  
- Accept `title`, `description`, and `type`.  
- Normalize text (lowercase, strip punctuation).  
- Foundation keywords: `initialize`, `scaffold`, `setup`, `install`, `configure`, `express`, `server`, `openapi`, `spec`, `sds`.  
- Stage keywords:  
  - `foundation`: init/scaffold/setup/install/configure/spec/sds/openapi  
  - `backend`: api/endpoint/server/persistence/db/storage  
  - `frontend`: ui/html/css/dom/render/style  
  - default: `other`  
- If type is `chore`, treat as foundation unless backend/frontend keywords override stage.  
- Return `{ stage, foundation, reasons[] }` where reasons explain which keywords matched (useful for debugging).  
**Files to touch**:  
- `packages/core/src/services/backlog/TaskOrderingHeuristics.ts` (new)  
- `packages/core/src/services/backlog/__tests__/TaskOrderingHeuristics.test.ts` (new)  
**Tests**:  
- Unit: verify stage/foundation detection for multiple titles/types.  
- Component: n/a  
- Integration: n/a  
- API: n/a  
**Dependencies**: none  
**Acceptance Criteria**:  
- Helper module returns deterministic stage/foundation for the specified keywords.  
- Unit tests cover at least 6 representative cases (foundation, backend, frontend, other, chore override, keyword conflict).  

---

## Task: ot-02-ordering-foundation-stage-rank

**Title**: Apply foundation/stage rank before dependency impact  
**Description**:  
Integrate the new heuristics into `TaskOrderingService.compareTasks`. The ordering must first rank by foundation (true first), then by stage order, then dependency impact, then existing priority tiebreakers. Allow stage order override via request.  
Details:  
- Add `stageOrder` to `TaskOrderingRequest` and default to `["foundation","backend","frontend","other"]`.  
- Use metadata if present (`metadata.stage`, `metadata.foundation`); otherwise use heuristics.  
- Compare by foundation (true before false), then stage index, then dependency impact.  
**Files to touch**:  
- `packages/core/src/services/backlog/TaskOrderingService.ts`  
- `packages/core/src/services/backlog/__tests__/TaskOrderingService.test.ts`  
**Tests**:  
- Unit: verify foundation tasks sort before non-foundation even when dependency impact is lower.  
- Component: n/a  
- Integration: n/a  
- API: n/a  
**Dependencies**: ot-01-heuristics-module  
**Acceptance Criteria**:  
- `order-tasks` output prioritizes foundation tasks first when no blocking.  
- Stage ordering follows configured stage list; invalid stage falls to `other`.  

---

## Task: ot-03-missing-context-blocking

**Title**: Treat open missing_context comments as blocked in ordering  
**Description**:  
Extend `TaskOrderingService` to treat tasks with open `missing_context` comments as blocked and push them after unblocked tasks.  
Details:  
- Query `task_comments` for `category='missing_context'` and `status='open'` for the selected task IDs.  
- Add blocked reason into `blockedBy` list (e.g., `missing_context`).  
- Ensure warnings mention how many tasks were blocked by missing_context.  
**Files to touch**:  
- `packages/core/src/services/backlog/TaskOrderingService.ts`  
- `packages/core/src/services/backlog/__tests__/TaskOrderingService.test.ts`  
**Tests**:  
- Unit: create two tasks, add missing_context comment to one, verify it is sorted after unblocked.  
- Component: n/a  
- Integration: n/a  
- API: n/a  
**Dependencies**: none  
**Acceptance Criteria**:  
- Tasks with open missing_context comments are excluded from the top of ordered list.  
- Warnings reflect missing_context blocking.  

---

## Task: ot-04-inject-foundation-deps

**Title**: Auto-inject dependencies on foundation tasks  
**Description**:  
Ensure all non-foundation tasks depend on foundation tasks so the topological sort starts with setup tasks.  
Details:  
- Identify foundation tasks (metadata or heuristics).  
- For each non-foundation task, insert dependency edges to every foundation task if not already present.  
- Use relation_type `inferred_foundation`.  
- Skip edges that would introduce cycles; record warning.  
**Files to touch**:  
- `packages/core/src/services/backlog/TaskOrderingService.ts`  
- `packages/db/src/repositories/workspace/WorkspaceRepository.ts` (if helper needed)  
- `packages/core/src/services/backlog/__tests__/TaskOrderingService.test.ts`  
**Tests**:  
- Unit: non-foundation task gets dependencies inserted; foundation tasks are unchanged.  
- Integration: verify ordering after injection is foundation-first.  
- Component/API: n/a  
**Dependencies**: ot-01-heuristics-module  
**Acceptance Criteria**:  
- Non-foundation tasks now depend on foundation tasks in `task_dependencies`.  
- Ordering is consistent and cycle-free (skips invalid edges).  

---

## Task: ot-05-agent-deps-prompt-parse

**Title**: Add agent-driven dependency inference (prompt + parser)  
**Description**:  
Add a dependency inference mode in `TaskOrderingService` that calls an agent to read all tasks and propose dependencies across epics/stories.  
Details:  
- New method `inferDependenciesWithAgent` returning a list of `{ taskKey, dependsOnKeys[] }`.  
- Prompt must include epics/stories/tasks with titles, descriptions, and current deps.  
- Output JSON schema: `{ "dependencies": [ { "task_key": "...", "depends_on": ["..."] } ] }`.  
- Validate: existing keys only, no self-deps, ignore duplicates.  
**Files to touch**:  
- `packages/core/src/services/backlog/TaskOrderingService.ts`  
- `packages/core/src/services/backlog/__tests__/TaskOrderingService.test.ts`  
**Tests**:  
- Unit: parse valid output, ignore invalid keys/self-deps.  
- Component: n/a  
- Integration: n/a  
- API: n/a  
**Dependencies**: ot-02-ordering-foundation-stage-rank  
**Acceptance Criteria**:  
- Valid agent output produces a normalized dependency list with deduplication.  
- Invalid entries are ignored and warnings recorded.  

---

## Task: ot-06-agent-deps-apply

**Title**: Apply inferred dependencies and re-run ordering  
**Description**:  
Persist agent-inferred dependencies into `task_dependencies` with relation_type `inferred_agent`, then re-run ordering with updated deps.  
Details:  
- Add a `inferDependencies` option to `orderTasks` request.  
- When enabled, call `inferDependenciesWithAgent`, persist, then rebuild nodes/impact/order.  
- Skip edges that introduce cycles; record warnings.  
**Files to touch**:  
- `packages/core/src/services/backlog/TaskOrderingService.ts`  
- `packages/core/src/services/backlog/__tests__/TaskOrderingService.test.ts`  
**Tests**:  
- Integration: after applying inferred deps, ordering reflects new constraints.  
- Unit: cycles are skipped and warnings emitted.  
**Dependencies**: ot-05-agent-deps-prompt-parse  
**Acceptance Criteria**:  
- `order-tasks` can infer and apply deps with stable ordering.  
- Cycle prevention works and does not crash ordering.  

---

## Task: ot-07-order-tasks-cli-flags

**Title**: Extend order-tasks CLI with dependency inference and stage options  
**Description**:  
Add CLI flags to control inference and stage order.  
Details:  
- `--infer-deps` (bool): enable agent inference.  
- `--apply` (bool): persist inferred deps (required when infer-deps is set).  
- `--stage-order foundation,backend,frontend,other` to override default.  
- Update usage text and tests.  
**Files to touch**:  
- `packages/cli/src/commands/backlog/OrderTasksCommand.ts`  
- `packages/cli/src/__tests__/OrderTasksCommand.test.ts`  
**Tests**:  
- Unit: argument parsing for new flags.  
- Integration: command passes request flags to core service.  
**Dependencies**: ot-06-agent-deps-apply  
**Acceptance Criteria**:  
- CLI accepts new flags and passes them to `TaskOrderingService`.  
- Usage text reflects new options.  

---

## Task: ot-08-create-stage-metadata

**Title**: Stamp stage/foundation metadata during create-tasks  
**Description**:  
Integrate heuristics into `CreateTasksService` so tasks get `metadata.stage` and `metadata.foundation` at creation time.  
Details:  
- Merge into existing metadata (doc_links/test_requirements).  
- Preserve existing metadata keys.  
**Files to touch**:  
- `packages/core/src/services/planning/CreateTasksService.ts`  
- `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`  
**Tests**:  
- Unit: created tasks include stage/foundation fields.  
- Integration: ordering uses metadata without re-computation.  
**Dependencies**: ot-01-heuristics-module  
**Acceptance Criteria**:  
- New tasks include stage/foundation metadata in DB.  

---

## Task: ot-09-refine-stage-metadata

**Title**: Maintain stage/foundation metadata during refine-tasks  
**Description**:  
When refine updates title/description/type, recompute stage/foundation metadata.  
Details:  
- Update metadata if the task content changes.  
- If metadata already includes stage/foundation and no relevant edits, keep as-is.  
**Files to touch**:  
- `packages/core/src/services/planning/RefineTasksService.ts`  
- `packages/core/src/services/planning/__tests__/RefineTasksService.test.ts`  
**Tests**:  
- Unit: refine updates stage/foundation when title changes.  
- Integration: no change when updates don’t touch content.  
**Dependencies**: ot-01-heuristics-module  
**Acceptance Criteria**:  
- Refine results persist accurate stage/foundation in metadata.  

---

## Task: ot-10-seed-priority-on-create

**Title**: Seed priorities after create-tasks  
**Description**:  
After creating tasks, invoke ordering to assign explicit priority values.  
Details:  
- Use `TaskOrderingService` with `recordTelemetry=false`.  
- Ensure priorities are written before create-tasks completes.  
**Files to touch**:  
- `packages/core/src/services/planning/CreateTasksService.ts`  
- `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`  
**Tests**:  
- Integration: newly created tasks have non-null priorities.  
**Dependencies**: ot-02-ordering-foundation-stage-rank  
**Acceptance Criteria**:  
- All created tasks have priority values assigned (no NULL).  

---

## Task: ot-11-seed-priority-on-refine

**Title**: Seed priorities after refine-tasks apply  
**Description**:  
After applying refine operations, re-run ordering to normalize priorities.  
Details:  
- Run ordering for the project when `--apply` is used.  
- Avoid agent inference unless explicitly requested.  
**Files to touch**:  
- `packages/core/src/services/planning/RefineTasksService.ts`  
- `packages/core/src/services/planning/__tests__/RefineTasksService.test.ts`  
**Tests**:  
- Integration: priorities updated after refine apply.  
**Dependencies**: ot-02-ordering-foundation-stage-rank  
**Acceptance Criteria**:  
- All affected tasks have updated priorities after refine apply.  

---

## Task: ot-12-selection-priority-order

**Title**: Ensure task selection uses ascending priority  
**Description**:  
Fix selection ordering so priority `1` is chosen first by work-on-tasks and gateway-trio.  
Details:  
- Update `TaskSelectionService` queue sorting to order by ascending priority (lower is earlier).  
- Keep SP, created_at, and status tiebreakers.  
**Files to touch**:  
- `packages/core/src/services/execution/TaskSelectionService.ts`  
- `packages/core/src/services/execution/__tests__/TaskSelectionService.test.ts`  
**Tests**:  
- Unit: verify priority 1 task is selected before priority 2.  
**Dependencies**: ot-10-seed-priority-on-create  
**Acceptance Criteria**:  
- Work-on-tasks selection uses lowest priority number first.  

---

## Task: ot-13-selection-missing-context-block

**Title**: Block tasks with open missing_context comments in selection  
**Description**:  
Align selection with ordering by treating missing_context tasks as blocked in `TaskSelectionService`.  
Details:  
- Load missing_context comments for candidate task IDs.  
- Mark those tasks as blocked unless explicitly requested.  
**Files to touch**:  
- `packages/core/src/services/execution/TaskSelectionService.ts`  
- `packages/core/src/services/execution/__tests__/TaskSelectionService.test.ts`  
**Tests**:  
- Unit: tasks with open missing_context are blocked.  
**Dependencies**: ot-03-missing-context-blocking  
**Acceptance Criteria**:  
- Selection excludes missing_context tasks from ordered list.  

---

## Task: ot-14-tests-runall-registration

**Title**: Register new tests in run-all script  
**Description**:  
Ensure any new test files that are not auto-discovered are included in `tests/all.js`.  
Details:  
- Add dist test paths for new core tests if needed.  
- Verify `node tests/all.js` runs and reports completion marker.  
**Files to touch**:  
- `tests/all.js`  
**Tests**:  
- Integration: `node tests/all.js` completes successfully.  
**Dependencies**: ot-02-ordering-foundation-stage-rank, ot-08-create-stage-metadata, ot-09-refine-stage-metadata, ot-12-selection-priority-order  
**Acceptance Criteria**:  
- All new tests are executed by `node tests/all.js` without manual overrides.  

