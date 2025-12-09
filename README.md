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
