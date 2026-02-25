# Project Guidance Enhancement Progress

## Status
Completed

## Checklist
- [x] Create implementation plan document.
- [x] Implement project-scoped guidance paths in shared guidance service.
- [x] Implement SDS-aware guidance generation and metadata hashing.
- [x] Add guidance staleness detection and managed-file refresh behavior.
- [x] Add guidance validation warnings (required sections/placeholders).
- [x] Extend `project-guidance` command with project resolution and richer JSON output.
- [x] Bootstrap guidance in `set-workspace`.
- [x] Wire project-aware guidance ensure/load in `work-on-tasks`.
- [x] Wire project-aware guidance ensure/load in `code-review`.
- [x] Wire project-aware guidance ensure/load in `qa-tasks`.
- [x] Update docs (`README.md`, `docs/usage.md`) and command metadata aliases.
- [x] Add/extend unit tests for guidance and command behavior.
- [x] Run targeted tests and fix regressions.
- [x] Run broader package tests and finalize.

## Implemented Changes
- `packages/core/src/services/shared/ProjectGuidance.ts`
  - Added project-aware guidance pathing and candidate resolution.
  - Added SDS discovery + SDS-derived guidance template generation.
  - Added guidance frontmatter metadata for traceability.
  - Added stale SDS hash detection and managed guidance refresh.
  - Added structural guidance validation warnings.
- `packages/cli/src/commands/workspace/ProjectGuidanceCommand.ts`
  - Added `--project` argument parsing.
  - Added project key fallback logic (requested -> configured -> first project).
  - Extended JSON output with guidance source and warnings.
- `packages/cli/src/commands/workspace/SetWorkspaceCommand.ts`
  - Added first-run guidance bootstrap.
- `packages/core/src/services/execution/WorkOnTasksService.ts`
  - Passes `projectKey` to guidance ensure/load and logs warnings.
- `packages/core/src/services/review/CodeReviewService.ts`
  - Ensures project guidance before review run and uses project-aware load.
- `packages/core/src/services/execution/QaTasksService.ts`
  - Ensures guidance at run preflight.
  - Uses project-aware guidance load in prompt generation paths.
- `packages/core/src/services/shared/__tests__/ProjectGuidance.test.ts`
  - Added project-scoped path, SDS seed, stale detection, and refresh tests.
- `packages/cli/src/__tests__/ProjectGuidanceCommand.test.ts`
  - Added `--project` parsing and project-scoped output coverage.
- `docs/usage.md`, `README.md`, `packages/shared/src/metadata/CommandMetadata.ts`
  - Updated command/docs metadata alignment.

## Validation Log
- `pnpm --filter @mcoda/core run test` ✅
- `pnpm --filter mcoda run test` ✅
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda` ✅
