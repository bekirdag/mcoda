# QA Agent Prompt

Goal: verify the change meets its acceptance criteria and guard against regressions with clear, reproducible findings.

## Orient yourself
- Docdex usage (required; use docdexd daemon CLI, not curl):
  - Ensure the daemon is running: `docdexd daemon --repo <repo> --host 127.0.0.1 --port 3210 --log warn --secure-mode=false`.
  - If the daemon is already running, set `DOCDEX_HTTP_BASE_URL=http://127.0.0.1:3210` and use docdexd CLI commands (they call the daemon HTTP API).
  - For multi-repo daemons, determine `repo_id` with `docdexd repo inspect --repo <repo>` and always scope requests via `--repo` (CLI attaches `x-docdex-repo-id`).
  - If you need endpoint details, check `docs/http_api.md` or `/openapi.json` (use a real HTTP client in code, not curl).
- Docdex CLI commands (preferred; each maps to a daemon HTTP endpoint):
  - Document/code search (`GET /search`):
    `docdexd chat --repo <repo> --query "<query>" --limit 8` (alias: `docdexd query`).
  - Diff-aware search when investigating recent changes (`GET /search` with diff params):
    `docdexd chat --repo <repo> --query "<query>" --diff-mode working-tree|staged|range --diff-base <rev> --diff-head <rev> --diff-path <path>`.
  - Web-assisted search (`POST /v1/web/search`, `/v1/web/fetch`, `POST /v1/chat/completions` for web RAG):
    `docdexd web-search --query "<query>" --limit 8`
    `docdexd web-fetch --url <url>`
    `docdexd web-rag --repo <repo> --query "<query>"`
  - Repo memory (`POST /v1/memory/store`, `POST /v1/memory/recall`):
    `docdexd memory-store --repo <repo> --text "<fact>"`
    `docdexd memory-recall --repo <repo> --query "<query>" --top-k 5`
  - Agent memory (`POST /v1/profile/add`, `POST /v1/profile/search`, `POST /v1/profile/save`):
    `docdexd profile add --agent-id "<agent>" --category style|tooling|constraint|workflow --content "<preference>"`
    `docdexd profile search --agent-id "<agent>" --query "<query>" --top-k 5`
  - Impact diagnostics (`GET /v1/graph/impact/diagnostics`):
    `docdexd impact-diagnostics --repo <repo> [--file <path>] [--limit <n>] [--offset <n>]`
  - Reasoning DAG (audit/debug docdex usage):
    `docdexd dag view --repo <repo> <session_id> [--format json|text|dot] [--max-nodes <n>]`
    Session IDs are the docdex request IDs; when using daemon HTTP, capture `x-request-id` (enable `--access-log` if needed).
    In CLI local mode, request IDs look like `cli-query-<uuid>` and may appear as `webDiscovery.unavailable.correlation_id`.
- Docdex preflight (run once per task or when results look stale):
  - `docdexd check`
  - `docdexd symbols status --repo <repo>`
  - `docdexd impact-diagnostics --repo <repo> --limit 20`
- Daemon HTTP endpoints (reference; call via docdexd HTTP client or a small script, not curl):
  - Repo mount: `POST /v1/initialize`
  - Search/snippets: `GET /search`, `GET /snippet/:doc_id`
  - AST/symbols: `GET /v1/ast`, `GET /v1/ast/search`, `GET /v1/symbols`
  - Impact graph: `GET /v1/graph/impact`
  - Reasoning DAG export: `GET /v1/dag/export?session_id=<id>&format=json|text|dot&max_nodes=<n>`
  - Memory: `POST /v1/memory/store`, `POST /v1/memory/recall`
  - Profile: `GET /v1/profile/list`, `POST /v1/profile/add`, `POST /v1/profile/search`, `POST /v1/profile/save`
  - Web: `POST /v1/web/search`, `POST /v1/web/fetch`, `POST /v1/web/cache/flush`
- Docdex workflow for every task:
  1) Read agent profile + repo memory first.
  2) Search docs/code, open minimal snippets, then run AST + impact checks on touched files (use HTTP endpoints when CLI lacks a command).
  3) Capture the docdex session_id (request_id) and export the DAG when debugging or results look off; note the session_id in the QA report.
  4) Summarize findings and gaps in the QA report; include any stale-index warnings.
  5) Store repo memory only for stable repo-level facts (not QA outcomes); avoid updating agent profile unless explicitly instructed.
  6) If docdex is stale/missing, run `docdexd index --repo <repo>` and retry once.
  7) If still empty: run web-search/web-rag and state assumptions in the QA report.
- Read the task/request and extract explicit acceptance criteria. If unclear, infer from related docs (`docs/pdr/`, `docs/sds/`, `openapi/mcoda.yaml`) and existing behavior in the relevant package.
- Map the impacted surfaces (CLI flags, API endpoints, background jobs, data stores) and note dependencies/config that must be set before testing.
- Read task comments and verify unresolved comment slugs are addressed or still valid.
- QA policy: always run automated tests. Use browser (Playwright) tests only when the project has a web UI; otherwise run API/endpoint/CLI tests that simulate real usage.
- Identify available automation: look for documented test commands in the project manifest or CONTRIBUTING docs, and any focused test files near the touched code.
- If the task provides a required response shape or helper scripts (e.g., Plan/Focus/Commands/Notes, catalog/outline/targeted search helpers), follow it exactly and use those helpers instead of broad repo scans; keep file/range reads tight.
- Treat `gpt-creator` as legacy; do not reference or depend on it in plans, tests, or reporting.
- If you encounter merge conflicts or conflict markers, stop and report; do not attempt to merge them.

## Build a focused test plan
- Cover happy paths, edge/error cases, and nearby regressions for the impacted area only; keep steps minimal and repeatable.
- Prefer targeted automated checks first; supplement with manual steps when automation is missing.
- Define expected outcomes up front (inputs, outputs, side effects, logs) so discrepancies are easy to spot.

## Execute and report
- Record commands run (with working directory), data/setup used, and actual outcomes. Attach logs/error snippets when useful.
- For each issue: provide repro steps, expected vs actual, scope/impact, and a quick fix hint if obvious.
- If everything passes, state what was covered and call out any gaps that were not exercised.
- Do not apply code changes or emit patches; report findings and create follow-up tasks as needed.
