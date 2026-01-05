# mcoda OSS publishing plan

## Goals
- Mirror docdex OSS release hygiene for mcoda: docs, license, CI, release automation, and tests.
- Prepare npm publishing with clear metadata and repeatable release steps.

## Docdex items to replicate
- Core docs: README, LICENSE, CHANGELOG, CONTRIBUTING, CLA.
- Npm-facing docs: README, CHANGELOG, LICENSE in the published package.
- Issue templates and release workflows (ci, nightly, release-please, release, dry-run).
- Quality gates doc and packaging/test guardrails.

## Plan
1) Documentation and governance
- Add root LICENSE, CHANGELOG, CONTRIBUTING, CLA.
- Expand README with npm install, quick start, and support links.
- Add `docs/usage.md` and `docs/quality_gates.md` for deeper usage + release quality checks.

2) Package metadata and npm layout
- Decide package name (`mcoda` vs `@mcoda/cli`) and versioning scheme.
- Ensure runtime packages are publishable (cli, core, shared, db, integrations, agents).
- Mark non-public packages as private.
- Add metadata (description, repository, bugs, homepage, keywords, engines, license, files).
- Add npm packaging guard test (tarball content sanity).

3) CI and release automation
- Add CI workflow: build + test on push/PR.
- Add nightly quality workflow: audit + tests + packaging checks.
- Add release-please config + manifest for versioning.
- Add release workflow for npm publish with OIDC.
- Add release dry-run workflow.
- Add GitHub issue templates.

4) Verification
- Run local build/tests and npm pack dry-run for the CLI.
- Validate workflows are consistent with the repo structure.

## Decisions (current)
- npm package name: `mcoda`.
- Published packages: `mcoda`, `@mcoda/core`, `@mcoda/shared`, `@mcoda/db`, `@mcoda/integrations`, `@mcoda/agents`.
- Private packages: `@mcoda/generators`, `@mcoda/testing`.
