# Unified Codali Cognitive Architecture v1.2 (final)

This design merges the latest inputs and aligns strictly with mcoda + Docdex
capabilities. It keeps the 4-phase "Cognitive Scaffolding" approach to make
cheap local models reliable while using Docdex for verified context, structure,
memory, and dependency safety.

## 1) Core Philosophy: Cognitive Scaffolding
Small local models struggle with long contexts and deep reasoning. codali
compensates by splitting work into discrete phases and injecting Docdex
"technical truth" at each phase, minimizing guesswork.

## 2) Execution Graph (Phase Pipeline)
User Request
  -> Phase 1: Librarian (context + index checks)
  -> Phase 2: Architect (plan + risk)
  -> Phase 3: Builder (implementation tool loop)
  -> Phase 4: Critic (validation + repair + learning)

Fast path: trivial edits can skip Phase 2.
Feedback loop: failures in Phase 4 route back to Phase 2 or 3 (maxRetries).

## 3) Phase Specifications
### Phase 1: Librarian (Context Aggregation)
Role: assemble the "State of the World" only. No reasoning or code generation.
Engine: small local model for query expansion (optional) or heuristic logic.

Mandatory Docdex actions:
1) docdex_health (daemon reachable).
2) docdex_initialize (bind repo_id in multi-repo daemon when missing).
3) docdex_stats + docdex_files (index coverage and staleness).
4) docdex_search (1-3 focused queries).
5) docdex_open (top hits; small windows only).
6) docdex_symbols + docdex_ast (structure for likely-to-change files).
7) docdex_impact_graph (dependencies with maxDepth/maxEdges).
8) docdex_memory_recall (repo-specific lessons).
9) docdex_get_profile (user preferences).
10) docdex_impact_diagnostics (dynamic imports if graph looks sparse; include in context bundle).

Optional Docdex actions:
- docdex_web_research (when local confidence is low; requires DOCDEX_WEB_ENABLED=1).
- docdex_dag_export (trace complex dependency chains).
- docdex_tree (folder structure via MCP tool).
- docdex_index (rebuild or ingest if index is stale).
- docdexd libs discover/fetch + docdex_search(include_libs) for dependency docs.

Output: context_bundle.json (structured facts only).

### Phase 2: Architect (Reasoning + Planning)
Role: produce a plan, risks, and verification strategy.
Engine: higher-reasoning model (can still be local if context is strong).
Constraint: no code generation.

Output: plan.json containing:
- steps
- target files
- risk assessment
- verification strategy (tests/lint/docs)

### Phase 3: Builder (Implementation)
Role: apply the plan using codali tools.
Engine: coding-optimized model (prefer local).
Constraints:
- Structured output enforced (GBNF or JSON schema).
- Prefer codali tools (edit/diff/docdex) over ad-hoc shell.
- Keep Docdex requests narrow (snippet windows, symbols/AST summaries).

### Phase 4: Critic (Validation + Learning)
Role: quality gatekeeper and teacher.
Engine: higher-reasoning model.

Workflow:
1) Validate using plan-defined checks (mcoda commands or Docdex hooks).
   - Docdex hook endpoint: POST /v1/hooks/validate
2) Compare Builder output to the Architect plan.
3) Decide:
   - PASS: return results.
   - FAIL: capture reasons and retry (maxRetries).
4) Learn: after repeated failure (e.g., 3) or explicit user correction, store
   a lesson via docdex_memory_save.

## 4) Context Bundle (Minimal, Structured)
Example shape:

```json
{
  "request": "...",
  "queries": ["...", "..."],
  "snippets": [{ "doc_id": "...", "path": "...", "content": "..." }],
  "symbols": [{ "path": "...", "summary": "..." }],
  "ast": [{ "path": "...", "nodes": [] }],
  "impact": [{ "file": "...", "inbound": [], "outbound": [] }],
  "impact_diagnostics": [{ "file": "...", "diagnostics": {} }],
  "memory": [{ "text": "...", "source": "repo" }],
  "golden_examples": [{ "intent": "...", "patch": "..." }],
  "preferences_detected": [{ "category": "constraint", "content": "use date-fns" }],
  "profile": [{ "content": "...", "source": "agent" }],
  "index": { "last_updated_epoch_ms": 0, "num_docs": 0 },
  "warnings": []
}
```

Notes:
- Keep snippets small; Docdex open has a 512 KiB content cap.
- Prefer symbols/AST summaries to raw code for cheap models.
- Use Docdex diff-aware search when iterating on a working tree.

## 5) Docdex Integration Map (HTTP vs MCP)
codali must support both HTTP endpoints and MCP tools (JSON-RPC over /v1/mcp).
There is no HTTP /v1/tree endpoint; tree is MCP only.

| Phase | codali tool | Transport | Docdex endpoint/tool | Purpose |
| --- | --- | --- | --- | --- |
| all | docdex_health | HTTP | GET /healthz | Availability check |
| 1 | docdex_initialize | HTTP | POST /v1/initialize | Bind repo_id |
| 1 | docdex_search | HTTP | GET /search | Retrieval |
| 1 | docdex_open | HTTP | GET /snippet/:doc_id | Targeted context |
| 1 | docdex_symbols | MCP | docdex_symbols | Structure (high-level) |
| 1 | docdex_ast | MCP | docdex_ast | Structure (detailed) |
| 1 | docdex_impact_graph | HTTP | GET /v1/graph/impact | Dependency analysis |
| 1 | docdex_impact_diagnostics | HTTP/MCP | GET /v1/graph/impact/diagnostics or docdex_impact_diagnostics | Dynamic imports |
| 1 | docdex_files | MCP | docdex_files | Index coverage |
| 1 | docdex_stats | MCP | docdex_stats | Index health |
| 1 | docdex_memory_recall | MCP | docdex_memory_recall | Fetch lessons |
| 1 | docdex_get_profile | MCP | docdex_get_profile | Fetch preferences |
| 2 | docdex_dag_export | HTTP | GET /v1/dag/export | Reasoning trace |
| 3 | docdex_tree | MCP | docdex_tree | Folder visualization |
| 4 | docdex_memory_save | MCP | docdex_memory_save | Save new lessons |
| 4 | docdex_save_preference | MCP | docdex_save_preference | Save user prefs |

Docdex extras to add to codali:
- docdex_web_research (MCP, requires DOCDEX_WEB_ENABLED=1)
- docdex_index (MCP or POST /v1/index/rebuild)
- docdex_delegate (POST /v1/delegate for micro-tasks)
- docdex_open_file (MCP docdex_open) for path-based file slices

## 6) Memory & Learning Strategy
Use Docdex global state (API) instead of repo-local .docdex files.

Repo memory:
- Read: docdex_memory_recall
- Write: docdex_memory_save
- Trigger: 3x failures or explicit user correction

Profile memory (agent_id scoped):
- Read: docdex_get_profile
- Write: docdex_save_preference

Evolution and recovery loops:
- On QA pass (gateway-trio), capture a bounded redacted golden example in `.mcoda/codali/golden-examples.jsonl`.
- Librarian injects top golden examples into the next context bundle to bias toward known-good patterns.
- On revert (task moves `completed -> changes_requested`), gateway-trio writes a repo-memory learning note and optionally saves a profile preference for explicit global constraints.
- Revert learning and QA failure summaries are attached to the next gateway handoff context.

## 7) Routing & Configuration
Extend codali.config.json with role routing. If a role is missing, fallback to
CODALI_PROVIDER / CODALI_MODEL.

```json
{
  "routing": {
    "librarian": { "provider": "ollama-remote", "model": "gemma2:2b", "temperature": 0.1 },
    "architect": { "provider": "ollama-remote", "model": "llama3:instruct", "temperature": 0.4 },
    "builder": { "provider": "ollama-remote", "model": "deepseek-coder:6.7b", "temperature": 0.2, "format": "json" },
    "critic": { "provider": "ollama-remote", "model": "llama3:instruct", "temperature": 0.1 }
  },
  "limits": {
    "maxSteps": 12,
    "maxToolCalls": 40,
    "maxRetries": 3,
    "timeoutMs": 300000
  }
}
```

## 8) Implementation Checklist
1) Update CLI: add --smart (or config flag) to enable the 4-phase pipeline.
2) Context assembler: implement Phase 1 tool calls and context_bundle.json.
3) Transport layer: implement HTTP vs MCP per the integration map.
4) Prompts: architect (plan only), builder (code only + GBNF), critic (review only).
5) Memory hook: persist lessons via docdex_memory_save after repeated failure.
6) Telemetry: log per-phase timing and model usage under logs/codali.

This architecture keeps codali cheap-model-first while leveraging Docdex for
retrieval, structure, memory, and dependency safety.
