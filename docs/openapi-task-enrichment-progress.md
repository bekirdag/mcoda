# OpenAPI Enrichment Progress

## Current Goal

Implement SDS-first OpenAPI generation and improve downstream task enrichment quality.

## Current Status

Completed (implementation and targeted validation complete)

## Checklist

- [x] Create implementation plan document
- [x] Create progress tracking document
- [x] Add `--project` support to `openapi-from-docs`
- [x] Enforce SDS-required context in OpenAPI generation
- [x] Tighten OpenAPI generation prompt to avoid speculative endpoints
- [x] Add/validate `x-mcoda-task-hints` contract
- [x] Feed OpenAPI hint context into `create-tasks`
- [x] Feed OpenAPI hint context into `refine-tasks`
- [x] Add/update tests for new behavior
- [x] Run targeted test suite and record results

## Work Log

### 2026-02-25

1. Added implementation plan:
   - `docs/openapi-task-enrichment-implementation-plan.md`
2. Created this progress tracker:
   - `docs/openapi-task-enrichment-progress.md`
3. Implemented CLI + OpenAPI strictness:
   - Added `--project` parsing/forwarding in `packages/cli/src/commands/openapi/OpenapiCommands.ts`.
   - Added parser coverage in `packages/cli/src/__tests__/OpenapiCommands.test.ts`.
   - Enforced SDS-required generation path in `packages/core/src/services/openapi/OpenApiService.ts`.
4. Implemented OpenAPI hint contract validation:
   - Added `x-mcoda-task-hints` schema checks in `packages/core/src/services/openapi/OpenApiService.ts`.
   - Added validation tests in `packages/core/src/services/openapi/__tests__/OpenApiService.test.ts`.
5. Implemented downstream task-enrichment plumbing:
   - `create-tasks` now appends `[OPENAPI_HINTS]` context from operation hints in `packages/core/src/services/planning/CreateTasksService.ts`.
   - `refine-tasks` now appends `[OPENAPI_HINTS]` summary in `packages/core/src/services/planning/RefineTasksService.ts`.
   - Added tests in:
     - `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`
     - `packages/core/src/services/planning/__tests__/RefineTasksService.test.ts`
6. Targeted test runs (all passed):
   - `docdexd run-tests --repo . --target packages/cli/src/__tests__/OpenapiCommands.test.ts`
   - `docdexd run-tests --repo . --target packages/core/src/services/openapi/__tests__/OpenApiService.test.ts`
   - `docdexd run-tests --repo . --target packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`
   - `docdexd run-tests --repo . --target packages/core/src/services/planning/__tests__/RefineTasksService.test.ts`
