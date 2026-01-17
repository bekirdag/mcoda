# Tasks: Fix Command Workflow Issues

Each task includes a slug, title, detailed description, dependencies, acceptance criteria, tests to write (unit/component/integration/api where relevant), files to touch, and priority. Tasks are ordered by highest priority.

## P0 tasks

### Task 1
- slug: work-base-branch-honor-config
- title: Honor configured base branch in work-on-tasks
- priority: P0
- description: Use the workspace config base branch when provided, instead of forcing `mcoda-dev`. Preserve the current warning behavior only when a command-line override conflicts with config. Ensure branch selection is consistent in logs, VCS operations, and metadata updates.
- dependencies: None
- acceptance criteria:
  - If `workspace.config.branch` is set, work-on-tasks uses it as the base branch.
  - If no config is present, base defaults to `mcoda-dev`.
  - A warning is emitted only when a CLI override conflicts with config.
  - Unit tests cover both config-present and config-absent cases.
- tests to write:
  - unit: `WorkOnTasksService` uses configured base branch and default fallback.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 2
- slug: work-no-change-all-statuses
- title: Block no-change runs regardless of initial status
- priority: P0
- description: If an agent run occurs and no changes are detected (no touched files and no dirty paths), block the task with `no_changes` regardless of initial status. Emit a clear task comment describing next steps.
- dependencies: None
- acceptance criteria:
  - Tasks starting in `ready_to_review` or `ready_to_qa` still block when no changes are produced.
  - A `no_changes` task comment is created for these cases.
  - Unit tests cover no-change behavior for a non `not_started` status.
- tests to write:
  - unit: `WorkOnTasksService` blocks no-change for `ready_to_review`.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 3
- slug: review-invalid-json-block
- title: Block review when JSON output is invalid
- priority: P0
- description: When the review agent returns invalid JSON after retry, block the task instead of falling back to `info_only`. Add a review comment requesting a re-run with a stricter model and mark the task blocked with a distinct reason (for example `review_invalid_output`).
- dependencies: None
- acceptance criteria:
  - Invalid JSON after retry leads to `blocked` state, not `ready_to_qa`.
  - A task comment is created with re-run guidance.
  - Tests confirm task does not advance on invalid JSON.
- tests to write:
  - unit: `CodeReviewService` invalid JSON -> blocked + comment.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

### Task 4
- slug: review-empty-diff-block
- title: Block review when diff is empty
- priority: P0
- description: Detect empty diffs before agent invocation. If there are no code changes, block the task with a `review_empty_diff` reason and add a comment explaining that a review cannot proceed without changes.
- dependencies: None
- acceptance criteria:
  - Empty diff triggers `blocked` state and review comment.
  - Review agent is not invoked for empty diffs.
  - Unit test covers empty-diff blocking.
- tests to write:
  - unit: `CodeReviewService` empty diff -> blocked + comment.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

### Task 5
- slug: qa-unclear-state
- title: Treat unclear QA outcomes as blocked
- priority: P0
- description: Handle `unclear` outcomes explicitly by blocking the task with a distinct reason (for example `qa_unclear`) and adding a QA comment describing what information is missing.
- dependencies: None
- acceptance criteria:
  - `unclear` outcome transitions task to `blocked` with `qa_unclear`.
  - QA comment is created with follow-up guidance.
  - Unit test covers `unclear` outcome.
- tests to write:
  - unit: `QaTasksService` unclear -> blocked with `qa_unclear`.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

### Task 6
- slug: qa-docdex-setup-guidance
- title: Add docdex setup guidance on QA install failures
- priority: P0
- description: When Playwright or browser install checks fail, include explicit guidance to run `docdex setup` and install at least one browser. Ensure this guidance appears in logs and in task comments.
- dependencies: None
- acceptance criteria:
  - Install failure comments include `docdex setup` guidance.
  - Logs include the same guidance message.
  - Unit test confirms guidance is appended.
- tests to write:
  - unit: `QaTasksService` install failure message contains guidance.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

## P1 tasks

### Task 7
- slug: work-run-all-tests-script
- title: Auto-create run-all tests script when missing
- priority: P1
- description: Add a helper that creates a minimal `tests/all.js` script when missing in the target workspace. The script should run registered unit/component/integration/api test commands when present. After creation, re-run tests in the same task run and commit the script if auto-commit is enabled.
- dependencies: work-base-branch-honor-config
- acceptance criteria:
  - `tests/all.js` is created when missing and task requires tests.
  - Tests are re-run after creation and can pass within the same task run.
  - The created script is staged/committed when `noCommit` is false.
  - Unit test covers script creation and re-run.
- tests to write:
  - unit: `WorkOnTasksService` creates `tests/all.js` and re-runs tests.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 8
- slug: work-monorepo-test-discovery
- title: Improve monorepo test command discovery
- priority: P1
- description: When tasks touch files in nested packages, resolve the nearest `package.json` and prefer local test commands (for example `pnpm -C <dir> test`). Fallback to workspace root when no nested package exists.
- dependencies: work-run-all-tests-script
- acceptance criteria:
  - Test command selection prefers nearest `package.json`.
  - Fallback to root occurs when no nested package config exists.
  - Unit test covers nested package discovery.
- tests to write:
  - unit: `WorkOnTasksService` selects nested test command for touched files.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 9
- slug: work-file-block-overwrite
- title: Allow safe FILE block overwrite for existing files
- priority: P1
- description: Permit FILE blocks to overwrite existing files only when no patch content is provided and a safe flag is enabled. Validate that FILE blocks include full content and log warnings when overwrite occurs.
- dependencies: None
- acceptance criteria:
  - Existing files can be updated via FILE blocks when patches are absent and flag is enabled.
  - A warning is logged when overwriting.
  - Unit test covers overwrite path.
- tests to write:
  - unit: `WorkOnTasksService` accepts FILE blocks for existing files with flag.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 10
- slug: work-scope-auto-merge-gate
- title: Gate auto-merge when no file scope is defined
- priority: P1
- description: Add a config flag (for example `restrictAutoMergeWithoutScope`) that prevents auto-merge when metadata `files` is empty. Log a warning with the list of changed files, and move the task to `ready_to_review` without merging.
- dependencies: None
- acceptance criteria:
  - When the flag is enabled and `metadata.files` is missing, merge is skipped.
  - Task still reaches `ready_to_review`.
  - Warning includes changed file list.
  - Unit test covers gate behavior.
- tests to write:
  - unit: `WorkOnTasksService` skips merge when scope missing and flag enabled.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/shared/src/config.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 11
- slug: work-auto-merge-push-flags
- title: Add auto-merge and auto-push controls
- priority: P1
- description: Introduce config/CLI flags to disable auto-merge and auto-push. When disabled, skip those steps and leave the task branch for manual PR. Emit logs indicating the skipped behavior.
- dependencies: work-scope-auto-merge-gate
- acceptance criteria:
  - `autoMerge=false` skips merge and logs the reason.
  - `autoPush=false` skips push and logs the reason.
  - Unit tests cover both flags.
- tests to write:
  - unit: `WorkOnTasksService` respects `autoMerge` and `autoPush`.
  - component: CLI flag parsing for the new options.
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/shared/src/config.ts`
  - `packages/cli/src/commands/work/WorkOnTasksCommand.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`

### Task 12
- slug: review-unresolved-backlog-gate
- title: Enforce unresolved comment backlog in review decisions
- priority: P1
- description: If unresolved comment slugs exist and the reviewer does not resolve them, disallow `approve`/`info_only` and force `changes_requested`. Add a summary comment explaining which slugs remain open.
- dependencies: review-invalid-json-block
- acceptance criteria:
  - Review decisions with open slugs are coerced to `changes_requested`.
  - Summary comment includes unresolved slug list.
  - Unit test validates gating behavior.
- tests to write:
  - unit: `CodeReviewService` forces `changes_requested` when unresolved slugs remain.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

### Task 13
- slug: review-resume-terminal-filter
- title: Filter terminal tasks during resume
- priority: P1
- description: When resuming a review job, re-fetch selected tasks and exclude those already `completed` or `cancelled`. Emit warnings listing skipped keys.
- dependencies: None
- acceptance criteria:
  - Resume runs skip terminal tasks and update progress accordingly.
  - Warning lists skipped task keys.
  - Unit test covers resume filtering.
- tests to write:
  - unit: `CodeReviewService` resume ignores terminal tasks.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

### Task 14
- slug: review-docdex-reindex
- title: Retry docdex search with reindex fallback
- priority: P1
- description: If docdex search fails during review, attempt a one-time reindex and retry the search. If it still fails, continue with a warning rather than blocking the review.
- dependencies: None
- acceptance criteria:
  - Docdex search failure triggers a single reindex attempt.
  - Failure after retry produces a warning and continues.
  - Unit test validates reindex retry behavior.
- tests to write:
  - unit: `CodeReviewService` retries docdex search after reindex.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

### Task 15
- slug: qa-ui-profile-detection
- title: Prefer Playwright profile for UI tasks
- priority: P1
- description: Add UI detection heuristics (metadata tags, common UI folders, config files) and select a Playwright profile when UI scope is detected and a browser profile exists.
- dependencies: None
- acceptance criteria:
  - UI detection selects Playwright (chromium) profile when available.
  - Fallback to CLI profile when no UI profile exists.
  - Unit test covers UI detection path.
- tests to write:
  - unit: `QaTasksService` selects Playwright profile for UI tasks.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

### Task 16
- slug: qa-invalid-json-unclear
- title: Treat QA agent invalid JSON as unclear
- priority: P1
- description: When QA agent output is invalid after retry, record an `unclear` interpretation, include raw output in the QA comment, and optionally create a follow-up task for manual QA.
- dependencies: qa-unclear-state
- acceptance criteria:
  - Invalid JSON results in `unclear` recommendation and comment includes raw output.
  - Follow-up task is created when configured.
  - Unit test covers invalid JSON handling.
- tests to write:
  - unit: `QaTasksService` invalid JSON -> unclear + comment.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

### Task 17
- slug: qa-followup-dedupe
- title: Deduplicate QA follow-up tasks
- priority: P1
- description: Add a deterministic slug/hash for QA follow-up tasks and skip creating duplicates. Store the slug in follow-up task metadata and check existing tasks before creating new ones.
- dependencies: qa-invalid-json-unclear
- acceptance criteria:
  - Duplicate follow-ups are not created on repeated QA runs.
  - Metadata includes a stable follow-up slug/hash.
  - Unit test verifies deduplication.
- tests to write:
  - unit: `QaTasksService` skips duplicate follow-up creation.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/db/src/store.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`

### Task 18
- slug: qa-missing-test-marker
- title: Detect missing test suite markers in CLI QA
- priority: P1
- description: Require the run-all tests script to emit a known marker. If the marker is missing in stdout/stderr, treat the QA outcome as `infra_issue` or `unclear` and log guidance.
- dependencies: work-run-all-tests-script
- acceptance criteria:
  - CLI QA marks missing markers as infra issue or unclear.
  - Guidance is logged in QA task comment.
  - Unit test covers missing marker detection.
- tests to write:
  - unit: `QaTasksService` missing marker -> infra issue/unclear.
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`
  - `tests/all.js`

## P2 tasks

### Task 19
- slug: docs-update-workflow-usage
- title: Update usage and workflow docs for new behaviors
- priority: P2
- description: Document the new flags and behaviors (base branch config, auto-merge/push flags, run-all tests creation, QA unclear handling) in `docs/usage.md` and workflow docs.
- dependencies: work-auto-merge-push-flags, qa-unclear-state, work-run-all-tests-script
- acceptance criteria:
  - `docs/usage.md` reflects new flags and behaviors.
  - Workflow docs mention new gating conditions.
  - Content is accurate and concise.
- tests to write:
  - unit: N/A
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `docs/usage.md`
  - `docs/work-on-tasks-workflow.md`
  - `docs/qa-workflow.md`
  - `docs/code-review-workflow.md`

### Task 20
- slug: tests-all-js-audit
- title: Audit repo-level test runner for new tests
- priority: P2
- description: Verify whether any new standalone test scripts require explicit registration in `tests/all.js` and update the list if needed.
- dependencies: work-run-all-tests-script, review-invalid-json-block, qa-unclear-state
- acceptance criteria:
  - `tests/all.js` includes any new standalone tests not auto-discovered.
  - No duplicate test registrations are introduced.
- tests to write:
  - unit: N/A
  - component: N/A
  - integration: N/A
  - api: N/A
- files to touch:
  - `tests/all.js`
