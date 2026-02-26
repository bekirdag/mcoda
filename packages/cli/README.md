# mcoda

mcoda is a local-first CLI for planning, documentation, and execution workflows with agent assistance.

## Install
- Requires Node.js >= 20.
- Global install: `npm i -g mcoda`
- Verify: `mcoda --version`

## Quick start
```sh
mcoda set-workspace --workspace-root .
mcoda docs pdr generate --workspace-root . --project WEB --rfp-path docs/rfp/web.md --agent codex
```

## Docdex & QA
- mcoda depends on the `docdex` CLI for doc search and context stitching.
- Run `docdex setup` (or `docdexd browser install`) to install the headless Chromium browser used for web enrichment.
- Docdex stores state under `~/.docdex`; mcoda does not create repo-local `.docdex` folders.
- If `~/.docdex/agents.md` exists, it is prepended to every agent run.

## Workspace layout
- `~/.mcoda/workspaces/<fingerprint>/config.json` for defaults (docdex URL, branch metadata, telemetry preferences).
- `~/.mcoda/workspaces/<fingerprint>/mcoda.db` for backlog, jobs, and telemetry.
- `~/.mcoda/workspaces/<fingerprint>/docs/` for generated artifacts.

## Common commands
- Docs: `mcoda docs pdr generate`, `mcoda docs sds generate`
- Specs: `mcoda openapi-from-docs`
- Planning: `mcoda create-tasks`, `mcoda task-sufficiency-audit`, `mcoda refine-tasks`, `mcoda order-tasks`
- Execution: `mcoda add-tests`, `mcoda work-on-tasks`, `mcoda code-review`, `mcoda qa-tasks`
- Backlog: `mcoda backlog`, `mcoda task`
- Jobs/telemetry: `mcoda jobs`, `mcoda tokens`, `mcoda telemetry`
- Agents: `mcoda test-agent`, `mcoda agent-run`
- Updates: `mcoda update --check`

`mcoda work-on-tasks` auto-runs the same test-harness bootstrap logic as `mcoda add-tests` when selected tasks require tests but no runnable harness exists.
`mcoda create-tasks` auto-runs a sufficiency pass (same engine as `mcoda task-sufficiency-audit`) to compare SDS coverage against generated backlog items and fill obvious planning gaps.
If that sufficiency pass errors, create-tasks continues (fail-open) and records audit failure details in job checkpoints/logs.

## Configuration
Environment variables are optional overrides for workspace settings:
- `MCODA_DOCDEX_URL` to point at a docdex server.
- `MCODA_API_BASE_URL` or `MCODA_JOBS_API_URL` for job APIs.
- `MCODA_TELEMETRY` set to `off` to disable telemetry.
- `MCODA_STREAM_IO=1` to emit agent I/O lines to stderr.

## Programmatic usage
```ts
import { McodaEntrypoint } from "mcoda";

await McodaEntrypoint.run(["--version"]);
```

## Documentation
Full docs live in the repository:
- README: https://github.com/bekirdag/mcoda
- Usage guide: https://github.com/bekirdag/mcoda/blob/main/docs/usage.md
- Quality gates: https://github.com/bekirdag/mcoda/blob/main/docs/quality_gates.md

## License
MIT - see `LICENSE`.
