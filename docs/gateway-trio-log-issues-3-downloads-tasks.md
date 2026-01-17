# Gateway-Trio Downloads Log Fix Tasks

Source plan: `docs/gateway-trio-log-issues-3-downloads-plan.md`

## Mcoda Tasks

### Task GT3-001
- slug: gt3-docdex-repo-scope
- title: Enforce docdex repo scoping for gateway-trio
- description:
  - Resolve the authoritative workspace root from `gateway-trio` inputs (`--workspace` flag, workspace config, and project key) and treat it as the single source of truth for docdex scoping.
  - Ensure every docdex call includes a repo identifier (repo path or repo id) and fails fast with a clear error when missing.
  - Wire the resolved workspace root into the docdex client so `search`, `open`, `symbols`, and `ast` calls always carry the correct scope.
  - Update doc context builders (work/review/QA/gateway) to rely on the scoped docdex client instead of implicit defaults like `process.cwd()`.
  - Surface a single, actionable warning when scope is missing so downstream runs do not spam `missing_repo`.
- dependencies: none
- files to touch:
  - `packages/integrations/src/docdex/DocdexClient.ts`
  - `packages/core/src/services/shared/WorkspaceResolver.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/agents/GatewayAgentService.ts`
- acceptance criteria:
  - Docdex requests consistently target the workspace root passed to gateway-trio.
  - Missing repo scope produces one clear error and prevents follow-on docdex calls.
  - `missing_repo` errors no longer appear in gateway-trio runs when a workspace is provided.
- tests:
  - unit: `packages/integrations/src/docdex/__tests__/DocdexClient.test.ts` (assert repo scope required and attached)
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (assert preflight scope check)
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if any new top-level tests are introduced
  - test run all: ensure new standalone tests are registered in `tests/all.js` when needed

### Task GT3-002
- slug: gt3-docdex-health-check
- title: Add docdex daemon health checks and recovery hints
- description:
  - Run a docdex health check at gateway-trio startup and capture the result as a job-level artifact.
  - When the daemon is unreachable or returns bind/ollama errors, surface a concise remediation hint (docdex check, docdex setup, ollama status).
  - Gate downstream docdex calls behind the health check to avoid repeated failures and misleading “search failed” output.
  - Add a single warning line to agent prompts that docdex is unavailable so agents do not claim missing context.
- dependencies: gt3-docdex-repo-scope
- files to touch:
  - `packages/integrations/src/docdex/DocdexRuntime.ts`
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
- acceptance criteria:
  - Gateway-trio emits one clear docdex availability warning when the daemon is down.
  - Docdex calls are skipped when health checks fail, avoiding repeated error spam.
  - A job artifact captures the docdex check output for auditing.
- tests:
  - unit: `packages/integrations/src/docdex/__tests__/DocdexRuntime.test.ts` (simulate failed check)
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts` (assert warning + skip)
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if any new top-level tests are introduced
  - test run all: ensure new standalone tests are registered in `tests/all.js` when needed

### Task GT3-003
- slug: gt3-review-json-harden
- title: Harden review JSON output and escalation flow
- description:
  - Validate review output against the expected JSON schema on first pass.
  - If parsing fails, perform a single retry using a strict JSON-only prompt and a stricter model override (if configured).
  - When the retry still fails, block the task with reason `review_invalid_output` and include the raw response in the review artifacts for diagnostics.
  - Ensure gateway-trio recognizes `review_invalid_output` as an escalation signal to pick a stronger reviewer next cycle.
- dependencies: none
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
- acceptance criteria:
  - Review retries use strict JSON-only instructions.
  - Invalid JSON after retry blocks the task with `review_invalid_output`.
  - Gateway-trio escalates reviewers based on the new block reason.
- tests:
  - unit: `packages/core/src/services/review/__tests__/CodeReviewService.test.ts` (invalid JSON retry + block reason)
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts` (escalation on review_invalid_output)
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if any new top-level tests are introduced
  - test run all: ensure new standalone tests are registered in `tests/all.js` when needed

### Task GT3-004
- slug: gt3-patch-apply-resilience
- title: Make patch application resilient and debuggable
- description:
  - Validate patch output before applying to ensure diff headers and file paths are present and scoped.
  - Add a fallback apply path (3-way or reject mode) when the first apply fails, then re-check for touched files.
  - Persist raw patch payloads and apply errors under `.mcoda/jobs/<jobId>/work/patches/` for postmortem inspection.
  - Keep existing file-block fallback but log when it is used so patch failures are visible.
- dependencies: none
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/integrations/src/vcs/VcsClient.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- acceptance criteria:
  - Patch failures produce a persisted artifact path and a clear warning.
  - 3-way (or reject) apply is attempted before marking `patch_failed`.
  - Work-on-tasks continues when file-block fallback succeeds.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (fallback + artifact path)
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if any new top-level tests are introduced
  - test run all: ensure new standalone tests are registered in `tests/all.js` when needed

### Task GT3-005
- slug: gt3-sds-context-filter
- title: Prevent non-spec docs from being labeled SDS in doc context
- description:
  - Add a doc-type normalization helper that overrides `docType` to `DOC` when the path is not under `docs/sds/` and lacks SDS frontmatter.
  - Apply this normalization to gateway doc summaries and doc context summaries for work/review/QA.
  - Keep QA/e2e docs out of SDS context so they are not treated as system design.
  - Log when doc types are downgraded to help validate classification behavior.
- dependencies: none
- files to touch:
  - `packages/core/src/services/agents/GatewayAgentService.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/shared/ProjectGuidance.ts`
- acceptance criteria:
  - Docs outside `docs/sds/` are no longer labeled `[SDS]` in agent context.
  - QA/e2e issue docs do not appear as SDS in gateway-trio runs.
  - Downgrade logging is visible for misclassified docs.
- tests:
  - unit: `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts` (docType normalization)
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (doc context labels)
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if any new top-level tests are introduced
  - test run all: ensure new standalone tests are registered in `tests/all.js` when needed

### Task GT3-006
- slug: gt3-prompt-docdex-cleanup
- title: Clean docdex guidance in prompts and add repo-scoped examples
- description:
  - Remove MCP-specific guidance and any `docdexd serve` references from prompts.
  - Standardize docdex usage examples to include repo scoping (`--repo <workspaceRoot>` or `DOCDEX_REPO`).
  - Ensure all prompts describe docdex as daemon-only and clarify that context is injected by mcoda.
  - Update prompt validation tests to assert the new guidance content.
- dependencies: gt3-docdex-repo-scope
- files to touch:
  - `prompts/gateway-agent.md`
  - `prompts/code-writer.md`
  - `prompts/code-reviewer.md`
  - `prompts/qa-agent.md`
  - `tests/gateway-trio-docs.test.js`
- acceptance criteria:
  - Prompts no longer mention MCP or `docdexd serve`.
  - Docdex examples include repo scoping in every prompt.
  - Prompt tests validate the updated guidance.
- tests:
  - unit: `tests/gateway-trio-docs.test.js` (prompt content assertions)
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if new prompt tests are added outside existing files
  - test run all: ensure `tests/gateway-trio-docs.test.js` remains covered by `tests/all.js`

### Task GT3-007
- slug: gt3-run-all-portable
- title: Fix run-all tests portability and remove absolute node paths
- description:
  - Replace absolute Node paths with `process.execPath` or PATH-resolved `node` in run-all orchestration.
  - Align `tests/all.js` and helper scripts so they resolve node consistently across environments.
  - Update any CLI/test runner logging to show the resolved node binary for diagnostics.
  - Add a unit test to lock in node resolution behavior.
- dependencies: none
- files to touch:
  - `tests/all.js`
  - `scripts/run-node-tests.js`
  - `package.json`
  - `tests/unit/node_resolution.test.js` (new)
- acceptance criteria:
  - Run-all tests no longer reference absolute Node installation paths.
  - Node resolution is stable across machines and CI.
  - New unit test passes and documents expected behavior.
- tests:
  - unit: `tests/unit/node_resolution.test.js`
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: add `tests/unit/node_resolution.test.js` to `tests/artifacts.md`
  - test run all: ensure `tests/unit/node_resolution.test.js` is included by `tests/all.js`

### Task GT3-008
- slug: gt3-watch-progress
- title: Improve gateway-trio watch progress reporting
- description:
  - Increment progress after each task attempt (success, failure, or retry) so `--watch` reflects real work.
  - Add a heartbeat that includes the last activity timestamp and current task key.
  - Move progress output to stderr (or a dedicated channel) to avoid interleaving with agent responses.
  - Add tests that assert processedItems increments on failed attempts.
- dependencies: none
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
- acceptance criteria:
  - Watch output advances during retries instead of stalling at 0/3.
  - Progress logging does not corrupt agent output streams.
  - New tests confirm processedItems increments on failed attempts.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
  - component: n/a
  - integration: n/a
  - api: n/a
  - test artifacts: update `tests/artifacts.md` if any new top-level tests are introduced
  - test run all: ensure new standalone tests are registered in `tests/all.js` when needed

## External Docdex Tasks

### Task GT3-EXT-01
- slug: docdex-playwright-availability
- title: Ensure Playwright CLI is available under docdex
- description:
  - Update the docdex repo to package or resolve Playwright CLI reliably.
  - Fail fast with a clear setup message when the CLI is missing.
  - Confirm docdex QA adapters use the same resolution path.
- dependencies: none (external docdex repo)
- files to touch:
  - docdex repo: Playwright resolution utilities and QA adapter preflight
- acceptance criteria:
  - Docdex reports a clear error when Playwright is missing and provides a setup command.
  - QA runs do not crash with missing module errors.
- tests:
  - unit: docdex repo tests for Playwright resolution
  - component: n/a
  - integration: docdex repo QA adapter smoke test
  - api: n/a
  - test artifacts: update docdex repo test artifact listing if new tests are added
  - test run all: register new docdex repo tests in its run-all harness

### Task GT3-EXT-02
- slug: docdex-daemon-bind-ollama
- title: Resolve docdex daemon bind and ollama startup failures
- description:
  - Investigate and fix daemon lock/bind failures so `docdexd check` succeeds reliably.
  - Ensure ollama availability checks provide actionable diagnostics without blocking daemon startup.
  - Add documentation for clearing stale locks or state directories.
- dependencies: none (external docdex repo)
- files to touch:
  - docdex repo: daemon startup/lock handling and docs
- acceptance criteria:
  - `docdexd check` succeeds on a clean machine without manual lock cleanup.
  - Ollama unavailability yields a clear warning but does not crash the daemon.
- tests:
  - unit: docdex repo daemon lock handling tests
  - component: n/a
  - integration: docdex repo daemon startup smoke test
  - api: n/a
  - test artifacts: update docdex repo test artifact listing if new tests are added
  - test run all: register new docdex repo tests in its run-all harness
