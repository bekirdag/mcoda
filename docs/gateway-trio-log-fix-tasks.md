# Tasks: Fix Gateway-Trio Issues from logs/1.txt

## Task 1
- **Slug**: gw-prompt-sanitize
- **Title**: Sanitize gateway agent prompt and clarify docdex usage
- **Priority**: P0
- **Description**:
  - Filter out gateway agent job/character prompts that contain routing-only schema instructions (e.g., “routing gateway”, “choose a route”), so the gateway agent receives a single schema.
  - Update `prompts/gateway-agent.md` to clarify that docdex context is injected by mcoda and the agent must not claim to have executed docdex queries; it should only summarize provided context and list any missing docdex gaps in `docdexNotes`.
- **Files to touch**:
  - `packages/core/src/services/agents/GatewayAgentService.ts`
  - `prompts/gateway-agent.md`
  - `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts`
- **Dependencies**: None
- **Unit tests**:
  - Add a test that captures the gateway prompt and asserts routing-only prompt text is excluded.
- **Component tests**: Not applicable
- **Integration tests**: Not applicable
- **API tests**: Not applicable
- **Acceptance criteria**:
  - Gateway prompt no longer contains routing-only schema text.
  - `prompts/gateway-agent.md` explicitly states docdex context is pre-fetched and prevents claims of direct queries.
  - New unit test passes.

## Task 2
- **Slug**: work-prompt-no-plan
- **Title**: Remove work-on-tasks prompt contradiction
- **Priority**: P0
- **Description**:
  - Remove the “Provide a concise plan…” instruction from `WorkOnTasksService.buildPrompt` to align with strict patch-only output requirements.
- **Files to touch**:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- **Dependencies**: None
- **Unit tests**:
  - Add a test that asserts the task prompt does not contain the “Provide a concise plan” instruction.
- **Component tests**: Not applicable
- **Integration tests**: Not applicable
- **API tests**: Not applicable
- **Acceptance criteria**:
  - Work-on-tasks prompt contains only patch/file output requirements (no plan instruction).
  - Unit test passes.

## Task 3
- **Slug**: work-docdex-link-resolve
- **Title**: Resolve docdex doc_links by path
- **Priority**: P1
- **Description**:
  - Enhance `gatherDocContext` to detect `docdex:`/`doc:` prefixed links and use `findDocumentByPath` first.
  - Fall back to `fetchDocumentById` when path lookup fails.
  - Emit warnings when a link cannot be resolved.
- **Files to touch**:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- **Dependencies**: None
- **Unit tests**:
  - Add a test that provides a `docdex:docs/...` link and confirms `findDocumentByPath` is called and content is included in summary.
- **Component tests**: Not applicable
- **Integration tests**: Not applicable
- **API tests**: Not applicable
- **Acceptance criteria**:
  - `docdex:` path links yield real snippets instead of `{"doc":null,"snippet":null}`.
  - Unit test passes.

## Task 4
- **Slug**: trio-progress-advance
- **Title**: Update gateway-trio progress per attempt
- **Priority**: P1
- **Description**:
  - Update `GatewayTrioService` to increment `processedItems` after each attempted task (success or failure) so `--watch` progress advances.
- **Files to touch**:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
- **Dependencies**: None
- **Unit tests**:
  - Add a test that verifies `updateJobStatus` is called with incremented `processedItems` after a failed attempt.
- **Component tests**: Not applicable
- **Integration tests**: Not applicable
- **API tests**: Not applicable
- **Acceptance criteria**:
  - Progress increments during retries/failures instead of staying at 0.
  - Unit test passes.

## Task 5
- **Slug**: review-invalid-json-escalate
- **Title**: Escalate reviewers after invalid JSON output
- **Priority**: P1
- **Description**:
  - When review output remains invalid JSON after retry, mark the task blocked with reason `review_invalid_output` and surface an error code so gateway-trio can avoid the same agent.
  - Add `review_invalid_output` to retryable and escalation reason sets.
- **Files to touch**:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
- **Dependencies**: None
- **Unit tests**:
  - Add/update a test to assert invalid JSON output produces `review_invalid_output` metadata and is reflected in results.
- **Component tests**: Not applicable
- **Integration tests**: Not applicable
- **API tests**: Not applicable
- **Acceptance criteria**:
  - Invalid JSON review results drive escalation to a stronger reviewer on retry.
  - Unit test passes.

