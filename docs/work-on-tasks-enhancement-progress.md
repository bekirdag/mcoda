# Work-on-Tasks Enhancement Progress

## Current Status
Completed (implementation and targeted validation complete)

## Checklist
- [x] Create implementation plan document
- [x] Add `work-on-tasks` project key fallback logic (explicit -> config -> first workspace project)
- [x] Add execution context policy parser support in CLI
- [x] Pass execution context policy from CLI to core service
- [x] Add job-level execution context preflight in `WorkOnTasksService`
- [x] Correct base branch handling to honor configured/requested branch
- [x] Prioritize SDS/OpenAPI in doc context search
- [x] Add parser/helper tests in `WorkOnTasksCommand.test.ts`
- [x] Add strict policy preflight regression test in `WorkOnTasksService.test.ts`
- [x] Run targeted tests and fix failures
- [x] Run broader relevant test suites and fix failures
- [x] Final docs/usage alignment pass (if needed)

## Files Changed
- `packages/cli/src/commands/work/WorkOnTasksCommand.ts`
- `packages/cli/src/__tests__/WorkOnTasksCommand.test.ts`
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- `docs/work-on-tasks-enhancement-implementation-plan.md`
- `docs/work-on-tasks-enhancement-progress.md`

## Test Log
2026-02-25:
- `pnpm -C packages/core run build && node scripts/run-node-tests.js packages/core/dist/services/execution/__tests__/WorkOnTasksService.test.js`
  - PASS (`84/84`)
- `pnpm -C packages/cli run build && node scripts/run-node-tests.js packages/cli/dist/__tests__/WorkOnTasksCommand.test.js`
  - PASS (`15/15`)

Validation note:
- Updated the doc-context query test to avoid brittle call-index assumptions after SDS/OpenAPI-first search ordering.

## Notes
- Service-level default for execution context policy remains backward-compatible (`best_effort`) for direct callers.
- CLI default is strict (`require_sds_or_openapi`) to align with SDS-first execution.
