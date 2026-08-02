# mSwarm Relay Result Timeout Plan — 2026-08-02

## Goal

Allow durable media result uploads to finish without applying the node's short control-plane timeout to multi-megabyte result payloads.

## Evidence

- Production Wodo/Bekir acceptance completed audio and image inference on Suku, then the result endpoint aborted four times at the configured 10-second request timeout.
- `MswarmSelfHostedNodeClient.postJobResult` used the same `timeoutMs` as enrollment, heartbeat, and other small control-plane calls.
- Result submission is part of the job lifecycle and may include base64 media plus durable gateway persistence.

## Change order

1. Add a result-only client timeout with a five-minute default and a floor of the ordinary request timeout.
2. Derive the runtime value from `jobTimeoutMs`, capped at five minutes, while leaving ordinary request and long-poll behavior unchanged.
3. Add an abort-aware regression that exceeds the ordinary timeout but completes within the result timeout.
4. Run impact, focused, full-package, and semantic pre-commit gates; package the exact build; deploy with rollback backup; rerun Wodo/Bekir audio, image, and video acceptance.

## Exit criteria

- Large result delivery no longer aborts at 10 seconds.
- Ordinary control-plane timeouts are unchanged.
- Retries and failure logging remain intact.
- All three real media modalities complete through AI Chat with the expected tenant-owned mCoda agents.
