# codali Usage

codali is a standalone tool runner that edits the repo directly. It supports optional streaming output and pre-flight cost estimation. It can be used standalone or as an adapter for mcoda agents.

## Standalone run

```sh
codali run --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
```

## Workflow commands
Codali exposes first-class workflow commands that map to internal run profiles:

- `codali fix`: patch/change-focused output (`patch_summary` contract).
- `codali review`: findings/risk-focused output (`review_findings` contract).
- `codali explain`: explanation-first output (`explanation` contract).
- `codali test`: verification-first output (`verification_summary` contract).

Examples:

```sh
codali fix --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
codali review --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
codali explain --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
codali test --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
```

`codali run` remains the advanced/general entrypoint. You can still override the run profile explicitly:

- `--workflow-profile <run|fix|review|explain|test>` (alias: `--profile`)
- `CODALI_WORKFLOW_PROFILE=<run|fix|review|explain|test>`

Precedence for active profile resolution:
- Command-derived profile for `fix|review|explain|test`
- CLI override (`--workflow-profile` / `--profile`)
- Environment (`CODALI_WORKFLOW_PROFILE` / `CODALI_PROFILE`)
- Config file (`workflow.profile`)
- Built-in default (`run`)

## Learn command (Epic-8)
Use `codali learn` to persist governed learning rules from post-mortem history and to promote candidates.

Analyze a file/run history and write governed outcomes:

```sh
codali learn --file src/index.ts
```

Promote candidate rules explicitly:

```sh
codali learn --confirm profile_memory::constraint::do not use moment.js
```

You can combine both:

```sh
codali learn --file src/index.ts --confirm profile_memory::constraint::do not use moment.js
```

Learning lifecycle behavior:
- Rules are scored with confidence metadata and persisted only if policy thresholds pass.
- Accepted rules are written as `candidate` or `enforced` with deterministic dedupe keys.
- Low-confidence paths are deferred unless explicit confirmation/promotion policy is satisfied.
- Scope-aware routing is enforced (`repo_memory` vs `profile_memory`).

Deterministic `codali learn` exit codes:
- `0`: success (including no-change analysis)
- `2`: usage error (`--file` or `--confirm` required)
- `3`: promotion failure (`--confirm` rejected)
- `4`: writeback rejection during learned-rule persistence

Learning config in `codali.config.json`:

```json
{
  "learning": {
    "persistence_min_confidence": 0.45,
    "enforcement_min_confidence": 0.85,
    "require_confirmation_for_low_confidence": true,
    "auto_enforce_high_confidence": true,
    "candidate_store_file": "logs/codali/learning-rules.json"
  }
}
```

Learning env overrides:
- `CODALI_LEARNING_PERSISTENCE_MIN_CONFIDENCE`
- `CODALI_LEARNING_ENFORCEMENT_MIN_CONFIDENCE`
- `CODALI_LEARNING_REQUIRE_CONFIRMATION_FOR_LOW_CONFIDENCE`
- `CODALI_LEARNING_AUTO_ENFORCE_HIGH_CONFIDENCE`
- `CODALI_LEARNING_CANDIDATE_STORE_FILE`

## Eval command (Epic-7)
Run deterministic eval suites and regression gates:

```sh
codali eval --suite eval/smoke.json --workspace-root . --provider openai-compatible --model gpt-4o-mini
```

Useful options:
- `--output <text|json>` (default `text`)
- `--baseline <path>` (optional baseline report override)
- `--report-dir <path>` (override eval report directory)
- run overrides: `--provider`, `--model`, `--api-key`, `--base-url`, `--agent`, `--agent-id`, `--agent-slug`, `--profile`, `--smart`, `--no-deep-investigation`

`codali eval` emits required quality metrics:
- `M-001` task success rate
- `M-002` first-pass success rate
- `M-003` patch apply success rate
- `M-004` verification pass rate
- `M-005` hallucination rate
- `M-006` scope violation rate
- `M-007` latency median/p95
- `M-008` success tokens/cost median/p95

Deterministic exit codes:
- `0`: pass (run + gates)
- `2`: CLI usage error
- `3`: suite validation error
- `4`: run failure (task failure/execution error)
- `5`: regression gate failure

Report storage:
- Default: `<workspace-root>/logs/codali/eval`
- Reports include suite fingerprint, run artifacts, metrics, baseline deltas, and gate results.

Eval gate config (`codali.config.json`):

```json
{
  "eval": {
    "report_dir": "logs/codali/eval",
    "gates": {
      "patch_apply_drop_max": 0.02,
      "verification_pass_rate_min": 0.9,
      "hallucination_rate_max": 0.02,
      "scope_violation_rate_max": 0
    }
  }
}
```

Eval env overrides:
- `CODALI_EVAL_REPORT_DIR`
- `CODALI_EVAL_GATE_PATCH_APPLY_DROP_MAX`
- `CODALI_EVAL_GATE_VERIFICATION_PASS_RATE_MIN`
- `CODALI_EVAL_GATE_HALLUCINATION_RATE_MAX`
- `CODALI_EVAL_GATE_SCOPE_VIOLATION_RATE_MAX`

## Verification policy behavior (Epic-6)
Verification is always classified explicitly in smart pipeline runs:

- `verified_passed`
- `verified_failed`
- `unverified_with_reason`

Default workflow profile verification policy:
- `run`: `verificationPolicy=general`, `verificationMinimumChecks=0`, `verificationEnforceHighConfidence=false`
- `fix`: `verificationPolicy=fix`, `verificationMinimumChecks=0`, `verificationEnforceHighConfidence=false`
- `review`: `verificationPolicy=review`, `verificationMinimumChecks=0`, `verificationEnforceHighConfidence=false`
- `explain`: `verificationPolicy=explain`, `verificationMinimumChecks=0`, `verificationEnforceHighConfidence=false`
- `test`: `verificationPolicy=test`, `verificationMinimumChecks=1`, `verificationEnforceHighConfidence=true`

When high-confidence enforcement is active, Codali blocks PASS if verification is not `verified_passed`.

Profile overrides are configured in `codali.config.json` under `workflow.profiles.<profile>`:

```json
{
  "workflow": {
    "profiles": {
      "test": {
        "verificationPolicy": "test",
        "verificationMinimumChecks": 2,
        "verificationEnforceHighConfidence": true
      }
    }
  }
}
```

Run logs include verification evidence:
- `verification_report` event in `logs/codali/<runId>.jsonl`
- `verify/verification_report` phase artifact in `logs/codali/phase/<runId>/`

## Run observability and query contracts (Epic-9)
Codali emits versioned run telemetry for each execution:

- `run_summary` (`schema_version=1`) includes:
  - `quality_dimensions` (`plan`, `retrieval`, `patch`, `verification`, `final_disposition`)
  - `final_disposition` (`status`, `failure_class`, `reason_codes`, `stage`, `retryable`)
  - `artifact_references`, `phase_telemetry`, and explicit `missing_artifacts`
- `phase_telemetry` (`schema_version=1`) includes:
  - `phase`, `provider`, `model`, `duration_ms`
  - usage/cost fields when available
  - `missing_usage_reason` / `missing_cost_reason` when unavailable

For programmatic log access, `RunLogReader.queryEvents(...)` supports deterministic filters:
- `run_id`
- `task_id`
- `phase`
- `event_type`
- `failure_class`
- `limit`, `offset`, `sort` (`asc|desc`)

Eval output now carries a normalized run-consumer payload per task (`normalized_run`) so report/history processors can consume run identity, phase outcomes, failure lineage, and telemetry without custom parsing.

## Smart pipeline
Enable the multi-phase pipeline (librarian/architect/builder/critic) for better results on small models:

```sh
codali run --smart --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
```

Or via env:

- `CODALI_SMART=1`

## Deep investigation mode
Deep investigation adds a mandatory research phase and evidence gating before planning. It **requires** the smart pipeline.

```sh
CODALI_DEEP_INVESTIGATION_ENABLED=1 codali run --smart --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
```

Key env flags:
- `CODALI_DEEP_INVESTIGATION_ENABLED=1`
- `CODALI_DEEP_INVESTIGATION_DEEP_SCAN_PRESET=1` (optional, increases retrieval depth)
- `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SEARCH`
- `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_OPEN_OR_SNIPPET`
- `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_SYMBOLS_OR_AST`
- `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_IMPACT`
- `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_TREE`
- `CODALI_DEEP_INVESTIGATION_TOOL_QUOTA_DAG_EXPORT`
- `CODALI_DEEP_INVESTIGATION_BUDGET_MIN_CYCLES`
- `CODALI_DEEP_INVESTIGATION_BUDGET_MIN_SECONDS`
- `CODALI_DEEP_INVESTIGATION_BUDGET_MAX_CYCLES`
- `CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SEARCH_HITS`
- `CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_OPEN_OR_SNIPPET`
- `CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_SYMBOLS_OR_AST`
- `CODALI_DEEP_INVESTIGATION_EVIDENCE_MIN_IMPACT`
- `CODALI_DEEP_INVESTIGATION_EVIDENCE_MAX_WARNINGS`

Notes:
- Deep mode disables plan-hint/fast-path shortcuts.
- Runs fail closed if Docdex health/index checks, quotas, budgets, or evidence gates are unmet.
- Every librarian pass now emits retrieval accountability metadata:
  - `retrieval_disposition` (`resolved|degraded|unresolved`)
  - `retrieval_report` (preflight, selection reason codes, dropped/truncated rationale, unresolved gaps, tool execution, capability snapshot)

Stdin input:

```sh
echo "Update README with setup steps" | codali run --workspace-root . --provider ollama-remote --model llama3
```

## Provider configuration
- `openai-compatible`: set `CODALI_API_KEY` and optionally `CODALI_BASE_URL`.
- `ollama-remote`: set `CODALI_BASE_URL` (default `http://127.0.0.1:11434`).

## Streaming output
Streaming is enabled by default and writes tokens to stdout as they arrive. Disable if you need clean, single-shot output.

- `CODALI_STREAMING_ENABLED` (true/false)
- `CODALI_STREAMING_FLUSH_MS` (flush interval in ms, default 250)

While streaming, Codali also emits **status/tool events** (e.g., `thinking`, `executing`, `patching`) to stderr so progress is visible without contaminating stdout.

## Cost estimation
codali prints a pre-flight estimate (chars -> tokens -> cost) before execution and can block if it exceeds the max.

- `CODALI_COST_MAX_PER_RUN` (default 0.5)
- `CODALI_COST_CHAR_PER_TOKEN` (default 4)
- `CODALI_COST_PRICING_OVERRIDES` (JSON map, e.g. `{"ollama-remote:llama3": {"per1K": 0.002}}`)

## Local context storage
Codali can persist short-term conversation history per job/task/role under `codali/context`, rooted in
the global workspace folder (`~/.mcoda/workspaces/<workspace>/`).
This keeps multi-phase runs consistent and summarizes history if the active model’s context window is exceeded.

- `CODALI_LOCAL_CONTEXT_ENABLED` (default false)
- `CODALI_LOCAL_CONTEXT_STORAGE_DIR` (default `codali/context`)
- `CODALI_LOCAL_CONTEXT_PERSIST_TOOL_MESSAGES` (default false)
- `CODALI_LOCAL_CONTEXT_MAX_MESSAGES` (default 200)
- `CODALI_LOCAL_CONTEXT_MAX_BYTES_PER_LANE` (default 200000)
- `CODALI_LOCAL_CONTEXT_MODEL_TOKEN_LIMITS` (JSON map, e.g. `{"llama3": 8192}`)
- `CODALI_LOCAL_CONTEXT_SUMMARIZE_ENABLED` (default true)
- `CODALI_LOCAL_CONTEXT_SUMMARIZE_PROVIDER` (default `librarian`, resolves via routing)
- `CODALI_LOCAL_CONTEXT_SUMMARIZE_MODEL` (default unset; inherits selected phase agent model)
- `CODALI_LOCAL_CONTEXT_SUMMARIZE_TARGET_TOKENS` (default 1200)

Notes:
- Lane IDs are derived from `jobId`/`taskId`/`taskKey` + phase role.
- Secret redaction uses `CODALI_CONTEXT_REDACT_SECRETS` and `CODALI_SECURITY_REDACT_PATTERNS`.

## Builder patch mode
Codali defaults to **freeform + interpreter**. Use patch_json when you want the model to emit
structured patches directly without the interpreter.

- `CODALI_BUILDER_MODE=patch_json`
- `CODALI_BUILDER_PATCH_FORMAT=search_replace` (default)
- `CODALI_BUILDER_PATCH_FORMAT=file_writes` (model returns full file contents)

## Freeform builder + interpreter
Freeform is the **default**. The builder can respond with prose/snippets and the interpreter
converts it into patch JSON for Codali to apply.

- `CODALI_BUILDER_MODE=freeform`
- `CODALI_INTERPRETER_PROVIDER` (`auto` by default; accepts `librarian|architect|builder|critic|interpreter` or a provider name like `openai-compatible`)
- `CODALI_INTERPRETER_MODEL` (`auto` by default; uses the selected phase model unless overridden)
- `CODALI_INTERPRETER_FORMAT` (default `json`)
- `CODALI_INTERPRETER_MAX_RETRIES` (default `1`)
- `CODALI_INTERPRETER_TIMEOUT_MS` (default `120000`)
- `--agent-interpreter <agent-slug>` (CLI override, resolves provider/model via mcoda agent DB)
- `CODALI_AGENT_INTERPRETER` (env override for interpreter agent selection)

## Patch resilience behavior (Epic-5)
Codali enforces deterministic patch behavior before and during apply:

- strict schema/content gate before apply (malformed JSON, schema-echo payloads, and empty top-level arrays fail closed)
- deterministic patch failure classes: `schema`, `scope`, `search_match`, `filesystem`, `rollback`, `guardrail`
- bounded retry/fallback ladder with class-aware retryability (non-retryable classes short-circuit)
- rollback attempt on partial apply failure, with rollback failure surfaced as its own class
- final patch failures carry attempt-history metadata in run artifacts/logs

Critic PASS gate is also stricter:
- PASS is blocked without concrete plan-target evidence
- touched files must align with plan targets
- critic report includes `alignment_evidence` fields for auditability

## Docdex configuration
codali uses docdex for search, snippets, impact graphs, and memory tools.

- `DOCDEX_HTTP_BASE_URL` (default `http://127.0.0.1:28491`)
- `CODALI_DOCDEX_REPO_ID` (optional)
- `CODALI_DOCDEX_REPO_ROOT` (optional)

Docdex transport:
- HTTP: search/snippets/impact graph
- MCP: symbols/AST/memory/tools

## Context hints and guardrails
Use these when you want to pin context or avoid extra search calls.

- `CODALI_CONTEXT_PREFERRED_FILES` (comma-separated; preferred focus/periphery list)
- `CODALI_CONTEXT_SKIP_SEARCH=1` (skip docdex search when preferred files are present)
- `CODALI_PLAN_HINT` (string or JSON plan; bypasses architect when JSON)
- `CODALI_SECURITY_READONLY_PATHS` (comma-separated read-only paths for WRITE POLICY)

## Smart routing config
Define per-phase routing in `codali.config.json` (fields are optional; prefer `agent` so provider/model are resolved from the mcoda agent registry):

```json
{
  "routing": {
    "librarian": { "agent": "<librarian-agent-slug>", "temperature": 0.1 },
    "architect": { "agent": "<architect-agent-slug>", "temperature": 0.4 },
    "builder": { "agent": "<builder-agent-slug>", "temperature": 0.2, "format": "json" },
    "critic": { "agent": "<critic-agent-slug>", "temperature": 0.1 },
    "interpreter": { "agent": "<interpreter-agent-slug>", "temperature": 0.1 }
  },
  "limits": {
    "maxRetries": 3
  }
}
```

To enforce a GBNF grammar with Ollama, set:

```json
{
  "routing": {
    "builder": { "format": "gbnf", "grammar": "root ::= \"ok\"" }
  }
}
```

Routing env overrides:
- `CODALI_PROVIDER_LIBRARIAN`
- `CODALI_PROVIDER_ARCHITECT`
- `CODALI_PROVIDER_BUILDER`
- `CODALI_PROVIDER_CRITIC`
- `CODALI_PROVIDER_INTERPRETER`
- `CODALI_MODEL_LIBRARIAN`
- `CODALI_MODEL_ARCHITECT`
- `CODALI_MODEL_BUILDER`
- `CODALI_MODEL_CRITIC`
- `CODALI_MODEL_INTERPRETER`
- `CODALI_FORMAT_LIBRARIAN`
- `CODALI_FORMAT_ARCHITECT`
- `CODALI_FORMAT_BUILDER`
- `CODALI_FORMAT_CRITIC`
- `CODALI_FORMAT_INTERPRETER`
- `CODALI_GRAMMAR_LIBRARIAN`
- `CODALI_GRAMMAR_ARCHITECT`
- `CODALI_GRAMMAR_BUILDER`
- `CODALI_GRAMMAR_CRITIC`
- `CODALI_GRAMMAR_INTERPRETER`
- `CODALI_LIMIT_MAX_RETRIES`

## Work-on-tasks integration
`work-on-tasks` uses codali via the `codali-cli` adapter when required. Streaming can be toggled via `CODALI_STREAMING_ENABLED`.

Required environment variables for WOT + codali:
- `CODALI_BIN`
- `CODALI_API_KEY` (for openai-compatible providers)
- `DOCDEX_HTTP_BASE_URL`
- `CODALI_DOCDEX_REPO_ID`
- `CODALI_DOCDEX_REPO_ROOT`

When `gateway-trio` is used, WOT will pass the gateway handoff into codali by setting:
- `CODALI_CONTEXT_PREFERRED_FILES` (from gateway file list)
- `CODALI_CONTEXT_SKIP_SEARCH=1` (skip docdex search when preferred files exist)
- `CODALI_PLAN_HINT` (gateway plan steps as JSON)
- `CODALI_SECURITY_READONLY_PATHS` (docs/sds, docs/rfp, openapi + openapi.yaml/yml/json)

## Tool configuration
- `CODALI_TOOLS_ENABLED` (comma-separated tool names; empty means all)
- `CODALI_ALLOW_SHELL` (set to `true` to enable `run_shell`)
- `CODALI_SHELL_ALLOWLIST` (comma-separated commands allowed by `run_shell`)

## Use codali as a mcoda agent adapter
Configure an agent with adapter `codali-cli` and pass provider/base URL details in the agent config.

Example agent config:

```json
{
  "adapter": "codali-cli",
  "defaultModel": "gpt-4o-mini",
  "config": {
    "provider": "openai-compatible",
    "baseUrl": "https://api.openai.com/v1",
    "docdexBaseUrl": "http://127.0.0.1:28491"
  }
}
```

The adapter passes workspace root via metadata when available. If missing, it falls back to the current working directory.

## Logs
Each run writes JSONL logs under `logs/codali/<runId>.jsonl` by default, rooted in the global
workspace folder (`~/.mcoda/workspaces/<workspace>/`).

## Troubleshooting
- If docdex is unavailable, verify the daemon with `docdexd serve --repo <path>` or set `DOCDEX_HTTP_BASE_URL`.
- If the CLI is not on PATH, set `CODALI_BIN` to the binary location.
