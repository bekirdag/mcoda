# Changelog

## Unreleased

## 0.1.93 - 2026-07-16

- Generate GitHub release npm tarballs with pnpm so workspace dependencies are
  rewritten to portable package versions.
- Run Windows pnpm command shims through `ComSpec` so portable packaging works
  across every release matrix platform.
- Validate packed manifests and clean consumer installation before publishing.
- Refresh the Agent Setup SDK installation guide for the current release.

## 0.1.89 - 2026-07-02

- Add the product-neutral Codali agentic orchestration gateway with runtime
  policy compilation, dynamic tool contracts, mcoda agent-tier resolution,
  worker execution, evidence normalization, verification, context packing,
  final large-model synthesis, trace/replay, evaluations, and production
  safety boundaries.
- Expose the gateway through mswarm `codali_gateway` payloads while preserving
  existing `codali_job` and single-task runtime compatibility.
- Harden encrypted Docdex repository access and signed read-only app tool
  gateway dispatch for tenant-scoped product integrations.

## 0.1.88

- Add OSS docs, CI, release automation, and npm packaging metadata.
- Align mcoda SDK, agent setup SDK, and CLI self-hosted mswarm access with
  tenant/client identity headers, allowlist metadata, and catalog filtering.

## 0.1.78

- Add owner-local mswarm generic GPU/package job support across shared
  contracts, core APIs, CLI commands, SDK helpers, and docs.

## 0.1.9

- Release v0.1.9.

## 0.1.8

- Initial public release of the mcoda CLI.
