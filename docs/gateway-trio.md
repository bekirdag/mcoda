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

## Fast path (plan hint)
- When the gateway handoff includes a trusted plan hint, Codali runs **plan validation** instead of full re‑planning.
- If validation succeeds, the Builder uses the gateway plan directly.
- If validation fails, Codali falls back to full Architect planning.

## State and resilience
- **Job state file**: `~/.mcoda/workspaces/<workspace>/.mcoda/jobs/<jobId>/gateway-trio/state.json`
- **Resume**: `mcoda gateway-trio --resume <jobId>` restores cycle + progress.
- **Cancellation**: SIGINT/SIGTERM marks job cancelled and stops loops.

## Escalation and retries
Gateway‑trio tracks failure history per task and can:
- Retry work with **forced tier upgrades** after repeated failures (avoid reselecting the same tier).
- Skip retry for **non‑retryable reasons** (scope violations, doc edits, auth errors, invalid JSON).
- Back off on zero‑token runs to avoid hot loops.

## Guardrails
- **Guardrail outcomes**: retryable violations route to escalation; non‑retryable violations terminate the task.
- **Non‑retryable failures**: `scope_violation`, `doc_edit_guard`, `merge_conflict`, `review_invalid_output`, `auth_error`, etc.
- **Docdex preflight**: validates docdex availability before running.
- **File‑scope enforcement**: WOT must only edit allowed paths.
- **Review + QA slugs**: unresolved feedback forces `changes_requested` and loops back to work.

## QA failure re‑analysis
- QA failures trigger a **new gateway analysis** so the next work step uses a refreshed plan and context.

## QA failure handoff enrichment
- After QA failure, gateway-trio stores a concise failure summary (outcome, error/notes, artifacts).
- The summary is injected into the next gateway handoff under `## QA Failure Summary`.

## Golden examples (evolution)
- On QA pass, gateway-trio captures a bounded redacted golden example into `.mcoda/codali/golden-examples.jsonl`.
- Codali Librarian loads these examples and adds them to context as guidance for similar tasks.

## Post-revert learning loop
- When task status moves from `completed` to `changes_requested`, gateway-trio treats it as a revert event.
- It writes a repo-memory learning note and optionally saves a profile preference for explicit global constraints.
- The learning summary is attached to the next handoff under `## Revert Learning`.

## State write timing (Q/T/V)
- State is written after work (`Q`), review (`T`), QA (`V`), and retry/terminal decisions.
- `state.json` keeps step outcomes and decision history so resume can continue from the latest checkpoint.

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
