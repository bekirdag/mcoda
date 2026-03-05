# SDS Suggestions Command Implementation Plan

## 1. Objective
Add a new command workflow: `mcoda sds suggestions`.

The workflow will:
- Review the active SDS document using a high-ranked mcoda agent.
- Detect and report:
  - unresolved/open questions + optimum answers aligned with the rest of docs,
  - inconsistencies,
  - issues/risks,
  - enhancement opportunities.
- Persist each review result to `docs/suggestions/sds_suggestions[NUMBER].md`.
- Hand the review output to a second high-ranked agent to revise SDS content.
- Iterate review/fix until reviewer reports no issues.
- Hard-stop at 100 iterations.

## 2. Scope

### In scope
- CLI routing and argument parsing for `sds suggestions`.
- Docs service orchestration for review/fix loop.
- High-ranked agent selection for reviewer/fixer roles.
- Suggestions artifact numbering and write behavior.
- SDS path resolution and update-in-place.
- Deterministic stop conditions and safeguards.
- Automated tests (unit/component/integration-style in current repo conventions).
- Documentation + progress tracking.

### Out of scope
- New DB schema/migrations.
- New network APIs.
- Replacing existing `sds generate` functionality.
- Full semantic correctness guarantee of LLM outputs beyond iterative validation gates.

## 3. Command UX and CLI Contract

### Primary command
- `mcoda sds suggestions`

### Alias behavior
- `mcoda sds` remains defaulted to generate workflow for backward compatibility.
- `mcoda sds suggestions` dispatches to new suggestions flow.
- `mcoda docs sds suggestions` is also supported via docs command path.

### Arguments
- `--workspace-root <PATH>` optional.
- `--project <KEY>` optional but recommended.
- `--sds-path <FILE>` optional override; if omitted, resolver discovers SDS path.
- `--review-agent <NAME>` optional override.
- `--fix-agent <NAME>` optional override.
- `--max-iterations <N>` optional; clamped to `1..100`, default `100`.
- `--agent-stream <true|false>` optional; default `false` for deterministic file-oriented output.
- `--rate-agents` optional.
- `--json` optional structured output.
- `--dry-run` optional; review artifacts written, SDS not modified.
- `--quiet`, `--debug`, `--no-color`, `--no-telemetry` parity flags.

## 4. SDS Path Resolution Strategy
When `--sds-path` is missing, resolve in this order:
1. `<workspaceRoot>/docs/sds/sds.md`
2. `<workspaceRoot>/docs/sds.md`
3. Latest modified `*.md` under `<workspaceRoot>/docs/sds/`
4. `<mcodaDir>/docs/sds/<projectSlug>.md` (if project key provided)
5. `<mcodaDir>/docs/sds/sds.md`

Failure behavior:
- If no candidate exists, command fails with actionable error including looked-up locations.

## 5. Suggestions Artifact Contract

### Directory
- Ensure `<workspaceRoot>/docs/suggestions` exists (`mkdir -p`).

### File naming
- `sds_suggestions[NUMBER].md` where NUMBER is global monotonic next index from existing files.
- Example: `sds_suggestions1.md`, `sds_suggestions2.md`, `...`

### File content shape
Each file includes:
- Metadata block:
  - timestamp,
  - iteration index,
  - reviewer agent,
  - fixer agent,
  - SDS path,
  - result (`PASS|FAIL`),
  - issue count,
  - job/command run IDs.
- Reviewer output section.
- Parsed summary section for machine-derived status.
- Fix application summary section (applied/skipped/errors).

## 6. Agent Selection Strategy

### Inputs
- Global agent inventory (`repo.listAgents`) + health summary + capabilities.

### Ranking
Prefer candidates by:
1. satisfies required capabilities,
2. preferred capabilities count,
3. rating descending,
4. reasoning rating descending,
5. cost per million ascending,
6. deterministic slug tie-breaker.

### Capability profile
Required:
- `doc_generation`
- `docdex_query`

Preferred:
- `sds_writing`
- `spec_generation`
- `code_review`
- `multiple_draft_generation`

### Role selection
- Reviewer: highest-ranked candidate (or `--review-agent` override).
- Fixer: next highest-ranked candidate distinct from reviewer when available; otherwise same reviewer agent.
- Warn if override agent is unhealthy/missing capabilities.

## 7. Iteration Workflow
For each iteration `1..maxIterations`:
1. Read current SDS content.
2. Build reviewer prompt with:
   - SDS content,
   - contextual summaries (RFP/PDR/OpenAPI if available via existing context assembler),
   - strict output contract requesting JSON verdict + markdown findings.
3. Invoke reviewer agent.
4. Parse reviewer output to extract verdict:
   - `PASS` or `FAIL`,
   - issue count,
   - normalized findings markdown.
5. Persist review artifact file (`sds_suggestions[NUMBER].md`).
6. If verdict is PASS and issue count is 0:
   - stop success.
7. Else invoke fixer agent with:
   - current SDS,
   - the persisted suggestions markdown,
   - instruction to return full revised SDS only.
8. Validate fixer output (minimum structural validity and non-empty content).
9. If valid and not dry-run:
   - write SDS in place,
   - optionally register/update in Docdex if configured.
10. Continue loop.

Hard stop:
- On reaching max iterations without PASS, return `max_iterations_reached` outcome.

## 8. Prompt/Parsing Contracts

### Reviewer prompt output requirement
- Must include a JSON object with fields:
  - `result`: `PASS|FAIL`
  - `issueCount`: integer
  - `summary`: string
- Must include markdown body sections:
  - Open questions + optimum answers
  - Inconsistencies
  - Issues
  - Enhancements
  - Recommended fixes

### Parser fallback behavior
If JSON parse fails:
- Heuristically infer FAIL unless explicit no-issues markers are found.
- Default `issueCount=1` on ambiguous negative output.
- Preserve raw reviewer output in suggestions file.

### Fixer prompt output requirement
- Return complete revised SDS markdown.
- No explanation wrappers.

### Fixer parse fallback
- If fenced code block exists, extract markdown payload.
- If output invalid/empty, keep old SDS and continue iteration with warning.

## 9. Failure and Recovery Behavior
- Missing SDS file: fail fast with clear path lookup details.
- Agent invocation failure:
  - record warning/checkpoint,
  - fail command if reviewer invocation fails and cannot continue.
- Fixer failure:
  - record in suggestions file and continue to next iteration only if safe; otherwise stop failed.
- File write failure:
  - fail command with explicit path/errno.
- JSON mode must return machine-readable summary even on partial failures.

## 10. Telemetry, Job, and Checkpoints
Add a dedicated command run and job type (`sds_suggestions`) in existing job flow.
Checkpoints:
- `sds_loaded`
- `agents_selected`
- `iteration_reviewed`
- `iteration_fixed`
- `completed`

Metadata includes:
- reviewer/fixer ids,
- total iterations,
- final status,
- suggestions file list,
- final SDS path.

## 11. Test Strategy

### CLI tests
- Parse `sds suggestions` args.
- Defaults for max iterations and stream.
- Clamping behavior for max iterations.
- Entrypoint routes `mcoda sds suggestions` correctly.

### Service tests
- Creates `docs/suggestions` when missing.
- Writes numbered suggestion files incrementally.
- Uses two ranked agents when available.
- Falls back to same agent if only one candidate.
- Stops on PASS.
- Stops at max iterations.
- Applies fixer output to SDS content.
- Honors `dry-run` (no SDS write).

### Regression tests
- Existing `sds generate` routing remains unchanged.
- Existing docs command parsing unaffected.

## 12. Rollout Sequence
1. Add docs artifacts (plan/tasks/progress).
2. Add CLI parser and command routing for suggestions.
3. Add DocsService workflow and helpers.
4. Add tests and run targeted test loops.
5. Run broader package tests.
6. Perform code review + alignment/perfection pass.
7. Update progress doc with completed evidence.

## 13. Acceptance Criteria
- `mcoda sds suggestions` command exists and runs.
- `docs/suggestions` auto-created when needed.
- Suggestion files saved as `sds_suggestions[NUMBER].md`.
- Reviewer/fixer loop executes until PASS or 100 iterations.
- Fixer updates SDS in place (unless dry-run).
- Agent selection uses high-ranked logic with deterministic fallback.
- Tests pass for new behavior and no regressions in existing sds generate flow.
