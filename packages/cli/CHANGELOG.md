# Changelog

## Unreleased

## 0.1.94 - 2026-07-16

- Generate portable release-archive tarballs with rewritten mcoda workspace
  dependencies and enforce the behavior in packaging guardrails.
- Execute Windows pnpm command shims through `ComSpec` during package checks.
- Keep trusted npm publication on a deterministic Node-20-compatible npm CLI.

- Initial npm packaging scaffold for the mcoda CLI.
- Added bundled mswarm consent terms plus guided `mcoda setup`/postinstall consent bootstrap for installed CLI packages.
- Add `mcoda self-hosted` client identity flags and show node allowlist
  metadata returned by mswarm.

## 0.1.78

- Added owner-local GPU job commands: `mcoda gpu list`, `mcoda gpu ops`, and GPU-aware `mcoda job artifact upload|run|status|logs|events|artifacts|cancel|retry`.
- Added README and usage docs for the generic GPU job connection flags and environment fallbacks.

## 0.1.76

- Added top-level help aliases: `mcoda help`, `mcoda --help`, `mcoda -h`, and `mcoda -H`.
- Release v0.1.76.

## 0.1.9

- Release v0.1.9.

## 0.1.8

- Initial public release of the mcoda CLI.
