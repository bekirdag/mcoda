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

## Recorded corrections and secondary review

[The corpus erratum](errata.json) records ten validation cases whose `answer`
field is underspecified. The original corpus and strict scores remain frozen.
Report a separate sensitivity analysis excluding the whole family for every
arm and candidate; do not select exclusions based on which model passed.
The exclusion leaves the validation ranking unchanged and neither finalist
release-qualified. No held-out family is affected.

A secondary semantic review can distinguish a correct fact in the wrong format
from an incorrect answer. It does not change strict scores or promotion gates.
Review every eligible JSON failure across arms, bind records to the exact
output hash, and report semantic, formatting and tool-compliance outcomes
separately. Primary Codex review is not human or external independent review.

The original eight-candidate search is closed. An optional calculator experiment
is a separate follow-up phase in the plan, motivated by development failures.
It cannot change the running comparison or reuse exposed held-out cases as
fresh evidence. Any new quality claim requires separately frozen evaluation.

The runner, qualifier and scorer accept `--corpus-root DIRECTORY` for a separate
versioned corpus. Its public prompts and private grading bytes must match its
own manifest; scoring rejects a run from a different corpus. The original
1,000-case partition remains the default qualification contract. A follow-up
manifest may declare `validationContract` with explicit `count`, `families` and
`splits` (`development`, `validation`, `held_out`); uniqueness, family isolation
and fixture boundaries still apply.

Follow-up calculation cases can declare `toolParity: "calculation"`. Their
`raw_tools` baseline receives the same pure calculator, without Codali's
dispatcher/reviewer or unrelated file tools. It uses the same aggregate limits
and a 2,048-token answer ceiling. Actual calculator requests and receipts are
retained. Repository tool baselines keep their existing Docdex surface. This
metadata selects evaluation controls, not the model's interaction route.

The [R1 module-format erratum](../codali-r1/errata.json) records three follow-up
code-generation families whose prompts omit an ES-module requirement even though
the frozen grader requires one. It was recorded during validation, before any R1
held-out inference. Preserve primary grades and selection, report exclusion of
the complete affected families, and use this separate diagnostic to distinguish
module loading from functional correctness:

```sh
node scripts/benchmarks/analyze-trust-code-compatibility.mjs \
  --scores /path/to/r1-scored/scores.jsonl \
  --corpus-root docs/benchmarks/codali-r1 \
  --output /path/to/new-compatibility-directory
```

The diagnostic executes unchanged source as ESM and, when necessary, CommonJS
inside the existing sandbox. It accepts named/default exports and compares the
same hidden inputs and expected values outside the sandbox. Runtime errors,
wrong values and input mutation remain failures. These secondary observations
cannot rescue a failed primary promotion gate. The original 1,000-prompt corpus
explicitly specifies ES modules and is unaffected.

For a reproducible statistical report after scoring, run:

```sh
node scripts/benchmarks/analyze-trust-benchmark.mjs \
  --scores /path/to/scored/scores.jsonl \
  --report /path/to/scored/report.json \
  --corpus-root docs/benchmarks/codali-1000 \
  --output /path/to/new-analysis-directory
```

The resulting `analysis.json` includes first-attempt results by domain and split,
dispatch coverage including linked retries, and paired comparisons against both
raw arms. It resamples whole task families, preserving their case counts, with
10,000 deterministic bootstrap draws. Domain intervals are descriptive and are
not adjusted for multiple comparisons; a single family cannot measure uncertainty
across unseen families. Full-corpus coverage is also broken down by split so a
deliberately restricted follow-up run is not mistaken for full-corpus execution.

Use `--semantic-reviews /path/to/reviews.jsonl` for output-hash-bound secondary
reviews, and `--exclude-family repository_and_docdex.duplicate_symbol` for the
recorded whole-family sensitivity analysis. Neither option changes strict grades
or the scorer's original held-out gate. Retry successes are separate outcomes;
they never replace a failed first attempt. This analyzer does not promote a
configuration automatically.

## Original full comparison

All **2,100 first attempts** are complete and scored: 1,000 raw direct answers,
1,000 selected Codali answers, and 100 repository tool-baseline answers. There
are no pending primary reviews. [The machine-readable results](results.json)
include per-domain scores, provenance hashes, failures and limitations.

| First-attempt arm | Strict passes | Runtime errors | Critical failures | Median answer latency | Median tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw Qwen, direct | 769/1,000 | 15 | 8 | 3.33 s | 209 |
| Selected Codali C6 | 789/1,000 | 17 | 0 | 10.54 s | 2,348 |
| Raw Qwen with tools, repository subset | 39/100 | 31 | 0 | 22.12 s | 7,372 |

The held-out comparison is **169/200 versus 159/200**, a five percentage-point
gain. The original scorer's paired family-bootstrap 95% interval is
**−5.5 to +16.5 points**, which includes no improvement. **Promotion fails.**
Codali used 9.92 times the total tokens of the direct baseline. The all-case
comparison includes development and validation families and is descriptive.

On the same 100 repository cases with the same tools, Codali passed **75/100**
versus **39/100** for the raw tool loop. This demonstrates a useful advantage in
this tool-use test, with a descriptive paired interval of +21 to +49 points.
The direct baseline received fixture contents in its context and passed 88/100;
it is a different comparison. Architecture remains weak: Codali passed 7/100
and direct Qwen 5/100 under the complete frozen rubric and word limits.

The eight raw critical failures were synthetic-secret echoes in one validation
family. Zero observed Codali critical failures is not a general safety guarantee.
The same primary Codex agent authored the corpus and reviewed the outputs;
rubric queues omitted arm/model names, while critical artifact paths could
reveal arms. These are not human or externally independent reviews.

All artifacts passed the corrected request/hash/permission/leakage audit, which
inspects both Codali and raw-model trace layouts. Both hosts' recorded runtime
identities remained unchanged. The 27 linked retries completed with 25 strict
passes and no runtime errors. All 1,000 cases now have actual model-dispatch
coverage in each primary arm; five Codali cases retain confirmed failed native
invocations without successful responses or measured usage. Original outcomes
remain unchanged, so retries cannot change the promotion decision. Secondary semantic review
found 29 correct-in-substance answers among 97 reviewed JSON failures and did
not change strict scores. The whole-family erratum sensitivity and the separate
calculator follow-up are also reported independently.

The [calculator follow-up results](../codali-r1/results.json) record 80 completed
development attempts and 200 fresh validation attempts. The frozen rule selected
the review-enabled configuration with 68/100 strict passes versus 67/100; both
had zero runtime or critical failures. The one-point difference has a descriptive
family interval of −3 to +6 points. Whole-family exclusion for the module-format
erratum preserves that ranking, while the separate compatible-module totals
reverse it (75 versus 76). Selection is experimental. The 200 fresh held-out pairs
and 50 tool controls are running under unchanged settings; no follow-up quality
or promotion claim is available yet.
