# Code-Review Enhancement Progress

## Current Status
Completed (code-review enhancement scope for this iteration)

## Checklist
- [x] Create implementation plan document
- [x] Add CLI argument support for execution context policy and empty-diff policy
- [x] Add CLI project fallback resolution (explicit -> config -> first workspace project)
- [x] Wire CLI policies into `CodeReviewService.reviewTasks`
- [x] Add service-level execution context preflight support
- [x] Update review doc context retrieval to SDS/OPENAPI-first
- [x] Replace hardcoded OpenAPI path with resolver chain
- [x] Include QA comments in review context/history
- [x] Add/adjust regression tests for new behavior
- [x] Run targeted test suites and fix failures
- [x] Run broader tests and finalize

## Files Changed
- `docs/code-review-enhancement-implementation-plan.md`
- `docs/code-review-enhancement-progress.md`
- `packages/cli/src/commands/review/CodeReviewCommand.ts`
- `packages/cli/src/__tests__/CodeReviewCommand.test.ts`
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

## Test Log
- `pnpm -C packages/core run build && node scripts/run-node-tests.js packages/core/dist/services/review/__tests__/CodeReviewService.test.js`
  - Result: pass (`tests=22, pass=22, fail=0`)
- `pnpm -C packages/cli run build && node scripts/run-node-tests.js packages/cli/dist/__tests__/CodeReviewCommand.test.js`
  - Result: pass (`tests=11, pass=11, fail=0`)
- `pnpm -C packages/core test`
  - Result: pass (`tests=490, pass=490, fail=0`)
- `pnpm -C packages/cli test`
  - Result: pass (`tests=191, pass=191, fail=0`)

## Notes
- CLI defaults are strict for workflow alignment.
- Service retains backward-compatible defaults for non-CLI callers.
- Updated `CodeReviewService` reindex regression test to fail on task query (`query === "Task"`) rather than first-ever docdex call so retry coverage remains deterministic with the new execution-context preflight search.
