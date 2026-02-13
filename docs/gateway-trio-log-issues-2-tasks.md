# Gateway Trio Fix Tasks (Implementation Plan)

Source plan: `docs/gateway-trio-log-issues-2-plan.md`

## Mcoda Tasks

### Task GT-001
- slug: gt-prompt-dedupe
- title: De-duplicate agent prompt assembly and remove cross-role contamination
- description:
  - Ensure each agent run receives exactly one role-appropriate prompt block (gateway, code-writer, code-reviewer, QA).
  - Remove gateway JSON-only instructions and docdex JSON-only lines from non-gateway prompts.
  - Strip injected persona text that appears before code-writer prompts.
  - Guarantee prompt ordering: project guidance first, then role prompt, then task-specific context.
- dependencies: none
- files to touch:
  - `packages/core/src/services/agents/GatewayAgentService.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `prompts/gateway-agent.md`
  - `prompts/code-writer.md`
  - `prompts/code-reviewer.md`
  - `prompts/qa-agent.md`
- acceptance criteria:
  - Each agent input contains a single role prompt block.
  - No gateway JSON-only schema or docdex JSON-only rule appears in code-writer/reviewer/QA inputs.
  - Project guidance appears as the first block in agent input.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (assert prompt contains only work-on-tasks prompt and no gateway schema)
  - unit: `packages/core/src/services/review/__tests__/CodeReviewService.test.ts` (assert prompt ordering and absence of gateway schema)
  - unit: `packages/core/src/services/execution/__tests__/QaTasksService.test.ts` (assert prompt ordering)
  - component: `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts` (assert gateway prompt assembly remains valid)
  - integration: n/a
  - api: n/a

### Task GT-002
- slug: gt-gateway-schema-validator
- title: Align gateway output validator with documented schema
- description:
  - Update gateway output validation to require only `filesLikelyTouched` and `filesToCreate` (remove unexpected `files`).
  - Add schema regression coverage to prevent future drift.
- dependencies: none
- files to touch:
  - `packages/core/src/services/agents/GatewayAgentService.ts`
  - `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts`
- acceptance criteria:
  - Gateway responses with the documented schema validate on the first pass.
  - Validation errors no longer reference a `files` field.
- tests:
  - unit: `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts` (schema validation test)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-003
- slug: gt-review-routing
- title: Prevent gateway-router planning for review/QA jobs
- description:
  - Skip gateway-router invocation for code-review and QA command runs.
  - Ensure discipline labeling is correct for review tasks (not `qa`).
  - Preserve gateway planning only for work-on-tasks decisions.
- dependencies: gt-prompt-dedupe
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
- acceptance criteria:
  - Code-review and QA runs do not invoke gateway-router planning.
  - Review runs record `discipline: review`.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts` (assert gateway planner not called for review/qa)
  - component: `packages/core/src/services/review/__tests__/CodeReviewService.test.ts` (discipline metadata)
  - integration: n/a
  - api: n/a

### Task GT-004
- slug: gt-merge-conflict-policy
- title: Unify merge-conflict instructions across prompts
- description:
  - Replace conflicting guidance ("resolve conflicts" vs "stop and report") with a single safety policy.
  - Ensure all agent prompts instruct to stop and report on conflict markers.
- dependencies: gt-prompt-dedupe
- files to touch:
  - `prompts/code-writer.md`
  - `prompts/code-reviewer.md`
  - `prompts/qa-agent.md`
- acceptance criteria:
  - All prompts explicitly instruct to stop and report on merge conflicts.
- tests:
  - unit: `tests/gateway-trio-docs.test.js` (assert prompt text contains unified policy)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-005
- slug: gt-docdex-scope-required
- title: Require repo scoping for all docdex calls in mcoda
- description:
  - Ensure every docdex request includes repo ID/path.
  - Add a preflight check before gateway/review/QA docdex calls and emit a clear error if scope is missing.
- dependencies: none
- files to touch:
  - `packages/integrations/src/docdex/DocdexClient.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/agents/GatewayAgentService.ts`
- acceptance criteria:
  - No `missing_repo` errors appear when repo is known.
  - Errors are actionable when scope is missing.
- tests:
  - unit: `packages/integrations/src/docdex/__tests__/DocdexClient.test.ts` (assert repo header is sent when repoId is set)
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (assert preflight failure message)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-006
- slug: gt-docdex-ref-resolve
- title: Resolve `docdex:` references into snippets before agent injection
- description:
  - Parse doc links prefixed with `docdex:` and resolve them to actual snippets via docdex.
  - If resolution fails, add a structured note rather than passing raw tags.
- dependencies: gt-docdex-scope-required
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
- acceptance criteria:
  - `docdex:` references are replaced by snippet content or a structured "not found" note.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (doc link resolution)
  - unit: `packages/core/src/services/review/__tests__/CodeReviewService.test.ts` (doc link resolution)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-007
- slug: gt-context-ordering-filter
- title: Order project guidance first and filter doc context by task scope
- description:
  - Prepend `docs/project-guidance.md` to every agent input.
  - Exclude QA/e2e docs from non-QA tasks.
  - Remove `.mcoda/docs` artifacts from injected context.
- dependencies: gt-docdex-ref-resolve
- files to touch:
  - `packages/core/src/services/shared/ProjectGuidance.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
- acceptance criteria:
  - Project guidance appears first in all agent inputs.
  - QA docs are included only for QA/documentation tasks.
  - `.mcoda/docs` references are filtered out of context.
- tests:
  - unit: `packages/core/src/services/review/__tests__/CodeReviewService.test.ts` (guidance ordering)
  - unit: `packages/core/src/services/execution/__tests__/QaTasksService.test.ts` (QA doc inclusion)
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (doc filtering)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-008
- slug: gt-docdex-guidance-cleanup
- title: Standardize docdex guidance in prompts
- description:
  - Remove MCP references and `.docdex/` references from prompts.
  - Use a single canonical daemon command and port across all prompts.
- dependencies: gt-prompt-dedupe
- files to touch:
  - `prompts/gateway-agent.md`
  - `prompts/code-writer.md`
  - `prompts/code-reviewer.md`
  - `prompts/qa-agent.md`
- acceptance criteria:
  - Prompts contain one daemon command and port (consistent across roles).
  - No MCP references or `.docdex/` mentions remain.
- tests:
  - unit: `tests/gateway-trio-docs.test.js` (prompt content assertions)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-009
- slug: gt-progress-stream-safety
- title: Stabilize progress ticker and stream output
- description:
  - Move progress ticker to stderr or a separate channel.
  - Start ticker only after task count is known.
  - Handle SIGPIPE/BrokenPipe in CLI output redirection.
- dependencies: none
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`
- acceptance criteria:
  - `--watch` logs do not interleave with agent output.
  - Job does not report `running 0/0` once tasks are loaded.
  - Redirected output does not produce BrokenPipe noise.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts` (progress count start)
  - component: `packages/cli/src/__tests__/GatewayTrioCommand.test.ts` (watch output path)
  - integration: n/a
  - api: n/a

### Task GT-010
- slug: gt-task-selection-validation
- title: Reject pseudo tasks and handle zero-token failures
- description:
  - Reject `[RUN]` prefixed task IDs before execution.
  - Treat zero-token task runs as infra errors and retry once with backoff before failing.
- dependencies: gt-progress-stream-safety
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
- acceptance criteria:
  - `[RUN]` tasks are skipped with a clear warning.
  - Zero-token attempts are retried once and then marked as infra failure.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts` (reject [RUN] and retry zero-token)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-011
- slug: gt-task-requeue-control
- title: Prevent completed tasks from re-queueing and handle no-change completions
- description:
  - Lock completed tasks per cycle so they are not reprocessed.
  - Require a justification string for `COMPLETED_NO_CHANGES` and record it as a task comment.
- dependencies: gt-task-selection-validation
- files to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/db/src/repositories/tasks/TaskCommentRepository.ts`
  - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
- acceptance criteria:
  - Completed tasks do not re-run in the same gateway-trio job.
  - `COMPLETED_NO_CHANGES` includes a justification comment.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts` (no requeue, justification comment)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-012
- slug: gt-comment-schema-injection
- title: Enforce comment schema and inject unresolved slugs into subsequent runs
- description:
  - Enforce comment fields: slug, file path, line number, summary.
  - Always inject unresolved comment slugs into work/review/QA prompts.
  - Avoid generating follow-up tasks for review unless explicitly requested; otherwise update comments on the original task.
  - Require SP/complexity on any generated tasks.
- dependencies: gt-task-requeue-control
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/db/src/repositories/tasks/TaskCommentRepository.ts`
- acceptance criteria:
  - Review/QA comments include file+line and slug.
  - Unresolved comment slugs appear in subsequent agent prompts.
  - No unrelated follow-up tasks are created.
- tests:
  - unit: `packages/core/src/services/review/__tests__/CodeReviewService.test.ts` (comment schema)
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (comment injection)
  - unit: `packages/core/src/services/execution/__tests__/QaTasksService.test.ts` (comment injection)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-013
- slug: gt-patch-format-enforcement
- title: Enforce patch-only output before applying changes
- description:
  - Validate output type before patch application.
  - If output is not patch/file-block, retry with strict patch-only prompt and a patch-only model if configured.
- dependencies: gt-prompt-dedupe
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- acceptance criteria:
  - Non-patch outputs never reach patch apply.
  - Retry prompt uses patch-only instructions.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (non-patch output triggers retry)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-014
- slug: gt-path-validation
- title: Preserve handoff file lists and validate path scope
- description:
  - Preserve `filesLikelyTouched`/`filesToCreate` in gateway handoff content.
  - Validate file paths against repo root to prevent cross-project edits.
  - Normalize path casing and enforce canonical paths.
- dependencies: gt-docdex-scope-required
- files to touch:
  - `packages/core/src/services/agents/GatewayHandoff.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/shared/src/paths/PathHelper.ts`
  - `packages/core/src/services/agents/__tests__/GatewayHandoff.test.ts`
- acceptance criteria:
  - Handoff content includes the file lists from gateway output.
  - Paths outside the workspace are rejected before patch apply.
  - Canonical path normalization is applied consistently.
- tests:
  - unit: `packages/core/src/services/agents/__tests__/GatewayHandoff.test.ts` (file list retention)
  - unit: `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts` (path rejection)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-015
- slug: gt-run-all-tests-update
- title: Update run-all tests orchestration
- description:
  - Update `tests/all.js` to run JS and TS/Vitest suites.
  - Remove absolute Node paths and use `node` or `pnpm`.
  - Ensure the completion marker is always emitted.
- dependencies: none
- files to touch:
  - `tests/all.js`
  - `scripts/run-node-tests.js`
  - `package.json`
- acceptance criteria:
  - Run-all tests execute JS and TS suites.
  - `MCODA_RUN_ALL_TESTS_COMPLETE` marker is emitted.
  - No absolute node path is logged in QA instructions.
- tests:
  - unit: `tests/unit/run_all_tests.test.js` (new test to assert marker and command selection)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-016
- slug: gt-qa-playwright-gating
- title: Gate QA on Playwright availability and stop npx auto-installs
- description:
  - Check for Playwright CLI availability via docdex runtime before QA.
  - If missing, surface a clear `docdex setup` instruction and stop QA.
  - Remove any `npx` auto-install flows.
- dependencies: gt-docdex-scope-required
- files to touch:
  - `packages/integrations/src/qa/ChromiumQaAdapter.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/integrations/src/docdex/DocdexRuntime.ts`
- acceptance criteria:
  - QA fails fast with a setup instruction when Playwright is missing.
  - No `npm warn exec ... playwright@` logs appear during QA.
- tests:
  - unit: `packages/integrations/src/docdex/__tests__/DocdexRuntime.test.ts` (Playwright missing error message)
  - unit: `packages/core/src/services/execution/__tests__/QaTasksService.test.ts` (QA stops on missing Playwright)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-017
- slug: gt-qa-deps-preflight
- title: Add QA dependency and environment preflight checks
- description:
  - Check required deps (`argon2`, `pg`, `ioredis`, `@jest/globals`) before QA runs.
  - Check required env vars (`TEST_DB_URL`, `TEST_REDIS_URL`) and emit actionable errors.
  - Update QA test-plan messages to avoid obsolete Jest configs.
- dependencies: gt-run-all-tests-update
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/integrations/src/qa/ChromiumQaAdapter.ts`
- acceptance criteria:
  - QA reports explicit missing deps/env vars and stops before running tests.
  - Test plan output no longer references Jest configs when Vitest is used.
- tests:
  - unit: `packages/core/src/services/execution/__tests__/QaTasksService.test.ts` (missing deps/env)
  - component: n/a
  - integration: n/a
  - api: n/a

### Task GT-018
- slug: gt-plan-validation-run
- title: End-to-end validation run and regression capture
- description:
  - Rebuild CLI and run gateway-trio against a 10-20 task sample.
  - Capture issues in a new log doc and compare against `docs/gateway-trio-log-issues-2.md`.
- dependencies: gt-qa-deps-preflight, gt-path-validation, gt-task-requeue-control
- files to touch:
  - `docs/gateway-trio-log-issues-3.md` (new)
- acceptance criteria:
  - No prompt duplication or JSON-only leakage.
  - No zero-token failures or re-queued completed tasks.
  - QA fails only with actionable dependency errors.
- tests:
  - unit: n/a
  - component: n/a
  - integration: n/a
  - api: n/a
