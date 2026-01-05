# mcoda Usage Guide

This guide covers installation, workspace setup, and common CLI workflows.

## Install
- Requires Node.js >= 20.
- Global install: `npm i -g mcoda`
- Verify: `mcoda --version`

## Workspace setup
Initialize a workspace to create the `.mcoda` directory, seed the SQLite DB, and (optionally) wire docdex.

```sh
mcoda set-workspace --workspace-root .
```

Key files:
- `.mcoda/config.json` for workspace defaults (docdex URL, branch metadata).
- `.mcoda/mcoda.db` for backlog, jobs, and telemetry.

## Docs and specs
Generate documentation and specs from local or docdex context.

```sh
mcoda docs pdr generate --workspace-root . --project WEB --rfp-path docs/rfp/web.md --agent codex
mcoda docs sds generate --workspace-root . --project WEB --agent codex --template SDS_backend_service
mcoda openapi-from-docs --workspace-root . --agent codex --force
```

## Planning and backlog
Create tasks, refine them, and order them by dependencies.

```sh
mcoda create-tasks --workspace-root . --project WEB --agent codex --doc .mcoda/docs/sds/web.md --openapi openapi/mcoda.yaml
mcoda refine-tasks --workspace-root . --project WEB --agent codex
mcoda migrate-tasks --workspace-root . --project WEB --plan-dir .mcoda/tasks/WEB
mcoda order-tasks --workspace-root . --project WEB
mcoda backlog --workspace-root . --project WEB --order dependencies
```

## Execution, review, QA
Run the implementation loop and follow with review/QA.

```sh
mcoda work-on-tasks --workspace-root . --project WEB --status not_started,in_progress --limit 3
mcoda code-review --workspace-root . --project WEB --status ready_to_review --limit 5 --base mcoda-dev
mcoda qa-tasks --workspace-root . --project WEB --status ready_to_qa --profile integration
```

## Jobs and telemetry
Inspect long-running jobs and token usage.

```sh
mcoda job list --project WEB
mcoda job status <JOB_ID>
mcoda tokens --group-by project,command,agent --since 7d
```

## Updates
Check for updates and install a specific release.

```sh
mcoda update --check
mcoda update --force --channel stable
```

## Troubleshooting
- Use `--debug` and `--json` to capture detailed output.
- If docdex is unavailable, commands fall back to local docs and print a warning.
- Ensure `.mcoda/` is in `.gitignore` to avoid committing workspace state.

For full CLI reference, see `README.md`.
