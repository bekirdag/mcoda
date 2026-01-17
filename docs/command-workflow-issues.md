# Command Workflow Issues

This document reviews the current workflows for `work-on-tasks`, `code-review`, and `qa-tasks` and lists issues/gaps observed in each.

## work-on-tasks issues
- Base branch is forced to `mcoda-dev` even when workspace config specifies a different base branch, which can merge into the wrong branch in non‑standard repos.
- No‑change detection only blocks for tasks that start in `not_started` or `in_progress`; if a task in `ready_to_review`/`ready_to_qa` is processed, it can be marked ready without any diff.
- Run‑all tests (`tests/all.js`) are required but never auto‑created; when missing, tasks block with `tests_not_configured` and can loop if agents do not add the script.
- Test command discovery is rooted at workspace root only; monorepos or per‑package test commands may be skipped or mis‑detected.
- FILE blocks for existing files are skipped by design; if the agent outputs only FILE blocks for existing files, the run becomes a no‑change and blocks, with no auto‑fallback to patch generation.
- Allowed file scope is only enforced when metadata `files` exists; otherwise tasks can touch any file and still auto‑merge into base.
- The command auto‑merges and optionally pushes to remote without a PR gate; for repos with protected branches, this fails late and blocks with `vcs_failed` instead of proactively warning.

## code-review issues
- Invalid JSON after retry falls back to `info_only`, which advances tasks to `ready_to_qa` even when the review output is unusable; this can let unreviewed changes pass.
- Reviews do not fail on an empty diff; a task with no code changes can still be approved and moved forward.
- Unresolved comment backlog is advisory only; the system does not enforce that open review/QA comments are resolved before approval.
- Resume runs reuse the original selection even if task status has since moved to `completed` or `cancelled`, which can re‑review tasks that should be terminal.
- Only a single JSON retry is attempted; repeated invalid output is not treated as a hard failure by default.
- Docdex context is best‑effort only; there is no reindex fallback or explicit stop when docdex context is missing.

## qa-tasks issues
- QA profile selection is tag/type driven and does not auto‑detect web UI scope; a UI task can be tested with CLI profile only and never exercise Playwright.
- `unclear` outcomes do not change task status but still mark the QA run as failed, which can cause repeated re‑runs with no explicit state transition.
- Adapter install failures block with `qa_infra_issue` but do not consistently instruct the user to run `docdex setup` to install Playwright/browsers.
- When QA agent output is invalid JSON after retry, the flow falls back to raw test results; failures can lose structured evidence or required follow‑ups.
- Follow‑up task creation has no deduplication; repeated QA runs can create identical follow‑up tasks.
- The CLI adapter treats missing/empty test suites as `infra_issue` only if stdout/stderr contain specific markers; silent pass outputs can incorrectly appear as a clean QA.
