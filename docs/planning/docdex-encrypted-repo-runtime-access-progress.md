# Docdex Encrypted Repo Runtime Access Progress

## Scope

Execution log for implementing `docs/planning/docdex-encrypted-repo-runtime-access-plan.md`.

Goal: let self-hosted mcoda/Codali jobs use job-supplied Docdex runtime context for encrypted repositories, authenticate with the attached mswarm API key, enforce allowed operations, and keep secrets out of logs, transcripts, and metadata.

## Progress

- [x] Loaded Docdex profile and repo memory before changes.
- [x] Reviewed `docs/planning/docdex-encrypted-repo-runtime-access-plan.md`.
- [x] Confirmed repo binding and index health with Docdex.
- [x] Mapped current implementation points:
  - `packages/codali/src/docdex/DocdexClient.ts`
  - `packages/codali/src/tools/docdex/DocdexTools.ts`
  - `packages/codali/src/runtime/CodaliRuntime.ts`
  - `packages/mswarm/src/codali-executor.ts`
  - `packages/mswarm/src/runtime.ts`
- [x] Ran Docdex impact graph checks for the main runtime files. Docdex reported no inbound/outbound dependency edges for those files.
- [x] Confirmed current Codali/mswarm flow:
  - `provider=mcoda` self-hosted jobs route through `MswarmCodaliExecutor`.
  - Codali creates a `DocdexClient` and exposes Docdex tools through `createDocdexTools`.
  - Tool policy already filters web, memory writes, profile writes, and index rebuilds, but not encrypted-repo operations.
- [x] Add Docdex runtime context fields and attached-key support.
- [x] Add allowed-operation/capability enforcement and stable error mapping.
- [x] Wire mswarm self-hosted jobs into Codali runtime without serializing raw API keys.
- [x] Add tests for auth headers, redaction, operation gates, and mswarm job mapping.
- [x] Fixed review misalignment: `attached_mswarm_api_key` is no longer read from local mcoda model/provider agent config.
- [x] Added direct self-hosted node attached-key header handoff.
- [x] Added `chat_context` runtime operation and `docdex_chat_context` tool.
- [x] Added managed mswarm OpenAI-compatible adapter Docdex context pass-through while keeping ordinary OpenAI agents unchanged.
- [x] Bumped release package versions from `0.1.60` to `0.1.61`.
- [x] Run targeted package tests.
- [x] Run Docdex package/repo validation.

## Implementation Notes

- `DocdexClient` now accepts `apiKey`, `credentialSource`, `required`, `allowedOperations`, and runtime `capabilities`.
- Attached mswarm credentials are sent to Docdex as `x-api-key`; when an API key is present it takes precedence over bearer `authToken` for Docdex runtime calls.
- `DocdexClient.chatContext()` posts to `/v1/chat/completions` with runtime headers and is exposed as `docdex_chat_context`.
- Runtime operation gates fail before network access with stable Docdex codes where possible.
- mswarm self-hosted jobs keep the API key out of serialized job context and pass it as `attachedMswarmApiKey` only when `credential_source` is `attached_mswarm_api_key`.
- `attachedMswarmApiKey` is accepted from execution options/direct-node headers, not from selected agent provider config.
- mswarm jobs with no Docdex context now pass `docdex.enabled = false` into Codali so self-hosted jobs do not expose Docdex tools unless the gateway supplied a Docdex block.
- Managed mswarm `openai-api` agents add a `docdex` runtime block to the OpenAI-compatible request body only when the agent config is marked `mswarmCloud` or `mswarmSelfHosted`.

## Test Evidence

- `pnpm --filter @mcoda/codali test` passed after chat-context and key-precedence changes.
- `pnpm --filter @mcoda/mswarm test` passed after the corrected attached-key runtime/header path.
- `pnpm --filter @mcoda/agents test` passed after managed mswarm OpenAI-compatible Docdex context pass-through.
- `pnpm -r build` passed after the `0.1.61` version bump.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda` passed after the `0.1.61` version bump.
- Added a Codali runtime mocked-search test that verifies `x-api-key`, `x-docdex-repo-id`, immutable runtime `repo_id`, and no raw API key in the runtime result.
- Added mswarm executor coverage for `docdex.enabled = false` when a self-hosted job lacks a Docdex context block.
- Added OpenAI adapter coverage proving managed mswarm Docdex context is sent without leaking the mswarm key and non-mswarm OpenAI agents ignore Docdex metadata.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/codali` passed before the final mocked-search addition; the subsequent full repo run covered the final test set.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda --target packages/mswarm` passed.
- `docdexd run-tests --repo /Users/bekirdag/Documents/apps/mcoda` passed in the final state.
- `docdexd impact-diagnostics` reported no diagnostics for the main changed runtime files.
- `git diff --check` passed.

## Notes

- Existing local Docdex behavior must remain the default when no encrypted repo runtime context is supplied.
- Runtime Docdex access must use job context as the source of truth. Prompt text must not override `base_url`, `repo_id`, or allowed operations.
- Raw API keys must not be logged, returned in metadata, or written to transcripts.
- The worktree already contained unrelated `.claude/` files before this implementation; they are left untouched.
