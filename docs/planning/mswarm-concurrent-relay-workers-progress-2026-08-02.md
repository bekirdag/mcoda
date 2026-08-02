# mSwarm Concurrent Relay Workers Progress — 2026-08-02

## Status

Implementation, local validation, and semantic pre-commit validation complete; commit pending.

## Investigation evidence

- Baseline commit: `560cc15f471b2e81b33bbd856c7e9efa2c872669` (clean worktree at start).
- Production read-only audit: the node is configured with cached inventory arguments `agent,list,--json`; no ordinary catalog-health change is justified.
- Local Codex session audit for 08:15–08:45 found no execution of `mcoda agent list --json --refresh-health` before later read-only process diagnostics at 08:43.
- Suku journals contain repeated 960×544 generations, but the caller cannot be proven from retained access logs. Health-probe changes are explicitly deferred rather than based on speculation.
- Confirmed defect: `startDaemon` holds one `polling` guard across `pollAndExecuteJob`, and that method includes execution plus result-post retry completion.
- Docdex symbol/AST inspection and impact traversal completed; impact graph reported no inbound/outbound file edges. Retrieval DAG: `9a1a5942-3639-42da-b04f-ec15297ad940`.

## Implementation log

- `SelfHostedNodeRuntime.startDaemon` now creates a bounded array of outbound relay workers from the LLM-class capacity (`maxConcurrentLlmJobs`, falling back to `maxConcurrentJobs`, minimum one).
- Each worker owns its polling flag, failure streak, and retry timer, so one slow execution/result post no longer occupies the entire daemon.
- `stop()` and gateway revocation clear every worker timer; already-running lifecycle promises remain observed and settle under the prior semantics.
- Successful heartbeat recovery wakes each failed sleeping lane without changing the recovery behavior added by `560cc15`.
- The regression intentionally configures overall capacity 4 and generic capacity 3 but LLM capacity 2, proving the relay pool is bounded by the correct execution class.

## Validation log

- `docdexd run-tests --target packages/mswarm/src/__tests__/runtime.test.ts` could not start its managed daemon because port `28491` was already occupied; validation continued with the repository package commands.
- `pnpm --filter @mcoda/mswarm run build` — passed.
- Focused concurrency test — passed (1/1).
- Existing relay backoff, heartbeat recovery, and revoked-node tests — passed (3/3).
- Full compiled runtime test — passed (126/126).
- `pnpm --filter @mcoda/mswarm test` — passed (139/139, including build/typecheck).
- `docdexd hook pre-commit` — passed.

## Final handoff

- Ready to commit on top of baseline `560cc15f471b2e81b33bbd856c7e9efa2c872669`.
