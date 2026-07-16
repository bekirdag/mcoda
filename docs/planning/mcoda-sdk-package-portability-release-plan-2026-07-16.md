# mcoda SDK Package Portability Release Plan - 2026-07-16

## Goal

Ship a patch release that makes the repository-generated npm tarballs portable
outside the pnpm workspace, keeps the public Agent Setup SDK aligned with mcoda,
and verifies the complete publishable package set from source through npm.

Target release: `v0.1.93`, replacing the failed and unpublished `v0.1.92`
workflow attempt.

## Scope

- Fix `scripts/pack-npm-tarballs.js` so packed manifests contain installable
  versions instead of `workspace:*` dependency protocols.
- Add deterministic regression validation for packed package manifests and a
  clean external consumer install of the complete tarball set.
- Keep the ten-package release set aligned:
  `@mcoda/shared`, `@mcoda/db`, `@mcoda/agents`, `@mcoda/generators`,
  `@mcoda/integrations`, `@mcoda/core`, `@mcoda/agent-setup`, `mcoda`,
  `@mcoda/codali`, and `@mcoda/mswarm`.
- Update Agent Setup SDK documentation and release notes from `0.1.91` to
  `0.1.93`.
- Publish through the tag-triggered `.github/workflows/release.yml` workflow and
  verify the GitHub run plus npm registry state.

Out of scope: publishing the Laravel SDK to Packagist and publishing the
internal, unstable `@mcoda/testing` package.

## Dependency-Ordered Work

1. **Packer contract**
   - Replace raw npm packing with the pnpm-aware packaging path.
   - Preserve cross-platform command resolution and the existing artifact names.
   - Fail packaging when any runtime dependency retains a `workspace:` protocol.

2. **Portability validation**
   - Add focused tests for command selection, artifact naming, and manifest
     validation.
   - Add a release-oriented verifier that installs the full local tarball set in
     a clean temporary consumer without lifecycle scripts.
   - Wire verification into release packaging so archive artifacts cannot be
     uploaded when they are not installable.

3. **SDK alignment and versioning**
   - Update the SDK install/usage document and changelogs.
   - Bump root and all ten release package manifests to `0.1.93` and refresh the
     lockfile without adding dependencies.

4. **Validation gates**
   - Targeted packer/unit tests.
   - `@mcoda/agent-setup` build and test suite.
   - CLI packaging guardrail.
   - Full npm tarball generation plus clean consumer install.
   - Laravel `ci:release` regression check because it mirrors the SDK contract.
   - Full repository tests, release publish dry-run, `git diff --check`, and
     Docdex pre-commit hook.

5. **Controlled release**
   - Commit the validated patch, create annotated tag `v0.1.93`, and push main
     plus the tag.
   - Monitor the release workflow to completion.
   - Verify all ten intended npm packages report `0.1.93` with internal
     dependencies pinned to `0.1.93`.

## Acceptance Criteria

- A tarball created for `@mcoda/agent-setup` or `mcoda` contains no runtime
  `workspace:` dependencies.
- Installing all ten generated tarballs into a clean temporary npm consumer
  succeeds.
- Published `@mcoda/agent-setup` co-installs with published `mcoda` and exposes
  the root, headless, server, and React entrypoints.
- Targeted and full test suites pass with no failures.
- GitHub release workflow for `v0.1.93` succeeds.
- npm reports `0.1.93` for all ten release packages.

## Release Safety

- Do not publish directly from the local npm client; use the repository's
  OIDC/provenance GitHub workflow.
- Do not publish `@mcoda/testing` or the Laravel package in this release.
- Stop before tagging if local validation or tarball consumer installation
  fails.
