# Mcoda Command Alignment Plan

Date: 2026-01-27
Owner: codex-architect
Status: In progress

## Goal
Ensure set-workspace, create-tasks, work-on-tasks, code-review, and qa-tasks operate in harmony with shared QA/test requirements, chromium-only UI policy, and dynamic base URL handling.

## Scope
- CLI commands: set-workspace, create-tasks, work-on-tasks, code-review, qa-tasks.
- Core services: SetWorkspaceCommand, CreateTasksService, WorkOnTasksService, CodeReviewService, QaTasksService, QaProfileService, QaTestCommandBuilder, ChromiumQaAdapter.
- Prompts: qa-agent, code-writer, code-reviewer, gateway-agent.

## Plan
1. Inventory current behavior and prompt contracts; list mismatches across commands.
2. Verify setup-time dependencies across stacks; ensure missing packages are installed by set-workspace.
3. Confirm create-tasks persists test_requirements + QA readiness metadata (profiles/entrypoints/blockers) for downstream commands.
4. Validate work-on-tasks uses test_requirements to run unit -> component -> integration -> api, and keeps tests/all.js up to date.
5. Ensure code-review prompt surfaces test expectations and chromium-only policy.
6. Validate qa-tasks uses dynamic base URL discovery, chromium-only UI runs, and Docdex-style Chromium reuse.
7. Update docs/prompts to reflect alignment and remove stale port/browser guidance.
8. Update unit tests for any adjusted behavior.
9. Run build/test validation to confirm no regressions.

## Progress Log
- 2026-01-27: Added @jest/globals to Node setup packages; updated node package selection tests.
- 2026-01-27: Confirmed QA base URL handling is dynamic (no hardcoded port defaults) and chromium-only prompts are in place.
- 2026-01-27: Enforced Chromium-only env overrides for CLI browser tools and ensured Cypress flags are normalized.
- 2026-01-27: Marked old QA prompts as stale when they include hardcoded localhost ports so workspace prompts refresh to dynamic port examples.
