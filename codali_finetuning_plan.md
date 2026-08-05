# Codali Fine-Tuning Plan

Goal: make Codali answer the six examples in `codali_workflow.txt` well, not just run without crashing.

Status today: the plumbing works. All connectors are live (docdex, GitHub, Jira, Microsoft Graph, web). Every failure we still see comes from the model doing the planning, not from Codali.

---

## Where it stands

Re-measured 2026-08-05, all-local models.

| Example | Works? | Notes |
|---|---|---|
| #1 Write pingpong code | Yes | Clean |
| #2 GDP of France | Partly | Goes to the web only when the index returns nothing; a weak match stops it |
| #3 Generate an image | Yes | Writes a PNG, returns a file path |
| #4 Bekir's performance | Yes | 31 cited evidence items from a 30-commit history |
| #5 Project X blockers | Yes | Found the blocked issue and cited it |
| #6 Who needs contacting | Partly | Names real people; needs re-measuring after the evidence fix |

**Invalid tool calls: fixed.** Every call across the test questions was valid.

**Evidence loss: fixed.** A connector list of 12 commits used to become a single
placeholder — "Tool … returned structured data" — so the synthesizer never saw
the records. Two causes: the normalizer had no way to describe a record with no
`claim` field, and the MCP adapter passed the protocol envelope downstream
instead of the parsed payload. A 30-commit history now yields 31 evidence items.

**Cost:** richer evidence means a bigger context pack, so answers went from ~48s
to ~250s on local models. Accepted — the previous fast answer was fast because
it had almost nothing in it.

Remaining gap is #2: the web fallback is presence-based, not relevance-based.

---|---|---|
| #1 Write pingpong code | Yes | Clean |
| #2 GDP of France | Partly | Goes to the web only when the index returns nothing; a weak match stops it |
| #3 Generate an image | Yes | Writes a PNG, returns a file path |
| #4 Bekir's performance | Partly | Correct tool calls, correct data, but large results get cut off |
| #5 Project X blockers | Yes | Found the blocked issue and cited it |
| #6 Who needs contacting | Partly | Names real people, misses some — same truncation |

**Invalid tool calls are fixed.** Across three test questions every call was
valid. The earlier problem — invented dates, empty ids, unsupported parameters —
came from the large model on the worker role and from stating the current time
without saying it was unusable as a filter. Both addressed.

What remains is **completeness, not correctness**: answers are accurate and
honest about what is missing, but large tool results are truncated, so a
fortnight of activity can come back as one item.

---|---|---|
| #1 Write pingpong code | Yes | Clean |
| #2 GDP of France | Partly | Falls back to web only when the local index finds nothing. If the index has a weak match it stops there |
| #3 Generate an image | Yes | Writes a PNG, returns a file path |
| #4 Bekir's performance | Partly | Reaches GitHub and Jira, but the small model writes bad tool arguments |
| #5 Project X blockers | Yes | Found the blocked Jira issue and cited it |
| #6 Who needs contacting | Partly | Reaches mail and chats, names real people, but misses most of them |

The pattern: **Codali asks the right questions, the small model fills in the wrong details.**

---

## Fixes required

- **mswarm routing: FIXED** (gateway runtime `0e9e877`, 2026-08-05). Self-hosted models now dispatch to the node instead of OpenRouter. Codali's filter that excluded these agents has been removed.
- **The suku node is too slow to orchestrate.** A trivial "say ok" call takes 25-130 seconds. A single question needs six or more model calls, so runs take minutes and some tasks time out before calling a tool. This is node health, not routing.
- **Make the web fallback smarter.** It only goes to the web when the repository index returns nothing at all. It should also go when results are clearly unrelated.
- **Stop tools returning more data than fits.** Large results get cut off, so answers are honest but incomplete.
- **Update `codali_build_plan.md`.** Says config files are TOML (they are JSON), and still claims GitHub and Jira are untested. Both are live.

## Model tiering — all local (2026-08-05)

**Production constraint: local models only.** No OpenAI, Anthropic, or hosted
cloud routing, in any role. A hosted model may be used for a one-off diagnostic
comparison but must never end up in a working config.

Working configuration:

```json
{ "agents": {
    "orchestrator": "local-qwen3b",
    "worker": "local-qwen3b",
    "synthesizer": "mswarm-self-hosted-mcoda-sukunahikona-qwen3-6-llama-cpp"
} }
```

`orchestrator` classifies and plans, `worker` makes the tool calls, `synthesizer`
writes the final answer. Roughly 2 minutes per question. That is the cost of
local models and is accepted.

Local synthesizer candidates, measured (3 calls each):

| Model | Reliability | Latency | Note |
|---|---|---|---|
| qwen3.6-llama.cpp (suku) | 3/3 | 47s | best quality, current choice |
| qwen3-4b-instruct-2507 (suku) | 3/3 | 11s | faster, weaker |
| qwen-3-5-35b (cassandra) | 0/3 | — | node not responding |
| local-qwen3b (ollama) | 3/3 | 1s | too small for synthesis |

Putting the large model on the *worker* role was worse on both axes — slower,
and it answered from memory instead of calling tools, once fabricating a file
path. Keep the large model on synthesis only.

---|---|---|---|---|
| qwen3.6 | qwen3.6 | codex55 | 138s | 0 tool calls |
| local-qwen3b | qwen3.6 | qwen3.6 | 112s | **fabricated a file that does not exist** |
| **local-qwen3b** | **local-qwen3b** | **qwen3.6** | **47s** | **correct, cited** |

Use the third. Small fast model plans and calls tools, qwen3.6 writes the final answer only.

```json
{ "agents": {
    "orchestrator": "local-qwen3b",
    "worker": "local-qwen3b",
    "synthesizer": "mswarm-self-hosted-mcoda-sukunahikona-qwen3-6-llama-cpp"
} }
```

`worker` is a new role: it makes the tool calls. Leave it unset and it follows the orchestrator.

Putting qwen3.6 on the worker was worse on both counts — slower and less accurate. It answered from memory rather than calling tools.

---

## What to work on next

### 1. Get a capable model on tool calls (do this first)

Try in this order, stop when one works.

- **Option A — fix mswarm routing.** Test with:
  ```sh
  curl -s -X POST https://api.mswarm.org/v1/swarm/openai/chat/completions \
    -H "Authorization: Bearer $MSWARM_KEY" -H 'Content-Type: application/json' \
    -d '{"model":"qwen/qwen3-6-27b","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
  ```
  Success looks like a normal reply. Failure looks like `is not a valid model ID`.

- **Option B — run one locally.** Roughly 18 GB download:
  ```sh
  ollama pull qwen3:30b
  mcoda agent add local-qwen30b --adapter ollama-remote --model qwen3:30b \
    --config-base-url http://127.0.0.1:11434 --supports-tools true \
    --context-window 32000 --max-output-tokens 8192 --cost-per-million 0
  ```

- Then point Codali at it in `~/.codali/config.json`:
  ```json
  { "agents": { "orchestrator": "local-qwen30b", "synthesizer": "codex55" } }
  ```
  Codali picks the tool worker automatically and prefers a model that can actually make tool calls.

### 2. Re-run the six examples

After the model change, run each and record what happens.

```sh
codali ask "Write a simple html/js pingpong game" --no-tools
codali ask "What is the GDP of France in 2025?"
codali ask "Generate an image of a puppy"          # needs media config
codali ask "Summarize my commits and Jira issues from the last two weeks"
codali ask "What are the current blockers in my Jira projects?"
codali ask "Who have I not replied to in email or Teams recently?"
```

Judge each on three things only:

- Did it call the right tools?
- Are the tool arguments valid (no invented dates, no empty ids)?
- Does every claim cite an evidence id?

### 3. Fix what the re-run exposes

Expect the remaining problems to be tool descriptions, not code. When a model calls a tool wrongly, the usual fix is a clearer description or a tighter input schema — both live in `~/.codali/config.json`, so no rebuild is needed.

### 4. Then tune the prompts

Only after step 3. Prompts live in:

- `packages/codali/src/gateway/GatewayPlanner.ts` — how the plan is made
- `packages/codali/src/gateway/LocalGatewayTaskRunner.ts` — how a worker uses tools
- `packages/codali/src/gateway/CodaliGateway.ts` — how the final answer is written

### 5. Housekeeping

- Refresh `codali_build_plan.md` (TOML→JSON, stale "untested" notes).
- Add a `codali auth` section to it; the whole Microsoft sign-in flow is undocumented there.
- Confirm the leaked Jira token was revoked.

---

## How to test as you go

Use `--trace` on every run. It shows, in order: which capabilities were chosen, the plan, each tool call with its arguments, whether it succeeded, and why the run ended.

Read it in that order. Most problems are visible in the tool-call arguments line.

```sh
codali ask "<question>" --trace
```

Quick checks:

```sh
codali tools health                    # are connectors up
codali tools list                      # what the model can see
codali tools call <name> --args-json '{}'   # test one tool without a model
```

`tools call` is the fastest way to tell a connector problem from a model problem. If the tool works by hand but fails in a run, the model wrote bad arguments.

---

## Behaviour suite (added 2026-08-05)

Unit tests say the machinery compiles; they say nothing about whether an answer
is any good. `packages/codali/eval/behaviour-suite.json` asks fifty live
questions across eight behaviours and grades each mechanically, so it can be
re-run after every change without a person reading fifty answers.

```
node packages/codali/eval/run-behaviour-suite.mjs --concurrency 2
node packages/codali/eval/run-behaviour-suite.mjs --only repo,web
node packages/codali/eval/run-behaviour-suite.mjs --ids repo-01,gen-01
```

The grader checks the things that actually go wrong: a cited path that does not
exist on disk, repo files cited for a question about the world, a generation
request that came back as a literature review, a hedge where the evidence held
the answer, and a leaked secret.

### Where it stands

Five consecutive runs scored 37, 38, 39, 39, 37 out of 50. Generation is 8/8,
honesty 5/5 and adversarial 2/2 on every run.

Of the thirteen or so failures in any given run, only seven are the same ones
each time. The rest flip between runs — the same question passes and fails with
no code change, because a 3B orchestrator on a loaded local box is not
deterministic. Chasing those with more code changes would be fitting to noise.

**Consistently failing, in rough order of value:**

- `repo-05`, `repo-11`, `repo-12` — questions needing a specific value or a file
  listing. Docdex ranks by whole-file similarity, so `ToolRegistry.ts` loses to
  files that merely discuss registering tools.
- `repo-06` — finds the constant, reports "a negative priority", never quotes
  `-10`.
- `web-04`, `web-05` — external facts where the fetched pages did not contain
  the specific figure or name.
- `priv-06` — picks web research over the Graph mail connector for the user's
  own mailbox, despite both the classifier and planner prompts now saying to
  match the tool to where the answer lives.

Every one of these is the same underlying limit: a 3B model choosing and
following up on tools. The measured alternative is worse — swapping the worker
to qwen3.6 scored **0/12** on the repo category, timing out rather than
answering, which is why the small worker stays.

### Note on the index

`.docdexignore` excludes `packages/codali/eval/` because the suite states its
own expected answers. Indexed, it was being returned as a search hit for the
very questions it grades. Docdex's index is additive, so if it ever gets in
again, the fix is to move `~/.docdex/state/repos/<id>/index` aside, restart the
daemon, and reindex.

## Current setup, for reference

Credentials in `~/.codali/.creds` (`KEY=value`, one per line, mode 600):

```
GITHUB_TOKEN, JIRA_EMAIL, JIRA_TOKEN, JIRA_BASE_URL,
MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_REFRESH_TOKEN
```

Connectors in `~/.codali/config.json`:

| Name | Type | Tools |
|---|---|---|
| docdex | built in | 26 |
| github | MCP | 23, read only |
| jira | HTTP | 4 |
| graph | HTTP + OAuth | 5 |
| web | via docdex | 1 |

Models: `orchestrator` plans, `synthesizer` writes the answer, and the tool worker is chosen automatically — command-line models such as codex cannot make tool calls, so Codali skips them for that job.
