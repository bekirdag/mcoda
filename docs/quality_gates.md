# mcoda Quality Gates

This document defines baseline quality gates for mcoda releases. Use it for release readiness checks and nightly CI.

## Release targets (global)
- Stability:
  - Core CLI flows complete without unhandled exceptions.
  - Workspace initialization creates `.mcoda` and the SQLite DB reliably.
  - Task creation, ordering, and migrations succeed on sample projects.
- Performance:
  - Dependency ordering completes within 5s for 10k tasks on a laptop.
  - Backlog listing for 1k tasks completes within 3s.
- Security:
  - No critical/high CVEs in direct dependencies.
  - Secrets are never printed in CLI output or logs.
- Documentation:
  - README and `docs/usage.md` cover new flags and behavior changes.
  - Docgen iteration flags, quality levels, and review report artifacts are documented in `docs/usage.md`.
  - Changelog updated for user-facing changes.
  - Docgen glossary (`packages/core/src/services/docs/review/glossary.json`) reflects canonical terminology for consent, pipeline naming, and telemetry.
- Tests:
  - Unit and integration tests pass across workspace packages.
  - Packaging guardrails pass (no accidental artifacts in npm tarball).
  - `node tests/all.js` covers run-all suites (add standalone scripts there when needed).

## Docgen iteration gates
- Iterative PDR/SDS generation runs review/patch/re-check loops up to `MCODA_DOCS_MAX_ITERATIONS` (default `2`), unless `--fast` or `--dry-run` disables iteration.
- `--quality build-ready` treats docgen gates as blocking and requires a complete artifact set (PDR, SDS, OpenAPI, SQL schema, deployment blueprint).
- Core gates include placeholder/template artifacts, terminology normalization, API path consistency, open questions extraction/resolution, no-maybes (when enabled), build-ready completeness, RFP consent contradictions, RFP definition coverage, PDR interfaces/ownership/open-questions quality, SDS explicit decisions/policy+telemetry/ops+observability/external adapters, OpenAPI schema sanity/coverage, SQL syntax/required tables, deployment blueprint validation, and cross-document alignment (unless `--cross-align false`).
- Review reports are persisted under `<workspace-dir>/jobs/<jobId>/review/` as JSON/Markdown (`review-iteration-<n>` plus `review-final`) with completion status (`completed` or `max_iterations`) and any remaining blockers.

## Nightly checks
- `pnpm -r run build`
- `node tests/all.js`
- `pnpm --filter mcoda run pack:verify`
- `pnpm audit --audit-level high`

## Evidence artifacts
- Test logs from CI runs.
- Pack dry-run output from `npm pack --dry-run --json`.
- Audit output stored in CI logs.
