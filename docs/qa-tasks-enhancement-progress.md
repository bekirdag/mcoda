# QA Tasks Enhancement Progress

## Current Status
Completed

## Checklist
- [x] Create implementation plan document
- [x] Add CLI project fallback resolution helper (explicit -> configured -> first workspace project)
- [x] Add CLI flags for dependency and no-changes policy
- [x] Wire new policy/debug flags through QaTasksApi
- [x] Extend QaTasksService request model for new policies
- [x] Make task selection dependency behavior policy-driven
- [x] Implement no-change policy modes: `require_qa`, `skip`, `manual`
- [x] Fix QA doc context project scoping (project key, not project id)
- [x] Make QA doc context SDS/OpenAPI-first with fallback
- [x] Gate verbose QA prompt logging behind debug
- [x] Add/adjust CLI unit tests for parser + project fallback picker
- [x] Add/adjust QA service tests for no-change policies and project-key doc scope
- [x] Run targeted tests and iterate on failures
- [x] Run broader affected-package tests
- [x] Final review and residual-risk note

## Files Changed
- `docs/qa-tasks-enhancement-implementation-plan.md`
- `docs/qa-tasks-enhancement-progress.md`
- `packages/cli/src/commands/planning/QaTasksCommand.ts`
- `packages/core/src/api/QaTasksApi.ts`
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/cli/src/__tests__/QaTasksCommand.test.ts`
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

## Test Log
1. `pnpm --filter @mcoda/core run test`
- Result: pass
- Notes: Includes QA service regression tests and broader core suite; no failures.

2. `pnpm --filter mcoda run test`
- Result: pass
- Notes: Includes QA command parser/behavior tests and broader CLI suite; no failures.

3. `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda`
- Result: pass (`success=true`, `exit_code=0`, `duration_ms=37237`)
- Notes: Workspace-wide build+test orchestration passed across packages.

## Residual Risk Note
- `docdex_impact_graph` returned sparse/empty edges during this iteration for QA files, so dependency-safety confidence relied on direct tests rather than graph traversal evidence.
- Existing verbose command logs in other services are outside this QA-focused scope and were not changed here.
