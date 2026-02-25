# QA Tasks Enhancement Implementation Plan

## Objective
Align `mcoda qa-tasks` with the SDS-first workflow:
- RFP -> PDR -> SDS -> OpenAPI -> create/refine/order -> work -> code-review -> qa
- SDS remains the single source of truth.
- QA should validate implementation outcomes and avoid unsafe default shortcuts.

## Scope
- CLI: `packages/cli/src/commands/planning/QaTasksCommand.ts`
- API adapter: `packages/core/src/api/QaTasksApi.ts`
- Service: `packages/core/src/services/execution/QaTasksService.ts`
- Tests:
  - `packages/cli/src/__tests__/QaTasksCommand.test.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

## Problems To Fix
1. Project key fallback in `qa-tasks` was inconsistent with other commands.
2. QA doc context used `task.projectId` as `projectKey` in Docdex search.
3. QA context retrieval was not explicitly SDS/OpenAPI-first.
4. QA selection always ignored dependencies.
5. `review_no_changes` shortcut defaulted to skip QA execution.
6. Full prompt logging was always on, not debug-gated.

## Implementation Tasks
1. CLI project fallback parity
- Add workspace project listing and fallback selection helper.
- Use precedence: explicit `--project` -> workspace configured project key -> first workspace project.
- Keep warning output when fallback decisions are made.

2. CLI policy surface
- Add `--dependency-policy enforce|ignore` (default `enforce`).
- Add `--no-changes-policy require_qa|skip|manual` (default `require_qa`).
- Forward policies and `debug` flag into API/service request.

3. Service request model
- Extend `QaTasksRequest` with:
  - `dependencyPolicy`
  - `noChangesPolicy`
  - `debug`
- Normalize effective policy values for resume and non-resume runs.

4. Dependency-aware task selection
- Use `ignoreDependencies = (dependencyPolicy === "ignore")` in selection.
- Persist selected policy in job payload for resumed jobs.

5. Safe no-changes policy behavior
- `skip`: preserve existing quick-pass behavior.
- `manual`: create unclear QA outcome and open issue comment; no auto completion transition.
- `require_qa` (default): continue full QA execution path even if review diff is empty.

6. SDS/OpenAPI-first doc context retrieval
- Resolve effective project key for each task (request project key first, then project-id lookup).
- In doc context retrieval, prioritize Docdex searches in order:
  - SDS (`docType: SDS`)
  - OpenAPI (`docType: OPENAPI`)
  - QA profile fallback only when structured context is absent.
- Keep context filtering and linked-doc behavior.

7. Debug-gated prompt logging
- Move verbose prompt/task logs behind `request.debug`.

8. Regression tests
- CLI parser tests for new policy defaults/flags and project-key picker behavior.
- QA service tests for:
  - skip mode for no-change tasks
  - default require_qa behavior
  - manual no-change behavior
  - project-key-scoped Docdex searches

## Validation Plan
1. Run focused command tests.
2. Run focused QA service tests.
3. If green, run package-level tests for affected packages.
4. Capture test commands/results in progress doc.

## Out of Scope (this iteration)
- Reworking full QA ordering semantics across unrelated command families.
- New DB schema/migration changes.
- UI formatting changes for command output.
