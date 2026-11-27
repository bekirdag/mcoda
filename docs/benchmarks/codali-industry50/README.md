# Fresh industry-50: Codali versus raw Qwen

Completed2026-11-04: all100 first attempts, no service errors. **Audited semantic average: Codali97.6%, rawQwen97.6%.** This suite shows no accuracy improvement from the current Codali setup.

| Metric | Codali | Raw Qwen |
|---|---:|---:|
| Audited semantic score |97.6%|97.6%|
| Original frozen-key strict score |89.6%|92.0%|
| Perfect audited jobs |47/50|46/50|
| Reported model tokens |234,787|37,456|
| Mean tokens/job |4,695.74|749.12|
| Total answer latency |782.071s|316.833s|
| Mean answer latency |15.641s|6.337s|
| Median answer latency |13.946s|6.084s|
| Model calls |129|50|
| Strict JSON-only replies |50/50|0/50|
| Service errors |0|0|

Codali used6.268x reported model tokens and2.468x total answer time. It won3jobs, lost2and tied45under audited scoring; both lost6of250criteria. Its measurable advantage here was JSON-only formatting, not higher semantic accuracy. Raw answers generally contained explanatory text plus a usable JSON object; those were not zeroed for extra prose.

[All50 paired scores](scores.md), [CSV](scores.csv), [complete outputs and criterion-level scores](results.json), [scoring errata](scoring-errata.json), [execution evidence](execution-evidence.json).

Codali actually used the calculator in11jobs and file reads in5jobs. **No Docdex calls occurred** in this run, despite tool availability; it is not evidence of improved Docdex-based retrieval. One calculator call in the renewal-date job failed with `Unexpected token minus`; Codali subsequently answered correctly. That failed tool call and its overhead remain in the logs and metrics. No browser or media job was included. Both systems saw the same source data, with raw receiving full file contents inline.

Audited failures: both systems missed the NRR/GRR numbers; raw additionally missed a cloud allocation/total by0.01, identified a release ticket instead of the gate decision, and omitted an excluded SQL row. Codali additionally rounded away fractional SLO budget minutes and violated explicit Unicode sorting. Equal criterion weights do not model differing business severity of these errors.

The previously requested10%accuracy improvement and<=1.5x token/time targets are **not met** by this run. High scores on these small supplied-evidence jobs should not be extrapolated to long autonomous development, real-world research or unrestricted general intelligence. Many jobs were easy for both systems, and post-response ambiguity auditing limits confirmatory claims.

## Protocol frozen before inference

50 newly authored synthetic workplace jobs, five objective criteria per job. Each correct criterion earns20points; overall score is the arithmetic mean of all50 job scores, including failed attempts. Jobs cover finance/data analysis, operations, software/repository analysis, architecture/security decisions and business documents. These are bounded read-only analytical deliverables, not a representative traffic sample, long autonomous projects, subjective design evaluations or executed code-generation tests. The `domain` labels are harness categories, not proof of each broader capability.

New fictional records, identifiers, policies and dates were authored for this evaluation. This prevents reliance on memorized answers to these exact fixtures; it cannot prove the model has never encountered similar task archetypes. No answering-model calls were used to author the jobs or their gold answers. A methodology-only delegation occurred without any case content.

- Runtime: existing `run-trust-benchmark.mjs` / `trust-attempt.mjs`, actual Codali `SessionController` versus one raw `ConfiguredProvider` answer. The runtime fingerprint and full resolved configuration are recorded in the private run manifest.
- Model: installed local Qwen Flash Next, stable served ID `qwen-latest-flash-next` (the model referred to as Qwen3.8 Flash Next in this session),64K context, mswarm routing across Raijin/Suku. This report does not independently verify a vendor release name from that alias.
- Codali configuration copied from the active `preview-26-v11-low.json`, with no benchmark-driven tuning. Answer model uses low reasoning with512-token reasoning budget; intent routing uses its configured Qwen alias with reasoning disabled. Both arms use the same answer binding, temperature0.
- Existing output policy retained: raw response ceiling2048, Codali interaction ceiling1024 and low-effort ceiling2048. Codali interaction budget16000tokens/8calls/6inspection steps; low-effort execution budget48000tokens/10calls/12tools/10steps. Common outer deadline300seconds. These product/harness asymmetries are disclosed; this is not an identical-prompt/identical-compute experiment.
- Raw receives complete source fixtures inline because it cannot read files. Codali receives the same source contents in isolated workspaces and may use its available read-only tools. This compares assistant product behavior against raw inference; tool effects cannot be separated from prompt/routing effects without an additional tool-parity arm.
- External web, persistent memory, media, network actions and workspace mutations are disabled for this controlled study. It does not measure browser/media use or changing live facts. Tools run only when selected; the report distinguishes available tools from actual calls.
- Arm order alternates by job. Requests run sequentially through shared production services; load and start/end times are logged. Latency includes routing, tool work and queue wait, and is not a dedicated-hardware microbenchmark.
- All first attempts retained; no best-of selection, silent retries, discarded failures or mid-run tuning. Normal product-internal recovery is part of Codali's measured behavior.
- Public prompt and hidden grading hashes in `manifest.json` were frozen before first inference. Answer workers never load `grading.jsonl`; tool workspaces contain only the public case files. Gold answers remain outside those workspaces. Original request/model/tool/result logs are retained under `~/.local/state/codali-industry50/run/`.

## Scoring

`grading.jsonl` lists all250 criteria. Numbers require numeric JSON values within0.005absolute tolerance; booleans and null are type-sensitive; strings ignore case and outer whitespace; arrays retain requested ordering. Missing fields score zero. A usable object inside Markdown/prose is scored semantically, with strict JSON compliance reported separately. Malformed/unextractable answers score zero; no silent JSON repair or LLM judge. Reference and negative-case qualification is implemented in `score-industry50.py`.

Gold values were reviewed before launch; the MRR arithmetic key was corrected during authoring before the run began. No gold values were changed after launch. Automated scorer tests validate reference answers and rejection of missing/wrong values; they are not by themselves proof that a gold key is substantively correct. Final mismatches will also be inspected for evaluator errors or ambiguity, with any erratum explicitly retained rather than silently rewriting primary scores.

## Reproduction

```sh
python3 scripts/benchmarks/build-industry50.py
python3 scripts/benchmarks/score-industry50.py --qualify
node scripts/benchmarks/run-trust-benchmark.mjs \
  --config /path/to/frozen-config.json --output /path/to/new-run \
  --corpus-root "$PWD/docs/benchmarks/codali-industry50" \
  --split validation --arms raw_direct,codali_selected --timeout-ms 300000
python3 scripts/benchmarks/score-industry50.py /path/to/new-run
```

Do not regenerate or modify the corpus during a run. After exposure, these50 cases are development evidence, not an unseen confirmation set for later tuning.

## Scoring audit and retained errata

The original keys remain unchanged. During inspection, some fields proved underspecified: capacity units, opening versus closing existing-customer MRR, release decision representation and a few label spellings. `scoring-errata.json` records accepted semantic equivalents and why, including when each was discovered. They apply symmetrically to both arms. The main results table uses **audited semantic scores**; the original frozen-key strict scores remain alongside them in CSV/JSON and aggregate reporting. No responses are rerun. This post-response scoring audit is a limitation of this first version of the corpus and must not be represented as wholly preregistered scoring. It avoids rewarding or penalizing a system solely for a reasonable interpretation of an underspecified field.
