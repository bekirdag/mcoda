# Codali: How It Works

This document explains how **Codali** runs tasks, edits repos, and enforces guardrails. It is based on the current codali implementation (`packages/codali`) and the mcoda integration points.

## What Codali is
Codali is a **local tool-runner** that turns LLM output into concrete repo changes. It can run standalone (`codali run`) or be invoked by mcoda as an agent adapter. It acts as the “local hands” in a Local Agent / Remote Brain architecture: Codali reads/serializes repo context, sends a prompt to a model, and applies edits locally.

Key properties:
- **Direct repo edits** via built-in tools (file, diff, search, shell).
- **Docdex-first context retrieval** (search/snippets/impact graphs via HTTP, symbols/AST/memory via MCP).
- **Multi-phase pipeline** for small models: Librarian → Architect → Builder → Critic.
- **Patch-first mode** to avoid tool calls when models are weak or tool‑limited.
- **Optional freeform mode** with interpreter to convert weak model output into patches.

## Core components

### CLI entrypoint
- `packages/codali/src/cli/RunCommand.ts`
  - Parses CLI/env/config.
  - Builds providers, tool registry, and docdex client.
  - Runs either the **smart pipeline** or a single **tool-loop**.

### Tooling layer
- `packages/codali/src/tools/*`
  - `filesystem`: read/write/delete within workspace root.
  - `diff`: git status/changes.
  - `search`: `rg`/`grep` search in workspace.
  - `shell`: allowlisted commands only.
  - `docdex`: search/open/impact/symbols/ast/memory via HTTP + MCP.

### Cognitive pipeline
- `ContextAssembler`: selects files (focus/periphery), docdex context, and serializes a “context bundle”.
- `ArchitectPlanner`: builds a **DSL plan** (no code) with GBNF validation.
- `BuilderRunner`: applies plan using tools or patch JSON (interpreter-first when freeform).
- `CriticEvaluator`: validates against plan and test results (deterministic pass/fail + reasons).
- `SmartPipeline`: orchestrates phases, retries, protocol requests, and memory writes.

### Patch pipeline
- `BuilderOutputParser` + `PatchApplier`: parse and apply patch payloads.
- `PatchInterpreter`: converts freeform output to patch JSON using a stronger model.
  - The interpreter can use its **own routed provider/agent** (`routing.interpreter` or `CODALI_AGENT_INTERPRETER`)
    so you can keep builders cheap and interpreters more reliable.

### Local context storage (optional)
- `ContextManager` + `ContextStore` + `ContextSummarizer` + `ContextRedactor`.
- Stores per‑job/task/role histories and summarizes when over model budgets.

## Execution modes

### 1) Standard tool-loop (single phase)
Used when `--smart` is not set.
- Sends task prompt to a single model.
- Model can call tools (if provider supports tool calls).
- Codali executes tool calls and returns the final response.

### 2) Smart pipeline (multi-phase)
Enabled via `--smart` or `CODALI_SMART=1`.
Phases:
1. **Librarian**: docdex + context selection only (no reasoning).
2. **Architect**: plan generation, DSL-only (GBNF).
3. **Builder**: apply the plan.
4. **Critic**: validate output, tests, and plan alignment; may request more context via protocol.

The smart pipeline is designed to reduce hallucinations in small models.

### 2a) Deep investigation mode (smart pipeline only)
Enabled via `CODALI_DEEP_INVESTIGATION_ENABLED=1` (requires `--smart`).
- Adds a mandatory **research phase** before Architect that runs Docdex tools (tree/search/open/snippet/symbols/ast/impact/dag export when configured).
- Captures a **research summary** and evidence metrics for the Architect.
- Enforces **tool-use quotas**, **investigation budget** (min cycles/time), and **evidence gate** thresholds.
- Fails closed if Docdex health/index coverage is missing or if quotas/budget/evidence are unmet.
- Disables plan-hint/fast-path shortcuts so Architect plans from research outputs.
- Optional deep-scan preset increases retrieval depth in Librarian/Research.

Fast path behavior:
- If `CODALI_PLAN_HINT` is present, Architect runs **validate-only** first.
- If the hint passes validation, Codali uses that plan directly (no full re-planning).
- If validation fails, Codali falls back to normal Architect planning and logs the fallback event.
- Fast path and plan hints are ignored when deep investigation mode is enabled.
- When run under gateway-trio, handoff context may also carry `QA Failure Summary` and `Revert Learning` sections into the next planning cycle.

### 2b) Event streaming (Codex-style UX)
When streaming is enabled, Codali emits structured `AgentEvent` updates and the CLI renders:
- **Tokens** to stdout (for piping into other tools).
- **Status/tool events** to stderr (for live progress without polluting output).

Event types include:
- `token` (incremental text)
- `status` (`thinking`, `executing`, `patching`, `done`)
- `tool_call` / `tool_result`
- `error`

### 3) Builder modes
- `freeform` (default): Model writes freeform text; interpreter converts to patches.
- `patch_json`: Model emits JSON patch payload; Codali applies it.
- `tool_calls` (legacy/opt-in): Model calls tools to change files.

Patch formats:
- `search_replace`: patch entries with action + search/replace blocks.
- `file_writes`: full file contents + optional delete list.

## Context selection and serialization
Codali uses a “Context Zipper”:
- **Focus files (Hi‑Res)**: full content of the primary files.
- **Periphery (Lo‑Res)**: symbols/interfaces for dependencies.

Data sources:
- Docdex search for relevance.
- Impact graph for dependency scope.
- Symbols/AST for interface-level summaries.

Context bundle fields include:
- Focus/periphery file lists and content.
- Read‑only / allow‑write policy.
- Docdex hits/snippets.
- Golden examples from local curated history (`.mcoda/codali/golden-examples.jsonl`) plus fallback examples.
- Project guidance and preferences.

## Guardrails and safety

### File scope guardrails
- **Allowed write paths** are derived from task scope and context bundle.
- **Read‑only paths** are enforced even if “focused”.
- Patch targets outside allowed scope fail with `scope_violation`.

### Patch validation
- **Whitespace normalization** when search blocks mismatch.
- **Ambiguity checks**: reject if multiple matches.
- Optional syntax checks via allowlisted shell (e.g., `node --check`).

### Tool constraints
- Shell tool requires `CODALI_ALLOW_SHELL=true` and allowlist.
- File tool enforces workspace root boundaries.

### Secret redaction
- `ContextRedactor` removes secrets before persisting local context.
- Ignore sources are configured via `CODALI_CONTEXT_IGNORE_FILES_FROM`.

### Output validation & retries
- Patch JSON must match schema; Codali retries with stricter prompt.
- If file_writes fails, Codali falls back to search_replace.
- Optional interpreter fallback when patch JSON cannot be parsed.

### Cost guardrails
- Preflight estimates chars → tokens → cost.
- Blocks if estimated cost exceeds `CODALI_COST_MAX_PER_RUN` unless confirmed.

## Learning and evolution loops

- **QA pass -> golden example capture**: gateway-trio stores a bounded redacted example (plan summary, touched files, QA/review notes) for future Librarian context injection.
- **Revert -> memory update**: when a task is reverted (`completed -> changes_requested`), gateway-trio records a repo-memory lesson and can save a profile preference for explicit general constraints.
- **Next-run context upgrade**: QA failure summaries and revert learning are attached to the next gateway handoff so Architect/Builder avoid repeating failed approaches.

## Why the design choices

- **Docdex-first retrieval**: deterministic relevance beats fuzzy RAG for code.
- **Multi-phase pipeline**: isolates retrieval/planning/implementation/validation to avoid cross‑contamination in small models.
- **Patch-first outputs**: enables models without tool support and avoids tool-call failures.
- **Interpreter mode**: weak models stay cheap; stronger model only reformats output.
- **Strict guardrails**: enforce scope safety and prevent unbounded repo edits.

## Runtime artifacts and logs
- Logs: `~/.mcoda/workspaces/<workspace>/logs/codali/<runId>.jsonl`
- Optional local context: `~/.mcoda/workspaces/<workspace>/codali/context/*.jsonl`

## Key configuration and env
- Provider/model: `CODALI_PROVIDER`, `CODALI_MODEL`, `CODALI_API_KEY`, `CODALI_BASE_URL`
- Smart pipeline: `CODALI_SMART=1`
- Deep investigation: `CODALI_DEEP_INVESTIGATION_ENABLED=1`, `CODALI_DEEP_INVESTIGATION_DEEP_SCAN_PRESET=1`, `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_*`, `CODALI_DEEP_INVESTIGATION_BUDGET_*`, `CODALI_DEEP_INVESTIGATION_EVIDENCE_*`
- Builder mode: `CODALI_BUILDER_MODE`, `CODALI_BUILDER_PATCH_FORMAT`
- Interpreter: `CODALI_INTERPRETER_PROVIDER` (`auto` or a phase name) and `CODALI_INTERPRETER_MODEL` (`auto` to use the phase model)
- Interpreter agent override: `CODALI_AGENT_INTERPRETER` (or CLI `--agent-interpreter`)
- Critic agent override: `CODALI_AGENT_CRITIC` (or CLI `--agent-critic`)
- Context: `CODALI_CONTEXT_*` (limits, redact, preferred files)
- Plan hint fast path: `CODALI_PLAN_HINT`
- Local context: `CODALI_LOCAL_CONTEXT_*`
- Docdex: `DOCDEX_HTTP_BASE_URL`, `CODALI_DOCDEX_REPO_ID`, `CODALI_DOCDEX_REPO_ROOT`
