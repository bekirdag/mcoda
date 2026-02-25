# Code-Review Enhancement Implementation Plan

## Objective
Align `mcoda code-review` with the SDS-first workflow:
- PDR -> SDS -> OpenAPI -> create/refine/order -> work -> code-review -> qa
- SDS is the single source of truth
- Review must be project-scoped and context-safe by default

## Scope
- CLI: `packages/cli/src/commands/review/CodeReviewCommand.ts`
- Core service: `packages/core/src/services/review/CodeReviewService.ts`
- Tests:
  - `packages/cli/src/__tests__/CodeReviewCommand.test.ts`
  - `packages/core/src/services/review/__tests__/CodeReviewService.test.ts`

## Planned Changes

### 1) Project Resolution Defaults
- Implement project key fallback for `code-review`:
  - explicit `--project`
  - workspace-configured project key
  - first workspace project in DB
- Emit warnings when fallback/override happens.
- Hard-fail only when no project can be resolved.

### 2) Execution Context Policy
- Add CLI + service support for:
  - `best_effort`
  - `require_any`
  - `require_sds_or_openapi`
- CLI default: `require_sds_or_openapi`.
- Service default remains backward-compatible (`best_effort`) for direct callers.
- Add job-level preflight that blocks once if strict policy cannot be satisfied.

### 3) SDS/OpenAPI-First Doc Context
- Update review doc context retrieval to:
  - prioritize SDS and OPENAPI doc types with project scoping
  - fall back to generic workspace-code context only when structured context is missing
- Keep existing link resolution and dedupe behavior.

### 4) OpenAPI Source Resolution
- Replace hardcoded `openapi/mcoda.yaml` assumption.
- Resolve OpenAPI from:
  - task metadata (`openapi_path`/`openapiPath`)
  - workspace config override
  - OpenAPI-like `doc_links`
  - common repo paths (`openapi/*.yaml`, root/docs alternatives)
  - docdex OPENAPI entries (path/content fallback)

### 5) Review Feedback Loop Integration
- Include `qa-tasks` comments in history/backlog context for review.

### 6) Empty Diff Completion Policy
- Add policy:
  - `complete` (legacy behavior)
  - `ready_to_qa` (strict pipeline behavior)
- CLI default: `ready_to_qa`.
- Service default: `complete` (backward compatibility).

## Validation Plan
1. CLI parser + fallback tests.
2. Core review preflight policy tests.
3. Empty-diff policy tests (`complete` vs `ready_to_qa`).
4. Existing code-review test suite pass after behavior updates.

## Risks and Mitigations
- Risk: stricter defaults block previously passing ad-hoc flows.
  - Mitigation: explicit policy overrides stay available.
- Risk: broader OpenAPI discovery introduces ambiguous file selection.
  - Mitigation: deterministic candidate order and docdex fallback.
