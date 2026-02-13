# @mcoda/codali

Standalone tool-runner adapter for mcoda. codali runs a tool loop that can edit the repo directly via built-in tools, with optional streaming output and pre-flight cost estimates.

## Usage

Run with a task file:

```sh
codali run --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
```

Or pass the task on stdin:

```sh
echo "Fix the failing test" | codali run --workspace-root . --provider ollama-remote --model llama3
```

## Smart pipeline
Enable the multi-phase pipeline with `--smart` (librarian/architect/builder/critic):

```sh
codali run --smart --workspace-root . --provider openai-compatible --model gpt-4o-mini --task tasks/work.txt
```

You can also set `CODALI_SMART=1` in the environment.

## Providers
- `openai-compatible` (default base URL: `https://api.openai.com/v1`)
- `ollama-remote` (default base URL: `http://127.0.0.1:11434`)
- `stub` (test-only provider)

## Config and env
codali merges config in this order:
1) CLI args
2) `codali.config.json` or `.codalirc`
3) Environment variables

Common environment variables:
- `CODALI_WORKSPACE_ROOT`
- `CODALI_PROVIDER`
- `CODALI_MODEL`
- `CODALI_API_KEY`
- `CODALI_BASE_URL`
- `CODALI_STREAMING_ENABLED`
- `CODALI_STREAMING_FLUSH_MS`
- `CODALI_COST_MAX_PER_RUN`
- `CODALI_COST_CHAR_PER_TOKEN`
- `CODALI_COST_PRICING_OVERRIDES`
- `CODALI_TOOLS_ENABLED`
- `CODALI_ALLOW_SHELL`
- `CODALI_SHELL_ALLOWLIST`
- `DOCDEX_HTTP_BASE_URL`
- `CODALI_DOCDEX_REPO_ID`

Routing config (per phase, optional) lives in `codali.config.json`:

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

To enforce a GBNF grammar with Ollama:

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

## Logs
codali writes JSONL logs under `logs/codali/<runId>.jsonl`, rooted in the global workspace folder
(`~/.mcoda/workspaces/<workspace>/`).

## Docdex integration
codali calls docdex over HTTP for search/snippets/graphs and uses MCP for symbols/AST/memory. Ensure `docdexd` is running and `DOCDEX_HTTP_BASE_URL` is set if needed.
