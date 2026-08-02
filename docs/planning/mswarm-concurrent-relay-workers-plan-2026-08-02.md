# mSwarm Concurrent Relay Workers Plan — 2026-08-02

## Goal

Make the outbound self-hosted node honor its declared LLM concurrency so a slow generation or result upload cannot block unrelated relay jobs.

## Scope

- `packages/mswarm/src/runtime.ts`: split claim polling from execution/result delivery, keep claims serialized, and bound detached execution lifecycles by configured LLM concurrency.
- `packages/mswarm/src/__tests__/runtime.test.ts`: prove at most one claim poll is outstanding while two leased jobs can progress concurrently, and prove `stop()` prevents a replacement poll.
- No production mutation, agent-name/media-name routing, catalog-health semantic change, or modification of commit `560cc15`.

## Evidence and dependency order

1. `SelfHostedNodeRuntime.startDaemon` owns scheduling and calls `pollAndExecuteJob`; `pollAndExecuteJob` owns poll, execution, and all result-post retries.
2. Its one `polling` boolean therefore serializes the full lifecycle even when `maxConcurrentJobs`/`maxConcurrentLlmJobs` is greater than one.
3. Concurrent gateway polls are unsafe under the current gateway store contract because claiming is not atomic. Concurrency must begin only after a single poll has returned a leased job.
4. AST/symbol inspection places both lifecycle methods inside `SelfHostedNodeRuntime`.
5. Docdex impact traversal returned no cross-file import edges for the monolithic runtime; direct consumers are the server entrypoint and runtime tests found by semantic search.
6. The retrieval DAG session `9a1a5942-3639-42da-b04f-ec15297ad940` records the search/tool/observation chain used to select this change order.

## Implementation phases

1. Extract one claim-only method and one execution/result-delivery method; keep public `pollAndExecuteJob` compatible by composing them sequentially.
2. Run exactly one claim dispatcher and launch each returned lease into an observed execution lifecycle, capped by `maxConcurrentLlmJobs` (falling back to `maxConcurrentJobs`, minimum one).
3. Centralize repolls through one guarded timer. Poll and result-delivery failures keep separate streaks, and the longer active cooldown governs the next claim so a successful in-flight poll cannot erase a delivery failure.
4. Preserve the existing heartbeat recovery behavior from `560cc15`: a successful heartbeat clears failure backoff and schedules an immediate poll when capacity allows.
5. Preserve synchronous `stop()` semantics: cancel timers, prevent new claims, and allow an already-issued poll or leased job to settle through its existing lifecycle.

## Validation

- Focused regression: hold the first claim response to prove only one poll is outstanding, then hold two result posts to prove the LLM cap is two even when overall/generic limits are larger.
- Backoff-race regression: fail job A while claim poll B is outstanding, release B, and prove no third claim starts before the execution/result-delivery cooldown.
- Stop regression: stop with both leases pending, complete job B while job A remains blocked, then assert no replacement poll starts.
- Existing relay backoff/recovery and removed-node tests.
- Package test/build/type validation, then Docdex pre-commit hook.

## Exit criteria

- A pending result upload consumes only its own configured slot.
- Exactly one gateway claim poll is outstanding, and no more than the declared LLM lifecycle count is active.
- No unhandled execution promise and no new poll after `stop()`.
- All targeted tests and build checks pass.
