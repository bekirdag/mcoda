# Codali Required Docdex Provenance Progress

Date: 2026-07-16
Status: Implementation validated; deployment pending

## Completed

- Confirmed production Codali completed with `toolCallCount=0`, `calledTools=[]`, and model-authored evidence despite TNL setting `docdex.required=true`.
- Added required Docdex task enforcement in `packages/codali/src/gateway/GatewayPlanner.ts`.
- Added `requiredToolCalls` prompt and result enforcement in `packages/codali/src/gateway/GatewayStateMachine.ts`.
- Added required-Docdex provenance filtering in `packages/codali/src/gateway/CodaliGateway.ts`.
- Added regression coverage for planner omission, worker evidence without a tool call, and final model-observation filtering.

## Validation Evidence

- PASS: focused gateway tests, 31/31.
- PASS: `pnpm --filter @mcoda/codali test`, 832/832.
- PASS: `pnpm --filter @mcoda/mswarm test`, 115/115.
- Docdex impact endpoints returned no dependency edges for the three gateway files; repo search and package tests were used to verify the known consumers.
- Docdex local completion review was attempted but the MCP transport was unavailable; primary-agent review and the full package suites were used instead.

## Remaining

- Build a portable `@mcoda/mswarm` tarball from the validated source.
- Install the package on Suku and restart `mswarm-self-hosted-node.service`.
- Run the exact TNL production question and record non-fallback Docdex telemetry.
- Commit and push the final production evidence.
