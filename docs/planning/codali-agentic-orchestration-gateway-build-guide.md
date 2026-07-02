# Codali Agentic Orchestration Gateway Build Guide

Date: 2026-07-02
Status: implementation in progress; Phases 0 through 12 complete
Source plan: `docs/planning/codali-agentic-orchestration-gateway.md`
Progress tracker: `docs/planning/codali-agentic-orchestration-gateway-build-progress.md`
Target packages: `packages/codali`, `packages/mswarm`, `packages/shared`, `packages/agents`, `packages/db`, `packages/cli`

Current implementation marker:

- Phases 0 through 12 are complete in `packages/codali`.
- Current build chunk is Phase 13: mswarm Gateway Transport.
- Progress and validation evidence are tracked in `docs/planning/codali-agentic-orchestration-gateway-build-progress.md`.

## Goal

Turn Codali into the production agentic orchestration gateway for the mcoda ecosystem.

The gateway receives arbitrary user/product queries, plans bounded work, dispatches small and medium mcoda agents to gather and normalize evidence through Docdex encrypted repositories and approved tools, then passes a curated evidence pack to a final large model for the user-visible answer.

Target runtime:

```text
Product or user request
  -> Codali gateway request
  -> policy and tenant scope compiler
  -> mcoda agent inventory and tier resolver
  -> staged orchestration loop
    -> classifier/router
    -> planner
    -> parallel evidence workers
    -> verifier/gap detector
    -> optional follow-up loop
    -> context refiner
    -> final synthesizer
  -> answer plus sources, telemetry, trace, and stored evidence
```

Production outcome:

- Works with Docdex encrypted search server repositories.
- Works with local, self-hosted, managed, and cloud mcoda agents.
- Uses suku-hosted small/medium/large models for validation.
- Uses suku image-generation model through a specialized artifact worker when a request needs images.
- Keeps product integrations generic through runtime tool contracts, app gateway dispatch, MCP, or typed internal tool adapters.
- Keeps tenant boundaries, allowed tools, denied tools, model budgets, and final-answer model policy enforceable outside prompt text.

## Architecture Decisions

These decisions close the open questions in the source plan for this repo.

1. Use the existing TypeScript mcoda/Codali stack, not LangGraph or LiteLLM as the primary implementation.
   - Codali already has `runCodaliTask`, `runCodaliJob`, providers, tools, sessions, subagents, Docdex tools, and mswarm transport.
   - External workflow/model gateways can remain future adapters, but production gateway logic should stay inside `@mcoda/codali` and `@mcoda/mswarm`.

2. Treat Docdex encrypted search as the primary RAG layer.
   - The "cloud RAG" in the source plan maps to Docdex encrypted server repos.
   - Codali must use immutable runtime `docdex.baseUrl`, `repoId`, `allowedOperations`, capabilities, and attached mswarm API-key context supplied by mswarm.
   - Prompt text must never override Docdex repo scope.

3. Resolve models by role and tier from mcoda agent inventory.
   - No hardcoded agent IDs or model names in gateway logic.
   - Stage roles include `classifier`, `router`, `planner`, `query_expander`, `rag_worker`, `tool_worker`, `extractor`, `verifier`, `context_refiner`, `final_synthesizer`, `image_worker`, and `repair`.
   - The suku agents are test fixtures discovered through mcoda inventory, not constants embedded in code.

4. Small models produce structured artifacts only.
   - Classifier, planner, workers, extractors, and verifiers return JSON that is schema-validated.
   - The final user-visible text comes from the configured final/large model when that path is available.
   - Smaller/local models may provide outage fallback only when policy explicitly allows degraded answers.

5. The orchestrator owns loops and safety.
   - Models can propose next actions.
   - The gateway validates schema, policy, tenant scope, budget, tool permission, and loop limits before executing anything.
   - The model never directly controls unlimited iteration or tool availability.

6. Start read-only for production.
   - Initial production gateway supports search, retrieval, analysis, summarization, and read-only app tools.
   - Write or destructive tools require a later approval workflow with explicit human gates.

7. Evidence store is a first-class system, not worker chat history.
   - Every worker output is normalized into evidence records.
   - Final synthesis receives a curated context pack built from evidence records, not raw tool transcripts.

8. Image generation is a specialized worker lane.
   - Use the suku image model only when the planner classifies the request as requiring generated image output or image artifact refinement.
   - Image output should be stored as an artifact reference with metadata, prompt, model, seed/options when available, and moderation/policy status.

## Current Baseline

Already available in mcoda:

- `packages/codali/src/runtime/CodaliRuntime.ts`
  - Programmatic `runCodaliTask`.
  - Provider adapters.
  - Tool registry.
  - Docdex encrypted runtime input.
  - Runtime-provided app/OKACAM tool contracts.
  - Dynamic tool telemetry.

- `packages/codali/src/runtime/CodaliJobRuntime.ts`
  - Programmatic `runCodaliJob`.
  - Stage DAG execution.
  - Stage roles.
  - Per-stage agent/provider policy.
  - Evidence normalization.
  - Verifier repair support.
  - Job telemetry/events.

- `packages/mswarm/src/codali-executor.ts`
  - Converts mswarm jobs into Codali runtime input.
  - Supports optional `codali_job`.
  - Forwards Docdex runtime context and dynamic tool metadata.
  - Emits OpenAI-compatible streaming chunks and metadata.

- `packages/shared/src/llm/LocalRunnerConfig.ts`
  - Local OpenAI-compatible runner support.
  - llama.cpp, vLLM, LocalAI, SGLang, TGI, and custom runner metadata.
  - JSON schema/GBNF/response-format strategy metadata.

- Existing planning docs:
  - `docs/planning/codali-docdex-orchestrator-plan.md`
  - `docs/planning/docdex-encrypted-repo-runtime-access-plan.md`
  - `docs/planning/codali-multistage-job-runtime-plan.md`

The new work should build on these pieces instead of replacing them.

## Target Package Shape

Add a gateway layer as a product-neutral API above `runCodaliJob`.

Proposed package surface:

```ts
export {
  runCodaliGateway,
  createCodaliGateway,
} from "./gateway/CodaliGateway.js";

export type {
  CodaliGatewayRequest,
  CodaliGatewayResult,
  CodaliGatewayPolicy,
  CodaliGatewayTrace,
  CodaliEvidenceItem,
  CodaliContextPack,
  CodaliAgentTierPolicy,
} from "./gateway/CodaliGatewayTypes.js";
```

Recommended folder:

```text
packages/codali/src/gateway/
  AgentTierResolver.ts
  ContextPackBuilder.ts
  CodaliGateway.ts
  CodaliGatewaySchemas.ts
  CodaliGatewayStore.ts
  CodaliGatewayTypes.ts
  EvidenceNormalizer.ts
  GatewayPolicyCompiler.ts
  GatewayPlanner.ts
  GatewayStateMachine.ts
  ToolCapabilityCompiler.ts
  __tests__/
```

mswarm integration:

```text
packages/mswarm/src/
  codali-executor.ts
  runtime.ts
  server.ts
```

Possible CLI surface:

```sh
mcoda codali gateway run --input request.json
mcoda codali gateway trace <run-id>
mcoda codali gateway eval --suite gateway-smoke
```

## Core Contracts

### Gateway Request

```ts
export interface CodaliGatewayRequest {
  id?: string;
  query: string;
  mode?: "fast" | "balanced" | "deep" | "cheap" | "image";
  product?: {
    name?: string;
    version?: string;
    surface?: string;
  };
  tenant?: {
    id?: string;
    slug?: string;
    realm?: string;
  };
  requester?: {
    id?: string;
    email?: string;
    role?: string;
    locale?: string;
  };
  conversation?: {
    id?: string;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  };
  docdex?: CodaliRuntimeDocdexInput;
  tools?: CodaliRuntimeToolManifest;
  policy: CodaliGatewayPolicy;
  agentPolicy?: CodaliAgentTierPolicy;
  response?: {
    format?: "text" | "json" | "json_schema";
    schema?: Record<string, unknown>;
    finalAnswerRequired?: boolean;
  };
  metadata?: Record<string, unknown>;
}
```

### Gateway Policy

```ts
export interface CodaliGatewayPolicy {
  allowedTools: string[];
  deniedTools?: string[];
  appToolContracts?: CodaliRuntimeAppToolContracts;
  appVirtualTools?: string[];
  appToolGateway?: CodaliRuntimeAppToolGatewayContract;
  maxIterations: number;
  maxRuntimeMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxEvidenceItems: number;
  maxContextPackTokens: number;
  allowWrites: false;
  allowShell: false;
  allowDestructiveOperations: false;
  allowOutsideWorkspace: false;
  requireFinalLargeModel: boolean;
  allowDegradedFinalAnswer?: boolean;
  allowImageWorker?: boolean;
}
```

Initial production policy should set all write/shell/destructive flags to `false`.

### Agent Tier Policy

```ts
export interface CodaliAgentTierPolicy {
  resolver: "mcoda_inventory";
  allowCloudFallback?: boolean;
  roles?: Record<
    string,
    {
      tier: "small" | "medium" | "large" | "image";
      capabilities?: string[];
      requiresTools?: boolean;
      requiresJsonSchema?: boolean;
      maxLatencyMs?: number;
      minContextWindow?: number;
      preferredRunnerKinds?: string[];
    }
  >;
}
```

Default roles:

```text
classifier       -> small, JSON schema preferred
router           -> small, JSON schema preferred
planner          -> medium, JSON schema required
query_expander   -> small
rag_worker       -> small or medium, tools required
tool_worker      -> small or medium, tools required
extractor        -> small, JSON schema required
verifier         -> small or medium, JSON schema required
context_refiner  -> medium
final_synthesizer -> large
image_worker     -> image
repair           -> medium or large
```

### Evidence Item

```ts
export interface CodaliEvidenceItem {
  id: string;
  runId: string;
  taskId?: string;
  stageId?: string;
  claim: string;
  summary?: string;
  sourceType: string;
  sourceId?: string;
  sourceUri?: string;
  sourceTitle?: string;
  sourceTimestamp?: string;
  rawExcerpt?: string;
  rawPayloadRef?: string;
  confidence: number;
  relevance: number;
  freshness?: "fresh" | "recent" | "stale" | "unknown";
  usedTool?: string;
  tenantScoped: boolean;
  metadata?: Record<string, unknown>;
}
```

### Context Pack

```ts
export interface CodaliContextPack {
  id: string;
  runId: string;
  originalQuery: string;
  decisionFacts: CodaliEvidenceItem[];
  contradictions: Array<{
    summary: string;
    evidenceIds: string[];
  }>;
  missingInformation: string[];
  selectedExcerpts: Array<{
    evidenceId: string;
    text: string;
  }>;
  toolSummary: Array<{
    tool: string;
    calls: number;
    statuses: Record<string, number>;
  }>;
  tokenEstimate: number;
  metadata?: Record<string, unknown>;
}
```

### Gateway Result

```ts
export interface CodaliGatewayResult {
  runId: string;
  status: "succeeded" | "failed" | "partial" | "needs_clarification";
  answer: string;
  sources: Array<{
    evidenceId: string;
    title?: string;
    uri?: string;
    sourceType: string;
  }>;
  confidence: "high" | "medium" | "low";
  evidence: CodaliEvidenceItem[];
  contextPack?: CodaliContextPack;
  finalModel?: {
    agentSlug?: string;
    tier: "large";
    model?: string;
  };
  trace: CodaliGatewayTrace;
  telemetry: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
```

## Data Model

Implement the gateway store behind an interface first. Add durable SQL storage before production rollout.

```sql
gateway_runs
- id
- product
- tenant_id
- requester_id
- conversation_id
- query
- mode
- status
- started_at
- completed_at
- policy_json
- docdex_scope_json
- agent_policy_json
- answer
- confidence
- error_code
- error_message

gateway_tasks
- id
- run_id
- stage_id
- worker_role
- objective
- status
- input_json
- output_json
- started_at
- completed_at
- attempts
- error_code
- error_message

gateway_evidence_items
- id
- run_id
- task_id
- stage_id
- claim
- summary
- source_type
- source_id
- source_uri
- source_title
- source_timestamp
- raw_excerpt
- raw_payload_ref
- confidence
- relevance
- freshness
- used_tool
- metadata_json

gateway_tool_calls
- id
- run_id
- task_id
- tool_name
- status
- input_json_redacted
- output_ref
- latency_ms
- error_code
- error_message

gateway_model_calls
- id
- run_id
- task_id
- role
- agent_slug
- provider
- model
- status
- prompt_tokens
- completion_tokens
- latency_ms
- error_code

gateway_context_packs
- id
- run_id
- token_estimate
- pack_json
- created_at

gateway_artifacts
- id
- run_id
- task_id
- kind
- uri
- content_type
- metadata_json
- created_at
```

Production rules:

- Never persist raw credentials.
- Redact API keys, bearer tokens, cookies, and secret headers before storing tool/model inputs.
- Store large raw tool outputs and generated images as artifacts with references, not inline unbounded JSON/base64.
- Keep tenant and requester identifiers on runs for audit and isolation.

## Phase Size Rule

Each phase below is sized so one LLM coding session can complete it end to end:

- One coherent feature slice.
- A small set of files.
- Focused tests.
- Progress doc update.
- No production deploy unless the phase explicitly reaches release gates.

Do not batch multiple phases into one large implementation unless the user explicitly asks for a sprint merge.

## Phase Overview

| Phase | Slice | Primary Result |
| --- | --- | --- |
| 0 | Baseline audit | Current gaps and current test evidence |
| 1 | Gateway contracts | Exported types and schema validators |
| 2 | Policy compiler | Strict tenant/tool/model policy enforcement |
| 3 | Agent tier resolver | mcoda inventory based role selection |
| 4 | Store abstraction | In-memory plus durable store contract |
| 5 | Router/planner | Structured plan from arbitrary queries |
| 6 | Worker task executor | Bounded parallel workers and evidence records |
| 7 | Evidence normalizer | Stable evidence item contract and provenance |
| 8 | Verification loop | Gap/contradiction detection and follow-up loop |
| 9 | Context packer | Curated final model packet |
| 10 | Final synthesizer | Large model final-answer stage |
| 11 | Docdex encrypted hardening | Production encrypted repo search validation |
| 12 | App tool gateway | Signed read-only product tool dispatcher |
| 13 | mswarm gateway transport | Hosted/self-hosted API and streaming metadata |
| 14 | Suku model harness | Live small/medium/large/image model validation |
| 15 | Observability and replay | Traces, inspectable runs, and replay |
| 16 | Evaluation suites | Regression, tenant, tool, and quality gates |
| 17 | Security and approvals | Production policy, rate limits, write approval skeleton |
| 18 | Release and rollout | Package publish and product integration gates |

## Phase 0: Baseline Audit And Progress Trail

Goal:

- Convert this guide into an actionable implementation run.
- Confirm current code and tests before changing runtime behavior.

Files:

- `docs/planning/codali-agentic-orchestration-gateway-build-progress.md`
- Existing relevant runtime/test files only for inspection.

Tasks:

1. Read this guide and the source plan.
2. Inspect:
   - `packages/codali/src/runtime/CodaliRuntime.ts`
   - `packages/codali/src/runtime/CodaliJobRuntime.ts`
   - `packages/mswarm/src/codali-executor.ts`
   - `packages/mswarm/src/runtime.ts`
   - `packages/shared/src/llm/LocalRunnerConfig.ts`
3. Run focused baseline tests:
   - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliRuntime.test.ts`
   - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/runtime/__tests__/CodaliJobRuntime.test.ts`
   - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm/src/__tests__/codali-executor.test.ts`
4. Record current failures or blockers in the progress doc.

Acceptance:

- Progress doc has a baseline section.
- Current runtime tests are known green or failures are documented as blockers.

## Phase 1: Gateway Contracts And Schemas

Goal:

- Add the public gateway API types and schema validators without changing runtime behavior.

Files:

- `packages/codali/src/gateway/CodaliGatewayTypes.ts`
- `packages/codali/src/gateway/CodaliGatewaySchemas.ts`
- `packages/codali/src/gateway/__tests__/CodaliGatewaySchemas.test.ts`
- `packages/codali/src/index.ts`

Tasks:

1. Add request/result/policy/evidence/context-pack/trace types.
2. Add JSON schema or lightweight validation helpers for:
   - gateway request
   - planner output
   - worker task
   - evidence item
   - verifier output
   - context pack
3. Export types from `@mcoda/codali`.
4. Keep all schemas product-neutral.
5. Add compatibility aliases for snake_case payloads used by mswarm/product callers.

Acceptance:

- Tests reject invalid tool permissions, invalid budgets, invalid evidence confidence, and missing query.
- No runtime behavior changes yet.

Validation:

- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/CodaliGatewaySchemas.test.ts`

## Phase 2: Gateway Policy Compiler

Goal:

- Compile product/runtime policy into enforceable Codali job/runtime policy.

Files:

- `packages/codali/src/gateway/GatewayPolicyCompiler.ts`
- `packages/codali/src/gateway/ToolCapabilityCompiler.ts`
- `packages/codali/src/gateway/__tests__/GatewayPolicyCompiler.test.ts`

Tasks:

1. Convert `CodaliGatewayPolicy` into:
   - `CodaliRuntimePolicy`
   - `CodaliJobBudgets`
   - effective allowed and denied tools
2. Enforce read-only initial production mode:
   - `allowWrites=false`
   - `allowShell=false`
   - `allowDestructiveOperations=false`
   - `allowOutsideWorkspace=false`
3. Remove disabled tools before stage prompts are constructed.
4. Validate Docdex operation capability against runtime `docdex.allowedOperations`.
5. Block tenant/repo/base URL override arguments in dynamic app tool calls.
6. Emit policy warnings for skipped tools and unsafe tool contracts.

Acceptance:

- Denied tools are not visible to planner/worker stages.
- Missing required Docdex context fails with stable operational error.
- Disabled integrations are uncallable even if a prompt asks for them.

Validation:

- Focused policy tests.
- Existing Codali runtime dynamic-tool tests still pass.

## Phase 3: mcoda Agent Tier Resolver

Goal:

- Select agents dynamically from mcoda inventory by role and tier.

Files:

- `packages/codali/src/gateway/AgentTierResolver.ts`
- `packages/codali/src/gateway/__tests__/AgentTierResolver.test.ts`
- Possible supporting types in `packages/agents` or `packages/shared`

Tasks:

1. Define a normalized gateway agent candidate shape:
   - slug
   - adapter
   - provider
   - model
   - runner kind
   - health
   - context window
   - supports tools
   - supports JSON schema
   - supports image generation or artifact output
   - cost/latency metadata when available
2. Resolve roles by policy:
   - exact role preference
   - tier preference
   - capability match
   - health
   - local/self-hosted preference
   - cloud fallback only when allowed
3. Do not hardcode suku model names.
4. Add deterministic tie-breaking for testability.
5. Return clear resolution errors with candidate diagnostics.

Acceptance:

- Given an inventory fixture, classifier/planner/verifier choose small/medium local agents.
- Final synthesizer chooses a large capable agent.
- Image worker chooses an image-capable agent only when `allowImageWorker=true`.
- Cloud fallback is blocked unless policy allows it.

Validation:

- Unit tests with inventory fixtures.
- Later live suku validation in Phase 14.

## Phase 4: Gateway Store Abstraction

Goal:

- Add a durable evidence/run-state boundary without forcing one database implementation into every runtime path immediately.

Files:

- `packages/codali/src/gateway/CodaliGatewayStore.ts`
- `packages/codali/src/gateway/__tests__/CodaliGatewayStore.test.ts`
- Later adapter files under `packages/db` if needed.

Tasks:

1. Define store interface:
   - create run
   - update run status
   - create task
   - update task
   - append evidence
   - append tool call
   - append model call
   - save context pack
   - save artifact metadata
   - read run trace
2. Implement in-memory store for tests and lightweight local runs.
3. Add a durable adapter plan:
   - use existing `packages/db` if it already has migration conventions
   - otherwise add migration in a later dedicated phase
4. Add redaction helpers before store writes.

Acceptance:

- Gateway can run in tests without external DB.
- Store captures evidence, tool calls, model calls, context packs, and final status.
- Secrets are redacted before persistence.

Validation:

- Store contract tests.

## Phase 5: Router And Planner Stages

Goal:

- Convert arbitrary queries into bounded, structured gateway plans.

Files:

- `packages/codali/src/gateway/GatewayPlanner.ts`
- `packages/codali/src/gateway/CodaliGateway.ts`
- `packages/codali/src/gateway/__tests__/GatewayPlanner.test.ts`

Tasks:

1. Add classifier output schema:
   - query type
   - needs private data
   - needs fresh data
   - needs Docdex
   - needs app tools
   - needs image worker
   - direct answer candidate
2. Add planner output schema:
   - subquestions
   - worker tasks
   - allowed tool names per task
   - expected evidence shape
   - max iterations
   - final answer style
3. Build stage prompts that include:
   - query
   - policy constraints
   - tool names/descriptions only for allowed tools
   - expected JSON schema
4. Validate model output; attempt one repair for parse/schema failures.
5. Keep planner product-neutral.

Acceptance:

- Generic questions can plan a direct final-answer path.
- Repo/product questions plan Docdex/tool worker tasks.
- Image requests plan an image worker task only when allowed.
- Disabled tools never appear in planner output.

Validation:

- Stub-provider tests for classifier/planner JSON.

## Phase 6: Worker Task Executor

Goal:

- Execute planner tasks through bounded parallel workers.

Implementation status:

- Complete as of 2026-07-02.
- `GatewayStateMachine` converts validated planner tasks into injected worker task-runner calls.
- The state machine enforces max parallel workers, max runtime, per-task timeout, max tool calls, approved tool filtering, required/optional failure behavior, run/task trace persistence, and per-worker telemetry.
- `CodaliGateway.executeWorkerTasks` wires the Phase 5 planner output into the state machine while preserving the planning-only API.

Files:

- `packages/codali/src/gateway/GatewayStateMachine.ts`
- `packages/codali/src/gateway/CodaliGateway.ts`
- `packages/codali/src/gateway/__tests__/GatewayStateMachine.test.ts`

Tasks:

1. Convert planner tasks into Codali job stages or direct runtime calls.
2. Enforce:
   - max parallel workers
   - max tool calls
   - max runtime
   - per-task timeout
3. Worker prompts must say:
   - gather evidence only
   - do not answer the user
   - output JSON only
4. Workers call only approved tools.
5. Failed optional workers record errors and continue.
6. Failed required workers fail or trigger verifier-directed follow-up.

Acceptance:

- Parallel worker wave runs deterministically in tests.
- Required worker failure fails the run.
- Optional worker failure is recorded and does not hide errors.
- Tool budget exhaustion stops further tool execution.

Validation:

- State-machine tests with stub task runner.
- Current evidence:
  - `pnpm --filter @mcoda/codali run build` passed.
  - `node --test packages/codali/dist/gateway/__tests__/GatewayStateMachine.test.js` passed: 6 tests, 6 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed: 636 tests, 636 passed, 0 failed.

## Phase 7: Evidence Normalizer And Provenance

Goal:

- Normalize all worker outputs into stable evidence records with provenance.

Implementation status:

- Complete as of 2026-07-02.
- `EvidenceNormalizer` accepts direct evidence arrays, facts arrays, source records, Docdex search hits, app-tool payloads, generic worker output, and malformed worker JSON.
- Normalized evidence receives stable ids, conservative confidence/relevance scores, preserved source/tool metadata, duplicate folding, tenant-scope enforcement, and low-confidence model-observation fallback for unprovenanced material.
- `GatewayStateMachine` now normalizes worker evidence/output/tool-call results before appending evidence to the gateway store.

Files:

- `packages/codali/src/gateway/EvidenceNormalizer.ts`
- `packages/codali/src/gateway/__tests__/EvidenceNormalizer.test.ts`

Tasks:

1. Accept evidence-like worker outputs:
   - evidence array
   - facts array
   - source records
   - Docdex search hits
   - app tool JSON payloads
2. Normalize into `CodaliEvidenceItem`.
3. Deduplicate by source and claim fingerprint.
4. Score relevance and confidence conservatively.
5. Preserve source ids, URLs, Docdex doc ids, tool names, timestamps, and source types.
6. Reject evidence without tenant scope when tenant scope is required.

Acceptance:

- Docdex results become cited evidence.
- App tool results become cited evidence.
- Duplicate evidence is collapsed with metadata.
- Evidence without provenance is kept only as low-confidence model observation or rejected by policy.

Validation:

- Normalizer tests for Docdex hits, tool outputs, malformed worker JSON, and duplicates.
- Current evidence:
  - `pnpm --filter @mcoda/codali run build` passed.
  - `node --test packages/codali/dist/gateway/__tests__/EvidenceNormalizer.test.js packages/codali/dist/gateway/__tests__/GatewayStateMachine.test.js` passed: 12 tests, 12 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed: 642 tests, 642 passed, 0 failed.

## Phase 8: Verification And Follow-Up Loop

Status: Complete as of 2026-07-02.

Goal:

- Let small/medium models identify gaps while the gateway owns loop limits.

Files:

- `packages/codali/src/gateway/GatewayStateMachine.ts`
- `packages/codali/src/gateway/__tests__/GatewayVerificationLoop.test.ts`

Tasks:

1. Add verifier schema:
   - passed
   - missing information
   - contradictions
   - weak evidence
   - unsupported final-risk claims
   - suggested follow-up tasks
2. Gateway validates suggested follow-up tasks against policy and budget.
3. Run at most `policy.maxIterations`.
4. Stop early when:
   - verifier passes
   - no useful new tasks remain
   - budget exhausted
   - required tool unavailable
5. Persist verifier results and loop decisions.

Acceptance:

- Follow-up loop runs only within policy.
- Verifier can add a second Docdex query when evidence is weak.
- Infinite loop is impossible.
- Contradictions are preserved for the context pack.

Validation:

- Tests for pass, follow-up, budget stop, and contradiction handling.
- Current evidence:
  - `pnpm --filter @mcoda/codali test` passed: 648 tests, 648 passed, 0 failed.
  - New Phase 8 coverage verifies early verifier pass, weak-evidence Docdex follow-up, tool-budget stop, unavailable-tool rejection, max-iteration stop, and contradiction preservation.
  - Targeted `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/GatewayVerificationLoop.test.ts` was attempted and interrupted with exit code 130 after roughly 90 seconds with no output.

## Phase 9: Context Pack Builder

Status: Complete as of 2026-07-02.

Goal:

- Create the curated evidence packet for final synthesis.

Files:

- `packages/codali/src/gateway/ContextPackBuilder.ts`
- `packages/codali/src/gateway/__tests__/ContextPackBuilder.test.ts`

Tasks:

1. Rank evidence by relevance, confidence, freshness, and source quality.
2. Deduplicate similar claims.
3. Separate:
   - decision facts
   - contradictions
   - missing information
   - selected raw excerpts
   - tool call summary
4. Respect `maxContextPackTokens`.
5. Include enough provenance for final citations.
6. Persist the context pack.

Acceptance:

- Final model does not receive raw worker transcripts by default.
- Context pack is deterministic enough for tests.
- Evidence IDs in pack map back to stored evidence.

Validation:

- Tests for ranking, truncation, contradiction preservation, and source mapping.
- Current evidence:
  - `pnpm --filter @mcoda/codali run build` passed.
  - Focused compiled tests passed: `node --test packages/codali/dist/gateway/__tests__/CodaliGatewayStore.test.js packages/codali/dist/gateway/__tests__/ContextPackBuilder.test.js` returned 7 tests, 7 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed: 652 tests, 652 passed, 0 failed.
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/ContextPackBuilder.test.ts` passed with `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`; targeted file summary was 4 tests, 4 passed, 0 failed.
  - New Phase 9 coverage verifies evidence ranking, duplicate-claim folding, source mapping, excerpt truncation, context-pack token budgeting, tool-call summaries, verifier gap/contradiction preservation, and store persistence.
  - `docdex_symbols` on `packages/codali/src/gateway/ContextPackBuilder.ts` succeeded.
  - `docdex_impact_graph` on `packages/codali/src/gateway/ContextPackBuilder.ts` returned no tracked inbound or outbound edges.
  - `docdex_impact_diagnostics` on `packages/codali/src/gateway/ContextPackBuilder.ts` returned no unresolved import diagnostics.
  - `docdex_index` ingested the Phase 9 TypeScript source, tests, store, and package export files.

## Phase 10: Final Synthesizer

Status: Complete as of 2026-07-02.

Goal:

- Ensure the final answer is produced by the configured final/large model using only the curated context pack.

Files:

- `packages/codali/src/gateway/CodaliGateway.ts`
- `packages/codali/src/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.ts`

Tasks:

1. Add final synthesizer prompt:
   - answer the actual query
   - use only context pack evidence
   - mention uncertainty when evidence is weak
   - do not expose internal trace unless requested
   - do not cite disabled integrations
2. Resolve final agent through `AgentTierResolver`.
3. Enforce `requireFinalLargeModel`.
4. If final model fails:
   - retry once if retryable
   - use repair/fallback only when policy allows degraded answer
   - otherwise return clear operational failure
5. Return answer, sources, confidence, final model metadata, and trace.

Acceptance:

- User-visible answer comes from large/final tier in normal operation.
- Small-model direct answer is blocked when `requireFinalLargeModel=true`.
- Sources are drawn from context-pack evidence.

Validation:

- Stub tests asserting large tier is called for final answer.
- Current evidence:
  - `pnpm --filter @mcoda/codali run build` passed.
  - Focused compiled tests passed: `node --test packages/codali/dist/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.js` returned 6 tests, 6 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed: 658 tests, 658 passed, 0 failed.
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.ts` passed with `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`; targeted file summary was 6 tests, 6 passed, 0 failed.
  - New Phase 10 coverage verifies full gateway final synthesis ignores classifier direct-answer drafts, final prompts and sources only use allowed context-pack evidence, non-large final assignments are blocked when `requireFinalLargeModel=true`, retryable final-provider failures are retried once, degraded fallback is policy-gated, and final prompt helpers avoid internal trace payloads.
  - `docdex_symbols` on `packages/codali/src/gateway/CodaliGateway.ts` succeeded and listed `run`, `synthesizeFinalAnswer`, final-synthesis helpers, and metadata-preserving run updates.
  - `docdex_impact_graph` on `packages/codali/src/gateway/CodaliGateway.ts` and `packages/codali/src/index.ts` returned no tracked inbound or outbound edges.
  - `docdex_impact_diagnostics` on `packages/codali/src/gateway/CodaliGateway.ts` and `packages/codali/src/index.ts` returned no unresolved import diagnostics.
  - `docdex_index` ingested the Phase 10 gateway source, final-synthesizer test, and package export files.

## Phase 11: Docdex Encrypted Search Hardening

Goal:

- Make encrypted Docdex repo access production-safe in gateway mode.

Status:

- Complete as of 2026-07-02.

Files:

- `packages/codali/src/gateway/ToolCapabilityCompiler.ts`
- `packages/codali/src/docdex/DocdexClient.ts`
- `packages/codali/src/tools/docdex/DocdexTools.ts`
- Relevant tests under `packages/codali/src/docdex/__tests__` and `gateway/__tests__`

Tasks:

1. Require immutable runtime Docdex context for encrypted runs:
   - base URL
   - repo id
   - allowed operations
   - capability map
   - attached mswarm API key when credential source requires it
2. Ensure gateway cannot fall back to local Docdex defaults for encrypted jobs.
3. Propagate stable Docdex error codes:
   - `missing_credentials`
   - `repo_access_denied`
   - `scope_denied`
   - `encrypted_operation_disabled`
4. Add encrypted-search evidence fixtures.
5. Record Docdex request IDs in telemetry when available.

Implementation completed:

- `DocdexClient` treats attached-mswarm-key jobs, or explicit immutable jobs, as immutable runtime contexts.
- Encrypted jobs require remote `baseUrl`, immutable `repoId`, non-empty `allowedOperations`, a capability map, and an attached API key when that credential source is selected.
- Encrypted jobs do not auto-initialize from `repoRoot`, do not send `repo_root`/`x-docdex-repo-root`, and do not include `project_root` in MCP params.
- Stable encrypted Docdex errors are preserved through tool execution: `missing_credentials`, `repo_access_denied`, `scope_denied`, and `encrypted_operation_disabled`.
- `ToolCapabilityCompiler` now fails attached-key gateway jobs that are missing immutable Docdex context and continues to reject `repo_id`/tenant/base URL override fields in app-tool call schemas.
- Docdex response request IDs are normalized into result `meta`, carried into evidence metadata, exposed in trace-safe tool-call metadata, and returned as final-result `telemetry.docdexRequestIds`.
- Test stubs now model headers accurately so request-id telemetry does not confuse `content-type` with request IDs.

Acceptance:

- Missing encrypted credentials fail clearly when required.
- Disallowed Docdex operation is blocked before network call.
- Repo id cannot be overridden by model/tool args.
- Successful Docdex hits become evidence items.
- Response telemetry includes Docdex request IDs when the server returns them.

Validation:

- Existing encrypted Docdex tests.
- New gateway-level encrypted search tests.
- Current evidence:
  - `pnpm --filter @mcoda/codali run build` passed.
  - Focused compiled tests passed: `node --test packages/codali/dist/docdex/__tests__/DocdexClient.test.js packages/codali/dist/tools/docdex/__tests__/DocdexTools.test.js packages/codali/dist/gateway/__tests__/GatewayPolicyCompiler.test.js packages/codali/dist/gateway/__tests__/EvidenceNormalizer.test.js packages/codali/dist/gateway/__tests__/CodaliGatewayFinalSynthesizer.test.js` returned 43 tests, 43 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed: 665 tests, 665 passed, 0 failed.
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/docdex/__tests__/DocdexClient.test.ts` passed with `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`; targeted file summary was 15 tests, 15 passed, 0 failed.
  - New Phase 11 coverage verifies immutable encrypted context, missing repo id, missing capability/operation contract, capability-disabled operations, stable encrypted error codes, no local initialize fallback, no repo-root override, request-id metadata, evidence request-id propagation, final telemetry request IDs, and gateway compiler immutable-context validation.
  - `docdex_impact_diagnostics` reported no diagnostics in touched Codali files; remaining diagnostics are pre-existing unresolved imports in `packages/integrations`.
  - `docdex_index` ingested the touched Phase 11 Codali source and tests.
  - `git diff --check` passed.

## Phase 12: Signed App Tool Gateway

Status: Complete as of 2026-07-02.

Goal:

- Add generic direct dispatch for read-only product tools beyond Docdex-backed snapshots.

Files:

- `packages/codali/src/gateway/AppToolGatewayDispatcher.ts`
- `packages/codali/src/runtime/CodaliRuntime.ts`
- `packages/codali/src/gateway/__tests__/AppToolGatewayDispatcher.test.ts`

Tasks:

1. Define dispatcher request:
   - run id
   - session id
   - tenant scope
   - requester scope
   - tool name
   - validated args
   - timestamp
   - nonce
   - signature
2. Enforce read-only gateway contracts.
3. Reuse `callSchema`, `resultContract`, allowed tools, denied tools, and tenant capability guards.
4. Add deterministic signature verification/injection boundary.
5. Normalize gateway responses into evidence.
6. Redact request/response logs.

Implementation completed:

- Added `AppToolGatewayDispatcher` with a product-neutral signed request envelope:
  - `version`
  - `run_id`
  - `session_id`
  - `request_id`
  - `tenant_scope`
  - `requester_scope`
  - `tool_name`
  - `validated_args`
  - `timestamp`
  - `nonce`
  - `read_only`
  - `call_schema`
  - `result_contract`
  - source metadata
  - HMAC `signature`
- Direct app gateways now require explicit `readOnly/read_only: true` on both the app tool contract and gateway config before dispatch.
- Direct gateway dispatch requires signing material through one of:
  - `signatureSecret`
  - `signature_secret`
  - `signingSecret`
  - `signing_secret`
  - `secret`
  - `signature`
- Signature verification uses deterministic canonical JSON and constant-time comparison.
- Runtime dynamic tools now call `dispatchAppToolGateway` instead of the older inline static-signature POST path.
- Gateway responses are normalized into app-tool evidence payloads that the existing evidence normalizer can consume.
- Dispatcher and runtime diagnostics use redacted request/response payloads, including secret-like strings in diagnostic bodies.
- `ToolCapabilityCompiler` now hides direct gateway tools that are unsigned or missing explicit gateway read-only flags.
- Public exports now include dispatcher signing, verification, redaction, dispatch, and request/response types.

Acceptance:

- Gateway contract missing read-only flag is rejected.
- Missing required signature is rejected.
- Tool args cannot override tenant/repo/base URL/credential scope.
- Product gateway result becomes evidence.

Validation:

- Dispatcher tests with signed/unsigned/malformed requests.
- Current evidence:
  - `pnpm --filter @mcoda/codali run build` passed.
  - Focused compiled tests passed: `node --test packages/codali/dist/gateway/__tests__/AppToolGatewayDispatcher.test.js packages/codali/dist/gateway/__tests__/GatewayPolicyCompiler.test.js packages/codali/dist/runtime/__tests__/CodaliRuntime.test.js` returned 28 tests, 28 passed, 0 failed.
  - `pnpm --filter @mcoda/codali test` passed: 673 tests, 673 passed, 0 failed.
  - `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali/src/gateway/__tests__/AppToolGatewayDispatcher.test.ts` passed with `MCODA_RUN_ALL_TESTS_COMPLETE status=passed`; package wrapper summary was 673 tests passed and targeted dispatcher summary was 6 tests passed.
  - `docdex_impact_diagnostics` on touched Phase 12 Codali files returned no diagnostics.
  - `docdex_symbols` and `docdex_ast` succeeded for `packages/codali/src/gateway/AppToolGatewayDispatcher.ts`.
  - `docdex_impact_graph` on `AppToolGatewayDispatcher.ts` and `CodaliRuntime.ts` returned no tracked inbound or outbound edges.
  - `docdex_index` ingested the touched Phase 12 TypeScript files; planning docs remain ignored by the repo's Docdex ignore rules.
  - `git diff --check` passed.

## Phase 13: mswarm Gateway Transport

Goal:

- Expose the gateway through mswarm self-hosted and managed runtime paths.

Files:

- `packages/mswarm/src/codali-executor.ts`
- `packages/mswarm/src/runtime.ts`
- `packages/mswarm/src/server.ts`
- `packages/mswarm/src/__tests__/codali-executor.test.ts`
- `packages/mswarm/src/__tests__/runtime.test.ts`

Tasks:

1. Add optional payload:

```json
{
  "execution_runtime": "codali",
  "codali_gateway": {
    "query": "...",
    "mode": "balanced",
    "policy": {},
    "agent_policy": {},
    "response": {}
  }
}
```

2. Keep compatibility:
   - no `codali_gateway` -> existing `codali_job` or single-task behavior
   - `codali_job` remains supported
3. Forward:
   - Docdex encrypted runtime context
   - tool manifest/contracts
   - tenant/requester metadata
   - session/conversation metadata
4. Stream gateway events through OpenAI-compatible chunks where possible.
5. Return metadata:
   - run id
   - status
   - stage/task counts
   - tool calls
   - model calls
   - warnings/errors
   - source count
   - evidence count

Acceptance:

- mswarm can invoke `codali_gateway`.
- Existing `codali_job` and single-task tests still pass.
- Metadata is safe for product assistant-message storage.

Validation:

- mswarm executor/runtime tests.

## Phase 14: Suku Live Model Validation Harness

Goal:

- Validate the gateway against real suku-hosted models and image model.

Files:

- `packages/codali/src/eval/` or `packages/codali/src/gateway/__tests__/live/`
- `docs/planning/codali-agentic-orchestration-gateway-build-progress.md`
- Optional CLI command under `packages/codali/src/cli/EvalCommand.ts`

Tasks:

1. Discover models dynamically:
   - `mcoda agent list --json --refresh-health`
   - or the configured mswarm/self-hosted inventory path
2. Classify candidates:
   - small JSON-capable
   - medium planner/verifier
   - large final synthesizer
   - image-capable worker
3. Run live smoke suite:
   - direct generic question
   - Docdex encrypted repo search question
   - tool-disabled leakage question
   - multi-step evidence question
   - final-answer-large-model assertion
   - image generation request
4. Record:
   - agent slugs
   - tiers
   - latency
   - JSON validity
   - tool call counts
   - final answer status
   - artifact metadata for image run
5. Do not store secrets in progress docs.

Acceptance:

- At least one small/medium agent can produce valid structured JSON.
- At least one large/final agent can synthesize from context pack.
- Image worker can produce an artifact reference for an image request.
- Gateway degrades clearly when an expected tier is unavailable.

Validation:

- Live suku smoke command documented in progress.
- Results redacted and summarized.

## Phase 15: Observability, Trace, And Replay

Goal:

- Make production runs inspectable and replayable without exposing secrets.

Files:

- `packages/codali/src/gateway/CodaliGatewayStore.ts`
- `packages/codali/src/runtime/RunLogQuery.ts`
- `packages/codali/src/runtime/RunLogReader.ts`
- CLI/API surfaces as needed

Tasks:

1. Add trace read API:
   - run metadata
   - tasks
   - evidence
   - tool calls
   - model calls
   - context pack
   - final answer
2. Add replay input export:
   - redacted request
   - frozen tool/evidence fixtures
   - model output fixture option
3. Add debug summaries for product metadata.
4. Add OpenTelemetry-style event names for future dashboard integration.
5. Ensure trace never includes raw credentials.

Acceptance:

- A failed run can be diagnosed from stored trace.
- A successful run can explain which tools and sources were used.
- Replay fixtures can reproduce planner/context/final stages in tests.

Validation:

- Trace/replay tests.

## Phase 16: Evaluation Suites And Quality Gates

Goal:

- Prevent regressions in routing, evidence use, disabled-tool leakage, and final answer quality.

Files:

- `packages/codali/src/eval/`
- `packages/codali/src/gateway/__tests__/`
- `docs/planning/codali-agentic-orchestration-gateway-build-progress.md`

Tasks:

1. Add evaluation task types:
   - generic question
   - code/repo question
   - encrypted Docdex search question
   - product tool question
   - disabled integration question
   - image generation question
   - missing evidence question
2. Add metrics:
   - planner schema validity
   - evidence precision
   - citation/source correctness
   - disabled-tool leakage
   - final answer directness
   - final large model used
   - latency
   - token/model/tool budget
3. Add a pass/fail report.
4. Gate release on focused eval suite plus unit tests.

Acceptance:

- Eval suite catches hardcoded keyword routing.
- Eval suite catches disabled integration leakage.
- Eval suite catches final answer produced by wrong tier.
- Eval suite records cost/latency regressions.

Validation:

- `codali eval gateway-smoke` or equivalent package test.

## Phase 17: Security, Rate Limits, And Approval Skeleton

Goal:

- Prepare production safety boundaries before broad product rollout.

Files:

- Gateway policy/compiler files.
- Store/trace files.
- mswarm runtime files.

Tasks:

1. Add per-run and per-tenant limits:
   - max runtime
   - max model calls
   - max tool calls
   - max evidence items
   - max image artifacts
2. Add tool risk categories:
   - read-only
   - write with approval
   - destructive blocked
3. Keep writes disabled in production unless a product explicitly uses approval workflow.
4. Add approval skeleton types, but do not enable mutation tools by default.
5. Add prompt-injection hardening:
   - tool output is evidence, not instruction
   - Docdex/app tool results cannot change policy
   - final prompt names allowed evidence scope
6. Add tenant isolation checks in every tool dispatch path.

Acceptance:

- Prompt text cannot enable blocked tools.
- Tool output cannot mutate gateway policy.
- Tenant/repo scope cannot be overridden by model-generated args.
- Approval skeleton exists for future write tools without changing read-only behavior.

Validation:

- Security policy tests.
- Redaction tests.

## Phase 18: Release, Rollout, And Product Integration

Goal:

- Publish and roll out the production gateway safely.

Files:

- package manifests
- release docs
- product integration docs
- progress tracker

Tasks:

1. Run local validation:
   - focused package tests
   - gateway eval smoke
   - mswarm transport tests
   - live suku smoke
   - dry-run npm publish
2. Bump package versions.
3. Commit, tag, and push through CI/CD release workflow.
4. Confirm npm registry versions.
5. Provide product integration brief:
   - OKACAM
   - future products using generic contracts
6. Roll out behind feature flags:
   - local/staging
   - one internal tenant
   - Wodo/Heka shadow evaluation
   - tenant-by-tenant enablement
7. Keep fallback to existing `codali_job` or single-task path until production quality is proven.

Acceptance:

- Published packages install cleanly.
- Existing Codali/mswarm behavior remains backward compatible.
- Gateway path works with Docdex encrypted repos and mcoda agents.
- Product metadata stores run id, sources, tool calls, model tiers, warnings, and errors.

Validation:

- CI release success.
- npm view confirms versions.
- Product smoke tests pass.

## End-To-End Build Order

Recommended implementation order:

```text
0  Baseline audit
1  Contracts and schemas
2  Policy compiler
3  Agent tier resolver
4  Store abstraction
5  Router/planner
6  Worker executor
7  Evidence normalizer
8  Verification loop
9  Context packer
10 Final synthesizer
11 Docdex encrypted hardening
12 App tool gateway
13 mswarm transport
14 Suku live harness
15 Observability/replay
16 Evaluation suites
17 Security/rate limits/approval skeleton
18 Release/rollout
```

Do not start with product-specific OKACAM behavior. Build the generic gateway, then integrate OKACAM through runtime tool manifests and `codali_gateway`.

## Gateway Runtime State Machine

Target states:

```text
created
  -> policy_compiled
  -> agents_resolved
  -> classified
  -> planned
  -> workers_running
  -> evidence_normalized
  -> verified
  -> followup_planned
  -> context_packed
  -> final_synthesized
  -> succeeded
```

Failure states:

```text
failed_policy
failed_agent_resolution
failed_docdex_scope
failed_planning
failed_worker_required
failed_budget
failed_final_model
partial
needs_clarification
```

Every transition should emit a gateway event and write an auditable trace record.

## Testing Matrix

### Unit

- Schema validation.
- Policy compilation.
- Agent tier resolution.
- Store contract.
- Planner output repair.
- Worker task conversion.
- Evidence normalization.
- Verification loop.
- Context pack truncation.
- Final synthesizer tier enforcement.
- App tool gateway signature and scope checks.

### Integration

- Codali gateway with stub providers.
- Gateway -> `runCodaliJob`.
- Gateway -> dynamic app tool contracts.
- Gateway -> encrypted Docdex mock.
- mswarm `codali_gateway` payload normalization.
- OpenAI-compatible streaming metadata.

### Live Suku

- Inventory discovery.
- Small structured JSON classifier.
- Medium planner/verifier.
- Large final synthesizer.
- Image worker artifact generation.
- Timeout/fallback behavior.
- Latency and budget telemetry.

### Product Shadow

- Generic question with no unnecessary tools.
- Tenant Docdex search question.
- Disabled integration leakage question.
- Multi-source evidence question.
- Final answer directness.
- Assistant-message metadata persistence.

## Production Readiness Checklist

- [ ] Gateway API exported from `@mcoda/codali`.
- [ ] mswarm accepts `codali_gateway`.
- [ ] Policy compiler blocks shell/write/destructive behavior by default.
- [ ] Docdex encrypted repo context is immutable and required when configured.
- [ ] Agent resolver uses mcoda inventory without hardcoded model names.
- [ ] Small/medium stages produce schema-validated JSON.
- [ ] Final answer uses final/large tier when available.
- [ ] Evidence store persists normalized evidence and provenance.
- [ ] Context pack is curated and bounded.
- [ ] Tool calls, model calls, evidence, and context packs are traceable.
- [ ] Suku live model smoke passes.
- [ ] Image worker produces artifact metadata for image requests.
- [ ] Eval suite catches disabled-tool leakage and wrong final model tier.
- [ ] Redaction prevents credential leakage.
- [ ] Release dry-run passes.
- [ ] Published package versions are verified.

## Product Integration Contract

Products should call the gateway with:

- user query
- tenant/requester identity
- Docdex encrypted repo context when enabled
- allowed/denied tools
- app tool contracts
- app virtual tools
- optional signed app gateway
- mode and budget
- response policy

Products should store:

- `runId`
- final answer
- confidence
- sources
- evidence count
- tool call count
- called tools
- model tiers/agent slugs
- warnings/errors
- latency
- context pack id

Products should not:

- send raw credentials in prompt-visible payloads
- rely on keyword routing
- expose disabled tools to Codali
- let tenant users see other users' chat/run traces unless an explicit admin/audit feature exists

## Known Non-Goals For The First Production Release

- Fully autonomous write tools.
- Unbounded web browsing.
- Product-specific OKACAM logic inside Codali.
- Hardcoded suku model names.
- Replacing Docdex encrypted search with a separate RAG vendor.
- Replacing existing Codali runtime with LangGraph/CrewAI.
- Storing full raw worker transcripts as final evidence.

## First Three Implementation Sessions

Session 1:

- Phase 1: contracts and schemas.
- Add progress notes and focused tests.

Session 2:

- Phase 2: policy compiler.
- Include disabled-tool and Docdex operation tests.

Session 3:

- Phase 3: agent tier resolver.
- Include inventory fixtures and no-hardcoded-model tests.

After these sessions, the gateway has enough skeleton to implement planning, evidence, and final synthesis without reworking foundational contracts.
