# E2E Fixes and Proposed Solutions

## Applied Fixes in mcoda

1) Add `--fast` to docs generation
- Files: `packages/core/src/services/docs/DocsService.ts`, `packages/cli/src/commands/docs/DocsCommands.ts`, `packages/cli/src/__tests__/DocsCommands.test.ts`, `docs/usage.md`
- Summary: Added `--fast` flag to skip enrich/tidy/iterative passes for PDR/SDS.

2) Guard doc service shutdown errors
- Files: `packages/core/src/services/docs/DocsService.ts`
- Summary: Swallow Docdex close errors (`SQLITE_MISUSE`) during shutdown.

3) Prevent invented endpoints without OpenAPI
- Files: `packages/core/src/services/docs/DocsService.ts`
- Summary: Sanitize Interfaces sections when OpenAPI is missing; fix `replaceSection` regex and extend endpoint line stripping.

4) Default doc discovery for `create-tasks`
- Files: `packages/core/src/services/planning/CreateTasksService.ts`
- Summary: Auto-scan `.mcoda/docs`, `docs`, `openapi`; filter `.meta.json` and `*-first-draft.md`; detect OpenAPI doc type.

5) Robust JSON extraction for `create-tasks`
- Files: `packages/core/src/services/planning/CreateTasksService.ts`, `packages/core/src/services/planning/__tests__/CreateTasksService.test.ts`
- Summary: Parse JSON blocks even with `<think>` or duplicate payloads; added a regression test.

6) Normalize invalid epic/task fields
- Files: `packages/core/src/services/planning/CreateTasksService.ts`
- Summary: Normalize epic area and task type; keep only docdex handles in related docs.

7) Improve `refine-tasks` parsing + retry
- Files: `packages/core/src/services/planning/RefineTasksService.ts`
- Summary: Robust JSON extraction, accept arrays/single ops, add retry prompt and warnings for empty ops.

8) Allow gateway agent override even if missing caps
- Files: `packages/core/src/services/agents/GatewayAgentService.ts`
- Summary: Honor explicit override with warning if agent is reachable but missing capabilities.

9) Add gateway-trio agent overrides
- Files: `packages/core/src/services/execution/GatewayTrioService.ts`, `packages/cli/src/commands/work/GatewayTrioCommand.ts`
- Summary: Added `--work-agent`, `--review-agent`, `--qa-agent` flags and request fields to bypass codex when needed.

10) Use run-all tests script as fallback per-task command
- Files: `packages/core/src/services/execution/WorkOnTasksService.ts`
- Summary: If test requirements exist and no test command is configured, fall back to `tests/all.js` when present.

## Workarounds Applied in <PROJECT_NAME>

- Added placeholder run-all tests script at `<WORKSPACE_ROOT>/tests/all.js` to allow `work-on-tasks` to proceed.

## Remaining / Proposed Fixes

1) Gateway agent output format compliance
- Problem: gateway outputs invalid schema (missing fields, placeholder paths, non-ASCII), causing low-quality handoffs.
- Proposed fix: stricter validation with automatic re-prompting until valid JSON or fail fast with explicit errors.

2) Code-writer patch compliance
- Problem: some models refuse to output patch format or return prose.
- Proposed fix: add a patch-extractor fallback + model fallback chain (e.g., try `glm-worker` then `codellama`), or enforce a “patch-only” validator that triggers retries.

3) Project guidance doc auto-generation
- Problem: no `docs/project-guidance.md` found during task runs.
- Proposed fix: add a `docs project-guidance generate` command and auto-run it before `work-on-tasks`/`gateway-trio` when missing.

4) `gateway-trio` selection when repo is docs-only
- Problem: tasks run against an empty repo (no app code) create heavy scaffolding or fail.
- Proposed fix: detect doc-only repo and generate scaffolding tasks first (or prompt user to initialize a template).
