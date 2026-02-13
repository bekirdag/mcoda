# Backlog and Estimate Tasks

These tasks implement the plan in `docs/backlog-estimate-implementation-plan.md`. Each task is scoped to minimize coupling and includes explicit tests and acceptance criteria.

## Task 01
- **Slug:** backlog-args-extensions
- **Title:** Extend backlog CLI flags and defaults
- **Description:**  
  Add new CLI flags and defaults that make `mcoda backlog` more usable in large workspaces. This includes parsing `--view` to select which sections are printed, `--limit/--top` for row limiting, and `--include-done` / `--include-cancelled` or `--status all` to control default status filtering. The behavior must be explicit and predictable: if a status filter is not provided, the command should default to active statuses only (not_started, in_progress, blocked, ready_to_review, ready_to_qa). If the user explicitly requests `--status all` or uses the include flags, the filter should be broadened accordingly. Update the usage string to document the new flags and defaults.
- **Files to touch:**  
  `packages/cli/src/commands/backlog/BacklogCommands.ts`,  
  `packages/cli/src/__tests__/BacklogCommands.test.ts`
- **Unit tests:**  
  Add/extend parsing tests for `--view`, `--limit/--top`, default status behavior, and `--status all` / include flags.
- **Component tests:**  
  Not applicable (parsing only).
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  None.
- **Acceptance criteria:**  
  - `parseBacklogArgs` accepts `--view`, `--limit`, `--top`, `--include-done`, `--include-cancelled`, and `--status all`.  
  - When no status is provided, the parsed object indicates active-only filtering.  
  - Usage/help text clearly documents new flags and defaults.  

## Task 02
- **Slug:** backlog-output-scope-view-limit
- **Title:** Add scope header, view selection, and limits to backlog output
- **Description:**  
  Make backlog output easier to read by adding a one-line Scope header (project/epic/story/assignee/status/order). Implement `--view summary|epics|stories|tasks` to control which sections print, and apply a unified `--limit/--top` to whichever list is shown. The limit must be deterministic and stable (e.g., after ordering), and output must remain consistent when `--json` is not used. The CLI should always show the scope header before any tables unless `--json` is used.
- **Files to touch:**  
  `packages/cli/src/commands/backlog/BacklogCommands.ts`,  
  `packages/cli/src/__tests__/BacklogCommands.test.ts`
- **Unit tests:**  
  Extend parsing tests if needed for `--view`/`--limit`.
- **Component tests:**  
  Add a CLI output test that seeds a temp workspace, runs `BacklogCommands.run`, captures output, and verifies the scope header + view/limit behavior.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  backlog-args-extensions
- **Acceptance criteria:**  
  - Scope line prints for human output and reflects actual filters.  
  - `--view` only prints requested sections.  
  - `--limit/--top` caps rows after ordering is applied.  

## Task 03
- **Slug:** backlog-task-table-title
- **Title:** Improve task table readability (title column + verbose description)
- **Description:**  
  Update the tasks table to include a TITLE column and move long descriptions out of the default view. Description text should only appear when `--verbose` is enabled, or in a separate detail line if verbose is true. This makes scanning possible while retaining depth when needed. The default view must not truncate or hide the task key.
- **Files to touch:**  
  `packages/cli/src/commands/backlog/BacklogCommands.ts`,  
  `packages/cli/src/__tests__/BacklogCommands.test.ts`
- **Unit tests:**  
  None (formatting behavior tested in component test).
- **Component tests:**  
  Extend CLI output tests to assert TITLE is present and description is omitted unless `--verbose` is passed.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  backlog-output-scope-view-limit
- **Acceptance criteria:**  
  - Tasks table includes TITLE.  
  - Description is only printed in verbose mode.  

## Task 04
- **Slug:** backlog-ordering-meta
- **Title:** Add ordering metadata to BacklogService results
- **Description:**  
  Enhance `BacklogService.getBacklog` to return ordering metadata that explains whether dependency ordering was requested, applied, or skipped, and why. This metadata must be stable for JSON output and visible to the CLI. When dependency ordering is requested without project scope, mark it as skipped with a clear reason string.
- **Files to touch:**  
  `packages/core/src/services/backlog/BacklogService.ts`,  
  `packages/core/src/services/backlog/__tests__/BacklogService.test.ts`
- **Unit tests:**  
  Add tests to verify ordering metadata for dependency ordering with and without project scope.
- **Component tests:**  
  Not applicable.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  None.
- **Acceptance criteria:**  
  - BacklogService returns a `meta.ordering` object with `requested`, `applied`, and `reason` fields.  
  - Ordering skipped due to missing project scope is recorded in metadata.  

## Task 05
- **Slug:** backlog-crosslane-warning
- **Title:** Detect cross-lane dependencies and warn
- **Description:**  
  Identify dependencies that cross backlog lanes (e.g., implementation task depends on review task), which makes per-lane ordering misleading. Add a warning and metadata count/list when cross-lane dependencies exist in the requested scope. The warning should be deterministic and not require verbose mode.
- **Files to touch:**  
  `packages/core/src/services/backlog/BacklogService.ts`,  
  `packages/core/src/services/backlog/__tests__/BacklogService.test.ts`
- **Unit tests:**  
  Add a test that injects a cross-lane dependency and asserts the warning is returned.
- **Component tests:**  
  Not applicable.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  backlog-ordering-meta
- **Acceptance criteria:**  
  - Cross-lane dependencies yield a warning and metadata flag.  
  - Warning is present regardless of verbose output.  

## Task 06
- **Slug:** backlog-json-meta
- **Title:** Include warnings and metadata in backlog JSON output
- **Description:**  
  Update the CLI JSON output for `mcoda backlog` to include both `warnings` and `meta` from BacklogService. The JSON shape should be `{ summary, warnings, meta }` so tooling can detect partial ordering, missing scope, and cross-lane dependencies.
- **Files to touch:**  
  `packages/cli/src/commands/backlog/BacklogCommands.ts`,  
  `packages/cli/src/__tests__/BacklogCommands.test.ts`
- **Unit tests:**  
  Extend parsing tests if needed.
- **Component tests:**  
  Add a CLI JSON output test that asserts `warnings` and `meta.ordering` are present.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  backlog-ordering-meta, backlog-crosslane-warning
- **Acceptance criteria:**  
  - `mcoda backlog --json` includes warnings and metadata.  
  - Metadata includes ordering state and cross-lane indicators.  

## Task 07
- **Slug:** estimate-impl-sp-override
- **Title:** Add implementation-only SP/h override
- **Description:**  
  Add CLI flag `--sp-per-hour-implementation` and wire it through to `VelocityService` and `EstimateService`. The override must only affect the implementation lane and must not mutate review/QA speeds. Update usage/help text and add parsing tests. Update shared/core types as needed so the override is typed and documented.
- **Files to touch:**  
  `packages/cli/src/commands/estimate/EstimateCommands.ts`,  
  `packages/cli/src/__tests__/EstimateCommands.test.ts`,  
  `packages/core/src/services/estimate/VelocityService.ts`,  
  `packages/core/src/services/estimate/EstimateService.ts`,  
  `packages/core/src/services/estimate/types.ts`,  
  `packages/shared/src/openapi/OpenApiTypes.ts`
- **Unit tests:**  
  - CLI parsing test for `--sp-per-hour-implementation`.  
  - Core velocity test to ensure implementation override is honored without affecting review/qa.
- **Component tests:**  
  Not applicable.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  None.
- **Acceptance criteria:**  
  - Implementation lane uses override; review/QA remain unchanged.  
  - CLI help reflects the new flag.  

## Task 08
- **Slug:** estimate-output-done-total-assumptions
- **Title:** Add DONE/TOTAL lines and assumptions to estimate output
- **Description:**  
  Enhance the estimate output to show DONE lane story points and a TOTAL line that reflects all lanes. Add a short assumptions line explaining the parallel-lane / critical-path model (total hours = max lane). This should make estimates more transparent and align with how totals are computed internally.
- **Files to touch:**  
  `packages/cli/src/commands/estimate/EstimateCommands.ts`,  
  `packages/cli/src/__tests__/EstimateCommands.test.ts`
- **Unit tests:**  
  None (formatting behavior validated in component test).
- **Component tests:**  
  Add a CLI output test that asserts DONE and TOTAL lines plus the assumptions line.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  estimate-impl-sp-override
- **Acceptance criteria:**  
  - Output includes DONE lane and TOTAL line.  
  - Assumptions line is present in human output.  

## Task 09
- **Slug:** estimate-velocity-transparency
- **Title:** Show velocity samples and window usage by default
- **Description:**  
  Make velocity sources more transparent by surfacing sample counts per lane and the window used, even outside `--debug`. If empirical samples are unavailable and config is used, show that explicitly. Extend `EffectiveVelocity` metadata to carry samples even when falling back to config so output can explain why.
- **Files to touch:**  
  `packages/core/src/services/estimate/VelocityService.ts`,  
  `packages/core/src/services/estimate/types.ts`,  
  `packages/shared/src/openapi/OpenApiTypes.ts`,  
  `packages/cli/src/commands/estimate/EstimateCommands.ts`,  
  `packages/core/src/services/estimate/__tests__/VelocityAndEstimate.test.ts`
- **Unit tests:**  
  - Core velocity tests assert samples are present and fallback is explicit.  
  - Update existing estimate tests if the response shape changes.
- **Component tests:**  
  CLI output test asserting sample counts and window appear.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  estimate-impl-sp-override
- **Acceptance criteria:**  
  - Output shows sample counts and window.  
  - Fallback to config is explicit when empirical data is missing.  

## Task 10
- **Slug:** estimate-eta-human
- **Title:** Add human-friendly ETA formatting
- **Description:**  
  Expand ETA output to include local time and a relative duration (e.g., “+2d 5h”). Keep the ISO timestamp for machine parsing, but pair it with a readable format for humans. Ensure output is stable and testable by stubbing time in tests.
- **Files to touch:**  
  `packages/cli/src/commands/estimate/EstimateCommands.ts`,  
  `packages/cli/src/__tests__/EstimateCommands.test.ts`
- **Unit tests:**  
  None.
- **Component tests:**  
  Add a CLI output test that freezes time and validates the relative/local ETA format.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  estimate-output-done-total-assumptions, estimate-velocity-transparency
- **Acceptance criteria:**  
  - ETA table shows ISO + relative/local values.  
  - Tests remain deterministic with frozen time.  

## Task 11
- **Slug:** backlog-estimate-docs-update
- **Title:** Update docs for backlog and estimate changes
- **Description:**  
  Update `docs/usage.md` and relevant SDS sections to reflect new flags, default behaviors, and output changes. Examples must include `--view`, `--limit`, `--include-done/--status all`, and the new estimate output format and SP/h override. Align terminology with CLI output so users can map flags to what they see.
- **Files to touch:**  
  `docs/usage.md`,  
  `docs/sds/sds.md`
- **Unit tests:**  
  Not applicable.
- **Component tests:**  
  Not applicable.
- **Integration tests:**  
  Not applicable.
- **API tests:**  
  Not applicable.
- **Dependencies:**  
  backlog-json-meta, estimate-eta-human
- **Acceptance criteria:**  
  - Docs reflect new flags and defaults.  
  - Examples match updated CLI output.  
