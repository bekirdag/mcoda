# Worker model scoreboard

Every model tried for the `worker` role, scored on the behaviour suite. The
orchestrator stays on a small model throughout (it only emits routing JSON) and
the synthesizer stays on qwen3.6, so the worker is the only variable.

Screening runs use the three categories that depend on tool use — `repo` (12),
`web` (8) and `private` (6), 26 cases — at concurrency 2. The finalist is then
run over all fifty to confirm nothing regressed in generation, reasoning,
honesty, ambiguity or prompt-injection resistance.

```
node packages/codali/eval/run-behaviour-suite.mjs --only repo,web,private --concurrency 2
```

## Availability

Established by sending each model a real tool-call request rather than trusting
its inventory record, which turned out to be wrong in both directions.

| model | reachable | emits tool calls | latency |
|---|---|---|---|
| `local-qwen3b` (qwen2.5:3b, ollama) | yes | yes | ~1s |
| `sukunahikona-qwen3-0-6b-instruct` | yes | yes | 1.2s |
| `sukunahikona-qwen3-1-7b-instruct` | yes | yes | 1.2s |
| `sukunahikona-qwen3-4b-instruct-2507` | yes | yes | 1.3s |
| `sukunahikona-qwen3-6-llama-cpp` | yes | yes | 3.3s |
| all `cassandra-local-*` | — | — | ignore: not a real server |

Cassandra is not a real server. Its thirty-odd agents are inventory entries
only; disregard them when choosing a model.

Every suku model was then probed with a real tool-call request and its record
corrected to match, on 2026-08-06:

| model | port | tool calls | was recorded | now |
|---|---|---|---|---|
| `qwen3-0.6b-instruct` | 11442 | no — answers in prose | false, ctx 16384 | false, ctx 32768 |
| `qwen3-1.7b-instruct` | 11443 | **yes** | false | **true** |
| `qwen3-4b-instruct-2507` | 11440 | **yes** | false, ctx 16384 | **true**, ctx 32768 |
| `qwen3.6-llama.cpp` | 11437 | yes | true | true (unchanged) |

Three of the four records were wrong, and the errors were not harmless: a model
recorded as `supportsTools: false` is silently passed over for tool work, so
the 1.7B and 4B were never eligible as workers at all. Context windows were
understated by half for two of them.

`qwen2.5-1.5b-instruct` is registered against port 11441 with nothing serving
it — a stale entry worth deleting.

## Scores

| worker | repo /12 | web /8 | private /6 | screen /26 | median | notes |
|---|---|---|---|---|---|---|
| **`local-qwen3b`** (qwen2.5:3b) | **8** | **4** | **5** | **17** | 54s | **kept** |
| `qwen3-4b-instruct-2507` | 7 | 3 | 5 | 15 | 53s | test invalid, see below |
| `qwen3.6-35b-a3b` | 4 | 2 | 0 | 6 | 73s | rejected |
| `Qwen3.5-9B` (installed, then removed) | 0 | 3 | 0 | 3 | 26s | rejected |

The smallest model won, which was not the expected result. Two of these numbers
need a caveat before anyone acts on them.

**The 4B run did not measure the 4B.** Its inventory record says
`supportsTools: false`, so the gateway quietly handed tool calling back to the
orchestrator — which is `local-qwen3b`. That row is mostly the 3B again, and the
small difference from row one is run-to-run noise. Fixing the metadata would
make the comparison real; it has not been done.

**Qwen3.5-9B is not a bad model.** Driven directly it answers a worker prompt
correctly and calls the right tool with 3, 27, 35 and 41 tools in scope, in
under three seconds. Through the gateway it called no tool in any of the 26
cases. The gap is in how a locally-registered agent is driven, not in the
model, and it is unexplained — worth reopening if a self-hosted worker is
wanted later.

One real bug surfaced on the way: a locally-registered agent with
`authMode: bearer` carries no key into the provider, so the worker call failed
in 0ms on every request while the run still reported success. Running the
trial server without auth on loopback worked around it for the benchmark.

## Why the big model loses

qwen3.6 is a 35B-A3B MoE started with `--n-cpu-moe 22`, so a third of its
experts run on CPU. It answers a bare tool prompt in 3s and a loaded one in
12s, against ~1s for the 3B. As the synthesizer, once per run, that is a good
trade. As the worker, called for every sub-task, it spends the budget without
producing better tool calls — and on the private-data questions it produced no
tool calls at all, scoring 0/6.

## Trial cleanup

Qwen3.5-9B was downloaded (5.68 GB), served on port 11441, benchmarked, and
removed: systemd unit disabled and deleted, model directory removed, key file
removed, agent records deleted on both machines. GPU1 returned to its
pre-trial 6591 MiB.
