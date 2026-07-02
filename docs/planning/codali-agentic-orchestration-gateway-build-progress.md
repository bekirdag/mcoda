# Codali Agentic Orchestration Gateway Build Progress

Guide: `docs/planning/codali-agentic-orchestration-gateway-build-guide.md`
Source plan: `docs/planning/codali-agentic-orchestration-gateway.md`
Date: 2026-07-02
Status: Phase 0 through Phase 18 release gates complete; release publish pending CI/tag confirmation

## Checklist

- [x] Load profile memory and repo memory.
- [x] Read `planning_progress_loop` skill.
- [x] Inspect `docs/planning/codali-agentic-orchestration-gateway.md`.
- [x] Inspect related Codali/Docdex/mswarm planning docs.
- [x] Inspect current Codali runtime, job runtime, mswarm executor, local runner config, and package tree.
- [x] Create a complete build guide under `docs/planning`.
- [x] Create this progress tracker.
- [x] Implement Phase 0 baseline audit.
- [x] Implement Phase 1 gateway contracts and schemas.
- [x] Implement Phase 2 gateway policy and tool capability compilers.
- [x] Implement Phase 3 mcoda agent tier resolver.
- [x] Implement Phase 4 gateway store abstraction.
- [x] Implement Phase 5 router and planner stages.
- [x] Implement Phase 6 worker task executor.
- [x] Implement Phase 7 evidence normalizer and provenance.
- [x] Implement Phase 8 verification and follow-up loop.
- [x] Implement Phase 9 context pack builder.
- [x] Implement Phase 10 final synthesizer.
- [x] Implement Phase 11 Docdex encrypted search hardening.
- [x] Implement Phase 12 signed app tool gateway dispatcher.
- [x] Implement Phase 13 mswarm gateway transport.
- [x] Implement Phase 14 Suku live model validation harness.
- [x] Implement Phase 15 observability, trace, and replay surfaces.
- [x] Implement Phase 16 evaluation suites and quality gates.
- [x] Implement Phase 17 security, rate-limit, and approval skeletons.
- [x] Implement Phase 18 release, rollout, and product integration preparation.
- [ ] Push release tag and confirm npm registry publish.

## Findings

- The source plan describes a generic agentic gateway pattern with small LLM workers, tools/RAG, evidence store, context refiner, and final large model synthesis.
- In this repo, the optimal implementation path is not a new LangGraph/LiteLLM service. Codali already has the native primitives needed for the gateway.
- Current Codali baseline includes `runCodaliTask`, `runCodaliJob`, dynamic runtime-provided read-only app tool contracts, stage role pass-through, Docdex tools, sessions, subagents, and telemetry.
- Current mswarm baseline can invoke Codali and now supports `codali_job` while preserving existing single-task behavior.
- Current Docdex encrypted repository access work already gives mcoda/Codali the required immutable runtime context model: attached mswarm API key, immutable repo id, allowed operations, capabilities, and stable Docdex error behavior.
- Current local runner config supports llama.cpp and other OpenAI-compatible local/self-hosted runners; gateway model selection should use mcoda inventory dynamically and must not hardcode suku model names.
- Phase 0 baseline tests were green before Phase 1 code changes.
- Phase 1 is intentionally contract-only. It adds product-neutral gateway request, policy, agent-tier, evidence, context-pack, result, planner, worker-task, verifier, trace, and validation-result types.
- Phase 1 validators normalize snake_case caller payloads into camelCase Codali gateway contracts, keep runtime Docdex/tool contract shapes by reference, and reject unsafe read/write/shell/destructive permissions for the initial read-only gateway.
- No runtime gateway execution behavior is wired yet. Policy compilation, agent resolution, store, planner, workers, evidence normalization, and final synthesis remain in later phases.
- Phase 2 adds a product-neutral policy compiler and tool capability compiler. They convert validated gateway policy into read-only `CodaliRuntimePolicy` and `CodaliJobBudgets`, remove denied/disabled/unsafe/undeclared tools before planner or worker exposure, enforce Docdex allowed operations, and block tenant/repo/base URL override fields in dynamic app tool call schemas.
- Phase 3 adds a product-neutral mcoda inventory resolver. It normalizes agent records into gateway candidates and assigns roles by tier, capability, health, local/self-hosted preference, image-worker policy, cloud fallback policy, and deterministic tie-breaks without hardcoded suku model names.
- Phase 4 adds the gateway store boundary with an in-memory implementation and recursive redaction for request metadata, tool calls, model calls, context packs, and artifact metadata.
- Phase 5 adds the provider-backed classifier/planner boundary and a planning-only gateway wrapper. The planner builds prompts from the effective Phase 2 tool surface, requests JSON-schema output, repairs one malformed JSON response, validates planner output, strips disabled tools, and gates image workers behind `allowImageWorker`.
- Phase 6 adds the worker task executor state machine. It converts validated planner tasks into injected worker task-runner calls, enforces max parallel workers, max tool calls, max runtime, per-task timeout, approved tools only, required/optional failure behavior, run/task trace persistence, and worker telemetry.
- Phase 7 adds evidence normalization and provenance. It normalizes worker outputs, direct evidence arrays, facts, source records, Docdex hits, app-tool payloads, and malformed JSON into stable `CodaliEvidenceItem` records with deterministic ids, conservative scoring, duplicate folding, source/tool metadata preservation, tenant-scope enforcement, and low-confidence model-observation fallback for unprovenanced material.
- Phase 8 adds the optional verifier/follow-up loop to `GatewayStateMachine`. It validates verifier JSON with the existing product-neutral verifier schema, persists verifier model calls, accepts only policy-approved follow-up tasks, rejects duplicate/disabled/unavailable/budget-exhausted follow-ups, stops on verifier pass, no useful work, max iterations, required tool unavailability, or budget exhaustion, and stores verification summaries on the run trace.
- Phase 9 adds the deterministic context pack builder. It ranks evidence by relevance, confidence, freshness, and source quality; folds duplicate claims; strips raw excerpts and raw payload refs from decision facts; emits only selected truncated excerpts; carries verifier missing-information and contradiction signals; summarizes tool calls by tool/status; respects evidence count and approximate context-token budgets; and persists the pack through the gateway store.
- Phase 9 also narrows gateway-store redaction so numeric token accounting keys such as `tokenEstimate`, `inputTokens`, `outputTokens`, and `totalTokens` remain usable in persisted telemetry while exact `token` secrets and bearer/API-key-like values still redact.
- Phase 10 adds final synthesis on `CodaliGateway`. It builds or reuses the Phase 9 context pack, filters final evidence/sources against allowed and denied tool policy, resolves the `final_synthesizer` role through `AgentTierResolver`, enforces `requireFinalLargeModel`, disables final-model tool calls, records final model-call telemetry, retries one retryable final-provider failure, and returns a `CodaliGatewayResult` with answer, sources, confidence, final model metadata, trace, and operational failure/degraded-fallback behavior.
- Phase 11 hardens encrypted Docdex repository access for gateway mode. Attached-mswarm-key Docdex jobs are immutable by default, cannot fall back to local base URL/repo root defaults, require remote base URL, repo id, allowed operations, capability map, and key material, preserve stable encrypted error codes, block disallowed operations before network access, and propagate Docdex request IDs into evidence, trace-safe tool-call metadata, and final result telemetry.
- Phase 12 adds signed app-tool gateway dispatch. `AppToolGatewayDispatcher` now builds HMAC-signed read-only request envelopes with run/session/request ids, tenant scope, requester scope, validated args, timestamp, nonce, contract/source metadata, redacted diagnostics, and evidence-ready response payloads. Runtime dynamic `app_tool_gateway` tools now execute through this dispatcher.
- Phase 12 also tightens direct gateway visibility. `ToolCapabilityCompiler` and runtime registration now hide direct gateway tools unless both the app contract and gateway explicitly declare read-only behavior and signing material is present. Dispatcher-level validation rejects reserved tenant/repo/base URL/credential overrides in args.
- Phase 13 adds mswarm `codali_gateway` request transport while preserving `codali_job` and single-task compatibility.
- Phase 14 adds a product-neutral live model validation harness for dynamic mcoda/Suku inventory discovery, role classification, live smoke scenarios, redacted reports, and CLI access through `codali eval --gateway-live-smoke`.
- The current Suku inventory proves large final-answer synthesis through `codex55`, but does not currently prove a runnable small/medium JSON agent or image artifact path. The harness records those as degraded/actionable live-environment gaps instead of silently passing.
- Phase 15 adds product-neutral gateway observability and replay fixtures. `GatewayTraceReplay` reads the store trace into a redacted diagnosis-ready view, derives product metadata summaries, emits OpenTelemetry-style event names, exports replay fixtures with optional model inputs/outputs and frozen tool/evidence/context data, and exposes convenience methods on `CodaliGateway`.
- Phase 16 adds a product-neutral gateway evaluation suite. It covers generic questions, code/repo questions, encrypted Docdex search questions, product-tool questions, disabled-integration questions, image generation questions, and missing-evidence questions without OKACAM-specific routing logic.
- Phase 16 gates catch planner schema/task-type drift, hardcoded routing, evidence precision loss, bad citation/source wiring, disabled-tool leakage, wrong final-answer model tier, non-direct final answers, missing image artifacts, missing-evidence fabrication, and cost/latency/token/tool/model budget regressions.
- Phase 17 adds production safety boundaries around the gateway without enabling write tools. It introduces effective per-run/per-tenant limits, explicit tool risk categories, approval skeleton types, model/evidence/image budget enforcement, and prompt-injection hardening for classifier, planner, worker, and final synthesis prompts.
- Phase 17 keeps mutation behavior disabled by default. Read-only tools remain callable; write-like tools require a future approval workflow and are still blocked unless policy and approval state explicitly allow them; destructive tools are blocked.
- Phase 18 bumps the workspace release to `0.1.89`, adds a product integration brief for OKACAM and future generic callers, confirms the tag-based npm release workflow, and prepares the release for CI/CD publish through `v0.1.89`.
- Phase 18 includes a small resolver hardening patch: nested self-hosted relay aliases are de-prioritized behind direct candidates when resolving agent tiers. This keeps dynamic inventory selection intact while avoiding poor aliases when a direct self-hosted candidate exists.
- Phase 18 local validation is green for build, full tests, gateway eval smoke, mswarm transport coverage, CLI packaging guardrails, and npm publish dry-run.
- Phase 18 live Suku validation is intentionally recorded as degraded, not green. `codex55` proved the large final synthesizer path, but current Suku self-hosted aliases selected from mcoda inventory fail through the OpenRouter-backed run path with "not a valid model ID", and no healthy text-to-image worker is advertised. This is live catalog/runtime drift outside the deterministic gateway tests, so rollout must keep feature flags and fallback paths active until Suku inventory dispatch is corrected.
- User constraints relevant to the build guide:
  - no hardcoded model or agent identifiers in Codali;
  - final user-visible OKACAM answers should use the big/final model when available;
  - small/local models should gather/classify/verify/draft structured artifacts, not become the normal final answer;
  - Docdex encrypted server memory/search features are core production capabilities;
  - major agent-runtime changes require live end-to-end validation, including suku models.

## Validation Evidence

### Phase 0 Baseline

- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliRuntime.test.ts` passed.
  - Wrapper summary: codali package suite passed 604 tests; targeted `CodaliRuntime.test.ts` passed 14 tests.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliJobRuntime.test.ts` passed.
  - Wrapper summary: codali package suite passed 604 tests; targeted `CodaliJobRuntime.test.ts` passed 4 tests.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/codali-executor.test.ts` passed.
  - Wrapper summary: mswarm package suite passed 112 tests; targeted `codali-executor.test.ts` passed 9 tests.
- `docdex_impact_graph` on `packages/codali/src/index.ts` returned no tracked inbound or outbound edges before Phase 1 export edits.
- `docdex_impact_diagnostics` on `packages/codali/src/index.ts` returned no unresolved import diagnostics.

### Phase 1 Implementation

- Added `packages/codali/src/gateway/CodaliGatewayTypes.ts`.
- Added `packages/codali/src/gateway/CodaliGatewaySchemas.ts`.
- Added `packages/codali/src/gateway/__tests__/CodaliGatewaySchemas.test.ts`.
- Updated `packages/codali/src/index.ts` to export gateway validators and public gateway types.
- `docdex_local_completion` was attempted for a lightweight implementation outline before coding.
- `docdex_index` ingested the new gateway files and updated `packages/codali/src/index.ts`.
- `docdex_symbols` on `packages/codali/src/gateway/CodaliGatewaySchemas.ts` succeeded.
- `docdex_impact_graph` on `packages/codali/src/index.ts` and `packages/codali/src/gateway/CodaliGatewaySchemas.ts` returned no tracked inbound or outbound edges after Phase 1.
- `docdex_impact_diagnostics` on `packages/codali/src/gateway/CodaliGatewaySchemas.ts` returned no unresolved import diagnostics.
- `pnpm --filter @mcoda/codali run build` passed.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/CodaliGatewaySchemas.test.ts` passed.
  - Wrapper summary: codali package suite passed 610 tests; targeted `CodaliGatewaySchemas.test.ts` passed 6 tests.
- Post-change bridge check: `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/codali-executor.test.ts` passed.
  - Wrapper summary: mswarm package suite passed 112 tests; targeted `codali-executor.test.ts` passed 9 tests.
- `git diff --check` passed.

### Phase 2 Implementation

- Added `packages/codali/src/gateway/ToolCapabilityCompiler.ts`.
- Added `packages/codali/src/gateway/GatewayPolicyCompiler.ts`.
- Added `packages/codali/src/gateway/__tests__/GatewayPolicyCompiler.test.ts`.
- Updated `packages/codali/src/index.ts` to export Phase 2 compiler functions, constants, and public types.
- `ToolCapabilityCompiler` enforces:
  - only `policy.allowedTools`;
  - `policy.deniedTools` removal;
  - read-only app contracts and app gateways;
  - safe read-only backing tools;
  - backing tools also present in the allowed set;
  - Docdex operation allow-list checks;
  - stable missing Docdex context errors;
  - tenant/repo/base URL reserved argument blocking in dynamic app tool schemas;
  - warnings and skipped-tool metadata for unavailable capabilities.
- `GatewayPolicyCompiler` emits:
  - read-only `CodaliRuntimePolicy`;
  - `CodaliJobBudgets`;
  - effective allowed and denied tools;
  - compiler warnings/errors and skipped tool diagnostics.

### Phase 3 Implementation

- Added `packages/codali/src/gateway/AgentTierResolver.ts`.
- Added `packages/codali/src/gateway/__tests__/AgentTierResolver.test.ts`.
- Updated `packages/codali/src/index.ts` to export Phase 3 resolver functions, defaults, and public types.
- `AgentTierResolver` normalizes mcoda-style inventory records with:
  - slug, adapter, provider, model, base URL, runner kind;
  - health and latency;
  - context and output token windows;
  - tool, JSON schema, image generation, artifact, and streaming capabilities;
  - rating, reasoning, cost, complexity, best-usage metadata;
  - local, self-hosted, worker, cloud, or unknown source classification.
- Role resolution now supports:
  - default role policies for classifier, planner, workers, verifier, context refiner, final synthesizer, image worker, and repair-style roles;
  - policy role overrides;
  - cloud fallback only when `agentPolicy.allowCloudFallback=true`;
  - image worker only when `allowImageWorker=true`;
  - deterministic score, cost, and slug tie-breaks;
  - clear unresolved-role diagnostics.

### Phase 2 And 3 Validation

- `docdex_local_completion` was attempted for lightweight edge-case review before coding.
- `pnpm --filter @mcoda/codali run build` initially caught one raw inventory typing issue in `AgentTierResolver.ts`; after the fix, the command passed.
- `docdex_index` ingested:
  - `packages/codali/src/gateway/ToolCapabilityCompiler.ts`
  - `packages/codali/src/gateway/GatewayPolicyCompiler.ts`
  - `packages/codali/src/gateway/AgentTierResolver.ts`
  - `packages/codali/src/index.ts`
- `docdex_impact_diagnostics` on all three new gateway modules returned no unresolved import diagnostics.
- `docdex_impact_graph` on all three new gateway modules and `packages/codali/src/index.ts` returned no tracked inbound or outbound edges.
- Targeted `docdexd run-tests` wrappers for the two new gateway test files were attempted but produced no output for more than 90 seconds and were interrupted with exit code 130.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 620 tests, 620 passed, 0 failed.
  - Included new Phase 2 tests:
    - read-only policy to runtime policy/job budgets;
    - missing required Docdex context stable error;
    - blocked Docdex operations;
    - disabled, unsafe, undeclared, and tenant-overriding tool removal;
    - forced runtime write/shell/destructive/outside-workspace guards.
  - Included new Phase 3 tests:
    - inventory normalization;
    - classifier/planner/verifier/final role resolution by tier;
    - image worker gate;
    - cloud fallback gate;
    - deterministic tie-breaks.
- `git diff --check` passed.

### Phase 4 Implementation

- Added `packages/codali/src/gateway/CodaliGatewayStore.ts`.
- Added `packages/codali/src/gateway/__tests__/CodaliGatewayStore.test.ts`.
- Updated `packages/codali/src/index.ts` to export Phase 4 store interfaces, in-memory store factory, trace types, and redaction helper.
- `CodaliGatewayStore` defines a durable boundary for:
  - create/update run;
  - create/update task;
  - append evidence;
  - append tool calls;
  - append model calls;
  - save context packs;
  - save artifact metadata;
  - read run trace.
- `InMemoryCodaliGatewayStore` supports lightweight local/test runs without an external database.
- `redactCodaliGatewaySecrets` recursively redacts sensitive key names and bearer/API-key-like string values before persistence.

### Phase 5 Implementation

- Added `packages/codali/src/gateway/GatewayPlanner.ts`.
- Added `packages/codali/src/gateway/CodaliGateway.ts`.
- Added `packages/codali/src/gateway/__tests__/GatewayPlanner.test.ts`.
- Added `CodaliGatewayClassifierOutput` to `packages/codali/src/gateway/CodaliGatewayTypes.ts`.
- Updated `packages/codali/src/index.ts` to export Phase 5 planner/gateway functions, schemas, classes, and public types.
- `GatewayPlanner` now provides:
  - classifier JSON schema;
  - planner JSON schema;
  - classifier prompt builder;
  - planner prompt builder;
  - provider-backed `classify` and `plan`;
  - one repair attempt for malformed or schema-invalid JSON;
  - sanitization of planner worker tools against effective allowed tools;
  - removal of image-worker tasks when `allowImageWorker` is false.
- `CodaliGateway` now provides a planning-only entry point that compiles policy, runs classifier/planner, stores model-call trace records, and returns the planning result plus store trace. Worker execution and final answer synthesis remain later phases.

### Phase 4 And 5 Validation

- `pnpm --filter @mcoda/codali run build` initially caught one strict-null assertion issue in `CodaliGatewayStore.test.ts`; after fixing the assertion, the build passed.
- Focused compiled tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/CodaliGatewayStore.test.js packages/codali/dist/gateway/__tests__/GatewayPlanner.test.js`
  - Summary: 10 tests, 10 passed, 0 failed.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 630 tests, 630 passed, 0 failed.
  - Included new Phase 4 tests:
    - store captures run/task/evidence/tool/model/context/artifact trace;
    - store redacts nested secret keys and bearer-like values;
    - redaction helper does not mutate caller-owned payloads.
  - Included new Phase 5 tests:
    - generic direct-answer planning path without worker tasks;
    - Docdex and app-tool worker tasks from effective policy tools;
    - disabled tool removal from model-proposed planner output;
    - image worker gated by `allowImageWorker`;
    - one JSON repair attempt;
    - planning-only gateway persists classifier/planner trace;
    - prompt helper includes only effective allowed tools.
- `git diff --check` passed.
- `docdex_index` ingested:
  - `packages/codali/src/gateway/CodaliGatewayStore.ts`
  - `packages/codali/src/gateway/GatewayPlanner.ts`
  - `packages/codali/src/gateway/CodaliGateway.ts`
  - `packages/codali/src/gateway/CodaliGatewayTypes.ts`
  - `packages/codali/src/index.ts`
- `docdex_impact_diagnostics` on the three new Phase 4/5 gateway modules returned no unresolved import diagnostics.
- `docdex_impact_graph` on the three new Phase 4/5 gateway modules and `packages/codali/src/index.ts` returned no tracked inbound or outbound edges.

### Phase 6 Implementation

- Added `packages/codali/src/gateway/GatewayStateMachine.ts`.
- Added `packages/codali/src/gateway/__tests__/GatewayStateMachine.test.ts`.
- Updated `packages/codali/src/gateway/CodaliGateway.ts` with `executeWorkerTasks` and `runCodaliGatewayWorkerTasks`.
- Updated `packages/codali/src/index.ts` to export Phase 6 state-machine functions, classes, and public types.
- `GatewayStateMachine` now provides:
  - planner-task preparation with effective allowed-tool filtering;
  - deterministic bounded parallel worker waves;
  - max runtime, max tool calls, and per-task timeout enforcement;
  - evidence-only worker prompts that say "Gather evidence only.", "Do not answer the user.", and "Output JSON only.";
  - required-worker failure as run failure with later task skip;
  - optional-worker failure as recorded partial result with continuation;
  - tool, model, evidence, artifact, task, run, warning, and error persistence through the Phase 4 store.

### Phase 6 Validation

- `pnpm --filter @mcoda/codali run build` initially caught one optional `maxParallelStages` typing issue in `GatewayStateMachine.ts`; after adding a default, the build passed.
- Focused compiled Phase 6 tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/GatewayStateMachine.test.js`
  - Summary: 6 tests, 6 passed, 0 failed.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 636 tests, 636 passed, 0 failed.
  - Included new Phase 6 tests:
    - deterministic parallel worker waves;
    - required worker failure fails the run and skips later workers;
    - optional worker failure is recorded and later workers continue;
    - tool budget exhaustion stops later tool workers;
    - workers receive only approved tools and evidence-only JSON prompts;
    - `CodaliGateway.executeWorkerTasks` wires planner output into the state machine.

### Phase 7 Implementation

- Added `packages/codali/src/gateway/EvidenceNormalizer.ts`.
- Added `packages/codali/src/gateway/__tests__/EvidenceNormalizer.test.ts`.
- Updated `packages/codali/src/gateway/GatewayStateMachine.ts` so worker evidence, worker output, and successful tool-call results are normalized before store persistence.
- Updated `packages/codali/src/index.ts` to export Phase 7 normalizer functions and public types.
- `EvidenceNormalizer` now provides:
  - direct evidence array ingestion;
  - facts array ingestion;
  - source-record and citation ingestion;
  - Docdex hit normalization with doc ids, paths, snippets, scores, and used tool metadata;
  - app-tool payload normalization with URLs, source ids, source timestamps, and used tool metadata;
  - malformed worker JSON fallback to low-confidence model observation;
  - low-confidence handling for unprovenanced facts;
  - tenant-scope rejection when policy requires tenant-scoped evidence;
  - source-plus-claim duplicate folding with duplicate metadata.

### Phase 7 Validation

- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 7 and state-machine regression tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/EvidenceNormalizer.test.js packages/codali/dist/gateway/__tests__/GatewayStateMachine.test.js`
  - Summary: 12 tests, 12 passed, 0 failed.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 642 tests, 642 passed, 0 failed.
  - Included new Phase 7 tests:
    - Docdex search hits become cited evidence;
    - app-tool facts preserve source URL/timestamp/tool metadata;
    - duplicates are folded by source and claim;
    - malformed worker JSON becomes low-confidence model observation;
    - tenant-scope policy rejects non-tenant-scoped evidence;
    - unprovenanced facts remain low-confidence model observations.

### Phase 8 Implementation

- Updated `packages/codali/src/gateway/GatewayStateMachine.ts`.
- Added `packages/codali/src/gateway/__tests__/GatewayVerificationLoop.test.ts`.
- Updated `packages/codali/src/index.ts` to export verifier runner, verifier input, verification-loop result, verification-iteration, and rejected-follow-up task types.
- `GatewayStateMachine` now supports an optional `verifierRunner` that:
  - receives current evidence, task results, policy compilation, remaining tool budget, request, planner, run id, and verifier iteration;
  - validates verifier output through `validateCodaliGatewayVerifierOutput`;
  - persists verifier model calls with success/failure status and loop-decision metadata;
  - accepts follow-up worker tasks only when their tool set is still allowed by the compiled policy;
  - rejects duplicate task ids, disabled image workers, unavailable/denied tools, and tool-budget-exhausted follow-ups;
  - runs no more verifier passes than `policy.maxIterations`;
  - stops on verifier pass, no useful follow-ups, max iterations, tool budget exhaustion, required tool unavailability, required worker failure, or verifier failure;
  - stores missing information, contradictions, issues, follow-up count, rejected follow-ups, and stop reason in the run metadata.

### Phase 8 Validation

- `docdex_local_completion` was used for a lightweight Phase 8 test-coverage checklist before writing tests.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 648 tests, 648 passed, 0 failed.
  - Included new Phase 8 tests:
    - verifier pass stops the loop early and returns `succeeded`;
    - weak evidence can add a second `docdex_search` worker;
    - exhausted tool budget rejects verifier follow-ups and returns `partial`;
    - unavailable/denied tools are rejected as required-tool-unavailable follow-ups;
    - `policy.maxIterations` prevents an infinite verifier loop;
    - contradictions are preserved in verification summary metadata.
- Targeted `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/GatewayVerificationLoop.test.ts` was attempted and interrupted with exit code 130 after roughly 90 seconds with no output, matching earlier targeted-wrapper behavior recorded for this plan.
- `docdex_impact_graph` on `packages/codali/src/gateway/GatewayStateMachine.ts` and `packages/codali/src/index.ts` returned no tracked inbound or outbound edges after Phase 8.
- `docdex_symbols` on `packages/codali/src/gateway/GatewayStateMachine.ts` succeeded and listed the new verifier-loop helpers.
- `docdex_impact_diagnostics` on `packages/codali/src/gateway/GatewayStateMachine.ts` and `packages/codali/src/index.ts` returned no unresolved import diagnostics.
- `docdex_index` ingested the touched TypeScript files; planning docs remained excluded by the repo ignore pattern.
- `git diff --check` passed.

### Phase 9 Implementation

- Added `packages/codali/src/gateway/ContextPackBuilder.ts`.
- Added `packages/codali/src/gateway/__tests__/ContextPackBuilder.test.ts`.
- Updated `packages/codali/src/index.ts` to export the Phase 9 context-pack builder functions, class, and public types.
- Updated `packages/codali/src/gateway/CodaliGatewayStore.ts` so redaction no longer treats numeric token-accounting keys as secrets.
- Updated `packages/codali/src/gateway/__tests__/CodaliGatewayStore.test.ts` to verify persisted context-pack `tokenEstimate` remains numeric.
- `ContextPackBuilder` now provides:
  - deterministic evidence ranking by relevance, confidence, freshness, source quality, and stable id tie-breaks;
  - duplicate claim folding with merged duplicate ids recorded on the winning evidence metadata;
  - curated decision facts without raw worker excerpts or raw payload refs;
  - selected excerpts with bounded text length;
  - verifier missing-information and contradiction preservation from explicit verifier output or stored run metadata;
  - grouped tool-call summaries by tool and status;
  - evidence-count and context-token budget enforcement with dropped evidence diagnostics;
  - `buildAndPersist` support over the Phase 4 gateway store.

### Phase 9 Validation

- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled store/context-pack tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/CodaliGatewayStore.test.js packages/codali/dist/gateway/__tests__/ContextPackBuilder.test.js`
  - Summary: 7 tests, 7 passed, 0 failed.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 652 tests, 652 passed, 0 failed.
  - Included new Phase 9 tests:
    - evidence ranking, duplicate-claim folding, source mapping, and raw-excerpt stripping from decision facts;
    - deterministic evidence drops under max evidence count and context token budget;
    - selected excerpt truncation;
    - tool-call summary grouping by tool and status;
    - verifier missing-information and contradiction preservation;
    - context-pack persistence through the gateway store.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/ContextPackBuilder.test.ts` passed.
  - Wrapper status: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`.
  - Targeted file summary: 4 tests, 4 passed, 0 failed.
- `docdex_symbols` on `packages/codali/src/gateway/ContextPackBuilder.ts` succeeded and listed the new builder interfaces/class and `buildAndPersist` method.
- `docdex_impact_graph` on `packages/codali/src/gateway/ContextPackBuilder.ts` returned no tracked inbound or outbound edges.
- `docdex_impact_diagnostics` on `packages/codali/src/gateway/ContextPackBuilder.ts` returned no unresolved import diagnostics.
- Phase 9 impact checks on `packages/codali/src/gateway/CodaliGatewayStore.ts` and `packages/codali/src/index.ts` returned no tracked inbound/outbound edges and no unresolved import diagnostics.
- `docdex_index` ingested the touched Phase 9 TypeScript source, tests, store, and package export files.

### Phase 10 Implementation

- Updated `packages/codali/src/gateway/CodaliGateway.ts`.
- Added `packages/codali/src/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.ts`.
- Updated `packages/codali/src/index.ts` to export `runCodaliGateway`, `buildCodaliGatewayFinalSynthesizerMessages`, and the Phase 10 final-synthesis public types.
- `CodaliGateway` now provides:
  - `run(request)` full path for planning, optional worker execution, context-pack creation, and final synthesis;
  - `synthesizeFinalAnswer` for existing stored runs and prebuilt context packs;
  - final synthesizer prompt construction that uses only the curated context pack and instructs the model not to expose internal trace/tool/model orchestration details;
  - final evidence/source filtering against `policy.allowedTools` and `policy.deniedTools`;
  - final agent resolution through `resolveCodaliGatewayAgentTiers` for the `final_synthesizer` role when inventory is provided;
  - strict blocking when `requireFinalLargeModel=true` and the final role is missing or resolves below large tier;
  - final provider calls with `toolChoice: "none"`;
  - one retry for retryable final-provider failures;
  - policy-gated degraded evidence summaries only when `allowDegradedFinalAnswer=true`;
  - metadata-preserving run updates and final answer telemetry/trace mapping.
- `CodaliGateway` now handles planner outputs with no worker tasks without requiring a worker runner, so direct-answer candidates still flow through the final/large synthesizer instead of becoming the user-visible answer.

### Phase 10 Validation

- `docdex_local_completion` was used for a lightweight Phase 10 test checklist before writing the final-synthesizer tests.
- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 10 tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.js`
  - Summary: 6 tests, 6 passed, 0 failed.
- `pnpm --filter @mcoda/codali test` passed.
  - Package test summary: 658 tests, 658 passed, 0 failed.
  - Included new Phase 10 tests:
    - full `runCodaliGateway` path calls the final synthesizer and ignores classifier direct-answer drafts;
    - final prompt and sources use only allowed context-pack evidence;
    - non-large final assignments are blocked before provider calls when `requireFinalLargeModel=true`;
    - retryable final-provider failures are retried once and recorded in telemetry;
    - final-model failure returns an operational failure unless degraded fallback is explicitly allowed;
    - final prompt helper avoids internal trace payloads.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.ts` passed.
  - Wrapper status: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`.
  - Targeted file summary: 6 tests, 6 passed, 0 failed.
- `docdex_symbols` on `packages/codali/src/gateway/CodaliGateway.ts` succeeded and listed the new `run`, `synthesizeFinalAnswer`, final-synthesis result helpers, and metadata-preserving update helper.
- `docdex_impact_graph` on `packages/codali/src/gateway/CodaliGateway.ts` and `packages/codali/src/index.ts` returned no tracked inbound or outbound edges.
- `docdex_impact_diagnostics` on `packages/codali/src/gateway/CodaliGateway.ts` and `packages/codali/src/index.ts` returned no unresolved import diagnostics.
- `docdex_index` ingested the touched Phase 10 gateway source, final-synthesizer test, and package export files.
- `git diff --check` passed.

### Phase 11 Implementation

- Updated `packages/codali/src/docdex/DocdexClient.ts`.
- Updated `packages/codali/src/runtime/CodaliRuntime.ts`.
- Updated `packages/codali/src/tools/ToolTypes.ts`.
- Updated `packages/codali/src/tools/ToolRegistry.ts`.
- Updated `packages/codali/src/tools/docdex/__tests__/DocdexTools.test.ts`.
- Updated `packages/codali/src/gateway/ToolCapabilityCompiler.ts`.
- Updated `packages/codali/src/gateway/EvidenceNormalizer.ts`.
- Updated `packages/codali/src/gateway/CodaliGateway.ts`.
- Updated `packages/codali/src/gateway/CodaliGatewayTypes.ts`.
- Updated Phase 11 tests in:
  - `packages/codali/src/docdex/__tests__/DocdexClient.test.ts`
  - `packages/codali/src/gateway/__tests__/GatewayPolicyCompiler.test.ts`
  - `packages/codali/src/gateway/__tests__/EvidenceNormalizer.test.ts`
  - `packages/codali/src/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.ts`
- `DocdexClient` now treats `credentialSource: "attached_mswarm_api_key"` or explicit `immutableRuntimeContext` as immutable encrypted runtime context.
- Immutable Docdex contexts now require `baseUrl`, `repoId`, non-empty `allowedOperations`, a `capabilities` map, and an attached API key when the credential source requires it.
- Immutable Docdex contexts now avoid local fallback:
  - no default local Docdex base URL in `CodaliRuntime`;
  - no repo-root fallback from `workspace.root`;
  - no auto `/v1/initialize` from `repoRoot`;
  - no `repo_root` query param;
  - no `x-docdex-repo-root` header;
  - no `project_root` MCP param.
- Stable encrypted Docdex error codes now propagate through tool execution:
  - `missing_credentials`
  - `repo_access_denied`
  - `scope_denied`
  - `encrypted_operation_disabled`
- `ToolCapabilityCompiler` now fails attached-key gateway jobs missing immutable encrypted context and keeps blocking `repo_id`/tenant/base URL override fields in dynamic call schemas.
- Docdex response request IDs are now normalized into successful result `meta`, error details, evidence metadata, trace-safe `toolCalls[].metadata`, and final-result `telemetry.docdexRequestIds`.
- Test fetch stubs now return only real `content-type` and explicitly provided request-id headers so request-id extraction is not polluted by fake content-type values.

### Phase 11 Validation

- `docdex_local_completion` was attempted for a lightweight Phase 11 test checklist and timed out after roughly 300 seconds; implementation continued with primary-agent validation.
- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 11 tests passed:
  - `node --test packages/codali/dist/docdex/__tests__/DocdexClient.test.js packages/codali/dist/tools/docdex/__tests__/DocdexTools.test.js packages/codali/dist/gateway/__tests__/GatewayPolicyCompiler.test.js packages/codali/dist/gateway/__tests__/EvidenceNormalizer.test.js packages/codali/dist/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.js`
  - Summary: 43 tests, 43 passed, 0 failed.
- First full package run exposed one test-stub issue:
  - `pnpm --filter @mcoda/codali test` failed because `DocdexTools.test.ts` returned `application/json` for every fake header lookup, causing request-id extraction to treat `content-type` as `docdex_request_id`.
  - The stub was fixed with a case-insensitive fake header map matching the `DocdexClient` tests.
- Final full package run passed:
  - `pnpm --filter @mcoda/codali test`
  - Package test summary: 665 tests, 665 passed, 0 failed.
- Targeted Docdex wrapper passed:
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/docdex/__tests__/DocdexClient.test.ts`
  - Wrapper status: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`.
  - Targeted file summary: 15 tests, 15 passed, 0 failed.
- New Phase 11 coverage verifies:
  - attached-key Docdex contexts are immutable;
  - missing repo id fails before local initialization or network access;
  - missing allowed operations/capability contracts fail with `scope_denied`;
  - capability-disabled operations fail with `encrypted_operation_disabled`;
  - missing attached key fails with `missing_credentials`;
  - encrypted auth failures map to `missing_credentials` while redacting secrets;
  - disallowed encrypted operations are blocked before network access;
  - successful encrypted search retains `x-docdex-request-id` as `meta.docdex_request_id`;
  - immutable search does not send `repo_root` or `x-docdex-repo-root`;
  - gateway policy compilation fails missing immutable attached-key context;
  - `repo_id` in dynamic call schemas is rejected as a reserved override;
  - encrypted Docdex request IDs propagate into normalized evidence;
  - final telemetry and trace-safe tool-call metadata include Docdex request IDs.
- `docdex_impact_graph` was run on Phase 11 target source/type files before edits and returned no tracked inbound or outbound edges for the touched Codali files.
- `docdex_symbols`/`docdex_ast` were used on Phase 11 target files before edits to confirm structure.
- `docdex_impact_diagnostics` after edits reported no diagnostics in touched Codali files; remaining diagnostics are pre-existing unresolved imports in `packages/integrations/src/index.ts` and `packages/integrations/src/index.js`.
- `docdex_index` ingested the touched Phase 11 source and test files.
- `git diff --check` passed.

### Phase 12 Implementation

- Added `packages/codali/src/gateway/AppToolGatewayDispatcher.ts`.
- Updated `packages/codali/src/runtime/CodaliRuntime.ts`.
- Updated `packages/codali/src/gateway/ToolCapabilityCompiler.ts`.
- Updated `packages/codali/src/index.ts`.
- Added `packages/codali/src/gateway/__tests__/AppToolGatewayDispatcher.test.ts`.
- Updated Phase 12 tests in:
  - `packages/codali/src/gateway/__tests__/GatewayPolicyCompiler.test.ts`
  - `packages/codali/src/runtime/__tests__/CodaliRuntime.test.ts`
- `AppToolGatewayDispatcher` now provides:
  - canonical JSON signing material;
  - HMAC SHA-256 request signatures;
  - constant-time signature verification helper;
  - signed request builder;
  - redaction helper;
  - direct read-only dispatcher;
  - evidence-payload normalization for app-tool gateway responses.
- Direct app-tool gateway request envelopes now include:
  - run id;
  - session id;
  - request id;
  - tenant scope;
  - requester scope;
  - tool name;
  - validated args;
  - timestamp;
  - nonce;
  - explicit `read_only: true`;
  - call schema;
  - result contract;
  - source metadata;
  - signature.
- Dispatcher guardrails:
  - reject missing explicit contract/gateway read-only flags;
  - reject missing endpoint;
  - reject missing signing material;
  - enforce allowed and denied tool policy;
  - validate required/object/primitive `callSchema` fields;
  - reject tenant/repo/base URL/credential override keys anywhere in args;
  - map malformed gateway JSON to a stable dispatcher error;
  - keep request/response diagnostics redacted, including secret-like strings.
- Runtime direct gateway tools now call `dispatchAppToolGateway` instead of the previous inline POST path and return evidence-ready JSON payloads to the model/tool loop.
- Runtime registration and `ToolCapabilityCompiler` now hide direct app gateway tools unless signing material and explicit gateway read-only flags are present.
- Public package exports now include dispatcher constants, helpers, errors, dispatch function, and signed request/result types.

### Phase 12 Validation

- `docdex_local_completion` was used for a lightweight Phase 12 test checklist before writing tests.
- `pnpm --filter @mcoda/codali run build` initially caught two TypeScript target/literal issues in `AppToolGatewayDispatcher.ts`:
  - `Object.hasOwn` was replaced with `Object.prototype.hasOwnProperty.call`.
  - literal `version` and `read_only` fields were narrowed explicitly.
- Final `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 12 tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/AppToolGatewayDispatcher.test.js packages/codali/dist/gateway/__tests__/GatewayPolicyCompiler.test.js packages/codali/dist/runtime/__tests__/CodaliRuntime.test.js`
  - Summary: 28 tests, 28 passed, 0 failed.
- Full Codali package suite passed:
  - `pnpm --filter @mcoda/codali test`
  - Package test summary: 673 tests, 673 passed, 0 failed.
- Targeted Docdex wrapper passed:
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/AppToolGatewayDispatcher.test.ts`
  - Wrapper status: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`.
  - Package wrapper summary: 673 tests, 673 passed, 0 failed.
  - Targeted dispatcher summary: 6 tests, 6 passed, 0 failed.
- New Phase 12 coverage verifies:
  - signed read-only gateway requests include run/session/request/tenant/requester scope;
  - signature header matches the signed request envelope;
  - signature verification succeeds and tampered args fail verification;
  - missing explicit read-only flags are rejected;
  - missing signing material is rejected;
  - reserved tenant/repo/base URL/credential override args are blocked;
  - `callSchema` required fields are enforced;
  - allowed and denied tool policy is enforced;
  - malformed JSON gateway responses produce a stable error;
  - redaction hides signatures and API-key-like fields;
  - product gateway facts normalize into app-tool evidence;
  - gateway policy compilation hides unsigned or non-read-only direct gateway tools;
  - runtime `runCodaliTask` registers and executes signed `app_tool_gateway` contracts.
- `docdex_index` ingested the touched Phase 12 TypeScript source and test files. Planning docs are ignored by the repo's Docdex ignore rules.
- `docdex_impact_diagnostics` returned no diagnostics for:
  - `packages/codali/src/gateway/AppToolGatewayDispatcher.ts`
  - `packages/codali/src/runtime/CodaliRuntime.ts`
- `docdex_symbols` and `docdex_ast` succeeded for `packages/codali/src/gateway/AppToolGatewayDispatcher.ts`.
- `docdex_impact_graph` returned no tracked inbound or outbound edges for:
  - `packages/codali/src/gateway/AppToolGatewayDispatcher.ts`
  - `packages/codali/src/runtime/CodaliRuntime.ts`
- `git diff --check` passed.

### Phase 13 Implementation

- Updated `packages/mswarm/src/codali-executor.ts`.
- Updated `packages/mswarm/src/runtime.ts`.
- Updated `packages/mswarm/src/__tests__/codali-executor.test.ts`.
- Updated `packages/mswarm/src/__tests__/runtime.test.ts`.
- `MswarmCodaliExecutor` now accepts `codaliGateway` and branches:
  - `codaliGateway` -> `runCodaliGateway`;
  - otherwise `codaliJob` -> `runCodaliJob`;
  - otherwise existing single-task `runCodaliTask`.
- The executor builds a normalized gateway request that inherits:
  - encrypted Docdex runtime context;
  - `docdex.tool_manifest`;
  - allowed and denied tools;
  - generic `appToolContracts` and OKACAM `okacamToolContracts`;
  - generic and OKACAM virtual tools;
  - read-only app gateway contract metadata;
  - per-call session id and conversation messages.
- The executor supplies Codali gateway options without hardcoded model ids:
  - provider adapter backed by the selected mswarm/Codali runtime agent;
  - worker task runner backed by `runCodaliTask`;
  - one selected-agent inventory candidate for `mcoda_inventory` tier resolution;
  - worker budgets from the gateway policy.
- Gateway streaming now emits the final answer and terminal stop as OpenAI-compatible chunks while internal gateway status remains progress telemetry.
- Response metadata now includes:
  - `codali_gateway_id`;
  - status and mode;
  - task/tool/model/source/evidence counts;
  - warnings/errors;
  - gateway trace;
  - assistant-message-safe telemetry.
- `SelfHostedNodeInvocationJob` now accepts snake_case `codali_gateway` and `session`.
- Runtime normalization supports gateway-local Docdex overrides in snake_case or camelCase, but inherits the existing top-level encrypted Docdex context by default.
- Runtime progress events now include `gateway_start` and `gateway_result`.

### Phase 13 Validation

- `docdex_local_completion` was attempted for a lightweight Phase 13 edge-case review and timed out; implementation continued with focused tests.
- `pnpm --filter @mcoda/mswarm run build` passed.
- Focused compiled tests passed:
  - `node --test packages/mswarm/dist/__tests__/codali-executor.test.js packages/mswarm/dist/__tests__/runtime.test.js`
  - Summary: 114 tests, 114 passed, 0 failed.
- Full mswarm package suite passed:
  - `pnpm --filter @mcoda/mswarm test`
  - Package summary: 114 tests, 114 passed, 0 failed.
- Targeted Docdex wrapper passed:
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/codali-executor.test.ts`
  - Wrapper status: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`.
  - Package wrapper summary: 114 tests, 114 passed, 0 failed.
  - Targeted executor summary: 10 tests, 10 passed, 0 failed.
- New Phase 13 coverage verifies:
  - `codaliGateway` uses `runCodaliGateway` and does not call `runCodaliTask` or `runCodaliJob`;
  - `codaliJob` behavior remains covered and unchanged;
  - single-task behavior remains covered and unchanged;
  - encrypted Docdex attached mswarm key is passed only through runtime Docdex context;
  - runtime tool contracts and virtual tools are inherited into gateway policy;
  - per-call session id reaches Codali runtime and gateway conversation context;
  - gateway final answer streaming emits OpenAI-compatible chunks;
  - gateway telemetry is returned on assistant-message metadata;
  - runtime progress events include `gateway_start` and `gateway_result`.
- `docdex_impact_diagnostics` returned no diagnostics for:
  - `packages/mswarm/src/codali-executor.ts`
  - `packages/mswarm/src/runtime.ts`
  - `packages/mswarm/src/__tests__/codali-executor.test.ts`
  - `packages/mswarm/src/__tests__/runtime.test.ts`
- `docdex_symbols` succeeded for `packages/mswarm/src/codali-executor.ts`.
- `docdex_impact_graph` returned no tracked inbound or outbound edges for:
  - `packages/mswarm/src/codali-executor.ts`
  - `packages/mswarm/src/runtime.ts`
- `docdex_index` ingested the touched Phase 13 TypeScript source and test files. Planning docs are ignored by the repo's Docdex ignore rules.
- `git diff --check` passed.

### Phase 14 Implementation

- Added `packages/codali/src/eval/CodaliGatewayLiveHarness.ts`.
- Added `packages/codali/src/eval/__tests__/CodaliGatewayLiveHarness.test.ts`.
- Updated `packages/codali/src/cli/EvalCommand.ts`.
- Updated `packages/codali/src/cli/__tests__/EvalCommand.test.ts`.
- Updated `packages/codali/src/cli.ts`.
- Updated `packages/codali/src/index.ts` to export the live harness API and types.
- `CodaliGatewayLiveHarness` now provides:
  - dynamic inventory discovery via `mcoda agent list --json --refresh-health` or injected inventory fixtures;
  - role classification for `small_json`, `medium_planner`, `medium_verifier`, `large_final`, and `image_worker` through the product-neutral `AgentTierResolver`;
  - medium JSON fallback for structured smoke validation when no strict small JSON classifier exists;
  - live scenarios for generic structured JSON, Docdex encrypted search selection, disabled-tool leakage, multi-step evidence planning, final large-model synthesis, and image artifact generation;
  - redacted JSON and text reports with run id, inventory status, role assignments, scenario status, warnings/errors, latency, JSON validity, called tools, final model tier, and artifact metadata;
  - default `mcoda agent-run <slug> --json --stdin` scenario execution;
  - injected scenario-runner support for future full gateway transport tests with real tool telemetry;
  - degraded results for default `agent-run` gateway-tool scenarios because direct agent-run cannot expose Codali gateway tool telemetry;
  - degraded results for known model-catalog mismatches such as "not a valid model ID";
  - strict mode support so CI can fail on degraded live smoke when the environment is expected to be fully provisioned.
- `codali eval` now supports:
  - `--gateway-live-smoke`;
  - `--live-timeout-ms <n>`;
  - `--live-mcoda-command <cmd>`;
  - `--allow-cloud-fallback`;
  - `--no-image-worker`;
  - `--agent-run-force`;
  - `--strict`.
- Phase 14 intentionally does not hardcode Suku model names. It reports whatever the live inventory resolves and degrades when expected tiers/capabilities are unavailable or not runnable through the chosen runner.

### Phase 14 Validation

- `docdex_local_completion` was attempted for a lightweight Phase 14 snippet review and timed out at the Docdex tool boundary after roughly 300 seconds; implementation continued with direct build, tests, and live smoke evidence.
- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 14 and CLI tests passed:
  - `node --test packages/codali/dist/eval/__tests__/CodaliGatewayLiveHarness.test.js packages/codali/dist/cli/__tests__/EvalCommand.test.js`
  - Summary: 12 tests, 12 passed, 0 failed.
- Live Suku smoke command completed with a degraded report:
  - Command: `node packages/codali/dist/cli.js eval --gateway-live-smoke --live-timeout-ms 180000`
  - Run id: `codali-gateway-live-2c5380d7-a63d-413e-8949-4bb7a3b63704`
  - Inventory: 566 records discovered in 18815 ms.
  - `large_final`: `codex55`, scenario `final_answer_large_model` passed with final tier `large`.
  - `small_json`, `medium_planner`, and `medium_verifier`: resolved to the highest-scored medium self-hosted structured candidate, but `mcoda agent-run` returned a model-catalog validation error, now recorded as degraded with `agent_run_model_catalog_mismatch`.
  - `image_worker`: unavailable with `GATEWAY_AGENT_ROLE_UNRESOLVED`, so `image_generation` was skipped.
  - Summary: large final synthesizer ok; no live small/medium JSON output proven; no image artifact proven; warnings/errors were redacted and summarized.
- Full Codali package suite passed:
  - `pnpm --filter @mcoda/codali test`
  - Package summary: 681 tests, 681 passed, 0 failed.
- Targeted Docdex wrapper passed:
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/eval/__tests__/CodaliGatewayLiveHarness.test.ts`
  - Wrapper status: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`.
  - Package wrapper summary: 681 tests, 681 passed, 0 failed.
  - Targeted harness summary: 7 tests, 7 passed, 0 failed.
- New Phase 14 coverage verifies:
  - live inventory fixtures resolve small, medium, large, and image roles;
  - injected gateway runner can mark all scenarios passed and record Docdex tool usage plus image artifact metadata;
  - default `mcoda agent-run` runner degrades tool-telemetry scenarios because gateway tool telemetry is unavailable there;
  - known model-catalog runner mismatches degrade with actionable metadata;
  - image artifact references are extracted and secret-like metadata is redacted;
  - missing image tier degrades clearly;
  - inventory parsing, redaction, and text formatting remain stable.
- `docdex_index` ingested the touched Phase 14 TypeScript source, tests, CLI, and package export files. Planning docs remain ignored by the repo's Docdex ignore rules.
- `docdex_impact_diagnostics` returned no diagnostics for `packages/codali/src/eval/CodaliGatewayLiveHarness.ts`.
- `docdex_symbols` and `docdex_ast` succeeded for `packages/codali/src/eval/CodaliGatewayLiveHarness.ts`.
- `docdex_impact_graph` returned no tracked inbound or outbound edges for `packages/codali/src/eval/CodaliGatewayLiveHarness.ts`.
- `git diff --check` passed.

### Phase 15 Implementation

- Added `packages/codali/src/gateway/GatewayTraceReplay.ts`.
- Added `packages/codali/src/gateway/__tests__/GatewayTraceReplay.test.ts`.
- Updated `packages/codali/src/gateway/CodaliGateway.ts`.
- Updated `packages/codali/src/index.ts` to export the trace/replay API, event-name constants, public class, and public trace/replay types.
- `GatewayTraceReplay` now provides:
  - `readCodaliGatewayTrace` for redacted run metadata, tasks, evidence, tool calls, model calls, context pack, artifacts, final answer, debug summary, and derived events;
  - `exportCodaliGatewayReplayFixture` for redacted request, frozen evidence/context/tool fixtures, optional model inputs/outputs, optional tool results, final-answer fixture data, and debug summary;
  - `summarizeCodaliGatewayTrace` for assistant-message/product metadata including product, tenant, conversation, counts, called/failed tools, model roles, final model, warnings, and errors;
  - `buildCodaliGatewayTraceEvents` plus `CODALI_GATEWAY_TRACE_EVENT_NAMES` for OpenTelemetry-style dashboard event naming.
- `CodaliGateway` now includes `readTrace(runId)` and `exportReplayFixture(runId, options)` convenience methods backed by the same redacted store trace.
- Runtime gateway result traces now populate derived trace events and a debug summary in trace metadata instead of leaving `events` empty.
- Phase 15 intentionally keeps replay as a read/export surface. It does not bypass live policy enforcement or add credential-bearing replay execution.

### Phase 15 Validation

- `docdex_local_completion` returned a lightweight Phase 15 coverage checklist before implementation.
- `pnpm --filter @mcoda/codali build` passed.
- Focused compiled Phase 15 tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/GatewayTraceReplay.test.js`
  - Summary: 4 tests, 4 passed, 0 failed.
- Full Codali package suite passed:
  - `pnpm --filter @mcoda/codali test -- --test-name-pattern "gateway trace|gateway replay|gateway instance"`
  - Package runner summary: 685 tests, 685 passed, 0 failed.
  - The package runner executes the package suite after build; the new Phase 15 tests were included and passed.
- Targeted Docdex wrapper passed:
  - `docdexd test run-node --repo /Users/bekirdag/Documents/apps/mcoda --file packages/codali/dist/gateway/__tests__/GatewayTraceReplay.test.js`
  - Summary: 4 tests, 4 passed, 0 failed.
- New Phase 15 coverage verifies:
  - trace read API returns redacted diagnosis details and final answer;
  - product/tenant/conversation debug summaries include tool/model/source counts and failed-tool metadata;
  - replay fixture export freezes redacted request, evidence, tool fixtures, context pack, optional model outputs, and final answer;
  - replay fixture export can omit model outputs and tool results;
  - `CodaliGateway` instance methods expose trace and replay reads;
  - derived events include run, tool, model, and final synthesis event names without leaking final-synthesis secrets.
- `docdex_index` ingested the touched Phase 15 TypeScript source, tests, gateway, and package export files. Planning docs remain ignored by the repo's Docdex ignore rules.
- `docdex_impact_diagnostics` returned no diagnostics for `packages/codali/src/gateway/GatewayTraceReplay.ts`.
- `docdex_impact_graph` returned no tracked inbound or outbound edges for `packages/codali/src/gateway/GatewayTraceReplay.ts`.
- `git diff --check` passed.

### Phase 16 Implementation

- Added `packages/codali/src/eval/GatewayEvalSuite.ts`.
- Added `packages/codali/src/eval/__tests__/GatewayEvalSuite.test.ts`.
- Updated `packages/codali/src/cli/EvalCommand.ts` with `codali eval --gateway-smoke`.
- Updated `packages/codali/src/cli/__tests__/EvalCommand.test.ts` with gateway-smoke parsing and run coverage.
- Updated `packages/codali/src/index.ts` to export the gateway eval suite, runner, thresholds, gate evaluator, baseline comparator, formatter, metrics, report, and public types.
- `GatewayEvalSuite` now provides:
  - seven default Phase 16 task types and cases;
  - injectable runner support for future live gateway transport traces;
  - deterministic local smoke runner for CI/package validation;
  - per-case assertions for planner schema validity, selected task type, required tools, denied tools, allowed-tool boundaries, evidence precision, citation/source correctness, final-answer directness, final large-model use, image artifact presence, missing-evidence handling, and budget compliance;
  - aggregate metrics for planner validity, evidence precision, citation correctness, disabled-tool leakage, final-answer directness, final large-model use, budget compliance, latency, tokens, cost, tool calls, and model calls;
  - baseline comparison for p95 latency, p95 cost, and p95 tokens;
  - release-style gate failures with stable codes.
- `codali eval --gateway-smoke` now emits the deterministic gateway report as text or JSON and exits with the existing eval gate-failure code when gateway gates fail.

### Phase 16 Validation

- `docdex_local_completion` reviewed the Phase 16 eval-suite plan and highlighted routing/schema, evidence precision, disabled-tool leakage, final-tier, image artifact, missing-evidence, and p95 cost/latency edge cases.
- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 16 tests passed:
  - `node --test packages/codali/dist/eval/__tests__/GatewayEvalSuite.test.js packages/codali/dist/cli/__tests__/EvalCommand.test.js`
  - Summary: 11 tests, 11 passed, 0 failed.
- Gateway smoke CLI passed:
  - `node packages/codali/dist/cli.js eval --gateway-smoke --output json`
  - Report summary: 7/7 cases passed, gates passed, baseline status `baseline_missing`, p95 latency/cost/token metrics present.
- Full Codali package suite passed:
  - `pnpm --filter @mcoda/codali test`
  - Package runner summary: 691 tests, 691 passed, 0 failed.
- Targeted Docdex wrapper passed:
  - `docdexd test run-node --repo /Users/bekirdag/Documents/apps/mcoda --file packages/codali/dist/eval/__tests__/GatewayEvalSuite.test.js`
  - Summary: 4 tests, 4 passed, 0 failed.
- New Phase 16 coverage verifies:
  - every required Phase 16 task type is present;
  - the deterministic smoke suite passes all quality gates;
  - wrong selected task type catches hardcoded routing/schema drift;
  - denied integration calls catch disabled-tool leakage;
  - small-tier final answers fail the final-large-model gate;
  - p95 latency and cost regressions are recorded and gateable.
- `docdex_index` ingested the touched Phase 16 TypeScript source, tests, CLI, and package export files. Planning docs remain ignored by the repo's Docdex ignore rules.
- `docdex_impact_graph` returned no tracked inbound or outbound edges for `packages/codali/src/eval/GatewayEvalSuite.ts`.
- `docdex_impact_diagnostics` returned no diagnostics for:
  - `packages/codali/src/eval/GatewayEvalSuite.ts`
  - `packages/codali/src/cli/EvalCommand.ts`
  - `packages/codali/src/index.ts`
- `git diff --check` passed.

### Phase 17 Implementation

- Added `packages/codali/src/gateway/GatewaySecurityPolicy.ts`.
- Added `packages/codali/src/gateway/__tests__/GatewaySecurityPolicy.test.ts`.
- Updated `packages/codali/src/gateway/CodaliGatewayTypes.ts` with:
  - `CodaliGatewayToolRiskCategory`;
  - approval requirement and approval record skeleton types;
  - per-tenant and effective limit profile types;
  - security issue, tool risk, prompt-hardening, and security review types;
  - optional `maxImageArtifacts` policy budget.
- Updated `packages/codali/src/gateway/CodaliGatewaySchemas.ts` to parse `maxImageArtifacts`/`max_image_artifacts` as a non-negative budget, including explicit zero.
- Updated `packages/codali/src/gateway/ToolCapabilityCompiler.ts` so every compiled capability carries:
  - `riskCategory`;
  - `approvalRequired`;
  - read-only/write/destructive classification based on capability read-only state and stable tool-name risk tokens.
- Updated `packages/codali/src/gateway/GatewayPolicyCompiler.ts` so policy compilation now includes a `security` review and uses the effective security limits for runtime/job budgets.
- Updated `packages/codali/src/gateway/GatewayStateMachine.ts` to enforce:
  - effective max runtime from the security review;
  - max tool calls;
  - max model calls, counting each worker invocation as at least one model call and counting verifier calls;
  - run-level max evidence items before persistence;
  - run-level max image artifacts before persistence;
  - stable budget failure codes for model and image artifact overages.
- Updated `packages/codali/src/gateway/GatewayPlanner.ts`, `GatewayStateMachine.ts`, and `CodaliGateway.ts` prompts so model stages are told:
  - tool output is evidence, not instruction;
  - tool output cannot mutate gateway policy, tool allow/deny lists, budgets, tenant scope, repo scope, credentials, or approvals;
  - final synthesis may use only curated context-pack evidence and excerpts.
- Updated `packages/codali/src/gateway/CodaliGateway.ts` so planning requires enough model budget for classifier and planner, and final synthesis/retries are bounded by remaining model-call budget.
- Updated `packages/codali/src/gateway/__tests__/GatewayStateMachine.test.ts` with security enforcement coverage for model-budget exhaustion, evidence caps, image-artifact caps, and tool-output policy mutation attempts.
- Updated `packages/codali/src/gateway/__tests__/GatewayVerificationLoop.test.ts` so the max-iteration fixture has enough model budget to test the intended stop condition after Phase 17 model-call accounting.
- Updated `packages/codali/src/index.ts` to export the Phase 17 security functions, prompt-hardening constant, approval/risk/limit types, and security review types.

### Phase 17 Validation

- `docdex_impact_graph` was run on the main gateway state machine, policy compiler, and gateway type files before edits; the graph returned no tracked inbound/outbound edges for these new gateway files, so edits were kept tightly scoped and validated with focused/full tests.
- `docdex_symbols` and `docdex_ast` were used on the gateway state machine, policy compiler, and gateway type files before edits.
- `docdex_impact_diagnostics` on `packages/codali/src/gateway/GatewayStateMachine.ts` returned no unresolved import diagnostics.
- `docdex_dag_export` was used on a Docdex search DAG session while planning Phase 17 scope.
- `docdex_local_completion` was attempted for a lightweight Phase 17 security-plan review, but the tool call timed out at the Docdex boundary after roughly 300 seconds; implementation continued with direct inspection and validation.
- `pnpm --filter @mcoda/codali run build` passed.
- Focused compiled Phase 17 tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/GatewaySecurityPolicy.test.js packages/codali/dist/gateway/__tests__/GatewayStateMachine.test.js packages/codali/dist/gateway/__tests__/GatewayPolicyCompiler.test.js packages/codali/dist/gateway/__tests__/GatewayVerificationLoop.test.js`
  - Summary: 27 tests, 27 passed, 0 failed.
- Full Codali package suite passed:
  - `pnpm --filter @mcoda/codali test`
  - Package runner summary: 699 tests, 699 passed, 0 failed.
- Resume final validation repeated the core checks:
  - `pnpm --filter @mcoda/codali run build` passed.
  - Focused compiled Phase 17 tests passed again with 27 tests, 27 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed again with 699 tests, 699 passed, 0 failed.
  - `git diff --check` passed for tracked changes.
  - `rg -n "[ \t]+$" docs/planning/codali-agentic-orchestration-gateway-build-progress.md docs/planning/codali-agentic-orchestration-gateway-build-guide.md` returned no trailing-whitespace matches for the ignored planning docs.
- `docdex_index` ingested the touched Phase 17 TypeScript source and test files. Planning docs remain excluded by the repo's Docdex ignore rules.
- Docdex wrapper was attempted:
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/GatewaySecurityPolicy.test.ts`
  - The wrapper ran the full Codali suite and initially exposed the verifier-loop fixture budget regression that Phase 17 model-call accounting introduced; after the fixture was aligned, the full direct package suite passed.
- New Phase 17 coverage verifies:
  - tenant limits reduce effective run limits;
  - write/destructive risk categories are assigned without enabling mutation tools;
  - approval skeleton records are parsed but do not bypass disabled writes;
  - risky declared actual tools are rejected before runtime exposure;
  - `maxImageArtifacts=0` validates;
  - worker prompts include prompt-injection hardening;
  - model-call budget exhaustion skips later workers;
  - evidence budget caps persisted evidence across workers;
  - image artifact budget rejects over-budget image artifacts;
  - tool output cannot mutate policy or enable blocked tools.

### Phase 18 Implementation

- Updated all workspace/package manifests from `0.1.88` to `0.1.89`.
- Updated `CHANGELOG.md` with the `0.1.89` gateway release notes.
- Added `docs/planning/codali-agentic-orchestration-gateway-product-integration-brief.md` covering:
  - `execution_runtime: "codali"` plus `codali_gateway`;
  - OKACAM's current runtime manifest and policy payload;
  - generic future `policy.app_tool_contracts`;
  - read-only tool contract requirements;
  - tenant/repo/session scope expectations;
  - assistant-message telemetry metadata that products should persist;
  - rollout guidance and fallback to `codali_job` or the single-task Codali path.
- Updated `packages/codali/src/gateway/AgentTierResolver.ts` so nested self-hosted relay aliases receive a deterministic score penalty instead of outranking direct self-hosted candidates.
- Added resolver coverage in `packages/codali/src/gateway/__tests__/AgentTierResolver.test.ts` for direct-candidate preference over nested relay aliases.
- Confirmed `.github/workflows/release.yml` publishes on `v*` tags and validates release package versions against the tag before running `pnpm run release:publish:npm` with Codali and agent-setup publishing enabled.

### Phase 18 Validation

- Full workspace build passed:
  - `pnpm -r run build`
- Full workspace test entrypoint passed:
  - `node tests/all.js`
  - Final marker: `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`
- Focused gateway and mswarm transport tests passed:
  - `node --test packages/codali/dist/gateway/__tests__/*.test.js packages/mswarm/dist/__tests__/codali-executor.test.js packages/mswarm/dist/__tests__/runtime.test.js`
  - Summary: 190 tests, 190 passed, 0 failed.
- Deterministic gateway eval smoke passed:
  - `node packages/codali/dist/cli.js eval --gateway-smoke --output json`
  - Summary: 7/7 cases passed, gates passed, disabled-tool leakage 0, final-large-model rate 1.
- Resolver/live-harness focused regression tests passed after nested relay de-prioritization:
  - `pnpm --filter @mcoda/codali run build`
  - `node --test packages/codali/dist/gateway/__tests__/AgentTierResolver.test.js packages/codali/dist/eval/__tests__/CodaliGatewayLiveHarness.test.js`
  - Summary: 13 tests, 13 passed, 0 failed.
- Live Suku smoke was executed and returned process success with degraded gateway status:
  - `node packages/codali/dist/cli.js eval --gateway-live-smoke --live-timeout-ms 180000 --output json`
  - Run id after resolver hardening: `codali-gateway-live-0c93c3dc-2a18-4981-ba94-02373ac4276d`
  - Large final synthesizer passed with `codex55`.
  - Structured small/medium Suku roles selected from mcoda inventory still failed with OpenRouter model-catalog errors such as "not a valid model ID".
  - `image_worker` was missing from the healthy inventory, so image artifact validation remains an environment/catalog blocker.
  - Manual `mcoda agent-run mswarm-self-hosted-mcoda-sukunahikona-qwen3-vl-32b --json --stdin` reproduced the invalid model-id failure, confirming this is not a gateway-only regression.
- CLI packaging guardrail passed:
  - `pnpm --filter mcoda run pack:verify`
- npm publish dry-run passed:
  - `MCODA_PUBLISH_AGENT_SETUP=1 MCODA_PUBLISH_CODALI=1 pnpm run release:publish:npm:dry-run`
  - npm emitted local config deprecation warnings only; dry-run tarball publication completed for the release packages.
- Version and pre-publish registry sanity checks passed:
  - 12 workspace package manifests report `0.1.89`.
  - `git tag --list v0.1.89` returned no existing local tag before release creation.
  - `npm view mcoda@0.1.89 version`, `npm view @mcoda/codali@0.1.89 version`, and `npm view @mcoda/mswarm@0.1.89 version` all returned expected pre-publish 404s.
- Final hygiene gates passed before release commit:
  - `git diff --check`
  - `rg -n "[ \t]+$" docs/planning/codali-agentic-orchestration-gateway-build-progress.md docs/planning/codali-agentic-orchestration-gateway-build-guide.md docs/planning/codali-agentic-orchestration-gateway-product-integration-brief.md`
  - `docdexd hook pre-commit --repo /Users/bekirdag/Documents/apps/mcoda`
- `docdex_local_completion` was attempted for a lightweight Phase 18 progress-note draft but timed out at the Docdex tool boundary after roughly 300 seconds; progress notes were written directly from command evidence.

### Build Guide Creation

- `git status --short` was clean before guide creation.
- `docdex_get_profile` loaded current Codex profile preferences.
- `docdex_memory_recall` returned relevant repo facts for Codali, Docdex encrypted runtime access, mswarm Codali transport, and prior runtime-tool work.
- `docdex_clone_directive` was used for non-trivial planning guidance.
- `docdex_tree` confirmed `docs/planning` and package source structure.
- `docdex_open` read:
  - `docs/planning/codali-agentic-orchestration-gateway.md`
  - `docs/planning/codali-docdex-orchestrator-plan.md`
  - `docs/planning/docdex-encrypted-repo-runtime-access-plan.md`
  - `packages/codali/src/runtime/CodaliRuntime.ts`
  - `packages/codali/src/runtime/CodaliJobRuntime.ts`
  - `packages/mswarm/src/codali-executor.ts`
  - `packages/shared/src/llm/LocalRunnerConfig.ts`
- `git diff --check -- docs/planning/codali-agentic-orchestration-gateway-build-guide.md docs/planning/codali-agentic-orchestration-gateway-build-progress.md` passed.
- `wc -l` reported 1503 lines in the build guide and 55 lines in this progress tracker before this evidence update.
- `git status --short` remains clean because `docs/planning/*` is ignored in this repo; these planning artifacts may need `git add -f` if they should be committed later.
- The new planning docs remain ignored by git because `docs/planning/*` is ignored in this repo; use `git add -f` for these docs if they should be committed.

## Next Step

Commit the Phase 18 release, create and push `v0.1.89`, monitor CI/CD publish, then confirm npm registry versions.
