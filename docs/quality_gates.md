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
  - Changelog updated for user-facing changes.
- Tests:
  - Unit and integration tests pass across workspace packages.
  - Packaging guardrails pass (no accidental artifacts in npm tarball).
  - `node tests/all.js` covers run-all suites (add standalone scripts there when needed).

## Nightly checks
- `pnpm -r run build`
- `node tests/all.js`
- `pnpm --filter mcoda run pack:verify`
- `pnpm audit --audit-level high`

## Evidence artifacts
- Test logs from CI runs.
- Pack dry-run output from `npm pack --dry-run --json`.
- Audit output stored in CI logs.
