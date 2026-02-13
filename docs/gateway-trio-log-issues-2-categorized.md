# Gateway Trio Log Issues (logs/2.txt) - Merged and Categorized

## Source
- Log: `/Users/bekirdag/Downloads/logs/2.txt`
- Job ID: `4dee8866-4525-43df-bdc6-650ee6d882c9`
- Source list: `docs/gateway-trio-log-issues-2.md` (issues 1-75)

## Docdex Repo Fixes (apply in docdex repo)

### D1) Daemon startup/locking and Ollama dependency handling
- Source issues: #4
- Cause: docdexd attempts to use a global lock path that is not writable in some environments, and hard-depends on Ollama being reachable.
- Impact: docdex search/AST/memory/DAG is unavailable during gateway/review/QA runs, so agents operate without repo context.
- Fix:
  - Move lock files to a repo-scoped or user-writable path (e.g., `~/.docdex/locks` or OS temp) and allow override via env var.
  - Treat Ollama as optional when not configured; return a degraded status but keep local index features available.
  - Improve error surfaces so callers can detect and retry with a clear remediation hint.

### D2) Index freshness and auto-reindex behavior
- Source issues: #32
- Cause: docdex returns `stale_index` but does not self-heal or prompt a deterministic auto-reindex path.
- Impact: symbol/impact lookups are skipped; planning and QA run on docs only.
- Fix:
  - Add an auto-reindex option (or one-shot retry) when `stale_index` is detected.
  - Make stale-state visible in a machine-readable field so callers can react consistently.
  - Add tests that simulate stale index -> auto-reindex -> successful query.

### D3) File/path lookup gaps for explicit targets
- Source issues: #49
- Cause: file-path lookup does not resolve paths like `openapi/mcoda.yaml` to doc IDs (likely a path-index or YAML ingestion gap).
- Impact: docdex reports "no matching documents" even for explicit paths, causing agents to work without file context.
- Fix:
  - Ensure YAML and OpenAPI files are indexed and addressable by full path and relative path.
  - Add a dedicated "open by path" lookup that bypasses semantic search when a path is explicit.
  - Add regression tests for path-based lookup for YAML and MD files.

### D4) Doc type classification and code/doc labeling
- Source issues: #29, #63, #70, #72
- Cause: doc type classification mislabels PDR as SDS, SDS as OPENAPI, and code files as SDS.
- Impact: agents interpret the wrong document type and follow incorrect contracts.
- Fix:
  - Implement deterministic path-based typing (e.g., `docs/pdr/*` => PDR, `docs/sds/*` => SDS, `openapi/*` => OPENAPI, non-doc paths => CODE).
  - Provide a doc_type field in metadata that callers can trust.
  - Add fixture tests to confirm correct labeling.

### D5) Context truncation and hidden directory leakage
- Source issues: #41, #51, #60
- Cause: snippet extraction truncates or cuts lines mid-stream and includes hidden/generated files like `.mcoda/docs`.
- Impact: corrupted excerpts and internal rewrite notes leak into context and degrade spec quality.
- Fix:
  - Make snippet extraction line-safe and length-bounded without mid-line truncation.
  - Add default ignore patterns for `.mcoda/`, `node_modules/`, and build artifacts (configurable).
  - Add tests for snippet integrity and ignore rules.

## Mcoda Fixes (apply in mcoda repo)

### A) Prompt composition, contracts, and schema alignment

**A1) Prompt duplication and contamination**
- Source issues: #25, #59, #61, #74, #38, #62
- Cause: multiple prompt blocks are concatenated; gateway JSON-only instructions and docdex JSON-only guidance leak into code-writer/reviewer prompts; persona text is injected.
- Impact: agents emit JSON instead of patches or reviews; patch application fails; tokens are wasted.
- Fix:
  - Build a single prompt pipeline that selects one role prompt only.
  - Strip JSON-only instructions from non-gateway prompts.
  - Remove persona text and dedupe prompt blocks before dispatch.

**A2) Schema/validator mismatch**
- Source issues: #43, #44
- Cause: validator expects `files` while schema defines `filesLikelyTouched`/`filesToCreate`.
- Impact: valid gateway outputs are rejected, causing retries and latency.
- Fix:
  - Align the validator with the schema.
  - Add a schema test that fails if required keys drift.

**A3) Review routing and discipline tagging**
- Source issues: #69, #73
- Cause: code-review jobs invoke gateway-router planning and label discipline as `qa`.
- Impact: extra model calls, routing confusion, and incorrect agent selection.
- Fix:
  - Skip gateway planning for review/QA jobs.
  - Set discipline to `review` for review jobs and validate in tests.

**A4) Conflicting merge-conflict instructions**
- Source issues: #17
- Cause: work prompt says "resolve conflicts" while review prompt says "stop and report".
- Impact: inconsistent and unsafe agent behavior.
- Fix:
  - Unify policy to "stop and report; do not resolve" across prompts.

### B) Context injection and docdex integration in mcoda

**B1) Missing repo scoping in docdex calls**
- Source issues: #16
- Cause: mcoda does not consistently pass repo ID or repo path to docdex.
- Impact: `missing_repo` errors; empty context for gateway/review/QA.
- Fix:
  - Require repo scoping on every docdex request.
  - Add a preflight check in gateway/review/QA to assert repo ID is present.

**B2) `docdex:` references are not resolved**
- Source issues: #53
- Cause: doc references are passed through without resolving to snippets.
- Impact: agents cannot open referenced docs and guess instead.
- Fix:
  - Resolve `docdex:` references to docdex snippets or local file content before injection.

**B3) Context pollution and ordering**
- Source issues: #11, #40, #41, #60, #27
- Cause: unrelated docs (QA/e2e) and `.mcoda` artifacts are injected; project guidance is not first; SDS still contains placeholders.
- Impact: agents drift from spec and ignore critical guidance.
- Fix:
  - Filter doc context by task scope (exclude QA docs unless the task is QA/documentation).
  - Prepend project guidance at the very top of every prompt.
  - Enforce a validation step for SDS to eliminate placeholders and tooling notes.

**B4) Docdex guidance quality in prompts**
- Source issues: #22, #28, #67, #71
- Cause: prompts include MCP instructions, `.docdex` references, and conflicting daemon commands/ports.
- Impact: agents follow incorrect setup and fail to reach docdex.
- Fix:
  - Remove MCP references and `.docdex` mentions.
  - Standardize a single daemon command and port in all prompts.

### C) Task lifecycle, progress, and streaming stability

**C1) Progress reporting and stream corruption**
- Source issues: #1, #24, #50, #31, #15
- Cause: progress ticker writes into agent streams; job starts at 0/0; duplicate output; BrokenPipe on redirection.
- Impact: noisy logs and parsing risk; misleading status during `--watch`.
- Fix:
  - Emit progress to stderr or a separate channel.
  - Start ticker only after task count is known.
  - Handle SIGPIPE explicitly to avoid BrokenPipe noise.

**C2) Task execution anomalies (zero-token failures, re-queues)**
- Source issues: #45, #54, #55, #56, #57
- Cause: placeholder tasks and normal tasks fail without any model call; completed tasks are re-queued and re-run; long runs end as `COMPLETED_NO_CHANGES`.
- Impact: cycles and token budgets are wasted; status becomes unreliable.
- Fix:
  - Validate task IDs (reject `[RUN]` entries upfront).
  - Treat zero-token runs as infra errors and retry with backoff.
  - Lock completed tasks per cycle and prevent re-queueing.
  - Require explicit confirmation for `COMPLETED_NO_CHANGES` with a justification string.

**C3) Review/QA comment loop and metadata integrity**
- Source issues: #14, #26, #30, #48, #66
- Cause: comments lack file/line; open slugs are not injected; review creates new tasks with unrelated acceptance criteria; SP 0 tasks.
- Impact: feedback is not actionable; backlog gets polluted; scheduling skewed.
- Fix:
  - Enforce comment schema: slug + file path + line number.
  - Always inject unresolved comments into the next work/review/QA run.
  - Use comments instead of follow-up tasks by default; if creating tasks, copy only relevant acceptance criteria.
  - Require SP/complexity in follow-up tasks.

### D) File/path resolution and patch application

**D1) Patch output contract failures**
- Source issues: #2, #23, #38
- Cause: agents emit narrative summaries or JSON instead of file patches; repair loop lacks strict enforcement.
- Impact: patch application fails; tasks stall.
- Fix:
  - Validate output format before attempting patch apply.
  - Use stricter patch-only prompts when a patch is required.
  - Fail fast with a retry policy that swaps to a patch-only model.

**D2) File path guessing and mismatch**
- Source issues: #10, #19, #37, #46, #52, #58, #65, #68
- Cause: gateway drops file lists; agents guess file paths or mix path conventions; cross-project paths leak; handoffs fabricate code state.
- Impact: edits target the wrong files, causing patch failures and regressions.
- Fix:
  - Preserve `filesLikelyTouched`/`filesToCreate` in the handoff.
  - Require docdex search for path confirmation and block edits when paths are unverified.
  - Enforce repo-root validation to prevent cross-project paths.
  - Normalize canonical paths and casing per repo.

### E) QA/test execution and tooling

**E1) Run-all tests orchestration gaps**
- Source issues: #6, #20, #21, #47
- Cause: `tests/all.js` stops after JS suites; root `npm test` runs only JS; run-all command is hard-coded to a local Node binary.
- Impact: TS/Vitest suites never execute and QA reports false "No tests found" failures.
- Fix:
  - Update `tests/all.js` to call each package test script and TS test runner.
  - Replace absolute Node path with `node` or `pnpm test`.

**E2) Playwright lifecycle and discovery**
- Source issues: #12, #13, #33
- Cause: Playwright is not installed via docdex setup; QA uses `npx` ad-hoc; tests are missing.
- Impact: browser QA fails or gets skipped.
- Fix:
  - Check for Playwright availability and prompt `docdex setup` when missing.
  - Avoid `npx` auto-installs in QA; use deterministic installation.
  - If no tests are found, emit a targeted "missing tests" action instead of failing silently.

**E3) Dependency/env gaps in QA**
- Source issues: #5, #7, #18, #64, #75, #34
- Cause: missing Argon2/pg/ioredis/Jest deps, missing DB/Redis env vars, and test plans referencing obsolete Jest configs.
- Impact: tests fail or skip; QA cannot validate requirements.
- Fix:
  - Preflight dependency/env checks before QA.
  - Update test plans to current runners.
  - Fail fast with explicit setup guidance.

### F) Project implementation defects surfaced (test-web-app)
These are application-level defects identified by gateway-trio. Mcoda should ensure they are captured and looped back into tasks, but fixes live in the project code.

**F1) Security and route wiring gaps**
- Source issues: #8, #35, #65
- Cause: missing auth middleware wiring, missing cookie parser, insecure JWT default, ambiguous entrypoint/routes.
- Impact: unprotected endpoints and incorrect auth behavior.
- Fix: mount routes/middleware properly, enforce JWT secret configuration, register cookie parser, standardize entrypoint and route names.

**F2) Contract and stack drift**
- Source issues: #9, #36
- Cause: OpenAPI path mismatch and pg usage in a Prisma-based project.
- Impact: spec drift and inconsistent data access layer.
- Fix: align routing and OpenAPI; keep data access consistent with stack (Prisma vs raw pg).

**F3) Missing runtime dependencies**
- Source issues: #34
- Cause: required deps (`pg`, `ioredis`) are not declared.
- Impact: runtime crashes and failed integration tests.
- Fix: declare dependencies in project package.json and align imports with the chosen data layer.
