# Changelog

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
