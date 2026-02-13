# Backlog and Estimate Implementation Plan

Goal: resolve the issues listed in `docs/backlog-estimate-issues.md` and make `mcoda backlog` and `mcoda estimate` more meaningful and easier to use.

## Scope
- CLI output and flags for backlog and estimate.
- BacklogService metadata and warnings surfaced to CLI.
- Velocity/estimate transparency improvements.
- Docs updates for new flags and output behavior.

Non-goals:
- Changing DB schema.
- Changing task lifecycle logic.
- Introducing new endpoints (use existing services).

## Plan
1) Add backlog view controls and clearer output
   - Add `--view summary|epics|stories|tasks` and `--limit/--top` (for tasks/stories/epics) in `packages/cli/src/commands/backlog/BacklogCommands.ts`.
   - Add `Scope:` header for human output (project/epic/story/assignee/status/order).
   - Add task TITLE column; move long description to `--verbose` (or new `--details`) to keep tables scan-friendly.
   - Default to active statuses; add `--include-done` and `--include-cancelled` or `--status all`.
   - Ensure dependency ordering warnings are shown even when `--verbose` is not set if ordering was requested but not applied.

2) Improve backlog ordering semantics and metadata
   - Add metadata about ordering applied, skipped, or partial in BacklogService results.
   - When ordering is per-lane and cross-lane dependencies exist, surface a warning flag in the output.
   - Include warnings + metadata in JSON output so tooling can detect partial ordering.

3) Standardize estimate flags and enrich output
   - Align workspace flag with backlog (`--workspace-root` or accept both consistently).
   - Add `--sp-per-hour-implementation` to override only implementation lane.
   - Add DONE lane + TOTAL line in estimate output to match the backlog totals used for command run stats.
   - Add a short "Assumptions" line explaining critical-path/parallel-lane model.

4) Make velocity and ETA outputs more actionable
   - Show sample counts by lane (not only in `--debug`) and indicate if a lane fell back to config.
   - Surface `windowTasks` used when mode is `empirical` or `mixed`.
   - Print ETAs with local time and a relative duration (e.g., "+2d 5h") alongside ISO.

5) Update docs
   - Update `docs/usage.md` and `docs/sds/sds.md` where command flags and examples appear.
   - Add examples for `--view`, `--limit`, and velocity transparency output.

## Acceptance Criteria
- `mcoda backlog` supports view selection and limits, shows task titles, and prints an explicit scope line.
- Dependency ordering warnings are visible when ordering is skipped or partial.
- JSON backlog output includes warnings and ordering metadata.
- `mcoda estimate` supports implementation-only SP/h override and shows DONE + TOTAL rows.
- Estimate output explains assumptions and shows sample counts and window usage.
- Docs match the new flags and output behavior.

## Tests
- Update/extend CLI tests for backlog and estimate output shape and flag parsing.
- Add tests for backlog JSON metadata and warnings.
- Add tests for estimate output (DONE/TOTAL rows, implementation override, velocity window display).
- Run `node tests/all.js`.

## Risks and Mitigations
- Output changes may break downstream parsing: keep `--json` stable and add new fields under a `meta` key.
- Large backlogs could still be noisy: keep defaults conservative (summary + tasks, truncated text).
- Velocity samples might be zero: make fallback explicit and keep output readable.
