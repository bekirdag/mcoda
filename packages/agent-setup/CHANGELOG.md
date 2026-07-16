# Changelog

## Unreleased

## 0.1.94 - 2026-07-16

- Ensure release-archive tarballs contain installable `@mcoda/core` versions
  instead of pnpm workspace protocols.
- Refresh SDK installation and public-entrypoint documentation for `0.1.94`.

- Surface self-hosted mswarm client identity and allowlist metadata in catalog
  entries, server groups, runtime adapters, and SDK docs.

## 0.1.78

- Add the trusted backend `createMcodaGpuJobClient()` helper for owner-local
  mswarm generic GPU/package jobs.
- Add the React `GpuJobOpsPanel` export and `McodaAgentSetupPage` GPU job ops
  callbacks for queue, usage, quota, logs/events/artifacts, cancellation, and
  retry drilldowns.

## 0.1.74

- Expose non-secret local-runner metadata in catalog entries.
- Add local-runner search terms to headless catalog filtering.
- Add a first-class Local source lane to the React setup UI for unmanaged local
  vLLM, llama.cpp, and OpenAI-compatible runner agents.

## 0.1.66

- Initial agent setup SDK package.
