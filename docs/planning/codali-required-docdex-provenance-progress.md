# Codali Required Docdex Provenance Progress

Date: 2026-07-17
Status: Complete and validated in TNL production

## Completed

- Confirmed production Codali completed with `toolCallCount=0`, `calledTools=[]`, and model-authored evidence despite TNL setting `docdex.required=true`.
- Added required Docdex task enforcement in `packages/codali/src/gateway/GatewayPlanner.ts`.
- Added `requiredToolCalls` prompt and result enforcement in `packages/codali/src/gateway/GatewayStateMachine.ts`.
- Added required-Docdex provenance filtering in `packages/codali/src/gateway/CodaliGateway.ts`.
- Added regression coverage for planner omission, worker evidence without a tool call, and final model-observation filtering.
- Propagated failed required evidence-stage executions instead of allowing synthesis to continue without Docdex provenance (`810eb6f`).
- Made required Docdex tools execute deterministically before model-led evidence work (`872b1d7`).
- Preserved encrypted Docdex client identity and logical tenant scope through Codali runtime construction (`189c73f`).
- Added the encrypted tenant-aware POST search, batch-search, and web-research contracts to `DocdexClient` (`e25261b`).
- Built and installed validated `@mcoda/codali` and `@mcoda/mswarm` packages on Suku, then restarted `mswarm-self-hosted-node.service` successfully.
- Ran the exact TNL production question and confirmed the required runtime Docdex tool call, current indexed evidence, and a grounded source-linked ranking.

## Validation Evidence

- PASS: focused gateway and `DocdexClient` tests, including 16/16 encrypted/local client cases.
- PASS: `pnpm --filter @mcoda/codali test`, 834/834.
- PASS: `pnpm --filter @mcoda/mswarm test`, 117/117.
- PASS: semantic pre-commit gate.
- PASS: Suku service active after installing both package tarballs; installed code contains the encrypted tenant search implementation.
- PASS: production TNL exact-question smoke returned HTTP 200 with gateway `succeeded`, `toolCallCount=1`, `calledTools=[docdex_search]`, 8 evidence items, 8 sources, and no warnings.
- Docdex impact endpoints returned no dependency edges for the three gateway files; repo search and package tests were used to verify the known consumers.
- Docdex local completion review was attempted but the MCP transport was unavailable; primary-agent review and the full package suites were used instead.

## Remaining

- None for this incident. TNL's answer-level grounding and temporal filters remain application-owned defenses around the shared Codali runtime.
