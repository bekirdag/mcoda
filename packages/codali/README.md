# @mcoda/codali

Codali is mcoda's terminal coding agent and embeddable tool runtime.

## Terminal quick start

```sh
codali login                 # masked mSwarm API-key entry
codali setup                 # discover authorized model routes and prepare private Docdex
codali doctor
codali chat --permissions ask --effort medium
```

Interactive `codali` and `codali chat` open the terminal UI with a scrollable
conversation, multiline editor, tool cards, approval dialogs and persistent
model, effort, permission and usage status. `codali resume SESSION_ID` restores
the conversation and waits for input; `/continue` resumes execution. JSONL and
noninteractive resume retain their automation behavior.

| Key | Action |
| --- | --- |
| Enter | Send, or queue a message while work is running |
| Alt+Enter or Ctrl+J | Insert a newline |
| Ctrl+S | Submit a correction; cancel current work and apply it at the next safe checkpoint |
| Ctrl+P / Ctrl+R | Search commands / input history |
| Tab | Complete a slash command or an `@workspace/path` reference |
| Page Up / Page Down | Scroll conversation or inspect a dialog |
| Ctrl+O | Expand or collapse tool output |
| Escape | Close a view, deny an approval, or cancel active work |
| Ctrl+C | Cancel work; press again within one second to exit |
| Ctrl+D | Exit with an empty editor |

Approvals start on **Deny**. Use Left/Right to choose, then Enter to confirm;
Page Up/Down exposes the complete arguments. Pasted text remains editable and
cannot select an approval. Use `NO_COLOR=1` for a monochrome TUI or `--plain`
for a line-oriented interface. Redirected output and `TERM=dumb` use plain mode.
The UI restores terminal modes and the original screen when it closes.

For automation, inject `MCODA_MSWARM_API_KEY` through your secret manager, or pipe
the key to `codali login --stdin`. Keys are never command-line arguments. Existing
encrypted mcoda credentials are reused when their service origin matches.
`codali logout` removes the terminal credential and disables that fallback;
an explicitly supplied environment credential still takes precedence.

```sh
codali exec 'Fix the failing parser test and verify the fix' \
  --permissions workspace --effort high --json
codali sessions
codali resume SESSION_ID --permissions workspace --effort high --json
codali inspect SESSION_ID
```

The terminal uses a versioned orchestration file: `--config PATH`, then
`CODALI_ORCHESTRATION_CONFIG`, then `~/.codali/orchestration.json`. Repository files
cannot silently select credential destinations or change terminal permissions.
See [the configuration reference](ORCHESTRATION.md) and the packaged `config/`
examples. `setup` never overwrites an existing profile. `/config reload` applies
an edited, validated profile between turns; submitted media jobs keep their
original configuration. All optional model roles must be explicitly bound or
disabled. Setup selects only catalog routes that identify their backend as Strata
for large-model work; it does not choose a paid fallback.

Setup enables embeddings only when the catalog declares a pinned model digest,
dimensions, query/document prefixes, normalization and pooling. Replicas must
match that entire contract. When embeddings are available, setup installs the
release-pinned Docdex binary in `~/.local/state/codali/runtimes/docdex/`, verifies
archive and binary checksums, and checks managed-client capabilities. It records
the binary path and checksum in the profile; sessions verify the checksum before
launching a private daemon. `doctor` checks this configured runtime.

For a locally built qualified binary, use `codali setup --docdex-binary /absolute/path/docdexd`.
Development builds without pinned release artifacts require this option. Setup
does not initialize the global daemon or overwrite its configuration. A failed
runtime qualification leaves the new profile unwritten; previous installed
runtime versions remain available for existing profiles.

| Command | Purpose |
| --- | --- |
| `/status`, `/usage` | Current execution state, reconciled accounting and server limits |
| `/permissions [plan\|ask\|workspace\|clear]` | Inspect/change policy or revoke exact session grants |
| `/effort [low\|medium\|high\|max]` | Change the shared model, tool, token and time budget between turns |
| `/goal`, `/plan`, `/tasks`, `/decisions` | Read the durable objective, criteria, dependencies and architecture decisions |
| `/models`, `/config [reload\|validate PATH\|diff PATH]` | Inspect routes or validate/compare a proposed configuration before reloading |
| `/plan [show\|history\|edit TEXT\|mode plan\|execute]` | Inspect or revise the plan; execute mode uses the approval policy |
| `/tools`, `/mcp`, `/docdex` | Inspect available tools, connectors and indexing configuration |
| `/context`, `/diff`, `/review` | Inspect retained context/changes or request a new review task |
| `/checkpoint`, `/compact` | Save progress or reduce conversation context while preserving canonical work state |
| `/cancel`, `/continue`, `/steer TEXT` | Interrupt, continue, or apply an explicit goal amendment |
| `/sessions`, `/resume ID`, `/fork`, `/new TEXT` | Manage sessions; forks require fresh verification and reset grants |
| `/artifacts` | Inspect durable image, audio and video jobs and artifact checksums |
| `/reconcile ID success\|failed NOTE` | Record an observed outcome for an interrupted tool invocation |
| `/export`, `/retention DAYS`, `/delete-session ID` | Export redacted events, preview retention candidates, or delete an inactive session |

Between turns, `/usage` reconciles up to 16 model requests with authenticated
mSwarm receipts. Repeat it if `remaining` is nonzero. Durable request IDs join
local calls to server attempts; successful reconciliation is replay-safe across
restarts. Missing, active, truncated or unreported receipts remain unresolved,
and an incomplete legacy ledger cannot reduce the shared budget. Reconciliation
requires the receipt endpoint and the original configured provider/key; older
servers return an explicit unavailable result. During a turn it is deferred.
Accounting settlement does not mark the coding task complete or replay inference.

`plan` permits reads; `ask` asks before side effects; `workspace` permits scoped
file edits and isolated shell commands. Web research, memory writes and media
generation have separate approval categories. Automation can explicitly enable
them with `--allow-web`, `--allow-memory` and `--allow-media`. Shell networking is
disabled unless `--allow-network` is supplied. Noninteractive requests for approval
are denied. Session grants match the exact tool arguments and remain subordinate
to the current policy. Linux execution requires bubblewrap; run `doctor` to check
the available platform executor.

The executor discovers installed Node/package-manager, Python and Rust tools from
the host's trusted PATH. Private Python standard libraries and the selected Rust
toolchain libraries are exposed read-only; Cargo and Python caches use a temporary
private home. Rustup proxies resolve to an already-installed host toolchain (the
host's `RUSTUP_TOOLCHAIN` or default), without repository-triggered downloads.
On macOS, the selected installed Xcode developer tools and SDK are also read-only.
Use `doctor` to inspect selected executable paths. Dependency installation still
requires network permission, and build outputs must fit the task's write scope.

Each task is tied to the original goal and a bounded path scope. A successful tool
call is not task completion: changed code needs recorded validation and separate
review, and the goal gate checks requirement coverage, current file hashes and
unresolved operations. Interruptions preserve checkpoints and uncertain outcomes;
they do not trigger an automatic retry of a side effect. Session data lives under
`~/.local/state/codali/workspaces/`, outside the editable repository. Media workers
survive terminal disconnects and keep binary artifacts out of model transcripts.

`--json` emits JSONL events. Stable fields are `schemaVersion`, `type` and `data`;
session events also carry `id`, `sessionId`, `sequence` and `at`. `turn_result`
contains `completed`; consumers must check it. `command_failed` covers command
failures. Exit codes are 0 for verified completion (or a requested planning turn),
1 for errors, 2 for open/blocked work, and 130 for cancellation. `--plain` disables
terminal editing escapes and token streaming. Ctrl-C requests cancellation;
a second Ctrl-C closes the terminal after cleanup.

## Legacy runtime commands

The following commands preserve the previous provider/configuration contract.
They do not automatically inherit the terminal orchestration profile. Embedded
hosts opt in with the trusted `orchestration.resolved` runtime input.

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
