# Codali Multi-Stage Job Runtime Plan

Date: 2026-07-01
Status: Releasable mcoda/Codali runtime scope implemented and validated for `0.1.88`; downstream OKACAM/suku rollout phases remain
Scope: `packages/codali`, `packages/mswarm`, mcoda agent catalog/roles, OKACAM AI chat integration

## Goal

Build a reusable Codali job runtime for heavy, multi-layer AI work that should not be solved by one large model call.

The runtime must divide work into smaller jobs that can be handled by cheaper local/self-hosted mcoda agents, integration workers, native product tools, and a final stronger synthesis model. OKACAM tenant AI chat is the first consumer, but the runtime must be generic enough for future mcoda/mswarm consumers such as code review, business analytics, CRM reporting, Jira triage, document search, and other product workflows.

## Current Repo Truth

Existing pieces we should reuse:

- `packages/codali/src/runtime/CodaliRuntime.ts`
  - Already exposes `runCodaliTask` and `createCodaliRuntime`.
  - Supports `tool_loop`, `protocol_loop`, `smart_pipeline`, `patch_json`, and `freeform` policy modes.
  - Supports provider selection, Docdex tools, local runner metadata, sessions, streaming events, and subagents.

- `packages/codali/src/subagents/SubagentOrchestrator.ts`
  - Already handles bounded parallel subagent execution.
  - Enforces write-scope overlap rules.

- `packages/codali/src/agents/PhaseAgentSelector.ts`
  - Already selects agents by phase.
  - Should be extended or paralleled with reusable job-stage role selection.

- `packages/mswarm/src/codali-executor.ts`
  - Already maps mswarm jobs into Codali runtime input.
  - Already passes session/subagent options and Codali runtime policy.
  - Now supports optional `codaliJob` payloads and calls `runCodaliJob` when present.

- `packages/shared/src/llm/LocalRunnerConfig.ts`
  - Already supports local OpenAI-compatible runners and llama.cpp runner aliases.

- `scripts/publish-npm-packages.js`
  - Publishes core mcoda packages.
  - Publishes `@mcoda/codali` only when `MCODA_PUBLISH_CODALI=1`.
- `.github/workflows/release.yml`
  - Publishes on `v*` tags after package builds, tests, packaging guardrails, and tag-version checks.
  - Sets `MCODA_PUBLISH_CODALI=1`, so the user-approved tag route publishes `@mcoda/codali` even though local npm auth is unavailable.

Downstream validation blocker:

- On suku, non-interactive SSH could not find `mcoda` on `PATH`.
- Before using the newly added small llama.cpp agents for production runtime validation, make the mcoda executable path reliable for non-interactive service execution.

## Product Shape

Add a new reusable Codali job layer on top of the existing task runtime.

Target flow:

```text
Product request
  -> mcoda/mswarm agent and role inventory
  -> Codali multi-stage job runtime
    -> route
    -> plan
    -> collect evidence with parallel workers
    -> adjudicate evidence
    -> synthesize final answer/result
    -> verify
    -> optional repair
  -> product receives clean result plus debug metadata
```

OKACAM example:

```text
OKACAM AI chat question
  -> Codali job type: okacam.tenant_ai_chat
  -> small router model decides whether tenant evidence is needed
  -> planner creates tasks only for enabled tenant tools
  -> native/integration workers gather evidence cards
  -> final model answers the actual question
  -> verifier checks relevance and disabled-integration leakage
```

## Package Responsibilities

### mcoda

mcoda owns agent inventory and role mapping.

Required capabilities:

- List local/self-hosted agents with health, cost, context, JSON reliability, tool support, and latency.
- Assign agent roles:
  - `router`
  - `planner`
  - `query_expander`
  - `worker`
  - `adjudicator`
  - `synthesizer`
  - `verifier`
  - `repair`
- Prefer small local llama.cpp/OpenAI-compatible agents for router/planner/verifier stages.
- Prefer stronger models only for synthesis or hard reasoning.
- Expose role metadata to Codali and mswarm.

### Codali

Codali owns the generic job runtime.

Required capabilities:

- Strict stage DAG execution. Implemented in `packages/codali/src/runtime/CodaliJobRuntime.ts`.
- Sequential and parallel stages. Implemented with bounded ready-stage waves.
- Per-stage agent selection. Implemented through request-provided stage/default agent and provider policy keyed by stage id, stage role, or stage kind; persisted mcoda catalog role discovery remains pending.
- Per-stage response schema forwarding. Implemented for JSON schema response mode; deterministic schema validation remains pending.
- Per-stage timeouts and budgets. Timeouts plus aggregate/per-stage tool budgets are implemented; retry policy remains basic and `maxRetries` is not implemented yet.
- Tool manifest enforcement. Reuses existing `runCodaliTask` policy/tool enforcement per stage.
- Evidence card contract. Implemented as normalized evidence arrays from stage JSON output.
- Streaming progress events. Implemented through job/stage/runtime events.
- Debug traces and metadata. Implemented through `CodaliJobTelemetry`.
- One bounded follow-up/repair loop. Implemented for verifier failures when budget remains.
- Product-agnostic APIs and types. Implemented and exported from `@mcoda/codali`.

### mswarm

mswarm owns remote/self-hosted transport.

Required capabilities:

- Accept Codali job payloads from hosted products. Implemented as `codali_job` on self-hosted invocation jobs.
- Route jobs to the selected self-hosted node.
- Preserve tenant/client identity and invocation metadata.
- Stream stage progress and final output back through OpenAI-compatible responses when needed. Stage progress is now forwarded as progress events; final output remains OpenAI-compatible.
- Keep existing single-agent Codali execution backward compatible. Existing `runCodaliTask` path remains the default when `codali_job` is absent.

### Product Consumers

Product consumers own domain tools and permissions.

For OKACAM:

- Tenant capability manifest.
- Native OKACAM workers.
- Integration workers.
- Viewer permission checks.
- AI chat metadata persistence.
- Admin/debug UI for traces.

## Core Contracts

### Codali Job Request

```ts
export interface CodaliJobRequest {
  jobId?: string;
  jobType: string;
  input: Record<string, unknown>;
  context?: Record<string, unknown>;
  tenant?: {
    id?: string;
    slug?: string;
    realm?: string;
  };
  requester?: {
    id?: string;
    email?: string;
    role?: string;
  };
  tools: CodaliToolManifest[];
  stages?: CodaliJobStageDefinition[];
  budgets: CodaliJobBudgets;
  agentPolicy?: CodaliJobAgentPolicy;
  response?: CodaliJobResponsePolicy;
  metadata?: Record<string, unknown>;
}
```

### Stage Definition

```ts
export type CodaliJobStageKind =
  | "router"
  | "planner"
  | "worker"
  | "adjudicator"
  | "synthesizer"
  | "verifier"
  | "repair";

export interface CodaliJobStageDefinition {
  id: string;
  kind: CodaliJobStageKind;
  role?: string;
  title?: string;
  goal?: string;
  prompt?: string;
  dependsOn?: string[];
  optional?: boolean;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  mode?: CodaliRuntimePolicy["mode"];
  agent?: CodaliRuntimeAgentInput;
  provider?: CodaliRuntimeProviderInput;
  response?: CodaliRuntimeInput["response"];
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}
```

### Tool Manifest

```ts
export interface CodaliToolManifest {
  name: string;
  group: string;
  description: string;
  enabled: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  permissions?: string[];
  usageGuide?: string;
  metadata?: Record<string, unknown>;
}
```

Disabled tools must be removed before model-visible prompts are created.

### Runtime-Provided Tool Contracts

The first implementation slice should bridge the current single-task Codali runtime to product-provided tool contracts before the full multi-stage job runtime lands.

Products can pass runtime tool contracts in the existing mswarm chat payload. Codali must consume these contracts generically and expose them as model-callable, read-only tools for the active run. OKACAM is the first consumer, but the runtime shape must not depend on OKACAM business logic.

Current OKACAM payload fields:

- `execution_runtime: "codali"`.
- `docdex.tool_manifest.actualTools`.
- `docdex.tool_manifest.virtualTools`.
- `policy.allowed_tools`.
- `policy.denied_tools`.
- `policy.okacam_virtual_tools`.
- `policy.okacam_tool_contracts`.
- Per-call `session.id`.
- Read-only Docdex context and tenant repo scope.

Generic aliases to support at the same boundary:

- `policy.app_tool_contracts`.
- `policy.app_virtual_tools`.
- `policy.app_tool_gateway`.

Each contract is keyed by the model-visible tool name and can include:

```ts
export interface CodaliRuntimeAppToolContract {
  executionMode: "server_supplied_snapshot_plus_docdex" | "app_tool_gateway" | string;
  callSchema: Record<string, unknown>;
  resultContract?: string;
  resultSources?: string[];
  backingTools?: string[];
  sourcePaths?: string[];
  sourceTypes?: string[];
  suppliedSnapshots?: string[];
  gateway?: {
    endpoint?: string;
    readOnly?: boolean;
    signatureRequired?: boolean;
  };
  metadata?: Record<string, unknown>;
}
```

Registration rules:

- Register only tools named by the manifest/contract set and allowed by `policy.allowed_tools`.
- Never register tools named by `policy.denied_tools`.
- Keep backing tools internal unless they are also explicitly allowed by policy.
- Reject contracts that require shell/write/destructive access when those runtime flags are disabled.
- Reject cross-tenant override arguments such as repo ids, repo roots, tenant ids, credentials, or base URLs.
- Enforce `policy.max_tool_calls` through the existing Codali runtime budget.

For current OKACAM contracts, dynamic virtual tools execute through declared read-only Docdex backing tools:

- `docdex_search`.
- `docdex_batch_search`.
- `docdex_open`.
- `docdex_files`.
- `docdex_tree`.
- `docdex_stats`.

The future direct gateway shape should reuse the same contract model. A read-only `app_tool_gateway` dispatcher call must include tenant scope, tool name, validated args, session/run id, and signature metadata, and it must reuse the same `callSchema`, `resultContract`, and tenant capability guards.

Runtime telemetry returned to mswarm/Codali callers should include:

- `run_id`.
- Runtime/mode.
- Tool call count.
- Called tools.
- Dynamic tools considered/registered/skipped.
- Warnings/errors.
- Per-tool latency and status.
- Metadata safe for OKACAM assistant-message storage.

### Evidence Card

```ts
export interface CodaliEvidenceCard {
  id: string;
  sourceType: string;
  title: string;
  summary: string;
  records?: unknown[];
  provenance?: unknown[];
  freshness?: string;
  confidence: number;
  gaps?: string[];
  metadata?: Record<string, unknown>;
}
```

### Job Result

```ts
export interface CodaliJobResult {
  jobId: string;
  status: "succeeded" | "failed" | "partial" | "needs_clarification";
  output: unknown;
  evidence?: CodaliEvidenceCard[];
  stageResults: CodaliJobStageResult[];
  verifier?: CodaliVerifierResult;
  usage?: Record<string, unknown>;
  timingsMs: Record<string, number>;
  metadata?: Record<string, unknown>;
}
```

## Stage Semantics

### 1. Router

Purpose:

- Decide whether the job needs external evidence or can be answered directly.
- Choose the broad tool groups.
- Return strict JSON.

Preferred agent:

- Small local llama.cpp/OpenAI-compatible model.

Example output:

```json
{
  "requestType": "direct_answer",
  "needsEvidence": false,
  "toolGroups": [],
  "confidence": 0.91,
  "clarifyingQuestion": null
}
```

### 2. Planner

Purpose:

- Convert the router decision into small tool tasks.
- Use only enabled tools.
- Return task JSON, not prose.

Preferred agent:

- Small local model with reliable JSON.

### 3. Worker Stages

Purpose:

- Execute product/native/integration tools.
- Return evidence cards, not final answers.

Worker types:

- Pure function worker.
- HTTP/API worker.
- Codali subagent worker.
- Docdex worker.
- Product-provided worker.

Workers should run in parallel where dependencies allow it.

### 4. Adjudicator

Purpose:

- Merge evidence.
- Dedupe records.
- Rank relevance.
- Identify contradictions and gaps.
- Decide whether one follow-up loop is needed.

Preferred agent:

- Small local model plus deterministic ranking helpers.

### 5. Synthesizer

Purpose:

- Produce the final user-facing answer/result.
- Receive only selected evidence and explicit output rules.

Preferred agent:

- Stronger model.

Rules:

- Answer the actual question.
- Do not reveal internal research by default.
- Do not include irrelevant sections.
- Do not cite disabled integrations.

### 6. Verifier

Purpose:

- Check answer quality before returning it.

Checks:

- Relevance to user question.
- Unsupported claims.
- Disabled tool leakage.
- Missing caveats.
- Schema validity.
- Whether clarification is required.

Preferred agent:

- Small local verifier model.

### 7. Repair

Purpose:

- Run one bounded correction pass when verifier fails.

Rules:

- No unlimited loops.
- If repair fails, return a clear fallback or clarifying question.

## Agent Role Selection

Add role-aware selection on top of current phase selection.

Current `0.1.88` release scope:

- Codali job stages can carry `role`.
- `agentPolicy.stageAgents` and `agentPolicy.stageProviders` resolve in this order: exact stage id, stage role, stage kind, default policy, runtime default.
- mswarm preserves `role` separately from `kind` when normalizing `codali_job.stages`, so products can choose a stage kind such as `worker` while assigning a role such as `evidence_collector`.

Remaining mcoda catalog scope:

Candidate metadata:

- `role`: router, planner, query_expander, worker, adjudicator, synthesizer, verifier, repair.
- `jsonReliability`: numeric score.
- `latencyP50Ms`, `latencyP95Ms`.
- `contextWindow`.
- `maxOutputTokens`.
- `supportsJsonSchema`.
- `supportsTools`.
- `costPerMillion`.
- `healthStatus`.
- `source`: local, self_hosted, cloud, hosted.

Selection rules:

- Router/planner/verifier prefer healthy local/self-hosted small agents with high JSON reliability.
- Synthesizer prefers the configured high-quality model.
- Workers use deterministic tools first; use model workers only when needed.
- Paid/cloud fallback requires explicit policy permission.

## mcoda CLI And SDK Additions

Potential CLI:

```sh
mcoda agent role set <agent-slug> router --json-reliability 0.9
mcoda agent role set <agent-slug> planner --json-reliability 0.85
mcoda agent role list
mcoda job run --type okacam.tenant_ai_chat --input input.json
mcoda job trace <job-id>
```

Potential SDK:

```ts
const result = await runCodaliJob({
  jobType: "okacam.tenant_ai_chat",
  input,
  tools,
  budgets,
  agentPolicy
});
```

## mswarm Payload Extension

Keep current `execution_runtime: "codali"` compatible.

Add an optional job block:

```json
{
  "execution_runtime": "codali",
  "codali_job": {
    "job_type": "okacam.tenant_ai_chat",
    "stages": ["router", "planner", "workers", "adjudicator", "synthesizer", "verifier"],
    "tools": [],
    "budgets": {
      "max_runtime_ms": 90000,
      "max_tool_calls": 20,
      "max_followups": 1
    }
  }
}
```

If `codali_job` is absent, current single-task Codali behavior remains unchanged.

## OKACAM Integration

OKACAM should call the new Codali job runtime for AI chat behind a feature flag.

OKACAM provides:

- Tenant capability manifest.
- Viewer permissions.
- Native tool manifests:
  - daily logs
  - business files
  - log attachments
  - employee profiles
  - line items
  - hours
  - ratings
  - badges/rewards
- Integration tool manifests:
  - Microsoft
  - GitHub
  - Jira
  - SmartClick CRM
- Usage guides for each tool group.
- Evidence card adapters for each worker.

OKACAM stores:

- Router result.
- Planner tasks.
- Tool calls.
- Evidence card counts.
- Stage timings.
- Verifier result.
- Final answer metadata.

User-visible answer remains clean.

## Suku Small-Agent Validation

First validation work:

1. Make `mcoda` available in non-interactive suku SSH/service PATH, or record its absolute executable path.
2. Run `mcoda agent list --json --refresh-health` on suku and identify the small llama.cpp candidates.
3. Select initial roles:
   - router
   - planner
   - verifier
4. Run strict-JSON smoke tasks:
   - generic coding question routes to direct answer.
   - OKACAM manager blocker question routes to native evidence.
   - Wodo SmartClick question refuses CRM routing when SmartClick is disabled.
5. Measure latency and JSON validity.
6. Store selected role mapping in mcoda config or system settings.

## Implementation Phases

### Phase 1: Planning And Contracts

- Add this plan and progress tracker.
- Define TypeScript contracts in `packages/codali`.
- Add unit tests for schema validation and disabled-tool filtering.
- Export types from `@mcoda/codali`.
- Implement the runtime-provided tool-contract bridge in the existing single-task Codali runtime:
  - Parse `docdex.tool_manifest` plus generic `policy.app_tool_contracts`.
  - Preserve OKACAM compatibility through `policy.okacam_tool_contracts` and `policy.okacam_virtual_tools`.
  - Register read-only dynamic virtual tools for the active run.
  - Execute current virtual tools through read-only Docdex backing tools.
  - Surface dynamic tool telemetry through Codali and mswarm metadata.

### Phase 2: Agent Role Inventory

- Add persisted role metadata in mcoda agent catalog.
- Add catalog-backed role selection helpers.
- Add CLI/SDK helpers for role assignment and listing.
- Validate suku small agents and role mapping.

### Phase 3: Codali Job Runtime

- Add `runCodaliJob`.
- Implement stage DAG execution.
- Support sequential and parallel stages.
- Add stage event streaming.
- Add budget enforcement and one repair/follow-up loop.

### Phase 4: Worker Adapter Layer

- Add worker interfaces.
- Add deterministic worker support.
- Add model-worker support using existing Codali task runtime.
- Add evidence card helpers.

### Phase 5: mswarm Transport

- Extend `packages/mswarm` Codali executor to accept `codali_job`.
- Preserve backward compatibility.
- Stream stage progress through current OpenAI-compatible output where possible.
- Add tests for self-hosted relay payload mapping.

### Phase 6: OKACAM AI Chat Integration

- Update OKACAM AI chat to call Codali job runtime behind feature flag.
- Convert native/integration searches into worker adapters.
- Store job metadata.
- Keep old path as fallback until quality is verified.

### Phase 7: Evaluation Harness

- Build Wodo/Heka test matrix:
  - generic questions
  - manager/team lead questions
  - project status
  - employee status
  - file lookup
  - report generation
  - Microsoft communications
  - GitHub/Jira
  - SmartClick CRM for enabled tenants
  - disabled-integration leakage
- Record answer, route, evidence, timings, verifier result, and pass/fail.

### Phase 8: Package Publish And Rollout

- Version bump affected packages to `0.1.88`.
- Run focused mcoda validation and npm dry-run validation.
- Publish packages by committing, tagging `v0.1.88`, and pushing the tag; CI/CD runs with `MCODA_PUBLISH_CODALI=1`.
- Update OKACAM dependencies.
- Deploy OKACAM behind feature flag.
- Shadow-test on Wodo and Heka.
- Enable tenant by tenant after pass criteria are met.

## Validation Checklist

- `packages/codali` tests pass.
- `packages/mswarm` tests pass.
- Full mcoda test suite passes.
- Suku small-agent strict JSON smoke passes.
- mswarm self-hosted relay accepts `codali_job`.
- OKACAM AI chat generic question performs no tenant evidence work.
- Wodo disabled SmartClick leakage test passes.
- Manager questions use relevant evidence cards.
- Verifier catches irrelevant forced sections.
- Published package versions install cleanly in OKACAM.

## Success Criteria

- Heavy AI jobs are decomposed into smaller reliable stages.
- Small llama.cpp agents handle routing, planning, adjudication, and verification.
- Strong models are reserved for final synthesis.
- Products can bring their own tools without Codali knowing product business logic.
- Disabled tools are invisible to planner and final model.
- Final answers are cleaner and more correct than single-call answers.
- The same Codali job runtime can be reused by future mcoda/mswarm consumers.
