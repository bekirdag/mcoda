# mcoda

## Generate a PDR from an RFP

Use the docs command to draft a Product Design Review with docdex + an agent:

```sh
mcoda docs pdr generate \
  --workspace-root ~/Documents/apps/test1 \
  --project TEST1 \
  --rfp-path docs/rfp/test1-rfp.md \
  --agent codex
```

Add `--agent-stream false` for a quieter run, or `--rfp-id <DOCDEX_ID>` to pull an RFP already registered in docdex. The PDR is written under `.mcoda/docs/pdr/` by default.

- If docdex is unavailable, the command runs in a degraded “local RFP only” mode and warns you.
- Agent selection uses the workspace default for `docs-pdr-generate` (or any agent with `docdex_query` + `doc_generation` capabilities); override with `--agent <name>`.
- Flags: `--debug`, `--quiet`, `--no-color`, `--agent-stream false`, `--json`, `--dry-run`, `--workspace-root <path>`, `--project <KEY>`, `--rfp-id` or `--rfp-path`.
- Workspace config: `.mcoda/config.json` supports `docdexUrl`, `mirrorDocs` (default true), and `branch` metadata for docdex registration.

## Generate an SDS from your PDR/RFP context

```sh
mcoda docs sds generate \
  --workspace-root ~/Documents/apps/test1 \
  --project TEST1 \
  --agent codex \
  --template SDS_backend_service
```

- Streams agent output by default; pass `--agent-stream false` for quiet mode.
- Default output: `.mcoda/docs/sds/<project>.md` (override with `--out <FILE>`). Use `--force` to overwrite an existing SDS.
- Context comes from docdex (RFP + PDR + any existing SDS + OpenAPI); if docdex is down the command falls back to local docs and warns.
- Flags: `--template <NAME>`, `--agent <NAME>`, `--workspace-root <path>`, `--project <KEY>`, `--agent-stream <true|false>`, `--force`, `--resume <JOB_ID>`, `--dry-run`, `--json`, `--debug`, `--no-color`, `--quiet`.
- Alias: `mcoda sds ...` forwards to `mcoda docs sds generate`.

## Generate the OpenAPI spec from docs

Produce or refresh the canonical `openapi/mcoda.yaml` from SDS/PDR context, docdex, and the existing spec:

```sh
mcoda openapi-from-docs --workspace-root . --agent codex --force
```

- Streams agent output by default; pass `--agent-stream false` to disable streaming.
- Writes to `openapi/mcoda.yaml` (backs up an existing file to `.bak` when `--force` is used).
- Use `--dry-run` to print the generated YAML without writing, or `--validate-only` to parse/validate the current spec without invoking an agent.

## Inspect the backlog (DB-only)

List SP buckets and tasks already stored in the workspace SQLite DB:

```sh
mcoda backlog --project WEB --order dependencies --verbose
```

- Flags: `--project <KEY>`, `--epic <KEY>`, `--story <KEY>`, `--assignee <USER>`, `--status <STATUS[,STATUS...]>`, `--order dependencies`, `--json`, `--verbose`, `--workspace-root <path>`.
- No agents or docdex are called; output comes purely from `.mcoda/mcoda.db`.

## Dependency-aware ordering

Compute a deterministic, dependency-aware order (most depended-on first, topo-safe) and persist global priorities:

```sh
mcoda order-tasks --project WEB --epic web-01 --include-blocked --json
mcoda tasks order-by-deps --project WEB --status not_started,in_progress
mcoda backlog --project WEB --order dependencies       # same core ordering
```

- Flags: `--workspace-root <path>`, `--project <KEY>` (required), `--epic <KEY>`, `--status <STATUS_FILTER>`, `--include-blocked`, `--agent <NAME>`, `--agent-stream <true|false>`, `--json`.
- Behavior: topo order over `task_dependencies`, ties by dependency impact → priority → SP → age → status; blocked tasks are listed separately unless `--include-blocked` is set. Updates `priority` across tasks, stories, and epics in the scoped project.

### Command list (partial)

- Agents & routing: `mcoda agent ...`, `mcoda routing ...`
- Planning: `mcoda create-tasks`, `mcoda refine-tasks`
- Ordering & backlog: `mcoda order-tasks`, `mcoda tasks order-by-deps`, `mcoda backlog --order dependencies`
- Execution: `mcoda work-on-tasks`, `mcoda code-review`, `mcoda qa-tasks`
- Docs/spec: `mcoda docs pdr generate`, `mcoda docs sds generate`, `mcoda openapi-from-docs`
- Telemetry: `mcoda tokens`, `mcoda telemetry`, `mcoda job ...`

## Update the CLI

Check for updates without applying:

```sh
mcoda update --check --json
```

Apply the latest release on the chosen channel (defaults to stable):

```sh
mcoda update --force --channel beta   # stable|beta|nightly
```

Use `--version <SEMVER>` to pin to a specific published version; `--json` emits machine-readable output, and `--quiet` suppresses non-essential logs. In CI or other non-interactive shells, pass `--force` to skip the confirmation prompt.

## Inspect a single task (DB + OpenAPI lookup)

Inspect a task with hierarchy, VCS, dependencies, comments, and optional logs/history:

```sh
mcoda task show web-01-us-01-t01 --project WEB --include-logs --include-history --format table
```

- Aliases: `mcoda task <KEY>`, `mcoda task-detail --project <KEY> --task <KEY>`.
- Flags: `--project <KEY>`, `--include-logs`, `--include-history`, `--format <table|json|yaml>` (YAML is experimental), `--no-telemetry`, `--workspace-root <path>`.
- Lookup: prefers the workspace DB; if `MCODA_API_BASE_URL` (or legacy `MCODA_TASKS_API_URL`) is set, the task key is first resolved via `GET /tasks?key=...` to align with the OpenAPI surface, then hydrated from the local DB for details.

## Telemetry: tokens and config

Summarize token usage (aggregated via the Telemetry API):

```sh
mcoda tokens --group-by project,command,agent --since 7d --format table
```

- Filters: `--project`, `--agent`, `--command`, `--job`, `--since/--until`, `--group-by <project|agent|command|day|model|job|action>`, `--format <table|json>`.

Inspect or toggle telemetry settings:

```sh
mcoda telemetry show
mcoda telemetry opt-out --strict   # disable remote export; strict also disables local logging
mcoda telemetry opt-in
```

Debug a specific job’s token usage:

```sh
mcoda job tokens <JOB_ID> --since 24h --format table
```

## Jobs: list, status, logs, resume

Keep long-running commands observable and resumable:

```sh
mcoda job list [--project <KEY>] [--status <STATE>] [--type <TYPE>] [--since <DURATION|TS>] [--limit <N>] [--json]
mcoda job status <JOB_ID> [--json]
mcoda job watch <JOB_ID> [--interval <SECONDS>] [--no-logs]
mcoda job logs <JOB_ID> [--since <TIMESTAMP|DURATION>] [--follow]
mcoda job inspect <JOB_ID> [--json]
mcoda job resume <JOB_ID> [--agent <NAME>] [--no-telemetry]
mcoda job cancel <JOB_ID> [--force]
mcoda job tokens <JOB_ID> [--since <TIMESTAMP|DURATION>] [--format table|json]

# Examples
mcoda job list --status running
mcoda job watch <JOB_ID> --interval 2 --no-logs
mcoda job inspect <JOB_ID> --json
mcoda job resume <JOB_ID> --agent codex
mcoda job logs <JOB_ID> --since 10m --follow
```

## Work on tasks (implementation pipeline)

Drive tasks from the workspace DB through the agent-powered implementation loop:

```sh
mcoda work-on-tasks --workspace . --project WEB --status not_started,in_progress --limit 3
```

- Scopes: `--project <KEY>` (required), `--task <KEY>...`, `--epic <KEY>`, or `--story <KEY>`. Default statuses: `not_started,in_progress` (override with `--status ...`).
- Behavior flags: `--limit <N>`, `--parallel <N>`, `--no-commit`, `--dry-run`, `--agent <NAME>`, `--agent-stream <true|false>`, `--json`.
- Selection & ordering: dependency-aware (skips/reroutes blocked tasks), topo + priority + SP + created_at, with in-progress tie-breaks. Blocked tasks are listed in JSON output (`blocked`).
- Orchestration: creates `jobs`, `command_runs`, `task_runs`, `task_logs`, and `token_usage` rows in `.mcoda/mcoda.db`, streams agent output by default, and stops tasks at `ready_to_review`. Checkpoints live under `.mcoda/jobs/<jobId>/work/state.json` for resume/debug.
- Scope & safety: enforces allowed files/tests from task metadata; scope violations are blocked and logged.
- VCS: ensures `.mcoda` exists and is gitignored, creates deterministic task branches (`mcoda/task/<TASK_KEY>`) from the base branch (default `mcoda-dev`), respects remotes when present, and skips commit/push on `--no-commit` or `--dry-run`.

## Code review (review pipeline)

Run AI-assisted review on task branches and write findings to the workspace DB:

```sh
mcoda code-review --workspace . --project WEB --status ready_to_review --limit 5 --base mcoda-dev --agent reviewer
```

- Scopes: `--project <KEY>`, `--task <KEY>...`, `--epic <KEY>`, `--story <KEY>`, default `--status ready_to_review` (override with `--status ...`), optional `--limit <N>`.
- Behavior: `--base <BRANCH>` (diff base), `--dry-run` (skip status transitions), `--resume <JOB_ID>`, `--agent <NAME>`, `--agent-stream <true|false>` (default true), `--json`.
- Outputs & side effects: creates `jobs`/`command_runs`/`task_runs`, writes `task_comments` + `task_reviews`, records `token_usage`, may auto-create follow-up tasks for review findings, and transitions tasks (`ready_to_review → ready_to_qa/in_progress/blocked` unless `--dry-run`). Artifacts (diffs, context, checkpoints) under `.mcoda/jobs/<jobId>/review/`. JSON output shape: `{ job: {id, commandRunId}, tasks: [...], errors: [...], warnings: [...] }`.

## QA tasks (QA pipeline)

Run automated or manual QA on tasks in the workspace DB:

```sh
mcoda qa-tasks --workspace . --project WEB --status ready_to_qa --profile ui --agent qa
```

- Scopes: `--project <KEY>` (required), `--task <KEY>...`, `--epic <KEY>`, `--story <KEY>`, default `--status ready_to_qa` (override for regression runs).
- Modes: `--mode auto` (default; runs CLI/Chromium/Maestro via QA profiles) or `--mode manual --result pass|fail|blocked [--notes "..."] [--evidence-url "..."]`.
- Profiles & runners: `--profile <NAME>` or `--level unit|integration|acceptance`, `--test-command "<CMD>"` override for CLI runner. Agent streaming defaults to true (`--agent-stream false` to quiet). Resume a QA sweep with `--resume <JOB_ID>`.
- Outputs & state: creates `jobs`/`command_runs`/`task_runs`/`task_qa_runs`, writes `task_comments`, records `token_usage`, and applies TaskStateService transitions (`ready_to_qa → completed/in_progress/blocked` unless `--dry-run`). Artifacts live under `.mcoda/jobs/<jobId>/qa/<task_key>/`.
- Manual example: `mcoda qa-tasks --project WEB --task web-01-us-01-t01 --mode manual --result fail --notes "Checkout button unresponsive" --evidence-url https://ci.example/run/123`.

## Routing defaults, preview, and explain

Use the OpenAPI-backed router to inspect or update workspace defaults:

```sh
# Show effective defaults (workspace + __GLOBAL__ fallback)
mcoda routing defaults [--workspace <PATH>] [--json]

# Update defaults (only the provided flags are changed)
mcoda routing defaults \
  --set-command create-tasks=codex \
  --set-qa-profile integration \
  --set-docdex-scope sds

# Reset a command to inherit from __GLOBAL__
mcoda routing defaults --reset-command work-on-tasks

# Preview which agent would run a command (honors --agent override)
mcoda routing preview \
  --command work-on-tasks \
  [--agent <SLUG>] \
  [--task-type <TYPE>] \
  [--project <KEY>] \
  [--json]

# Explain the routing decision with candidates/health/capabilities
mcoda routing explain \
  --command create-tasks \
  [--agent <SLUG>] \
  [--task-type <TYPE>] \
  [--debug] \
  [--json]
```

Flags & behavior:
- `--workspace <PATH>` resolves workspace_id + DB paths via WorkspaceResolver; omitted uses CWD.
- Defaults: `--set-command <cmd>=<agent>` (validates against global agents + required capabilities), `--reset-command <cmd>`, `--set-qa-profile <NAME>`, `--set-docdex-scope <NAME>`. With no setters, `--list` is implied.
- Preview/explain: validate command names via OpenAPI `x-mcoda-cli.name`; source shows `override|workspace_default|global_default`; explain prints candidate agents with health/capabilities/missing caps.
- Output: human-friendly tables by default; `--json` emits raw `RoutingDefaults` or `RoutingPreview` DTOs. `--debug` surfaces extra trace fields when available.
