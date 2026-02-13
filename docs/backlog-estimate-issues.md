# Backlog and Estimate Issues

This list captures current issues and how to make the backlog and estimate commands more meaningful and easier to use.

## Backlog
- Missing task titles in the tasks table (only description is shown), so scanning is hard; add a TITLE column and move description to `--verbose` or a `--details` view.
- Always prints summary + epics + stories + tasks with no way to focus or limit; add `--view summary|epics|stories|tasks` and `--limit/--top` so large backlogs are usable.
- `--order dependencies` silently degrades without a project (warnings only show with `--verbose`), so users think dependencies are applied when they’re not; show a warning any time dependency ordering is skipped or require `--project`.
- Status filtering is free-form and default includes done/cancelled; that inflates the backlog view; default to active statuses with an explicit `--include-done/--include-cancelled` or `--status all`.
- No scope banner (project/epic/story/assignee/status/order) in human output; add a one-line “Scope:” header to make output self-explanatory.
- JSON output drops warnings and ordering metadata; include `warnings` and `meta` so tooling can see when ordering or dependency checks were skipped.
- Dependency ordering is per-lane and ignores cross-lane dependencies; add explicit flags in output when dependencies are out-of-scope or cross-lane so the ordering isn’t misleading.

## Estimate
- Flag mismatch with backlog (`--workspace`/`--workspace-root`); standardize the workspace flag across commands for consistency.
- Output hides done/cancelled SP while totals include done for command run stats; add a DONE lane and a TOTAL line so users understand what’s being estimated.
- Velocity transparency is thin (source only, samples only in `--debug`); show sample counts and whether each lane fell back to config by default, or add `--explain`.
- ETAs are ISO timestamps only; add human-friendly “+Xd Yh” durations and local time to make them actionable.
- No per-lane override for implementation (only `--sp-per-hour` all + review/qa); add `--sp-per-hour-implementation` to avoid over/under-correcting.
- The math assumes critical-path = max(lane hours) but the UI doesn’t state that; add an “Assumptions” line explaining the parallelism model.
- No visibility into data freshness (e.g., last run date) or actual window use; show `windowTasks` and a recency hint when empirical/mixed is used.
