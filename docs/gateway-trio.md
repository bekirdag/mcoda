# Gateway‑Trio: How It Works

Gateway‑trio is the **orchestration loop** that runs tasks end‑to‑end:

1) **Gateway analysis** → 2) **Work‑On‑Tasks** → 3) **Code Review** → 4) **QA**

It handles retries, escalation, job state, and cancellation.

## High‑level workflow
1. **Select tasks** (default statuses: `not_started`, `in_progress`, `changes_requested`, `ready_to_code_review`, `ready_to_qa`).
2. **Gateway agent** produces task plan + file scope.
3. **Work‑On‑Tasks** runs implementation (often via codali).
4. **Code‑Review** validates diff and backlog resolution.
5. **QA** executes tests and checks.
6. **Loop** until task is complete or fails terminally.

## State and resilience
- **Job state file**: `~/.mcoda/workspaces/<workspace>/.mcoda/jobs/<jobId>/gateway-trio/state.json`
- **Resume**: `mcoda gateway-trio --resume <jobId>` restores cycle + progress.
- **Cancellation**: SIGINT/SIGTERM marks job cancelled and stops loops.

## Escalation and retries
Gateway‑trio tracks failure history per task and can:
- Retry work with stronger agents after repeated failures.
- Skip retry for **non‑retryable reasons** (scope violations, doc edits, auth errors, invalid JSON).
- Back off on zero‑token runs to avoid hot loops.

## Guardrails
- **Non‑retryable failures**: `scope_violation`, `doc_edit_guard`, `merge_conflict`, `review_invalid_output`, `auth_error`, etc.
- **Docdex preflight**: validates docdex availability before running.
- **File‑scope enforcement**: WOT must only edit allowed paths.
- **Review + QA slugs**: unresolved feedback forces `changes_requested` and loops back to work.

## Why this design
- Prevents “silent pass” when code changes are missing or invalid.
- Ensures failures are explicit and attributable.
- Keeps expensive retries bounded and escalated only when necessary.

## Logging and observability
- Gateway start/end events include selected agent, model, adapter.
- WOT/CR/QA results are persisted as task runs and logs.
- Telemetry can record agent ratings per step when enabled.

## Related code
- `packages/core/src/services/execution/GatewayTrioService.ts`
- `packages/core/src/services/agents/GatewayAgentService.ts`
- `packages/core/src/services/execution/WorkOnTasksService.ts`
- `packages/core/src/services/review/CodeReviewService.ts`
- `packages/core/src/services/execution/QaTasksService.ts`

