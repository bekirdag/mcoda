# Workflows: Work‑On‑Tasks (WOT), Code‑Review (CR), and QA

This document explains how the **work-on-tasks**, **code-review**, and **qa-tasks** workflows operate in mcoda, including guardrails and the reasons behind key design decisions.

---

## 1) Work‑On‑Tasks (WOT)

### Purpose
- Execute implementation tasks in a repo with direct edits.
- Enforce docdex grounding, file‑scope guardrails, and test gates.
- Produce a clean handoff for code review.

### Core logic
- **Selection**: `TaskSelectionService` picks tasks (status filter default: `not_started/in_progress/changes_requested`).
- **Runner**: `WorkOnTasksService` invokes an agent (usually through codali) to edit files directly.
- **Tests**: Runs task‑specific tests, then run‑all (`tests/all.js`).
- **Status**: On success, moves tasks to `ready_to_code_review`.

### Guardrails
- **Task locks** (TTL) prevent concurrent edits.
- **Allowed file scope** enforced from task metadata; out‑of‑scope edits fail with `scope_violation`.
- **Comment backlog enforcement**: unresolved CR/QA comments must be addressed first.
- **Patch mode** only if enabled (`MCODA_WORK_ON_TASKS_PATCH_MODE=1`), and ignored if codali is required.
- **VCS safety**: merge conflicts are surfaced, not auto‑resolved.

### Why it’s designed this way
- Keeps WOT deterministic: no “no‑change” approvals when backlog exists.
- Prevents silent changes outside approved file scope.
- Ensures every task is validated by tests before review.

---

## 2) Code‑Review (CR)

### Purpose
- Validate that WOT changes actually satisfy requirements and backlog items.
- Standardize review decisions and findings in strict JSON.

### Core logic
- **Selection**: tasks in `ready_to_code_review`.
- **Context**: diff against base, task history, unresolved comments, docdex snippets, OpenAPI slices.
- **Agent**: returns strict JSON (`decision`, `summary`, `findings`, `resolvedSlugs`, `unresolvedSlugs`).
- **Decision**:
  - `approve`/`info_only` → `ready_to_qa`
  - `changes_requested` → back to work
  - `block` → fail until reopened

### Guardrails
- **JSON-only** output schema enforced; retries with stricter prompt on invalid JSON.
- **Comment slug tracking** ensures feedback is explicitly resolved.
- **Empty diff handling** blocks review if no changes are present.

### Why it’s designed this way
- Ensures review is machine‑actionable (JSON), not narrative.
- Prevents auto‑approval without proof of changes.
- Guarantees unresolved review feedback cannot be silently ignored.

---

## 3) QA Tasks

### Purpose
- Run automated tests and environment checks after code review.
- Provide reproducible evidence for pass/fail decisions.

### Core logic
- **Selection**: tasks in `ready_to_qa`.
- **QA routing agent** chooses profiles (CLI, browser, API, stress).
- **Adapters**: CLI (shell), Chromium (headless UI), Maestro (mobile flows).
- **Outcome**:
  - `pass` → `completed`
  - `fix_required` → `not_started` (needs work)
  - `infra_issue` → `not_started` with infra reason

### Guardrails
- **No hardcoded ports**: QA uses env or auto‑detected ports.
- **Chromium only for UI tasks** (not just UI repos).
- **QA agent interpretation is off by default** unless `MCODA_QA_AGENT_INTERPRETATION=1`.
- **Follow‑ups** are deduplicated via stable slugs.

### Why it’s designed this way
- Keeps QA grounded in actual tests, not model speculation.
- Prevents false passes when infra/test setup is broken.
- Avoids noisy browser runs for backend‑only changes.

---

## Shared guardrails across WOT/CR/QA
- **Docdex grounding**: every stage uses docdex for context.
- **State transitions** are explicit, recorded in job/task logs.
- **Resume support** via job state files and checkpoints.
- **Agent ratings** optional (`rateAgents`) to track performance.

---

## Workflow relationship
- **WOT** writes code → **CR** validates correctness → **QA** validates execution.
- Each stage can emit comments + slugs which the next WOT cycle must resolve.

