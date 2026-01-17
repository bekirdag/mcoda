# Gateway Trio Fix Plan (Logs/2.txt)

## Goal
Stabilize gateway-trio so it reliably completes tasks (work -> review -> QA) with correct prompts, deterministic docdex context, robust task lifecycle handling, and consistent test/QA execution. This plan covers mcoda fixes and lists docdex repo fixes as external dependencies.

## Inputs
- `docs/gateway-trio-log-issues-2.md`
- `docs/gateway-trio-log-issues-2-categorized.md`

## Non-Goals
- Fixing application-level defects in `test-web-app` (those will be handled by project tasks, but mcoda must surface them consistently).

## Plan Overview
- Phase 0: Baseline + safety checks
- Phase 1: Prompt pipeline + schema validation
- Phase 2: Docdex integration in mcoda (repo scoping, context resolution, prompt cleanup)
- Phase 3: Task lifecycle + streaming stability
- Phase 4: Patch format enforcement + path validation
- Phase 5: QA/test orchestration
- Phase 6: Validation + regression runs
- External: Docdex repo fixes

---

## Phase 0: Baseline and guardrails
1) **Inventory current behavior**
   - Capture current prompt assembly paths, task runner states, and QA command execution.
   - Confirm where gateway-trio writes logs/state and how `--watch` is streamed.
   - Files to inspect: `packages/core/src/services/execution/GatewayTrioService.ts`, `packages/core/src/services/execution/WorkOnTasksService.ts`, `packages/core/src/services/review/CodeReviewService.ts`, `packages/core/src/services/execution/QaTasksService.ts`, `packages/cli/src/commands/work/GatewayTrioCommand.ts`.

2) **Lock on desired output contracts**
   - Document final expected output formats per agent role (gateway JSON, code-writer FILE diff, reviewer JSON, QA report JSON).
   - Source prompts: `prompts/gateway-agent.md`, `prompts/code-writer.md`, `prompts/code-reviewer.md`, `prompts/qa-agent.md`.

Deliverable: baseline notes and a confirmed output contract matrix (stored in this plan doc or an accompanying checklist).

---

## Phase 1: Prompt pipeline + schema validation (mcoda)

### 1A) De-duplicate prompts and remove contamination
- Implement a single-role prompt pipeline that emits exactly one prompt block per agent run.
- Remove gateway JSON-only instructions and docdex JSON-only guidance from non-gateway agents.
- Remove persona text injected before code-writer prompts.
- Files likely to touch:
  - `packages/core/src/services/agents/AgentService.ts`
  - `packages/core/src/services/agents/PromptService.ts` (or equivalent prompt builder)
  - `prompts/code-writer.md`, `prompts/code-reviewer.md`, `prompts/qa-agent.md`, `prompts/gateway-agent.md`

### 1B) Gateway schema alignment
- Align gateway schema validator to match the prompt schema (`filesLikelyTouched`, `filesToCreate` only).
- Ensure gateway output does not require a `files` field.
- Files likely to touch:
  - `packages/core/src/services/agents/GatewayAgentService.ts`
  - `packages/core/src/services/agents/GatewayHandoff.ts` (or equivalent)
  - Tests: `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts`, `packages/core/src/services/agents/__tests__/GatewayHandoff.test.ts`

### 1C) Review routing discipline
- Skip gateway-router planning for code-review and QA jobs.
- Ensure `discipline` is set appropriately for routing and telemetry (e.g., `review`, `qa`).
- Files likely to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/execution/GatewayTrioService.ts`

Acceptance criteria:
- A single prompt block is delivered per agent run.
- Non-gateway agents never receive JSON-only gateway schema instructions.
- Gateway outputs validate on first pass.
- Code-review jobs do not invoke gateway-router.

---

## Phase 2: Docdex integration in mcoda

### 2A) Enforce repo scoping in all docdex calls
- Require repo ID or repo path on every docdex request.
- Add a preflight assertion and a clear error if missing.
- Files likely to touch:
  - `packages/integrations/src/docdex/DocdexClient.ts`
  - `packages/core/src/services/shared/WorkspaceResolver.ts`
  - `packages/core/src/services/agents/*` (any service that uses docdex)

### 2B) Resolve `docdex:` references to snippets
- Resolve doc references into actual snippets before injecting into agent context.
- If no match, add a structured note (do not pass the raw `docdex:` tag).
- Files likely to touch:
  - `packages/core/src/services/shared/DocContextService.ts` (or equivalent)
  - `packages/core/src/services/agents/GatewayHandoff.ts`

### 2C) Context ordering and filtering
- Always prepend `docs/project-guidance.md` before docdex or prompt content.
- Filter doc context based on task type; exclude QA-only docs from code tasks.
- Strip `.mcoda/docs` artifacts from context.
- Files likely to touch:
  - `packages/core/src/services/shared/ProjectGuidanceService.ts`
  - `packages/core/src/services/shared/DocContextService.ts`
  - `packages/core/src/services/agents/PromptService.ts`

### 2D) Prompt docdex guidance cleanup
- Standardize daemon command and port (use one canonical example).
- Remove MCP references and `.docdex/` references.
- Files likely to touch:
  - `prompts/gateway-agent.md`, `prompts/code-writer.md`, `prompts/code-reviewer.md`, `prompts/qa-agent.md`

Acceptance criteria:
- All docdex calls are scoped to the repo.
- `docdex:` references resolve to snippets or a structured “not found” note.
- Project guidance appears first in every agent prompt.
- Docdex guidance in prompts is consistent and daemon-only.

---

## Phase 3: Task lifecycle + streaming stability

### 3A) Progress reporting and stream safety
- Emit ticker/progress output to stderr or a separate stream.
- Start progress only after task list is known.
- Handle SIGPIPE / BrokenPipe explicitly when redirecting output.
- Files likely to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/cli/src/commands/work/GatewayTrioCommand.ts`

### 3B) Task execution reliability
- Reject `[RUN]` pseudo-tasks during selection.
- Treat zero-token runs as infra errors and retry with backoff.
- Prevent completed tasks from being re-queued within the same run.
- Require justification for `COMPLETED_NO_CHANGES` and track it in comments.
- Files likely to touch:
  - `packages/core/src/services/execution/GatewayTrioService.ts`
  - `packages/db/src/repositories/tasks/TaskRepository.ts` (if state tracking needs updates)

### 3C) Review/QA feedback loop
- Enforce comment schema (slug + file + line) and inject unresolved comments into subsequent runs.
- Avoid creating follow-up tasks for review comments unless explicitly requested; otherwise update the original task comments.
- Require SP/complexity for generated tasks.
- Files likely to touch:
  - `packages/core/src/services/review/CodeReviewService.ts`
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/db/src/repositories/tasks/TaskCommentRepository.ts`

Acceptance criteria:
- Progress output does not interleave with agent output.
- Completed tasks do not re-run in the same job.
- Review/QA comments are re-injected with file/line metadata.

---

## Phase 4: Patch format enforcement + path validation

### 4A) Patch output enforcement
- Validate output type before applying patches; reject non-patch outputs.
- Use a strict patch-only fallback prompt when the initial output is invalid.
- Files likely to touch:
  - `packages/core/src/services/execution/WorkOnTasksService.ts`
  - `packages/core/src/services/agents/OutputValidator.ts` (or equivalent)

### 4B) Path verification and normalization
- Preserve `filesLikelyTouched` and `filesToCreate` in handoffs.
- Require docdex verification of file paths before editing.
- Block cross-project paths and normalize case/casing.
- Files likely to touch:
  - `packages/core/src/services/agents/GatewayHandoff.ts`
  - `packages/core/src/services/shared/PathHelper.ts`

Acceptance criteria:
- Patch-only enforcement prevents narrative/JSON outputs from being applied.
- Handoff files remain intact and are used by work agents.
- Cross-project paths are rejected before edits occur.

---

## Phase 5: QA/test orchestration

### 5A) Run-all tests script improvements
- Update `tests/all.js` to run TS/Vitest suites and package-level test scripts.
- Replace absolute Node paths with `node` or `pnpm`.
- Files likely to touch:
  - `tests/all.js`
  - `scripts/run-node-tests.js`
  - `package.json`

### 5B) QA runner and Playwright handling
- Verify Playwright availability and block QA if not installed, with clear `docdex setup` guidance.
- Avoid `npx` auto-installs.
- If no tests are found, emit a “missing tests” action rather than a silent failure.
- Files likely to touch:
  - `packages/integrations/src/qa/ChromiumQaAdapter.ts`
  - `packages/core/src/services/execution/QaTasksService.ts`

### 5C) QA dependency/environment preflight
- Preflight checks for `pg`, `ioredis`, `argon2`, and test env vars (`TEST_DB_URL`, `TEST_REDIS_URL`).
- Update QA plans to avoid referencing obsolete Jest configs.
- Files likely to touch:
  - `packages/core/src/services/execution/QaTasksService.ts`
  - `packages/core/src/services/shared/DependencyChecker.ts` (if exists)

Acceptance criteria:
- `node tests/all.js` runs JS + TS suites.
- QA fails fast with actionable setup instructions when deps or env are missing.
- Playwright does not auto-install during QA.

---

## Phase 6: Validation + regression runs

1) **Unit/integration tests**
   - Update/add tests covering:
     - Prompt de-duplication and ordering
     - Gateway schema validation
     - Task selection filters (reject `[RUN]`)
     - Comment injection and slug schema
     - Run-all tests runner behavior
   - Test suites likely to touch:
     - `packages/core/src/services/execution/__tests__/GatewayTrioService.test.ts`
     - `packages/core/src/services/agents/__tests__/GatewayAgentService.test.ts`
     - `packages/cli/src/__tests__/GatewayTrioCommand.test.ts`
     - `tests/all.js`

2) **Gateway-trio end-to-end check**
   - Rebuild CLI and run gateway-trio on 10-20 tasks in `test-web-app`.
   - Ensure:
     - work -> review -> QA loop closes tasks properly
     - no duplicate prompts or JSON-only leakage
     - no 0-token failures
     - logs clean and progress stable

---

## External Dependency: Docdex Repo Fixes
These are required for full stability but must be implemented in the docdex repo:
- D1: Lock path + Ollama optionality
- D2: Auto-reindex on stale index
- D3: Open-by-path for YAML/OpenAPI
- D4: Deterministic doc type classification
- D5: Snippet integrity + ignore hidden directories

Acceptance criteria (docdex):
- docdexd runs without lock errors in restricted environments
- stale index is auto-handled or clearly actionable
- open-by-path works for `openapi/*.yaml`
- doc types are correctly classified by path
- `.mcoda/` and build artifacts are excluded by default

---

## Exit Criteria
- No prompt duplication or cross-role JSON-only leakage.
- Gateway-trio completes a 10+ task run without re-queueing completed tasks or 0-token failures.
- QA runs are deterministic with clear dependency checks.
- Docdex context is scoped, ordered, and accurate.
- All tests pass: `node tests/all.js`.
