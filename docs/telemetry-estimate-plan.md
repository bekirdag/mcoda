# Telemetry + Estimate Alignment Plan

## Goals

- Capture input tokens, output tokens, cached tokens (where provided by adapters), per-call timing, and agent attribution for observability and scale planning.
- Track task status transition durations (ready_to_review, ready_to_qa, completed) so estimates reflect real workflow timings for gateway trio jobs.
- Align estimate calculations with telemetry and task history (work/review/qa lanes) to predict next-step timing, not just totals.

## Plan

### 1) Expand telemetry data model

- Add cached token fields to `token_usage` (workspace + global DB).
  - Suggested fields: `tokens_cached` (cached prompt tokens), `tokens_cache_read`, `tokens_cache_write` (if provider supplies them).
- Add explicit per-invocation fields to `token_usage` to avoid metadata-only parsing:
  - `command_name`, `action`, `invocation_kind`, `provider`, `currency`, `started_at`, `finished_at`, `duration_ms`.
- Add `agent_id` (primary) to `jobs` and `command_runs` plus `agent_ids_json` on `jobs` for multi-agent runs.
- Add a `task_status_events` table to record status transitions with timestamps and source context.

### 2) Capture missing telemetry fields at runtime

- Extend `JobService.recordTokenUsage` to accept cached tokens and timing fields; persist them into new columns.
- Update agent adapters and `AgentsApi` usage extraction to pull cached token usage when available.
- Ensure all `recordTokenUsage` call sites pass:
  - `command_name`, `action`, `invocation_kind`, `provider`, `started_at`, `finished_at`, `duration_ms`.
- Persist `jobs.agent_id` and `jobs.agent_ids_json` on job creation and update.

### 3) Record task status transition history

- Add a single helper (TaskStateService or WorkspaceRepository) to append `task_status_events` on every task status update.
- Include:
  - `task_id`, `from_status`, `to_status`, `command_name`, `job_id`, `task_run_id`, `agent_id`, `timestamp`.
- Backfill recent transitions from `task_runs`/`task_logs` when possible (best-effort, optional).

### 4) Telemetry APIs + CLI outputs

- Update TelemetryService/TelemetryClient types to include cached tokens and timing fields.
- Extend `mcoda tokens` output to show cached tokens and duration columns.
- Extend `mcoda job inspect` token summary to include cached token counts and durations per agent/model.

### 5) Estimate rework to align with telemetry and status history

- Compute lane velocity from `task_status_events` and `task_runs` (per-task durations), not `command_runs`.
  - Work lane: status changes to `ready_to_review`.
  - Review lane: status changes to `ready_to_qa`.
  - QA lane: status changes to `completed`.
- Use `task_runs.sp_per_hour_effective` when present; fall back to status-event durations.
- Update ETA logic to model the pipeline:
  - Account for current WIP tasks and their elapsed time in lane.
  - Predict “next” transition per lane (not just total max).

### 6) Tests and migrations

- Add migration tests for new columns/tables and backwards compatibility.
- Add unit tests:
  - TelemetryService mapping (cached tokens, timing, command/action columns).
  - EstimateService/VelocityService using status events + task_runs.
- Update CLI tests for `mcoda tokens` and `mcoda job inspect` output changes.

