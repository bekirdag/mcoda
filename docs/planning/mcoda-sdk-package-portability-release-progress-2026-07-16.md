# mcoda SDK Package Portability Release Progress - 2026-07-16

## Current Status

Status: local release gates passed; publication pending.

Target release: `v0.1.92`.

## Baseline Evidence

- Local `main` is clean at `4cd6f07` and matches remote `origin/main`.
- Tag `v0.1.91` points to `f492ca8`; no package or release-script files changed
  between that tag and current main.
- All ten intended npm packages currently report version `0.1.91` with internal
  dependencies pinned to `0.1.91`.
- `@mcoda/agent-setup` build and 30 tests pass.
- Published `@mcoda/agent-setup@0.1.91` cleanly co-installs with
  `mcoda@0.1.91`; public SDK entrypoints import successfully.
- Laravel SDK `composer run ci:release` passes, including 14 PHPUnit tests with
  118 assertions, consumer install, and release-archive smoke checks.

## Confirmed Gaps

- `scripts/pack-npm-tarballs.js` invokes raw `npm pack`. Generated
  `@mcoda/agent-setup` and `mcoda` tarballs retain `workspace:*` runtime
  dependencies.
- A clean install of the generated Agent Setup tarball fails with npm
  `EUNSUPPORTEDPROTOCOL` for `workspace:*`.
- The npm-published package works because `pnpm publish` rewrites workspace
  protocols; therefore npm publication is healthy while GitHub release archive
  tarballs are not portable.
- `docs/mcoda-agent-setup-sdk-install-usage.md` still documents `0.1.87` even
  though the current release is `0.1.91`.

## Work Log

- [x] Recovered repo/profile memory and audited current package/release truth.
- [x] Verified npm and Packagist external state.
- [x] Reproduced the local tarball install failure in an isolated consumer.
- [x] Complete impact/AST/DAG review for the packer change.
- [x] Implement pnpm-aware packing and portability validation.
- [x] Update documentation, changelogs, manifests, and lockfile assessment.
- [x] Run targeted and full validation.
- [ ] Commit, tag, push, and verify npm publication.

## Validation Evidence

- Docdex symbols/AST confirmed the packer has one command resolver and
  top-level pack loop; the impact graph has no JavaScript import edges.
- Docdex repo search identified `.github/workflows/release.yml` and
  `.github/workflows/release-dry-run.yml` as operational consumers, so workflow
  validation follows the packer change.
- `pnpm pack --pack-destination ... --json` was verified to rewrite
  `@mcoda/core: workspace:*` to the current package version in the generated
  Agent Setup manifest.
- The packer now inspects each generated tarball and rejects leaked workspace
  protocols, identity mismatches, and incorrect internal dependency rewrites.
- Added focused unit coverage plus pnpm-based CLI packaging guardrails and wired
  portable packing into the release dry-run workflow.
- Bumped the root and all ten release package manifests to `0.1.92`; the pnpm
  lockfile does not encode workspace package versions, so no lockfile content
  change is required.
- Updated root/CLI/Agent Setup changelogs and the Agent Setup install guide for
  the `0.1.92` release.
- pnpm `9.15.9`, matching the release workflow major, packs Agent Setup with
  `@mcoda/core` rewritten to `0.1.92` and no workspace protocols.
- All ten local `0.1.92` tarballs install together in a clean canonical-path npm
  consumer under CI's Node 20 line. Agent Setup's root, headless, server, and
  React entrypoints import; core/shared/codali import; the CLI reports `0.1.92`.
- `docdexd run-tests --target packages/agent-setup` passed all 30 SDK tests.
- `pnpm --filter mcoda run pack:verify` passed the CLI package-content guard.
- `MCODA_PUBLISH_AGENT_SETUP=1 MCODA_PUBLISH_CODALI=1 pnpm run
  release:publish:npm:dry-run` completed for all ten release packages.
- Laravel `composer run ci:release` passed 14 PHPUnit tests (118 assertions),
  consumer-install smoke, and release-archive smoke.
- `pnpm install --frozen-lockfile` completed without lockfile changes.
- Full `docdexd run-tests` passed all 11 tested workspace packages in 88.8
  seconds with no failures.
- Post-change Docdex indexing, symbols, AST, impact, and import diagnostics are
  healthy; the new packer test is the only inbound code edge.
- `git diff --check` and focused Prettier validation pass.

## Blockers

None. The initial npm cache permission message was a sandbox-access artifact;
the same pack commands succeed with normal user access.
