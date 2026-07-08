# Codali Agentic Orchestration Gateway Product Integration Brief

Date: 2026-07-02
Release: 0.1.89
Audience: OKACAM and future product developers integrating through mcoda/mswarm.

## What Is Available

Codali now has a generic agentic orchestration gateway. Product apps can send a runtime request through mswarm using `execution_runtime: "codali"` and `codali_gateway` without Codali containing product-specific routing logic.

The gateway supports:

- runtime-provided read-only Docdex and app tool contracts;
- encrypted Docdex repo context and tenant scope;
- dynamic mcoda agent-tier selection for classifier, planner, workers, verifier, image worker, and final synthesizer;
- signed read-only app tool gateway dispatch;
- evidence normalization, context packing, verification, and final large-model synthesis;
- trace/replay, telemetry, and evaluation gates;
- strict safety limits for model calls, tool calls, runtime, evidence, and image artifacts.

## OKACAM Payload Mapping

OKACAM should keep sending:

- `execution_runtime: "codali"`;
- `docdex.tool_manifest.actualTools`;
- `docdex.tool_manifest.virtualTools`;
- `policy.allowed_tools`;
- `policy.denied_tools`;
- `policy.okacam_virtual_tools`;
- `policy.okacam_tool_contracts`;
- per-call `session.id`;
- read-only Docdex encrypted repo context and tenant scope.

For gateway mode, add or populate:

```json
{
  "execution_runtime": "codali",
  "codali_gateway": {
    "query": "<user message or normalized task>",
    "mode": "balanced",
    "policy": {
      "allowed_tools": ["docdex_search", "docdex_open", "app_tool_gateway"],
      "denied_tools": [],
      "max_tool_calls": 8,
      "max_model_calls": 8,
      "max_evidence_items": 24,
      "max_image_artifacts": 0,
      "allow_image_worker": false
    },
    "agent_policy": {
      "require_final_large_model": true,
      "allow_cloud_fallback": false,
      "allow_image_worker": false
    },
    "response": {
      "include_sources": true,
      "include_trace_summary": true
    }
  }
}
```

Use generic `policy.app_tool_contracts` for new products. OKACAM can continue using `policy.okacam_tool_contracts`; Codali normalizes them through the same generic compiler.

## Tool Contract Requirements

Each app tool contract must stay read-only for this release:

- `executionMode` should be `server_supplied_snapshot_plus_docdex` or a signed read-only direct gateway mode.
- `callSchema` must not allow tenant, repo, base URL, credential, token, or signing override fields.
- `backingTools` must be in the effective allowed-tools list.
- Current supported backing tools are primarily `docdex_search`, `docdex_batch_search`, and `docdex_open`, with optional `docdex_files`, `docdex_tree`, and `docdex_stats`.
- Direct `app_tool_gateway` calls must be signed by the product backend and explicitly read-only.

Disabled integrations such as SmartClick, GitHub, Jira, Microsoft, or any tenant-unavailable capability must be omitted from `allowed_tools` or included in `denied_tools`.

## Response Metadata To Store

Store the Codali/mswarm response metadata on the assistant message:

- gateway run id;
- runtime and mode;
- status and failure reason, if any;
- called tools and tool-call count;
- model tiers and model-call count;
- source count and selected sources;
- evidence count;
- warnings and errors;
- per-tool latency/status;
- trace or replay reference when returned.
- `feedback_submission`, which is the product-neutral submission contract for
  later human feedback or review ingestion;
- `codali_product_metadata`, which contains product-facing run id, trace id,
  context pack id, dataset collection status, local-only privacy flags, record
  counts, feedback ref, called tools, model tiers, warnings/errors, and latency.

`codali_product_metadata.dataset_collection` intentionally exposes status and
counts only. Products must not persist or depend on internal dataset routing ids
such as idempotency or batch ids from storage backends.

## Feedback Adapter Note

OKACAM should keep chat and feedback scoped by employee/user through hashed
requester and conversation fields on `codali_gateway.requester` and
`codali_gateway.conversation`. Store the assistant message metadata, keep
`feedback_submission.requester_scope.tenant_wide` false by default, and submit
later feedback with `feedback_submission` or
`codali_product_metadata.feedback_ref`. Core Codali/mswarm logic stays
product-neutral; OKACAM-specific naming belongs in the adapter layer only.

## Rollout Recommendation

1. Enable the gateway behind an OKACAM feature flag.
2. Start with local/staging traffic using read-only Docdex and snapshot-backed app tools.
3. Shadow one internal tenant and compare final answers, sources, disabled-tool leakage, latency, and cost.
4. Keep fallback to existing `codali_job` or single-task Codali paths until shadow quality is acceptable.
5. Enable tenant-by-tenant with telemetry review after each cohort.

## Current Safety Boundaries

- Writes remain disabled by default.
- Write-like tool contracts are classified and blocked unless a future explicit approval workflow enables them.
- Destructive tools are blocked.
- Tool output is treated as evidence only; it cannot mutate policy, tenant scope, allowed tools, budgets, credentials, or approvals.
- Tenant/repo scope is immutable for encrypted Docdex jobs.
