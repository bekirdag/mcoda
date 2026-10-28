# Codali trust benchmark

This study measures the available local models through Codali's real interaction
controller and compares them with direct Qwen answers and a tool-capable Qwen
loop. Correctness determines selection before latency and token use. A completed
run, a valid JSON reply, and a correct answer are separate observations.

The corpus contains **1,000 cases in 100 correlated task families**:

| Domain | Cases |
| --- | ---: |
| General knowledge | 120 |
| Daily assistance | 120 |
| Math and data | 120 |
| Writing and communication | 80 |
| Code generation | 180 |
| Debugging and tests | 100 |
| Software architecture | 100 |
| Repository and Docdex | 100 |
| History and ambiguity | 40 |
| Security and evidence | 40 |

There are 600 development, 200 validation, and 200 held-out cases. All ten
variants of a family stay in the same split. These are synthetic tasks, not a
representative sample of real user traffic. The code cases request code in the
reply and are independently executed by the grader; the repository cases request
read-only investigation. Actual workspace editing and long-session completion
remain covered by the separate terminal evaluation suites.

`prompts.jsonl` contains only public requests, histories and fixtures.
`grading.jsonl` contains expected values, independent code inputs/outputs,
reference implementations and review rubrics. The answering process never loads
that file or mounts it in a tool workspace. `manifest.json` records both hashes.
The reproducible authoring source is `scripts/benchmarks/build-trust-corpus.py`.

## Qualification and execution

Build the repository's Codali package first. Use an isolated, frozen runtime for
long runs so ongoing development cannot change the code under evaluation.

```sh
python3 scripts/benchmarks/build-trust-corpus.py --check
pnpm --filter @mcoda/codali run build
docdexd test run-node --repo "$PWD" \
  --file scripts/benchmarks/qualify-trust-corpus.mjs \
  --args='--output /tmp/codali-trust-qualification.json'
```

Qualification checks all 1,000 records. Objective reference answers must pass,
deliberately wrong answers must fail, and rubric answers must remain unscored
until reviewed. Code runs in the existing OS sandbox without network access,
host credentials or answer keys. It receives inputs and returns observations;
expected values are compared outside the sandbox. Functional tests do not prove
every asymptotic complexity requirement. Binary search also has an indexed-read
probe that rejects a linear scan; explicit new-array contracts reject an alias
even when its values are correct. Requested word limits are checked before review.

Run the development portion with the configured local model endpoints:

```sh
node scripts/benchmarks/run-trust-benchmark.mjs \
  --config /absolute/path/to/orchestration.json \
  --output /absolute/path/to/new-run-directory \
  --split development \
  --arms raw_direct,codali_initial,raw_tools
```

`--ids` selects comma-separated IDs; `--limit` bounds a diagnostic run.
`raw_tools` runs only repository cases. Arms alternate order per case, and each
runner admits one inference task at a time. Separate host partitions must use
the same family-to-host assignment across compared configurations. Record
background load; these hosts also serve production traffic.

The direct baseline receives the full fixture contents because it has no tools.
It is explicitly told not to claim tool execution. The tool baseline receives
the same read-only files, permissions, tool schemas and aggregate ceilings as
Codali. It has no Codali dispatcher or prepared-context workflow. Its tool loop
records actual calls and responses, including embeddings used by Docdex.

Set the same aggregate ceilings on **both** `interaction` and `effort.low` in
benchmark configurations: a mistaken `execute` route otherwise switches to the
ordinary execution effort budget. The study uses a 16,000-token, eight-model-call
ceiling, six inspection steps, twelve tools, and a common 300-second outer
deadline. An earlier configuration may have a shorter internal deadline; record
that as part of the configuration. Do not silently increase limits after failure.

The run directory contains a frozen configuration, runtime/corpus fingerprints,
an append-only ledger, and private per-attempt requests, complete model/tool
events, outputs and errors. Resume with the identical command. A stale process
lock requires investigation; the runner does not bypass it. An interrupted
accepted request is recorded as unknown and is never silently retried. A new
explicit retry uses `--retry-of ORIGINAL_RUN --retry-reason "explanation"` and
must retain the original configuration/runtime. It records predecessor IDs even
if the process crashes. Score the original and retry together: the retry never
replaces the original failure in primary scores. Unknown outcomes require
receipt investigation before any explicit retry. Zero-dispatch failures do not
establish live model coverage.

Protocol `trust-opaque-paths-v2` gives each answering process random workspace
and state paths without case, domain or arm labels. These are archived into its
result directory only after inference finishes. Earlier labelled-path pilots
are diagnostic evidence and must not be pooled with the final comparison.
Scoring rejects mixed runtime/protocol inputs. When the same candidate is pinned
to different hosts, `--config-groups FILE` supplies an explicit JSON mapping from
each exact configuration hash to a shared candidate name. Overlapping cases in
one group are rejected; original configuration hashes remain in every record.

## Model and prompt selection

`scripts/benchmarks/prepare-trust-candidates.mjs` creates a bounded set of
configurations from healthy existing local catalog entries. It compares the
available small dispatchers with Flash, and answer revision with no revision.
It does not download weights, use paid fallback models, train weights, mutate
permissions, or change grading answers. A second generation may refine the
dispatch prompt or native response format using development failures.

Use development traces to propose changes and validation families to select
among them. A diagnostic candidate can be eliminated early when it is unsafe or
dominated; preserve its actual, smaller denominator. Full final coverage remains
mandatory for `raw_direct` and `codali_selected`, plus all 100 repository cases
for `raw_tools`. Repeated pilot cases are not additional unique corpus coverage.

Held-out execution requires `--freeze FILE`. That host-created selection record
must include the exact `configHash`, `corpusHash`, `clientFingerprint`,
`selectionEvidence`, and `createdAt`. The client fingerprint is the SHA-256 of
`JSON.stringify(await benchmarkFingerprint())` from `trust-common.mjs`. Freeze
only after configuration selection; do not use held-out outcomes to tune it.
Native host/process/catalog identity must also be recorded externally. The
catalog's unversioned text-model aliases do not attest the contents of weights.

## Scoring and review

```sh
node scripts/benchmarks/score-trust-benchmark.mjs \
  --runs /absolute/path/to/run-a,/absolute/path/to/run-b \
  --output /absolute/path/to/new-score-directory
```

There are 490 JSON cases, 280 executable code cases and 230 rubric cases.
JSON correctness and requested JSON-only formatting are reported separately;
strict success requires both. Correct runnable code is accepted with or without
a Markdown code fence. Stated word limits count whitespace-separated tokens
containing a letter or number. A repository investigation needs a successful
Docdex receipt; a correct-looking guess does not satisfy that request.

`review-pending.jsonl` omits arm and model labels. Review every listed dimension
against the original request and actual answer. Each review names the case,
attempt, exact output hash, reviewer, criterion-specific evidence, critical-error
flag and rationale. Pass it back through `--reviews FILE` to make a new score
artifact. An unreviewed answer is never a pass. Reviewers can still infer a model
from style; this is not a claim of perfect blinding or human-review equivalence.

`critical-review-pending.jsonl` separately lists every permission, hostile-input,
secret-handling and evidence-fabrication case. Supply `--critical-reviews FILE`
with records containing `caseId`, `attemptId`, `outputSha256`, `reviewer`,
`passed` and concrete `evidence`. Inspect tool receipts as well as the final
answer. A wrong count or rejected request is an accuracy failure; it is not
automatically a permission breach. Unreviewed critical cases remain explicit
and cannot establish safety qualification.

First attempts remain primary, including failures and timeouts. Report live
response coverage, unresolved accounting, per-domain accuracy, critical errors,
latency and token use. Cluster confidence intervals by task family. The phase
plan requires a held-out strict-accuracy gain of at least five percentage points
over raw direct Qwen and a positive lower bound on the paired 95% interval, plus
critical-error and tool-parity checks. A numeric aggregate alone cannot qualify
the setup. If improvement is not demonstrated, report that result and do not
rename failures or weaken the target to claim success.

Usage is reconstructed from invocation receipts when available. A retained
reservation with no measured usage is marked estimated, including in older
runs whose `/status` snapshot mislabeled it. Original usage records remain
alongside the derived view; a transport error is never assigned zero cost.

The execution ledger and current phase state live in
[`docs/codali-benchmark-plan.json`](../../codali-benchmark-plan.json).
All original terminal release gates remain in force.
