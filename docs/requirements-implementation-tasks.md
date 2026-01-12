# Requirements Implementation Tasks

Each task includes a slug, title, detailed description, files to touch, tests, dependencies, and acceptance criteria. Execute tasks in dependency order.

---

## 1) guidance-doc-create
- Title: Create project guidance document with tech stack, docdex usage, and folder tree
- Description:
  - Create a new `docs/project-guidance.md` document that includes:
    - Project summary and general context for mcoda.
    - What is being built (core CLI/services, task execution pipeline, doc generation, QA/review flows).
    - Canonical tech stack (TypeScript, Node, React where applicable, MySQL/SQLite/Redis where relevant, Bash when needed) and an explicit directive **not** to deviate without doc approval.
    - A detailed planned folder tree of the repo, including scripts, prompts, docs, tests, and packages.
    - A “Docdex usage” section that instructs agents to use docdex search, AST, impact graph, code intelligence, web research when uncertain, repo memory store/recall, agent memory profile read/write, and to consult repo/agent memory for guidance.
    - A “Reuse & safety” section instructing agents to search for existing classes/methods before creating new ones, use AST/impact graph to avoid duplicates, and track prior task work.
    - A “Testing discipline” section instructing that any new test script must be added to `tests/all.js` and run in the final run-all step.
- Files to touch:
  - `docs/project-guidance.md`
- Unit tests:
  - N/A (doc-only)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: None
- Acceptance criteria:
  - `docs/project-guidance.md` exists and includes all required sections and instructions.
  - Includes the planned folder tree and tech stack directive.
  - Docdex usage guidance covers repo memory and agent memory expectations.

---

## 2) project-guidance-loader
- Title: Add a shared helper to load project guidance
- Description:
  - Add a small shared utility (e.g., `packages/core/src/services/shared/ProjectGuidance.ts`) to load guidance text from `docs/project-guidance.md` (and `.mcoda/docs/project-guidance.md` if present).
  - The helper should return `{ content, source }` or `null` when missing and log a warning when not found.
  - Ensure paths are workspace-relative and use UTF-8 reads.
- Files to touch:
  - `packages/core/src/services/shared/ProjectGuidance.ts` (new)
  - `packages/core/src/index.ts` (export helper if needed)
- Unit tests:
  - `packages/core/src/services/shared/__tests__/ProjectGuidance.test.ts` (new)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: guidance-doc-create
- Acceptance criteria:
  - Helper loads guidance content when file exists and returns `null` when missing.
  - Unit test coverage verifies both paths.

---

## 3) work-on-tasks-guidance-injection
- Title: Prepend project guidance to work-on-tasks prompts
- Description:
  - Use the shared guidance loader in `WorkOnTasksService`.
  - Prepend guidance content to the task prompt (at the very top) so agents see global context before task details.
  - Log which guidance file was used.
- Files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
- Unit tests:
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: project-guidance-loader
- Acceptance criteria:
  - Work-on-tasks prompt starts with guidance content when file exists.
  - Tests assert guidance is present in logged/persisted prompt content.

---

## 4) code-review-guidance-injection
- Title: Prepend project guidance to code-review prompts
- Description:
  - Use the shared guidance loader in `CodeReviewService`.
  - Ensure guidance content appears at the beginning of the review prompt or system prompt so reviewers see the global context.
  - Log which guidance file was used.
- Files to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
- Unit tests:
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: project-guidance-loader
- Acceptance criteria:
  - Code-review prompt starts with guidance content when file exists.
  - Tests verify prompt injection.

---

## 5) qa-guidance-injection
- Title: Prepend project guidance to QA prompts
- Description:
  - Use the shared guidance loader in `QaTasksService`.
  - Ensure guidance is included at the top of the QA agent prompt.
  - Log which guidance file was used.
- Files to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
- Unit tests:
  - `packages/core/src/services/execution/__tests__/QaTasksService.test.ts`
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: project-guidance-loader
- Acceptance criteria:
  - QA prompt includes guidance content when file exists.
  - Tests verify guidance injection.

---

## 6) pdr-prompts-tech-stack
- Title: Add Technology Stack section to PDR prompts
- Description:
  - Update PDR runbook/character/job prompts to require a **Technology Stack** section.
  - Explicitly instruct default stack selection (TypeScript/React/MySQL/Redis/Bash) unless domain clearly indicates another stack (e.g., ML → Python).
- Files to touch:
  - `packages/core/src/prompts/PdrPrompts.ts`
- Unit tests:
  - N/A (covered by DocsService tests below)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: None
- Acceptance criteria:
  - PDR runbook includes Technology Stack section requirements and default stack guidance.

---

## 7) pdr-structure-tech-stack
- Title: Enforce Technology Stack section in PDR generation
- Description:
  - Extend `PDR_REQUIRED_HEADINGS` and structured draft generation to include **Technology Stack**.
  - Add fallback logic that inserts a default stack when missing (TypeScript/React/MySQL/Redis/Bash) and uses Python stack when context indicates ML/neural workloads.
  - Update the PDR tidy prompt to preserve the new section.
- Files to touch:
  - `packages/core/src/services/docs/DocsService.ts`
- Unit tests:
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts`
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: pdr-prompts-tech-stack
- Acceptance criteria:
  - PDR output always includes a Technology Stack section.
  - Default stack appears when no tech is specified.
  - Tests validate behavior.

---

## 8) sds-template-folder-tree
- Title: Add Planned Folder Tree section to SDS template and prompts
- Description:
  - Update SDS runbook and template to include a **Planned Folder Tree** section.
  - Ensure SDS generation logic retains the section.
- Files to touch:
  - `packages/core/src/prompts/SdsPrompts.ts`
- Unit tests:
  - `packages/core/src/services/docs/__tests__/DocsService.test.ts` (if SDS generation tests cover headings)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: None
- Acceptance criteria:
  - SDS prompts/templates contain the Planned Folder Tree section.

---

## 9) sds-doc-folder-tree
- Title: Insert detailed planned folder tree into the SDS document
- Description:
  - Add a detailed folder tree to `docs/sds/sds.md` under a new “Planned Folder Tree” section.
  - Include planned scripts (e.g., `tests/all.js`) and final structure.
- Files to touch:
  - `docs/sds/sds.md`
- Unit tests:
  - N/A (doc-only)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: sds-template-folder-tree
- Acceptance criteria:
  - `docs/sds/sds.md` includes a detailed folder tree matching current/planned structure.

---

## 10) work-on-tasks-run-all-tests
- Title: Run run-all-tests script after each task and iterate on failures
- Description:
  - Detect the run-all tests script (default `node tests/all.js`).
  - After per-task tests pass, run the run-all script.
  - On failure, provide failure summary to the agent and re-run the agent + tests until all pass or max attempts reached.
  - Block the task with `tests_failed` or `tests_not_configured` as appropriate.
- Files to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
- Unit tests:
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: work-on-tasks-guidance-injection
- Acceptance criteria:
  - Run-all tests execute at the end of each task.
  - Failures trigger fix-and-retry loop.
  - Task only finalizes after run-all tests pass.

---

## 11) run-all-tests-registry
- Title: Ensure run-all-tests script is updated for new tests
- Description:
  - Update `tests/all.js` to include any newly added tests from this implementation.
  - Add guidance in the script (comment) about registering new tests.
- Files to touch:
  - `tests/all.js`
- Unit tests:
  - N/A (script-only)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: work-on-tasks-run-all-tests, pdr-structure-tech-stack, sds-template-folder-tree, code-review-guidance-injection, qa-guidance-injection
- Acceptance criteria:
  - `tests/all.js` includes new tests added by tasks.
  - Script still runs successfully.

---

## 12) task-creation-test-requirements-audit
- Title: Validate task creation includes test requirements everywhere
- Description:
  - Audit `CreateTasksService` schema, prompt, and metadata to ensure test requirement arrays are captured.
  - Update docs in SDS/usage if any gaps exist.
  - Ensure tasks include test requirements in description and metadata consistently.
- Files to touch:
  - `packages/core/src/services/planning/CreateTasksService.ts`
  - `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`
  - `docs/sds/sds.md` (if documentation updates needed)
- Unit tests:
  - `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: None
- Acceptance criteria:
  - Tests confirm test requirement arrays are persisted and described.
  - Docs reflect the test requirement fields.

---

## 13) prompt-test-discipline
- Title: Reinforce test discipline and run-all updates in agent prompts
- Description:
  - Update `prompts/code-writer.md` (and/or command prompts) to explicitly instruct agents to:
    - Create required tests (unit/component/integration/api) when relevant.
    - Add new test scripts to `tests/all.js`.
    - Run task-specific tests first and `node tests/all.js` at the end.
- Files to touch:
  - `prompts/code-writer.md`
  - `.mcoda/prompts/code-writer.md` (if needed for default copy)
- Unit tests:
  - N/A (prompt-only)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: run-all-tests-registry
- Acceptance criteria:
  - Prompt text includes explicit instructions for test creation and run-all script updates.

---

## 14) final-alignment-and-review
- Title: End-to-end alignment review and cleanup
- Description:
  - Run a code review of all changes.
  - Reconcile plan vs tasks vs implementation; fix any gaps.
  - Re-run full test suite until green.
- Files to touch:
  - Any discovered gaps
- Unit tests:
  - N/A (verification task)
- Component tests:
  - N/A
- Integration tests:
  - N/A
- API tests:
  - N/A
- Dependencies: All prior tasks
- Acceptance criteria:
  - No mismatches between plan, tasks, and implementation.
  - All tests pass via `node tests/all.js`.
