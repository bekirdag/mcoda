# Plan: Fix Mcoda Issues from Gateway-Trio Downloads Log (3.txt)

## Goals
- Ensure docdex is always scoped to the target workspace and available during runs.
- Make gateway-trio outputs robust (JSON review responses, patch application, progress reporting).
- Remove prompt and doc-context contamination that causes drift.
- Restore portability in test orchestration (no absolute node paths).
- Document external docdex environment fixes required for stable QA.

## Inputs
- `docs/gateway-trio-log-issues-3-downloads.md`

## Non-Goals
- Fixing `test-web-app` application issues (auth routes, OpenAPI mismatches, etc.).

## Plan
1) **Enforce repo scoping for docdex**
   - Use the resolved `--workspace` root, not `process.cwd()`, for all docdex calls.
   - Add a preflight assertion so missing repo context fails fast with a clear error.
   - Files likely to touch: `packages/integrations/src/docdex/DocdexClient.ts`, `packages/core/src/services/shared/WorkspaceResolver.ts`, `packages/core/src/services/shared/DocContextService.ts`.

2) **Add docdex daemon health checks and recovery hints**
   - At gateway-trio start, check docdex availability and surface actionable instructions.
   - If unreachable, mark as infra dependency and avoid misleading “search failed” warnings.
   - Files likely to touch: `packages/core/src/services/execution/GatewayTrioService.ts`, `packages/cli/src/commands/work/GatewayTrioCommand.ts`.

3) **Harden review JSON output and escalation**
   - Enforce schema validation and a stricter JSON-only retry on the first failure.
   - If still invalid, return a structured `review_invalid_output` block reason for escalation.
   - Files likely to touch: `packages/core/src/services/review/CodeReviewService.ts`, `packages/core/src/services/agents/OutputValidator.ts`.

4) **Make patch application more resilient**
   - Validate patch-only output before apply; on failure, retry with a strict patch-only prompt.
   - Add fallback to a 3-way apply and capture patch artifacts for debugging.
   - Files likely to touch: `packages/core/src/services/execution/WorkOnTasksService.ts`.

5) **Remove non-spec docs from SDS context**
   - Restrict SDS classification to `docs/sds/` (or explicit frontmatter tags).
   - Prevent QA issue docs from being promoted to system design context.
   - Files likely to touch: `packages/core/src/services/shared/DocContextService.ts`.

6) **Clean docdex guidance in prompts**
   - Remove MCP/docdexd serve guidance; keep daemon-only instructions consistent.
   - Standardize docdex tool references across gateway, review, and QA prompts.
   - Files likely to touch: `prompts/gateway-agent.md`, `prompts/code-reviewer.md`, `prompts/qa-agent.md`, `prompts/code-writer.md`.

7) **Fix run-all tests portability**
   - Replace absolute Node paths with `node` from PATH (or `process.execPath`).
   - Ensure `tests/all.js` uses the same resolution logic as CLI.
   - Files likely to touch: `tests/all.js`, `scripts/run-node-tests.js`, `package.json`.

8) **Improve watch progress reporting**
   - Emit a heartbeat with last activity time and task index updates.
   - Increment progress after each attempt, not only on completion.
   - Files likely to touch: `packages/core/src/services/execution/GatewayTrioService.ts`.

9) **Docdex environment dependencies (external)**
   - Ensure Playwright CLI is available for docdex QA adapters (or add a preflight block).
   - Address daemon bind/ollama errors with clear remediation and lock handling.
   - Owners: docdex repo; track as external dependencies for gateway-trio stability.

## Test Strategy
- **Unit tests**
  - Docdex repo scoping and preflight assertions.
  - Review JSON retry path and `review_invalid_output` escalation.
  - Patch-only validation and fallback apply.
  - Doc context classifier (SDS vs QA docs).

- **Integration checks**
  - Run gateway-trio with `--watch` to verify progress heartbeat and no idle spam.
  - Validate `node tests/all.js` uses portable node resolution.

## Exit Criteria
- Docdex calls always include the target repo and fail fast when missing.
- Review agent JSON is valid on retry or escalates with a structured reason.
- Patch application succeeds or produces actionable diagnostics.
- Prompts no longer mention MCP/docdexd serve guidance.
- Watch output shows steady progress with accurate counts.
