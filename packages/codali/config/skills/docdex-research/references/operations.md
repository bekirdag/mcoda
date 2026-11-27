# Advanced operations and boundaries

The native catalog reference lists every packaged Docdex MCP feature. tools_discover/tools_enable exposes permitted schemas lazily; enabled schemas do not override read-only turns or workspace/external/memory permissions. Unknown future tools and changed schemas require an adapter/catalog update, not arbitrary RPC execution.

## Delegation

docdex_local_completion uses the shared daemon's configured code/general routing. Provide task_type, a complete minimal instruction/context capsule, exact snippets, allowed edit boundaries, output format and success criteria; local delegates cannot fetch missing context or call tools. Validate output. Codali requests draft_only with bounded output, and does not let the model override the configured agent. For this installation both lanes use mswarm's stable qwen-latest-flash-next with local enforcement and no primary/cloud fallback. Report outages rather than silently switching models. Use llm_diagnostics when appropriate. Nested inference usage must not be mistaken for free deterministic computation; inspect receipts/usage when comparing performance.

## Personal routines, generated skills and terminal integration

Use personal_preferences_status/categories/retention_policies to inspect support, then scoped list/search/read/export and claims/claim_read for evidence. Reviews, feedback and operator-event records support correction; snapshots, routines, routine_explain, mind_map and playbooks expose derived context. clone_context/directive/explain provide task guidance; replay_dataset/suite and evaluate/replay_evaluate support explicitly requested evaluations.

Generated skill list/read/events/preview/render let you inspect proposed skills before use. validate is not installation. Sync/autopilot/install/disable/rollback change persistent behavior and must respect user authorization; review contents and provenance first. Similarly ai_terminal_integrations/detect/status/events inspect client integration; bootstrap/capture/sync_skills are explicit stateful operations, not permission to scan unrelated terminal histories. Do not turn on disabled global personal collection just because tools are registered.

## Host CLI and administration

Some AGENTS.md features are host CLI operations rather than native tools: docdexd libs discover/fetch, run-tests/test run-node, hook pre-commit, delegation agents/savings, memory compact, repo init/id/status/dirty and mcp add. When an authorized execution environment actually contains docdexd and can reach the shared daemon, inspect its local --help and use it with the bound repo. Prefer run-tests for appropriate tests and hook pre-commit for staged validation. Register clients with mcp add rather than hand-editing config. No CLI command or fallback grants host access from Codali's isolated shell; if unavailable, state that boundary and use permitted equivalent tools. Do not claim a test or registration ran without a receipt.

HTTP/SSE/IPC/stdio transport, /v1/chat/completions context injection, daemon configuration and service management belong to the host integration. The native tools are the agent interface; do not start another daemon or writer. For stability triage consult the service's FD exhaustion playbook and inspect nofile pressure, DOCDEX_MIN_NOFILE_SOFT, profile lock retries, repository idle/hibernate/cleanup settings through an authorized host connector. Never delete live index locks or kill unrelated processes. On failure, attempt a bounded safe reconnect/retry; continue with local tools if recovery fails, preserving scope and permissions.
