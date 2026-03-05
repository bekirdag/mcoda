# SDS Suggestions Implementation Tasks

This task list implements `mcoda sds suggestions` end-to-end.

## Task 1
- slug: sds-suggestions-docs-artifacts-baseline
- title: Create and baseline implementation docs artifacts
- description: Create the implementation plan, detailed tasks list, and progress tracker under `docs/`. Ensure task execution references these documents and that progress updates include concrete test evidence and final alignment/perfection checks.
- files to touch:
  - `docs/sds-suggestions-implementation-plan.md`
  - `docs/sds-suggestions-tasks.md`
  - `docs/sds-suggestions-progress.md`
- unit tests: none
- component tests: none
- integration tests: none
- api tests: none
- dependencies: none
- acceptance criteria:
  - all three docs exist,
  - tasks include required schema fields,
  - progress file has task checklist and evidence sections.

## Task 2
- slug: sds-suggestions-cli-arg-schema
- title: Add parser contract for `sds suggestions` arguments
- description: Extend `DocsCommands` with a dedicated parser for `sds suggestions` including workspace/project/sds-path/review-agent/fix-agent/max-iterations/stream/rate-agents/json/dry-run/quiet/debug/no-color/no-telemetry. Implement defaults and boolean parsing parity with existing docs command parsers. Clamp max iterations to `1..100`.
- files to touch:
  - `packages/cli/src/commands/docs/DocsCommands.ts`
  - `packages/cli/src/__tests__/DocsCommands.test.ts`
- unit tests:
  - parser default values,
  - parser flag handling,
  - parser max-iteration clamp behavior.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-docs-artifacts-baseline`
- acceptance criteria:
  - parser returns typed result for suggestions mode,
  - defaults and clamping validated by tests,
  - no regression in existing pdr/sds generate parsers.

## Task 3
- slug: sds-suggestions-cli-dispatch
- title: Add `docs sds suggestions` command branch and output handling
- description: Update `DocsCommands.run` to branch for `sds suggestions` while preserving existing `sds generate` behavior. Wire parser output to core service invocation. Add human-readable summary and JSON payload modes for the new command result.
- files to touch:
  - `packages/cli/src/commands/docs/DocsCommands.ts`
  - `packages/cli/src/__tests__/DocsCommands.test.ts`
- unit tests:
  - branch selection for suggestions subcommand.
- component tests:
  - command output payload shape in json mode.
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-cli-arg-schema`
- acceptance criteria:
  - `docs sds suggestions` invokes new service method,
  - `docs sds generate` continues unchanged,
  - tests pass for both branches.

## Task 4
- slug: sds-suggestions-entrypoint-routing
- title: Route top-level `mcoda sds suggestions` in entrypoint
- description: Modify `McodaEntrypoint` so top-level `sds` command supports explicit subcommands. Keep backward-compatible default (`mcoda sds` => generate). Ensure `mcoda sds suggestions` reaches DocsCommands suggestions branch.
- files to touch:
  - `packages/cli/src/bin/McodaEntrypoint.ts`
  - `packages/cli/src/__tests__/McodaEntrypoint.test.ts`
- unit tests:
  - route assertions for `sds suggestions` and `sds` default generate mapping.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-cli-dispatch`
- acceptance criteria:
  - entrypoint routes suggestions correctly,
  - existing `sds` behavior preserved,
  - route tests pass.

## Task 5
- slug: sds-suggestions-core-result-contract
- title: Add core options/result contracts for suggestions workflow
- description: Introduce typed `GenerateSdsSuggestionsOptions` and `GenerateSdsSuggestionsResult` in `DocsService` to define command contract, iteration artifacts, final status, and warnings. Keep naming consistent with existing `generatePdr`/`generateSds` patterns.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
- unit tests:
  - compile-level contract usage through service test calls.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-entrypoint-routing`
- acceptance criteria:
  - options/result interfaces exist and are used by implementation,
  - no type regressions in build.

## Task 6
- slug: sds-suggestions-sds-path-resolution
- title: Implement SDS file discovery and validation helpers
- description: Add helper functions in `DocsService` to resolve target SDS path from explicit override or fallback search order. Include deterministic error messages listing attempted locations.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - explicit path resolution,
  - fallback candidate selection,
  - missing path error path list.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-core-result-contract`
- acceptance criteria:
  - resolver follows documented priority,
  - errors are actionable,
  - tests cover success + failure branches.

## Task 7
- slug: sds-suggestions-numbered-artifacts
- title: Implement suggestions directory bootstrap and monotonic filename numbering
- description: Add helper to ensure `<workspaceRoot>/docs/suggestions` and allocate next file index by scanning existing `sds_suggestions[NUMBER].md` files. Ensure stable monotonic numbering across runs.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - numbering from empty directory,
  - numbering with existing sparse files,
  - directory auto-create.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-sds-path-resolution`
- acceptance criteria:
  - artifact path generation deterministic and monotonic,
  - no overwrite of existing suggestion files.

## Task 8
- slug: sds-suggestions-agent-ranking-selection
- title: Implement reviewer/fixer high-ranked agent selection
- description: Build reusable ranking helper leveraging existing capability/health/rating/cost metadata. Select reviewer as top candidate and fixer as next distinct candidate when available. Respect `--review-agent` and `--fix-agent` overrides with warning surface when not ideal.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - two-agent selection with ranking tie-breakers,
  - single-agent fallback,
  - override precedence behavior.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-core-result-contract`
- acceptance criteria:
  - selection is deterministic,
  - reviewer/fixer assignment valid,
  - tests assert ranking behavior.

## Task 9
- slug: sds-suggestions-review-prompt-parser
- title: Implement reviewer prompt and verdict parser
- description: Add reviewer prompt builder requiring JSON verdict + markdown sections and implement parser that extracts structured result with fallback heuristics. Include issue-count normalization and ambiguous-output handling.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - valid JSON verdict parse,
  - malformed output fallback,
  - pass/fail heuristic inference.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-agent-ranking-selection`
- acceptance criteria:
  - parser resilient to common model output drift,
  - deterministic status from ambiguous output,
  - tests cover parser edge cases.

## Task 10
- slug: sds-suggestions-fixer-prompt-parser
- title: Implement fixer prompt and SDS output extraction
- description: Add fixer prompt builder consuming current SDS + suggestions markdown and requiring full revised SDS output. Implement extraction fallback from fenced blocks and minimal validity checks before write.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - fenced output extraction,
  - plain markdown output handling,
  - invalid/empty output rejection.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-review-prompt-parser`
- acceptance criteria:
  - fixer output extraction robust,
  - invalid output does not corrupt SDS,
  - tests validate safety guards.

## Task 11
- slug: sds-suggestions-iteration-engine
- title: Implement iterative review/fix loop with hard stop
- description: Add `generateSdsSuggestions` core loop running reviewer -> artifact write -> fixer apply until PASS/no-issues or max iterations reached. Persist iteration metadata and warnings. Honor dry-run by skipping SDS writes while still emitting suggestions files.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - converges when reviewer returns pass,
  - stops at max iterations,
  - dry-run no-write behavior.
- component tests:
  - iteration summaries include artifact paths and statuses.
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-numbered-artifacts`
  - `sds-suggestions-review-prompt-parser`
  - `sds-suggestions-fixer-prompt-parser`
- acceptance criteria:
  - loop behavior exactly matches contract,
  - hard-stop enforced at 100 max,
  - suggestions artifacts written every iteration.

## Task 12
- slug: sds-suggestions-job-checkpoints
- title: Add job/checkpoint logging for suggestions workflow
- description: Integrate the new workflow with command-run + job lifecycle APIs, including checkpoints and metadata for agents, final status, iteration count, and suggestion files.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - job metadata contains expected final fields.
- component tests:
  - checkpoint stages emitted in expected sequence.
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-iteration-engine`
- acceptance criteria:
  - command run/job entries created,
  - checkpoints and completion status accurate.

## Task 13
- slug: sds-suggestions-rating-hook
- title: Hook optional `--rate-agents` behavior into suggestions command
- description: Reuse existing rating service integration to rate reviewer/fixer runs when enabled. Ensure rating failures are warning-only and do not fail the command.
- files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- unit tests:
  - rating service invoked when enabled,
  - rating failures append warnings and continue.
- component tests: none
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-job-checkpoints`
- acceptance criteria:
  - optional rating behavior works,
  - no hard failure on rating subsystem errors.

## Task 14
- slug: sds-suggestions-cli-json-human-output
- title: Finalize CLI response formatting for human and JSON modes
- description: Ensure command prints concise human summary and stable JSON payload schema containing iteration count, final status, sdsPath, and suggestions file list. Add tests validating output keys and branch behavior.
- files to touch:
  - `packages/cli/src/commands/docs/DocsCommands.ts`
  - `packages/cli/src/__tests__/DocsCommands.test.ts`
- unit tests:
  - json payload shape and required fields.
- component tests:
  - human output includes final status and iteration summary.
- integration tests: none
- api tests: none
- dependencies:
  - `sds-suggestions-iteration-engine`
- acceptance criteria:
  - outputs stable in both modes,
  - tests assert formatting contract.

## Task 15
- slug: sds-suggestions-regression-suite
- title: Execute targeted regression suite and fix all failures
- description: Run all targeted tests affected by new feature (`DocsCommands`, `McodaEntrypoint`, `DocsService`) and iterate fixes until green. Confirm no regressions in existing `sds generate` flow.
- files to touch:
  - `packages/cli/src/__tests__/DocsCommands.test.ts`
  - `packages/cli/src/__tests__/McodaEntrypoint.test.ts`
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
  - any impacted implementation files.
- unit tests:
  - all targeted suites pass.
- component tests:
  - docs command behavior unchanged for generate path.
- integration tests:
  - run package-level tests for `@mcoda/cli` and `@mcoda/core`.
- api tests:
  - not applicable.
- dependencies:
  - tasks 2-14
- acceptance criteria:
  - targeted and package-level tests pass,
  - identified regressions fixed.

## Task 16
- slug: sds-suggestions-alignment-perfection-pass
- title: Perform code review and plan-task-completion alignment pass
- description: Conduct final pass comparing plan vs tasks vs implementation. Fix gaps, inconsistencies, and missing pieces. Update progress doc with completion evidence and explicit “no remaining misalignment” statement.
- files to touch:
  - `docs/sds-suggestions-progress.md`
  - any code/docs files needed for gap closure.
- unit tests:
  - rerun targeted tests if any final code change is made.
- component tests:
  - rerun affected command tests if output/UX changes.
- integration tests:
  - `pnpm --filter @mcoda/cli test`
  - `pnpm --filter @mcoda/core test`
- api tests:
  - not applicable.
- dependencies:
  - `sds-suggestions-regression-suite`
- acceptance criteria:
  - no unresolved mismatch between plan/tasks/code,
  - progress doc marks all tasks complete with evidence.
