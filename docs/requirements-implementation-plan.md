# Requirements Implementation Plan

## Overview
Deliver a fully test-enforced execution flow, richer task metadata for test expectations, explicit tech-stack definition in PDRs, and project-level guidance used by all agent runs. Ensure SDS and guidance docs include the final planned folder tree, and guarantee that every task run ends with a full repository test run and iterative fixes until all tests pass.

## Requirements Coverage Map

1. **Task creation must include unit/component/integration/api test attributes**
   - Add explicit `unitTests`, `componentTests`, `integrationTests`, `apiTests` attributes in task creation prompts and schema.
   - Persist test requirements per task so `work-on-tasks` can generate the correct tests.

2. **Work-on-tasks must run task tests and iterate until passing**
   - Every task run must execute the tests it created (unit/component/integration/api) and retry fixes on failures until passing.
   - Block a task if required tests have no configured command.

3. **Run-all-tests script per project with iterative enforcement**
   - Ensure a canonical run-all script (e.g., `tests/all.js`) executes *all* unit/component/integration/api tests.
   - Any new test script must be registered in the run-all script.
   - After each `work-on-tasks` completion, run the run-all script; if it fails, fix and repeat until green.

4. **PDR must specify explicit technology stack with defaults**
   - PDR prompts and validation must include a “Technology Stack” section.
   - If undefined, default to **TypeScript + React + MySQL + Redis + Bash (as needed)** unless context clearly indicates a different stack (e.g., ML → Python).

5. **Project guidance document**
   - Add a project-specific `docs/project-guidance.md` with summary/context, what is being built, tech stack, and folder tree.
   - Must include instructions to *use* the defined stack and *avoid* switching technologies.
   - Must include docdex usage instructions (search, impact graph, AST, code intelligence, web research, repo memory store/recall, agent memory profile read/write).
   - Must include instructions to avoid duplicate classes/methods by searching for existing ones and checking impact.

6. **SDS must include a detailed planned folder tree**
   - Add a “Planned Folder Tree” section to SDS template and the current SDS doc.
   - Include planned scripts and final structure.

7. **Guidance included at the start of every agent run**
   - `work-on-tasks`, `code-review`, and `qa-tasks` prompts must prepend project guidance content.

8. **Verification and iteration**
   - After all tasks, run code review and fix issues.
   - Perform alignment checks: planned vs. tasked vs. implemented; iterate until perfect.

---

## Implementation Plan (Detailed)

### A) Task Creation Enhancements
1. **Schema & Prompt Updates**
   - Ensure task schema includes `unitTests`, `componentTests`, `integrationTests`, `apiTests`.
   - Update task-generation prompt to explicitly request these lists and to use `[]` when not applicable.

2. **Persist Test Requirements in Metadata**
   - Store as `metadata.test_requirements` with `{ unit, component, integration, api }` arrays.
   - Ensure these are included in task descriptions for visibility.

3. **Tests**
   - Add/extend unit tests in `CreateTasksService` test suite to assert metadata and descriptions carry the test requirements.

### B) Work-on-Tasks: Per-Task Test Loop
1. **Per-Task Tests Execution**
   - Run test commands from `metadata.tests` (string or array).
   - If `metadata.test_requirements` exists but commands are missing, block task with `tests_not_configured`.

2. **Iterative Fix Loop**
   - On test failures, capture a concise failure summary, re-run agent with the failures, and retry within a max attempt budget.
   - Only finalize a task after all required tests pass.

3. **Logging & Metadata**
   - Log test attempts, results, and failure summaries in task logs.
   - Record `test_attempts` and `test_commands` on the task metadata after a successful run.

### C) Run-All-Tests Enforcement
1. **Canonical Script**
   - Treat `tests/all.js` as the run-all tests script (unit/component/integration/api).
   - Update detection and invocation logic to run `node tests/all.js`.

2. **Registration of New Tests**
   - Maintain explicit extra test entries in `tests/all.js` for scripts or dist test paths not auto-discovered.
   - Whenever new test scripts are created, append them to `tests/all.js`.

3. **Run-All Loop Integration**
   - After per-task tests pass, run `node tests/all.js`.
   - On failure, supply failure summary to the agent and loop back to fix and re-test (including per-task tests again).

4. **Fail-Safe Behavior**
   - If run-all script is missing, block with `tests_not_configured` and require remediation.

5. **Tests**
   - Add unit tests to confirm:
     - run-all tests run after task tests.
     - failures trigger retries.
     - success allows finalize.

### D) PDR Tech-Stack Requirements
1. **Prompt Updates**
   - Add “Technology Stack” section to PDR runbook and prompts.
   - Explicitly instruct default stack selection when unspecified.

2. **Structured PDR Enforcement**
   - Extend required headings to include “Technology Stack”.
   - Ensure draft cleanup preserves the tech stack section.
   - Add fallback stack content if missing.

3. **Heuristic Override for Specialized Domains**
   - If context clearly indicates ML/NN, allow a Python stack default instead of TS/React.

4. **Tests**
   - Update doc generation tests to assert presence of Technology Stack section and default logic.

### E) Project Guidance Document
1. **Create `docs/project-guidance.md`**
   - Content must include:
     - Project summary and goals
     - “What we are building” overview
     - Canonical tech stack and prohibition on alternative stacks
     - Detailed planned folder tree
     - Docdex usage instructions (search/impact/AST/code intelligence/web research/repo memory store+recall and agent memory profile read/write)
     - Instructions to check existing classes/methods before adding new ones

2. **Prompt Integration**
   - Prepend guidance to prompts for:
     - `work-on-tasks`
     - `code-review`
     - `qa-tasks`
   - If guidance file is missing, log and proceed with a warning.

3. **Tests**
   - Add tests that verify guidance is injected into prompts.

### F) SDS Folder Tree
1. **SDS Template Update**
   - Add “Planned Folder Tree” section to SDS prompt/template.

2. **Current SDS Update**
   - Insert a detailed folder tree including scripts and planned structure.

3. **Guidance Alignment**
   - Ensure the same folder tree is included in `docs/project-guidance.md`.

4. **Tests**
   - Update SDS generation tests to expect the new section.

### G) End-to-End Verification
1. **Per-Task Testing**
   - For each implementation task: run its unit/component/integration/api tests.
   - Update `tests/all.js` for any new tests.
   - Run `node tests/all.js` after each task and fix failures before continuing.

2. **Final Review**
   - Conduct a code review pass; fix issues until clean.

3. **Alignment Loop**
   - Reconcile plan vs tasks vs implementation; fix any gaps.
   - Repeat until no misalignments remain.

---

## Deliverables
- `docs/requirements-implementation-plan.md` (this plan)
- `docs/requirements-implementation-tasks.md` (detailed tasks list)
- Code updates in core services, prompts, docs, and tests
- Updated `tests/all.js` to include new tests
- Updated SDS and project guidance documents
