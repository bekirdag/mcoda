# Codali Required Docdex Provenance Plan

Date: 2026-07-16
Status: Implemented; production validation pending

## Problem

`docdex.required=true` validates that a Docdex runtime context is configured, but a gateway planner can still omit Docdex from its worker tasks. The gateway can then accept model-authored observations as evidence and synthesize an answer without a real Docdex tool call.

## Scope

1. Make planner output deterministic when Docdex is required.
2. Require successful tool telemetry for the selected Docdex worker task.
3. Exclude model-only observations from final synthesis when Docdex is required.
4. Preserve existing behavior for requests that do not set `docdex.required=true`.
5. Build the self-contained `@mcoda/mswarm` package and install it on the Suku self-hosted node.
6. Validate the TNL production question with a non-fallback answer, successful Docdex tool telemetry, indexed evidence, and dated citations.

## Change Order

1. Planner: mark an existing Docdex task as required or add a bounded required task.
2. Worker state machine: require the selected tool call to succeed before accepting evidence.
3. Final synthesizer: keep only Docdex-provenanced evidence for required-Docdex requests.
4. Tests: cover planner omission, worker evidence without tool telemetry, and final evidence filtering.
5. Package/deploy: build `@mcoda/codali`, build the vendored `@mcoda/mswarm`, install on Suku, and restart the user service.
6. Production validation: run the exact TNL seven-day question and inspect Codali telemetry plus relay health.

## Safety

- The enforcement gate is the existing `docdex.required` request flag.
- The worker remains read-only and receives only policy-approved tools.
- Evidence is discarded when required provenance is missing.
- No TNL, BDYA, or OKACAM data is modified by the package deployment.

## Validation

- Focused planner, state machine, and final synthesizer tests.
- Full `@mcoda/codali` test suite.
- Full `@mcoda/mswarm` package test suite.
- Docdex pre-commit hook.
- Suku service/package health.
- TNL production smoke with nonzero Docdex tool/evidence counts and cleanup verification.
