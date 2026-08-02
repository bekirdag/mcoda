# mSwarm Concurrent Relay Workers Plan — 2026-08-02

## Goal

Make the outbound self-hosted node honor its declared LLM concurrency so a slow generation or result upload cannot block unrelated relay jobs.

## Scope

- `packages/mswarm/src/runtime.ts`: replace the single daemon relay-poll guard with a bounded worker pool derived from the configured LLM concurrency.
- `packages/mswarm/src/__tests__/runtime.test.ts`: prove another job is polled while the first job's result post is still pending, and prove `stop()` prevents replacement workers.
- No production mutation, agent-name/media-name routing, catalog-health semantic change, or modification of commit `560cc15`.

## Evidence and dependency order

1. `SelfHostedNodeRuntime.startDaemon` owns scheduling and calls `pollAndExecuteJob`; `pollAndExecuteJob` owns poll, execution, and all result-post retries.
2. Its one `polling` boolean therefore serializes the full lifecycle even when `maxConcurrentJobs`/`maxConcurrentLlmJobs` is greater than one.
3. AST/symbol inspection places `startDaemon` at lines 8070–8199 and `pollAndExecuteJob` at 7880–8035 inside `SelfHostedNodeRuntime`.
4. Docdex impact traversal returned no cross-file import edges for the monolithic runtime; direct consumers are the server entrypoint and runtime tests found by semantic search.
5. The retrieval DAG session `9a1a5942-3639-42da-b04f-ec15297ad940` records the search/tool/observation chain used to select this change order.

## Implementation phases

1. Add a bounded count of active relay workers in `startDaemon`.
2. Fill available slots up to `maxConcurrentLlmJobs` (falling back to `maxConcurrentJobs`, minimum one).
3. Keep every worker promise observed, apply existing revocation/backoff handling, and refill only when the daemon is active.
4. Preserve the existing heartbeat recovery behavior from `560cc15`: a successful heartbeat cancels failure backoff and refills available workers immediately.
5. Preserve synchronous `stop()` semantics: cancel timers, prevent refills, and allow already-running work to settle through its existing lifecycle.

## Validation

- Focused regression: with concurrency two, hold job A's result post open and assert job B is polled and completed.
- Stop regression: stop while workers are pending, release them, and assert no replacement poll starts.
- Existing relay backoff/recovery and removed-node tests.
- Package test/build/type validation, then Docdex pre-commit hook.

## Exit criteria

- A pending result upload consumes only its own configured slot.
- No more than the declared LLM worker count is active.
- No unhandled worker promise and no new poll after `stop()`.
- All targeted tests and build checks pass.
