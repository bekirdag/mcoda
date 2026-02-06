# Codali Phase Workflows (Librarian, Architect, Builder, Interpreter, Critic)

This document summarizes the **actual runtime logic** for each Codali phase based on the current code in `packages/codali`. It is meant to help verify that each phase is doing what we expect.

Source of truth in code:
- `packages/codali/src/cognitive/SmartPipeline.ts`
- `packages/codali/src/cognitive/ContextAssembler.ts`
- `packages/codali/src/cognitive/ArchitectPlanner.ts`
- `packages/codali/src/cognitive/BuilderRunner.ts`
- `packages/codali/src/cognitive/PatchInterpreter.ts`
- `packages/codali/src/cognitive/CriticEvaluator.ts`
- `packages/codali/src/cognitive/Prompts.ts`

---

## Orchestration (SmartPipeline)

**File:** `packages/codali/src/cognitive/SmartPipeline.ts`

**Purpose:** Run the 4-phase pipeline with retries and logging. Manages phase status events, logging, and local context lanes.

**High-level flow:**
- Build context (Librarian).
- Build a plan (Architect). If a plan hint is present, run Architect in validate-only mode first and use the validated hint directly.
- Run Builder, then Critic. If the Critic fails and is retryable, loop Builder/Critic up to `maxRetries`.
- If Builder requests more context (`needs_context`), rerun Librarian and Architect (bounded by `maxContextRefreshes`).

**Key behaviors:**
- Emits `phase_start`/`phase_end` log events per phase.
- Writes `phase_input` and `phase_output` artifacts per phase under `~/.mcoda/.../logs/codali/phase/`.
- Logs `architect_output`, `plan_json`, `builder_input`, `builder_output`, `critic_output`.
- Passes `allow_write_paths` and `read_only_paths` to Critic for enforcement.
- Appends Critic results into local context lanes (if enabled).
- Preserves gateway handoff context sections (for example QA failure summaries and revert learning notes) when present.

---

## Librarian (ContextAssembler)

**File:** `packages/codali/src/cognitive/ContextAssembler.ts`

**Role:** Assemble a deterministic **ContextBundle** using Docdex and optional query expansion. No reasoning or code generation.

**Inputs:**
- `request` string
- Optional `additionalQueries`, `preferredFiles`, `recentFiles`
- Config options (query limits, snippet window, token budget, read strategy, write policy, etc.)

**Core Steps:**
1. **Docdex health check** (`docdex.health`). If this fails, return a minimal bundle with warnings.
2. **Initialize repo binding** if needed (`docdex.initialize`).
3. **Stats and file hints** (`docdex.stats`, `docdex.files`).
4. **Extract queries** from the request, merge with additional queries.
5. **Infer preferred files** (e.g., HTML hints if the request mentions “landing page”).
6. **Search** (`docdex.search`) unless `skipSearchWhenPreferred` is true.
7. **Query expansion** (optional): if low hits or low confidence, call a small model to expand queries and retry search.
8. **Snippets** (`docdex.snippet`) for top hits.
9. **Symbols/AST** (`docdex.symbols`, `docdex.ast`) for each hit path.
10. **Impact graph** (`docdex.impact`) only for supported code extensions. If inbound/outbound are empty, fetch diagnostics.
11. **Select context files** (focus/periphery) using `selectContextFiles`.
12. **Repo map**: use `docdex.tree` when low confidence; otherwise build a symbol-based map.
13. **Load focus/periphery files** using `ContextFileLoader` (Docdex or FS).
14. **Budget trimming**: enforce `maxTotalBytes`/`tokenBudget` (drop periphery first).
15. **Memory recall** (`docdex.memory_recall`) and **profile** (`docdex.profile`).
16. **Golden examples**: load local curated examples from `.mcoda/codali/golden-examples.jsonl` via `GoldenSetStore`, then merge with Docdex fallback examples.
17. **Index warnings**: mark empty/stale index; trigger `docdex.index_rebuild` when index is empty.
18. **Write policy**:
    - Default: `docs/` and periphery are read-only unless `allowDocEdits` is true.
    - `allow_write_paths` is selection-all minus read-only paths.
19. **Serialize bundle** (JSON or bundle_text) via `ContextSerializer`.

**Output:** `ContextBundle`
- `files` (focus + periphery)
- `snippets`, `symbols`, `ast`, `impact`, `impact_diagnostics`
- `selection`, `allow_write_paths`, `read_only_paths`
- `memory`, `profile`, `golden_examples`, `preferences_detected`, `warnings`, `index`
- `serialized` (when available)

---

## Architect (ArchitectPlanner)

**File:** `packages/codali/src/cognitive/ArchitectPlanner.ts`

**Role:** Produce a **DSL plan** (no code). Must resolve to `steps`, `target_files`, `risk_assessment`, `verification`.

**Inputs:**
- Context bundle (`ContextBundle`) – uses `context.serialized` if available.
- Optional `planHint` (pre-baked plan JSON).
- Optional response format (JSON or GBNF).

**Core Steps:**
1. **Validate-only fast path**: If `validateOnly=true` and `planHint` is present, parse + validate the hint locally.
2. **Plan hint path**: If `planHint` is present (without validate-only), parse/coerce it into a valid plan.
3. **Prompted plan**: Otherwise call provider with `ARCHITECT_PROMPT` and JSON/GBNF format.
4. **Loose parse + coercion**: Recover from noisy output, map aliases into canonical plan fields.
5. **Fallback plan**: If plan is missing keys, build a minimal plan from context focus/selection.

**Output:** `Plan`
- Always normalized to include `steps`, `target_files`, `risk_assessment`, `verification`.

**Notes:**
- Logs `architect_plan_normalized` when coercion or fallback is applied.
- Logs `architect_plan_hint_validated` when validate-only passes.
- Throws structured `plan_hint_validation_failed` errors on invalid hints; SmartPipeline catches this and falls back to full Architect planning.
- Uses `ARCHITECT_GBNF` if response format is GBNF without explicit grammar.

---

## Builder (BuilderRunner)

**File:** `packages/codali/src/cognitive/BuilderRunner.ts`

**Role:** Implement the plan. Can use tools, patch JSON, or freeform output depending on `mode`.

**Inputs:**
- `Plan` + `ContextBundle`
- Mode: `tool_calls | patch_json | freeform`
- Patch format: `search_replace | file_writes`
- Write policy: `allow_write_paths`, `read_only_paths`

**Core Steps:**
1. **Build system/user messages**:
   - System prompt from `buildBuilderPrompt` (depends on mode + patchFormat).
   - User message contains **PLAN** + **CONTEXT BUNDLE** (read-only).
2. **Run via Runner** with configured provider and response format.
3. **Context request detection**:
   - If output is `{"needs_context": true, ...}`, return a `contextRequest` to SmartPipeline.
4. **Mode handling**:
   - **tool_calls**: uses tool registry directly.
   - **patch_json**:
     - Parse JSON patches with `parsePatchOutput`.
     - Validate target files against write policy.
     - Apply with `PatchApplier`.
     - Retry invalid output with schema-only prompt.
     - Fallback from `file_writes` → `search_replace` when needed.
     - Optionally use **Interpreter** as precheck or fallback.
   - **freeform**:
     - Send output to **Interpreter** to produce patch JSON.
     - Apply patches with `PatchApplier`.

**Write Policy Enforcement:**
- Rejects patches targeting read-only paths.
- If `allow_write_paths` is present, patches must be in the allow-list.

**Output:**
- `BuilderRunResult` with `finalMessage`, optional `contextRequest`, and `usage`.

---

## Interpreter (PatchInterpreter)

**File:** `packages/codali/src/cognitive/PatchInterpreter.ts`

**Role:** Convert freeform builder output into **strict JSON patch payload**.

**Inputs:**
- Builder raw output string
- Patch format (`search_replace` or `file_writes`)

**Core Steps:**
1. Call provider with `buildInterpreterPrompt`.
2. Normalize output via `normalizePatchOutput`.
3. Parse with `parsePatchOutput`.
4. If parsing fails, retry once with `buildInterpreterRetryPrompt`.

**Output:**
- `PatchPayload` with `patches` array (or file-writes payload).

**Notes:**
- Logs `provider_request`, `interpreter_request`, `interpreter_response`, `interpreter_retry`.

---

## Critic (CriticEvaluator)

**File:** `packages/codali/src/cognitive/CriticEvaluator.ts`

**Role:** Validate whether the builder output and applied changes meet the plan and guardrails.

**Inputs:**
- `Plan`
- `builderOutput` string
- Optional `touchedFiles`
- Optional `allowedPaths` / `readOnlyPaths`

**Core Steps:**
1. Fail if builder output is empty.
2. If no `touchedFiles` provided, attempt to **infer from JSON patch**.
3. Enforce write policy:
   - Fail if touched files are read-only.
   - Fail if touched files fall outside `allow_write_paths`.
4. Enforce plan:
   - Fail if no files touched for planned targets.
   - Fail if touched files do not intersect plan targets.
5. Run verification steps via `ValidationRunner`.
6. Append critic summary into local context lane.

**Output:** `CriticResult`
- `PASS` or `FAIL` with `reasons` and `retryable` flag.

---

## Where the logic can drift (observability checkpoints)

- **Librarian:** verify focus files include the intended target (e.g., `src/public/index.html`).
- **Architect:** ensure output is not falling back (look for `architect_plan_normalized`).
- **Builder:** ensure mode is correct (patch_json vs freeform), and builder output is structured enough for patches.
- **Interpreter:** ensure the provider returns valid JSON; retries happen only once.
- **Critic:** ensure touched files intersect planned targets and do not violate write policy.

Log artifacts are emitted for phase inputs/outputs and can be inspected under:
`~/.mcoda/workspaces/<workspace-id>/logs/codali/phase/`
