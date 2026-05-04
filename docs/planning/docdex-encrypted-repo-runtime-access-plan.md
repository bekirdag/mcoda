# Docdex Encrypted Repository Runtime Access Plan

Status: implemented in mcoda 0.1.61 candidate; release/rollout pending
Owner repo: `mcoda`
Source reference: `/Users/bekirdag/Documents/apps/docdex/docs/planning/mswarm-docdex-encrypted-repo-access-implementation-plan.md`

## Implementation Review - 2026-05-03

Compared against the current codebase, the original plan is now aligned for the
mcoda-owned runtime surfaces:

- Completed: Docdex job-context types exist in the self-hosted mswarm runtime
  and Codali executor input.
- Completed: Codali's Docdex client sends `x-api-key`, `x-docdex-repo-id`,
  `x-docdex-repo-root`, and DAG session headers for HTTP and MCP calls.
- Completed: `x-api-key` takes precedence over bearer auth for Docdex runtime
  calls.
- Completed: client-side allowed-operation/capability gates cover search,
  snippet/open, MCP-backed tools, delegation, hooks, and `chat_context`.
- Completed: stable Docdex runtime error codes are preserved through Codali tool
  results and mswarm self-hosted job failures.
- Completed: self-hosted encrypted Docdex keys now come from an invocation
  envelope/header path, not from local model/provider agent config.
- Completed: direct self-hosted node jobs can receive the attached key through
  `x-mswarm-attached-api-key` or `x-attached-mswarm-api-key`; outbound/polled
  jobs fail clearly when a required attached key is not provided by the
  execution environment.
- Completed: managed mswarm OpenAI-compatible agents forward Docdex runtime
  context in the request body only for managed mswarm agents; ordinary OpenAI
  agents ignore Docdex metadata.
- Completed: jobs without a Docdex context disable Docdex tools instead of
  exposing local default Docdex access.
- Misalignment fixed: the earlier implementation treated a selected local
  mcoda agent `apiKey` as the attached mswarm API key. That is now rejected by
  construction.
- Missing part fixed: optional `chatContext(messages)` is now exposed as
  `docdex_chat_context` and guarded by the `chat_context` operation.

Remaining external dependency: mswarm/saas_be must attach the owner key to
self-hosted direct execution headers or an equivalent secure envelope for
required encrypted Docdex jobs. mcoda intentionally does not serialize that key
inside job JSON.

## Current Cross-System Context

Docdex now has the first-phase encrypted-repository auth gates for search,
snippet, chat context, and MCP. saas_be now provides stable API-key
introspection claims, scopes, usage meters, and cache invalidation. mswarm now
implements the encrypted-search provisioning module and exposes immutable
Docdex runtime context for ready encrypted repositories. mcoda 0.1.61 candidate
now consumes that context and uses the attached mswarm API key for Docdex calls.

Current Docdex runtime contract for mcoda:

- send the attached mswarm API key as `x-api-key`;
- send the immutable repository id as `x-docdex-repo-id`;
- prefer `x-api-key` over `Authorization: Bearer` for runtime keys so service
  tokens and static Docdex tokens remain clearly separated from agent data-plane
  auth;
- handle Docdex auth errors as stable operational failures:
  `missing_credentials`, `ambiguous_credentials`, `invalid_credentials`,
  `introspection_unavailable`, `repo_access_denied`, `scope_denied`, and
  `encrypted_operation_disabled`;
- do not attempt to bypass Docdex repo bindings locally. mcoda's allowed
  operations check is only a client-side safety guard.

The job context remains the source of truth for `base_url`, `repo_id`, and
allowed operations. Prompt text must never override those fields.

The saas_be authority is no longer a design blocker; Docdex auth failures should
be surfaced as runtime operational failures with the stable error codes above.
The mswarm runtime context is no longer a design blocker either; mcoda should
treat missing context as "feature not enabled" and invalid context as a clear
job configuration failure.

## Purpose

This is the mcoda-owned plan for letting agents use Docdex encrypted repository
access at runtime. mcoda agents already receive an mswarm API key. For Docdex,
that same attached API key should be sent as `x-api-key` to the dedicated Docdex
server, together with the Docdex repository id supplied by mswarm job context.

mcoda should not receive a separate Docdex bearer token, should not manage
Docdex encryption keys, and should not write raw API keys into logs or
transcripts.

## Boundary

mcoda owns:

- receiving Docdex runtime context in jobs,
- exposing Docdex HTTP/MCP helpers to agents,
- sending attached mswarm API key to Docdex as `x-api-key`,
- redacting credentials from logs and artifacts,
- clear failure behavior when Docdex is required but no API key exists,
- self-hosted and managed-agent parity for the same job contract.

mcoda does not own:

- API-key issuance,
- Docdex repository access policy,
- Docdex encryption keys,
- mswarm feature setup,
- source-system export.

## Compatibility Review Fixes

mcoda already stores the mswarm API key encrypted and uses it for mswarm access.
Docdex runtime access must reuse that existing credential path without changing
current setup, install, or self-hosted node behavior.

Non-breaking rules:

- do not require users to run a new setup command if they already have a valid
  mswarm API key configured,
- do not persist Docdex base URL or repo id into global mcoda config unless the
  user explicitly configures a standalone Docdex integration,
- do not include the raw API key in mswarm job JSON,
- do not change existing `MswarmApi` default base URL or timeout behavior for
  non-Docdex calls,
- do not enable Docdex tools for jobs that lack a Docdex context block,
- do not let prompt text override the repo id supplied by mswarm runtime
  context.

Rollout gates:

1. Add Docdex job-context types with no runtime behavior change.
2. Add a disabled-by-default Docdex client helper.
3. Enable helper only when a job context includes `docdex.required` or allowed
   operations.
4. Add self-hosted runtime smoke tests before enabling managed-agent parity.

## Job Context Contract

mswarm should inject a Docdex block into jobs that need encrypted repository
access.

Expected shape:

```json
{
  "docdex": {
    "base_url": "https://docdex.example",
    "repo_id": "docdex-repo-id",
    "required": true,
    "allowed_operations": ["search", "snippet"],
    "credential_source": "attached_mswarm_api_key",
    "capabilities": {
      "search": true,
      "snippet": true,
      "open": false,
      "chat_context": false
    }
  }
}
```

Rules:

- `base_url` and `repo_id` must come from mswarm feature state.
- the agent runtime must not override `repo_id` from prompt text.
- `credential_source` must be `attached_mswarm_api_key` for this flow.
- `required: true` means missing API key or unreachable Docdex fails the job
  clearly.
- `required: false` means tools can degrade gracefully.
- the Docdex context block must be treated as immutable runtime metadata.

## Runtime Auth Behavior

For Docdex REST calls:

```http
GET /search?q=...&limit=...
x-api-key: <attached-mswarm-api-key>
x-docdex-repo-id: <docdex-repo-id>
```

For Docdex MCP-over-HTTP:

- use the same Docdex base URL,
- send `x-api-key` on HTTP transport requests,
- include repository context using Docdex-supported header or request fields,
- expose only allowed operations from the job context.

For OpenAI-compatible chat calls:

- send `x-api-key`,
- include repo id in the Docdex-specific context field or header,
- do not inject encrypted repository context locally in mcoda.

## Tooling Surface

Add or extend a Docdex client/helper that supports:

- `search(query, limit)`,
- `snippet(doc_id, window)`,
- optional `open(path)` only when job context allows `open`,
- optional `chatContext(messages)` only when job context allows `chat_context`,
- MCP client initialization if the existing agent tool layer supports MCP.

The helper should:

- read attached mswarm API key from the existing secure runtime path,
- add `x-api-key` and `x-docdex-repo-id`,
- enforce allowed operations client-side before calling Docdex,
- normalize Docdex auth errors into actionable agent errors,
- redact all credentials from errors.

## Logic And Design Corrections

- mcoda should not create a second Docdex credential store. The attached mswarm
  API key is the runtime credential.
- For self-hosted nodes, the key should be decrypted once per job/session and
  held only in memory, not decrypted from disk for every Docdex tool call.
- For managed agents, the runtime must obtain the attached key from the secure
  mswarm execution environment, not from prompt-visible job payloads.
- mcoda should enforce allowed operations as a local safety check, but Docdex
  remains the enforcement authority.
- Usage metering should come from Docdex or saas_be. mcoda should log request
  ids and stable error codes, not attempt separate billable usage accounting.

## Performance Guardrails

- Reuse HTTP clients/connections for multiple Docdex tool calls in one job.
- Apply short connect/read timeouts and a total per-job Docdex budget.
- Cache Docdex capabilities per job context with a short TTL.
- Avoid repeated encrypted-config reads inside tight tool loops.
- Cap response sizes before adding Docdex results to agent context.
- Add circuit-breaker behavior so repeated Docdex failures do not stall the
  whole agent run when Docdex is optional.
- Redact credentials before retry logging or structured error serialization.

## Failure Modes

Stable mcoda-side failures:

- `docdex_context_missing`: job requires Docdex but no Docdex block exists.
- `docdex_api_key_missing`: job requires Docdex but no mswarm API key is attached.
- `docdex_operation_not_allowed`: prompt/tool asks for an operation outside job
  context.
- `docdex_auth_failed`: Docdex rejected the attached API key.
- `docdex_repo_access_denied`: Docdex denied repository access.
- `docdex_unavailable`: Docdex base URL is unreachable or times out.

Behavior:

- required Docdex access should fail the job with a clear message,
- optional Docdex access should return a degraded tool result,
- raw credentials must not appear in thrown errors, logs, telemetry, or
  transcript artifacts.

## Logging And Redaction

Redact:

- `x-api-key`,
- `authorization`,
- raw job secret payloads,
- Docdex service tokens if ever present by mistake,
- query text when the job policy marks it sensitive.

Safe to log:

- Docdex base URL host,
- Docdex repo id,
- operation,
- result status,
- stable error code,
- request id,
- API key fingerprint only if already safe and available.

## Likely Target Files

Validate exact paths before coding:

- `packages/core/src/api/MswarmApi.ts`
- `packages/mswarm/src/runtime.ts`
- `packages/mswarm/src/codali-executor.ts`
- `packages/codali/*`
- agent job payload/type definitions
- runtime logging/redaction helpers
- CLI and runtime tests for job payloads and header propagation

## Implementation Slices

1. Done: add Docdex job-context types.
2. Done: add Docdex client helper that uses the attached mswarm API key.
3. Done: wire Docdex context into agent runtime and Codali tool context.
4. Done: enforce allowed operations from job context.
5. Done: add MCP-over-HTTP/runtime tool support where the current tool layer can
   expose Docdex MCP-backed tools.
6. Done: add credential redaction tests for runtime logs and artifacts.
7. Done: add self-hosted and managed-agent smoke tests with mocked Docdex
   responses.

Validation evidence is recorded in
`docs/planning/docdex-encrypted-repo-runtime-access-progress.md`.

## Test Plan

Unit tests:

- Docdex client sends `x-api-key`.
- Docdex client sends `x-docdex-repo-id`.
- missing attached API key returns `docdex_api_key_missing`.
- disallowed operation returns `docdex_operation_not_allowed`.
- Docdex auth failures normalize to stable codes.
- raw API key is redacted from errors and logs.

Integration tests:

- job with Docdex context can call mocked Docdex search.
- job without Docdex context fails only when Docdex is required.
- self-hosted agent runtime receives the same Docdex context as managed agents.
- Codali executor propagates Docdex context to tools.
- prompt text cannot override the repo id.

Security tests:

- serialized job artifacts do not contain raw API keys,
- transcript artifacts do not contain raw API keys,
- debug logging still redacts credentials.

## Acceptance Criteria

- mcoda agents can call Docdex with the attached mswarm API key and the repo id
  supplied by mswarm.
- mcoda does not require a separate Docdex runtime secret.
- required Docdex jobs fail clearly when context or credentials are missing.
- allowed operations are enforced locally before tool calls and remotely by
  Docdex.
- logs, errors, and transcripts do not leak raw API keys.
