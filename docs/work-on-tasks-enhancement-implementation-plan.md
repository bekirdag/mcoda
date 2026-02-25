# Work-on-Tasks Alignment Implementation Plan

## Objective
Align `mcoda work-on-tasks` with the SDS-first workflow and reduce execution drift by adding safer defaults and deterministic preflight behavior.

## Target Workflow Alignment
1. RFP -> PDR -> SDS
2. OpenAPI generated from SDS
3. Tasks created/refined/ordered from SDS + OpenAPI
4. Work-on-tasks executes implementation using SDS/OpenAPI-grounded context
5. Code-review and QA follow

## Scope
- CLI command behavior:
  - `packages/cli/src/commands/work/WorkOnTasksCommand.ts`
  - `packages/cli/src/__tests__/WorkOnTasksCommand.test.ts`
- Core execution behavior:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/__tests__/WorkOnTasksService.test.ts`
- Documentation and tracking:
  - `docs/work-on-tasks-enhancement-progress.md`

## Planned Changes

### 1. Project Key Defaulting in `work-on-tasks`
- Add project key resolution order:
  1. explicit `--project`
  2. workspace config `projectKey`
  3. first project key found in workspace DB `projects`
- Emit explicit warnings when fallback/override behavior is applied.
- Fail only when no project can be resolved at all.

Acceptance:
- Running `mcoda work-on-tasks` without `--project` uses a deterministic project key when one exists.

### 2. Execution Context Policy Support
- Add command/service support for:
  - `best_effort`
  - `require_any`
  - `require_sds_or_openapi`
- Set CLI default to `require_sds_or_openapi`.
- Keep service-level fallback default backward-compatible (`best_effort`) for direct programmatic callers unless policy is explicitly passed.

Acceptance:
- Policy can be parsed and passed from CLI to service.
- Strict policy can block job start when SDS/OpenAPI planning context is missing.

### 3. Job-level Context Preflight in Work-on-Tasks
- Add preflight in service before task loop:
  - resolve planning context from docdex (SDS first, then OpenAPI, then fallback search)
  - enforce selected execution context policy
  - checkpoint preflight results
- Fail at job level before mutating task state when policy conditions are not met.

Acceptance:
- Preflight rejection produces command failure with no per-task status mutation.

### 4. Base Branch Behavior Correction
- Remove forced `mcoda-dev` override.
- Respect requested/configured branch, normalize `dev -> mcoda-dev`, fallback to default only when none provided.

Acceptance:
- Workspace-configured branch is used by `work-on-tasks`.

### 5. Doc Context Retrieval Tightening
- Update per-task doc context retrieval to prioritize SDS/OpenAPI docdex search before generic workspace-code search.
- Keep existing linked-doc behavior and filtering logic.

Acceptance:
- Feature task prompts prefer SDS/OpenAPI context when available.

## Validation Plan
1. Command parser tests:
- default and explicit execution context policy parsing
- project key selection helper behavior
2. Core execution tests:
- strict execution context policy blocks job when no SDS/OpenAPI context exists
- base branch behavior honors workspace config
3. Regression checks:
- run `work-on-tasks` command/core suites

## Risks
- Existing in-flight branch behavior assumptions may rely on forced `mcoda-dev`.
- Strict policy may block legacy workspaces with poor docdex indexing until SDS/OpenAPI docs are available.

## Mitigations
- Keep policy explicit and logged.
- Keep service default backward-compatible for direct callers.
- Add actionable error messaging in failures.
