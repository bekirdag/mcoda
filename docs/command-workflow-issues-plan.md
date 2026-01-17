# Plan: Fix Command Workflow Issues

This plan addresses the issues listed in `docs/command-workflow-issues.md` and outlines specific code changes, tests, and validation steps.

## Goals
- Make `work-on-tasks`, `code-review`, and `qa-tasks` safer and more deterministic.
- Reduce false positives (e.g., approvals without real output).
- Improve agent resiliency and error handling.
- Keep behavior explicit and discoverable via config and logs.

## Non-goals
- Major redesign of the task pipeline.
- Replacing existing agents or adapters.
- Changing the database schema unless required for deduplication or new state tracking.

## Phase 1: Work-on-tasks fixes

### 1. Base branch handling
Problem: Base branch is forced to `mcoda-dev`, ignoring workspace config.
Plan:
- Read the base branch from workspace config when provided.
- Only default to `mcoda-dev` if config is absent.
- Add a warning if the user explicitly passes a different base in the command.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/cli/src/commands/work/WorkOnTasksCommand.ts` (if needed to expose base)
Tests:
- Unit test that a configured base branch is honored.
- Unit test that default is `mcoda-dev` when missing.

### 2. No-change handling for all statuses
Problem: No-change blocking only applies to tasks starting in `not_started` or `in_progress`.
Plan:
- If a task was executed (agent run occurred) and no changes are detected, block with `no_changes` regardless of initial status.
- Include a task comment with suggested next action.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
Tests:
- Unit test: task in `ready_to_review` with no changes blocks with `no_changes`.

### 3. Run-all tests script creation
Problem: `tests/all.js` is required but not created automatically.
Plan:
- Add a helper that can create a minimal `tests/all.js` when missing:
  - Prints a start/end marker.
  - Runs configured unit/component/integration/api test scripts when present.
- If the file is created, commit it as part of the task run and re-run tests.
- Document the script in `docs/usage.md`.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `tests/all.js` (template or generator output)
- `docs/usage.md`
Tests:
- Unit test that missing `tests/all.js` is created and tests run.

### 4. Monorepo-aware test discovery
Problem: Test discovery only checks workspace root.
Plan:
- Resolve the nearest `package.json` relative to touched files or metadata file scope.
- Prefer a local test command (e.g., `pnpm -C <dir> test`) when available.
- Fall back to workspace root when no local config is found.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
Tests:
- Unit test with nested package.json and task metadata files.

### 5. FILE blocks for existing files
Problem: FILE blocks targeting existing files are skipped, resulting in no changes.
Plan:
- Allow FILE blocks to overwrite existing files only when:
  - No patches are present.
  - A safe flag is enabled (e.g., `allowFileOverwrite`).
- Log a warning and require the file block to include full content.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
Tests:
- Unit test: FILE block updates existing file when no patches present.

### 6. Enforce file scope even when metadata missing
Problem: Without `metadata.files`, any file can be changed and auto-merged.
Plan:
- Add a config gate `restrictAutoMergeWithoutScope`:
  - If no file scope exists, allow changes but skip auto-merge and mark task as `ready_to_review` without merging.
- Log an explicit warning with the set of changed files.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/shared/src/config.ts` (or workspace config parsing)
Tests:
- Unit test: no file scope prevents auto-merge and logs warning.

### 7. Safer merge/push defaults
Problem: Auto-merge/push fails late on protected branches.
Plan:
- Add explicit flags/config for `autoMerge` and `autoPush`.
- Default to current behavior but emit a warning if remote is protected or push fails.
- If `autoMerge` is false, skip merge and leave branch for manual PR.
Files:
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/cli/src/commands/work/WorkOnTasksCommand.ts`
- `docs/usage.md`
Tests:
- Unit test: `autoMerge=false` skips merge step.

## Phase 2: Code-review fixes

### 8. Invalid JSON should not advance tasks
Problem: Invalid JSON after retry falls back to `info_only`.
Plan:
- Change fallback to a hard failure with `decision=block` and `review_invalid_output`.
- Add a task comment that requests re-run with a stricter model.
- Allow an opt-in flag to keep legacy behavior if needed.
Files:
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
Tests:
- Unit test: invalid JSON blocks and does not move to `ready_to_qa`.

### 9. Empty diff handling
Problem: Empty diff can still be approved.
Plan:
- Detect empty diff before agent invocation.
- If empty, block with `review_empty_diff` and create a comment.
Files:
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
Tests:
- Unit test: empty diff results in blocked task.

### 10. Enforce unresolved comment backlog
Problem: Open comments are advisory only.
Plan:
- If unresolved comment slugs exist and reviewer does not resolve them, disallow `approve/info_only`.
- Force `changes_requested` and add a summary comment.
Files:
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
Tests:
- Unit test: unresolved backlog + approve -> changes_requested.

### 11. Resume selection filtering
Problem: Resume re-reviews terminal tasks.
Plan:
- On resume, re-fetch selected tasks and filter out `completed/cancelled`.
- Add a warning listing skipped keys.
Files:
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
Tests:
- Unit test: resume ignores completed tasks.

### 12. Docdex fallback behavior
Problem: No reindex or explicit stop when docdex is missing.
Plan:
- If docdex search fails, attempt a one-time reindex and retry.
- If still failing, record a warning and continue (do not block).
Files:
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
Tests:
- Unit test: reindex is attempted on failure (stub docdex).

## Phase 3: QA fixes

### 13. UI detection for profile selection
Problem: UI tasks can be tested only with CLI profile.
Plan:
- Add heuristics to detect UI scope:
  - Task metadata tags (ui/web/frontend).
  - Repo signals (presence of `src/pages`, `app`, `public`, `index.html`, `vite.config`, `next.config`).
  - Docdex context hints from SDS/OpenAPI.
- If UI detected and a Playwright profile exists, prefer it.
Files:
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`
Tests:
- Unit test: UI task selects Playwright profile when available.

### 14. Handle `unclear` outcomes explicitly
Problem: `unclear` causes repeated re-runs with no state change.
Plan:
- Treat `unclear` as a blocked state `qa_unclear`.
- Add a QA comment with required follow-up info.
Files:
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`
Tests:
- Unit test: `unclear` -> task blocked with `qa_unclear`.

### 15. Docdex setup guidance on install failures
Problem: Install failures do not consistently instruct `docdex setup`.
Plan:
- When Playwright install fails, append guidance: "Run docdex setup and install at least one browser."
- Surface this in task comments and logs.
Files:
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/integrations/src/playwright/ChromiumQaAdapter.ts` (if applicable)
Tests:
- Unit test: install failure message includes docdex setup guidance.

### 16. QA agent JSON failure handling
Problem: Invalid JSON drops structured evidence.
Plan:
- If JSON invalid after retry, mark QA interpretation as `unclear` and include raw output in comment.
- Optionally create a follow-up task for manual QA.
Files:
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`
Tests:
- Unit test: invalid JSON -> `unclear` + comment includes raw output.

### 17. Follow-up deduplication
Problem: QA follow-ups can duplicate.
Plan:
- Add a deterministic hash or slug for QA follow-ups and skip creating duplicates.
- Store hash in follow-up task metadata and compare on subsequent runs.
Files:
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/db/src/store.ts` (query helper for follow-ups)
Tests:
- Unit test: repeated QA run does not create duplicate follow-up.

### 18. CLI adapter missing tests detection
Problem: Empty test suites can look like success.
Plan:
- Require `tests/all.js` to emit a known marker (start/end).
- If marker is missing, treat result as `infra_issue` or `unclear`.
Files:
- `tests/all.js`
- `packages/core/src/services/execution/QaTasksService.ts`
- `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`
Tests:
- Unit test: missing marker -> `infra_issue` or `unclear`.

## Validation and rollout
- Update unit tests in `packages/core/src/services/execution/__tests__` and `packages/core/src/services/review/__tests__`.
- Run `pnpm --filter @mcoda/core test`.
- Rebuild CLI and run smoke tests on a sample project (`work-on-tasks`, `code-review`, `qa-tasks`, `gateway-trio`).
- Update docs: `docs/usage.md` and any workflow docs to reflect new behaviors and flags.

## Dependencies and ordering
1. Work-on-tasks changes first (test script creation, no-change handling).
2. Code-review gating fixes (invalid JSON, empty diff).
3. QA outcome handling and profile selection.
4. Dedup and doc updates.

## Risks
- Behavior changes may affect existing pipelines (auto-merge, approval flow).
- Enforcing stricter gating can increase blocked tasks; mitigate by adding flags to keep legacy behavior.
