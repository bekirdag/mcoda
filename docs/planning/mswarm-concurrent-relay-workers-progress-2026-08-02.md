# mSwarm Concurrent Relay Workers Progress — 2026-08-02

## Status

Safe dispatcher revision implemented, independently approved, and fully validated; ready to commit and deploy.

## Investigation evidence

- Baseline commit: `560cc15f471b2e81b33bbd856c7e9efa2c872669` (clean worktree at start).
- Production read-only audit: the node is configured with cached inventory arguments `agent,list,--json`; no ordinary catalog-health change is justified.
- Local Codex session audit for 08:15–08:45 found no execution of `mcoda agent list --json --refresh-health` before later read-only process diagnostics at 08:43.
- Suku journals contain repeated 960×544 generations, but the caller cannot be proven from retained access logs. Health-probe changes are explicitly deferred rather than based on speculation.
- Confirmed defect: `startDaemon` holds one `polling` guard across `pollAndExecuteJob`, and that method includes execution plus result-post retry completion.
- Safety review rejected parallel claim polls: the gateway's current store contract does not provide an atomic claim, so concurrent long polls could lease the same queued job.
- Docdex symbol/AST inspection and impact traversal completed; impact graph reported no inbound/outbound file edges. Retrieval DAG: `9a1a5942-3639-42da-b04f-ec15297ad940`.

## Implementation log

- `pollRelayJob` now owns the single gateway claim request, while `executeRelayJobClaim` owns execution, lifecycle events, and result delivery. Public `pollAndExecuteJob` retains its sequential contract by composing both.
- `startDaemon` has exactly one claim dispatcher and launches returned leases as observed promises bounded by the LLM-class capacity (`maxConcurrentLlmJobs`, falling back to `maxConcurrentJobs`, minimum one).
- One guarded `schedulePoll` owns all repolls. Poll and result-delivery failures have independent streaks, and the maximum active delay governs the next claim. A successful poll therefore cannot erase a concurrent result-delivery failure's cooldown.
- `stop()` and gateway revocation clear the dispatcher timer; an already-issued poll or leased job remains observed and settles under the prior graceful semantics.
- Successful heartbeat recovery clears failure backoff and schedules an immediate claim without changing the recovery behavior added by `560cc15`.
- The regression configures overall capacity 4 and generic capacity 3 but LLM capacity 2, asserts maximum simultaneous claim polls is exactly one, and proves job B can complete while job A's result remains pending.
- An adversarial follow-up regression fails job A while claim poll B is outstanding, releases B, and proves claim C cannot start before the result-delivery cooldown.

## Validation log

- `docdexd run-tests --target packages/mswarm/src/__tests__/runtime.test.ts` could not start its managed daemon because port `28491` was already occupied; validation continued with the repository package commands.
- `pnpm --filter @mcoda/mswarm run build` — passed.
- Focused concurrency test — passed (1/1).
- Existing relay backoff, heartbeat recovery, and revoked-node tests — passed (3/3).
- Full compiled runtime test — passed (126/126).
- `pnpm --filter @mcoda/mswarm test` — passed (139/139, including build/typecheck).
- `docdexd hook pre-commit` — passed.
- The earlier checks above validated commit `8c5aa62`; the safe serialized-claim follow-up was then revalidated as follows.
- Renewed `pnpm --filter @mcoda/mswarm run build` — passed.
- Renewed focused serialized-claim/LLM-cap regression — passed (1/1).
- Focused execution-failure/claim-success race regression — passed (1/1).
- Renewed relay backoff, heartbeat recovery, and revoked-node tests — passed (3/3).
- Final full compiled runtime suite — passed (127/127).
- Final `pnpm --filter @mcoda/mswarm test` — passed (140/140, including build/typecheck).
- Renewed Docdex index, impact traversal, and impact diagnostics — passed; zero impact edges and zero unresolved import diagnostics.
- Two independent adversarial reviews approved the serialized-claim scheduler and the execution-failure race fix with no blockers.
- Final staged `docdexd hook pre-commit` — passed.

## Final handoff

- Reviewed patch is staged for the integration owner to commit and package.
