# Gateway Trio Perfection Iteration Runbook

This document captures the repeatable loop to harden gateway-trio until it reliably completes work → review → QA and closes tasks.

## Purpose
Ensure gateway-trio can:
- Complete all tasks in a project backlog.
- Loop work/review/QA until tasks pass.
- Record reviewer/QA comments and let work-on-tasks resolve them on subsequent iterations.
- Evaluate agents (rating + complexity) after each run.

## Preconditions
- mcoda repo: `<MCODA_REPO_ROOT>`
- Test project: `<WORKSPACE_ROOT>`
- Test project includes `docs/rfp.md` and task backlog in `.mcoda/mcoda.db`.
- CLI built locally (see build step below).

## Iteration Loop (repeat until no issues remain)

### 1) Capture issues from a full gateway-trio run
- Build CLI (latest changes):
  - `pnpm install`
  - `pnpm -r run build`
  - `npm i -g ./packages/cli`
- Run gateway-trio on 20 untouched tasks:
  - `mcoda gateway-trio --workspace-root <WORKSPACE_ROOT> --project <PROJECT_KEY> --limit 20 --max-iterations 10 --max-cycles 10`
  - `--max-iterations`/`--max-cycles` are optional (default is unlimited); set explicit caps only if you want bounded runs.
  - Optional: add `--max-agent-seconds 600` if you want a 10-minute cap per agent step; timeouts are otherwise disabled by default.
- Record issues in `docs/gateway-trio-20-task-test-issues.md`:
  - Describe what happened, what you tried, and why it failed.
  - Include job IDs, task keys, and relevant logs.

### 2) Categorize issues + plan
- Group issues into categories:
  - Agent output/JSON parsing
  - Task state transitions (blocked/ready_to_review/ready_to_qa)
  - Test/QA gating (missing tests, infra issues, run-all marker)
  - Resume/lock handling
  - Agent routing/rating/complexity
  - Timeouts/heartbeats
- Write a plan in `docs/gateway-trio-issues-plan.md` with concrete fixes.

### 3) Create tasks document
- Create/refresh `docs/gateway-trio-issues-tasks.md`:
  - Each task must include: slug, title, detailed description, files to touch, tests to write (unit/component/integration/api), dependencies, acceptance criteria, priority.
  - Split tasks to be as granular as possible.

### 4) Implement tasks one-by-one
For each task in `docs/gateway-trio-issues-tasks.md`:
- Implement the change.
- Write the tests specified by the task.
- Update `tests/all.js` if a new test script was introduced.
- Run task-specific tests, then `node tests/all.js`.
- Fix issues until all tests pass before moving to the next task.

### 5) Rebuild CLI
- `pnpm -r run build`
- `npm i -g ./packages/cli`

### 6) Re-run gateway-trio
- Run gateway-trio on 20 untouched tasks.
- Ensure agent rating + complexity evaluation runs for each command.
- Update `docs/gateway-trio-20-task-test-issues.md` with new issues.

### 7) Repeat
- If any issue remains, return to step 2.
- Stop only when gateway-trio completes all tasks, reviews, and QA without new issues.

## Notes
- Always use `docs/project-guidance.md` and docdex context in agent prompts.
- QA requires automated tests; browser testing only when a web UI exists.
- `tests/all.js` must emit `MCODA_RUN_ALL_TESTS_COMPLETE` for QA validation.
