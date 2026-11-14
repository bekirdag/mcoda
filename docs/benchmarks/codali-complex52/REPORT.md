# Codali vs raw Qwen with tools: Complex52 final scores

Finalized 2026-11-05. All 100 prompt attempts and all four app attempts are scored. Scores describe the frozen first-attempt submissions, without evaluator repairs.

**50-prompt average: Codali 54.4%, raw Qwen with tools 41.2% — +13.2 percentage points (+32.0% relative). Neither system delivered a usable application.**

## Summary

| Cohort | Codali | Raw Qwen + tools |
|---|---:|---:|
| 50 complex prompts | 54.4% | 41.2% |
| FrostLedger app | 10% | 0% |
| BenchHarbor app | 8% | 6% |
| Two-app mean | 9% | 3% |

Prompt pairs: 21 Codali wins, 12 raw wins, 17 ties.

## All 50 prompt scores

| Job | Task | Codali | Raw Qwen + tools |
|---|---|---:|---:|
| 01 | Bitemporal settlement reconciliation | 70% | 0% |
| 02 | FIFO inventory with traceable returns | 70% | 100% |
| 03 | Censored reliability comparison | 80% | 0% |
| 04 | Simpson allocation reversal | 0% | 90% |
| 05 | Lease-versus-buy discounted cash flow | 100% | 100% |
| 06 | Queue-capacity admission | 0% | 100% |
| 07 | Dependency scheduling with a shared resource | 100% | 0% |
| 08 | Battery dispatch under export prohibition | 100% | 0% |
| 09 | Correlated measurement uncertainty | 100% | 0% |
| 10 | Sequential diagnostic evidence | 0% | 100% |
| 11 | Temporal SQL price intervals | 90% | 80% |
| 12 | Late-event materialized balance | 0% | 90% |
| 13 | Bounded asynchronous mapping | 0% | 80% |
| 14 | CSV invoice parser adversarial fields | 0% | 0% |
| 15 | Reservation race without global locking | 0% | 60% |
| 16 | Shortest paths and negative cycles | 80% | 80% |
| 17 | Interval coverage property testing | 90% | 100% |
| 18 | Zero-downtime uniqueness migration | 0% | 0% |
| 19 | DST scheduling semantics | 80% | 80% |
| 20 | Conditional HTTP state changes | 80% | 0% |
| 21 | Tenant-bound object authorization | 0% | 0% |
| 22 | SSRF-resistant evidence fetcher | 0% | 0% |
| 23 | Spreadsheet export threat model | 90% | 90% |
| 24 | Password-reset race and privacy | 0% | 0% |
| 25 | Webhook ordering and replay | 0% | 0% |
| 26 | RAG evidence conflict and prompt injection | 90% | 90% |
| 27 | Offline sync architecture with conflicts | 0% | 0% |
| 28 | Cross-service migration cutover | 0% | 0% |
| 29 | Incident timeline under clock skew | 70% | 90% |
| 30 | Restore evidence versus backup success | 100% | 70% |
| 31 | Difference-in-differences caveats | 80% | 90% |
| 32 | Calorimetry with phase transition | 90% | 100% |
| 33 | Genetic counseling probability model | 90% | 100% |
| 34 | Blend feasibility and dual bottleneck | 0% | 0% |
| 35 | Constraint schedule with conditional obligation | 100% | 90% |
| 36 | Supplier acceptance sampling | 100% | 90% |
| 37 | Privacy suppression differencing | 80% | 0% |
| 38 | Contract evidence conflict | 100% | 100% |
| 39 | Accessible asynchronous form review | 90% | 0% |
| 40 | Intent and irreversible ambiguity | 90% | 90% |
| 41 | Database isolation decision | 70% | 0% |
| 42 | Post-quantum migration evidence | 90% | 0% |
| 43 | Grid storage lifecycle decision | 40% | 0% |
| 44 | Clinical evidence versus surrogate endpoints | 40% | 0% |
| 45 | Inflation and real-wage comparison | 40% | 0% |
| 46 | Climate attribution communication | 50% | 0% |
| 47 | Accessible authentication requirements | 70% | 0% |
| 48 | Open-source distribution compliance | 50% | 0% |
| 49 | Space telescope detection claims | 60% | 0% |
| 50 | Sovereign debt data reconciliation | 0% | 0% |

## Cost and speed

| Cohort / arm | Client-metered tokens | Total attempt minutes |
|---|---:|---:|
| tasks / codali_candidate | 1,653,083 | 133.85 |
| tasks / raw_tools | 1,250,124 | 145.78 |
| apps / codali_candidate | 1,929,083 | 40.45 |
| apps / raw_tools | 985,085 | 13.70 |

For the 50 prompts, Codali used 1.322× tokens and 0.918× elapsed time. Across prompts plus apps, it used 1.603× tokens and 1.093× time.

These are total attempt costs, including failed attempts, not latency of equally correct answers. Client totals include estimated usage on some failures and exclude unmetered inference inside Docdex. They are not full-system token accounting. Sequential runs used live shared hosts; timing is observational.

## Completion and interpretation

Codali returned nonempty answers on 34/50 prompts; raw returned 23/50. Empty final answers receive zero, so the aggregate measures delivery reliability as well as answer quality. Research tasks 41–50 produced nine Codali responses and zero raw responses, but many Codali responses were incomplete or inadequately sourced. A response is not equivalent to a successful task.

- Non-web tasks 1–40: Codali 55.25%, raw 51.50% (n=40).
- Deep-web tasks 41–50: Codali 51.00%, raw 0.00% (n=10).
- Tasks where both scored above zero: Codali 88.82%, raw 90.59% (n=17).

The requested overall qualification is not achieved. The prompt cohort exceeds a 10% relative score gain within the measured 1.5× token/time limits, but this does not establish broadly higher intelligence: failures dominate parts of the comparison, research has factual errors, neither app is usable, and combined client tokens exceed 1.5×.

## App review

- **FrostLedger / Codali, 10/100:** health endpoint and placeholder page run; API routes return 404. Setup prints success without database initialization; database imports a missing seed file. Login, tenancy, shipments, transitions, imports, exports and functional UI are absent. Three smoke tests cover only scaffold behavior. Screenshot confirms “UI build pending.” Two automated cross-tenant passes are false positives from absent routes; no security credit awarded. The evaluator’s `ready: true` means server startup, not product readiness.
- **FrostLedger / raw, 0/100:** no application implementation; final response contains tool-call markup.
- **BenchHarbor / Codali, 8/100:** actual database setup, seeds, hashed passwords and some constraints exist. Missing build/server entry points, UI, authentication and booking/inventory APIs prevent use. Two scaffold tests are not domain coverage.
- **BenchHarbor / raw, 6/100:** dependency installation and database/validation source exist. Setup, server and UI entry files are missing; SQLite schema contains invalid `ON DROP RESTRICT`; test command executes zero tests.

UI criteria without a working interface are unassessable and receive zero demonstrated points, not an invented aesthetic rating. No incomplete app has been represented as secure.

## Grading and verification

Five frozen 20-point criteria per text task: 0 absent/wrong, 10 partial/material omission, 20 complete and supported. App rubric: features 48, build/delivery 14, security 12, tests 6, UI/UX 12, code quality 8; partial evidence earns half weight. Criterion-level scores and notes are in [scores.json](scores.json). Failure zeros remain in the denominator.

Manual review was performed by the primary assistant, not blinded and not an independent human panel. All returned text was reviewed; code verification combines inspection with selected execution, not exhaustive execution of every snippet. Frozen rubrics occasionally encode contestable details (for example task 1 note-event inclusion); this is an evaluation limitation. A 100 means the scoped rubric was met, not that every extra sentence is correct or the code is production ready.

Selected execution: task 12 raw passed 15 tests; task 13 raw passed 6 and failed 3 supplied/independent checks, including swallowed null rejection; task 16 raw passed 4 and failed 1 expected-path test; task 16 Codali core passed 6 tests, while its separate absent-target demonstration is defective; task 17 raw passed 19 and Codali 16 own tests, but Codali incorrectly rejects empty intervals. Earlier task 1 SQL and task 3 survival-analysis checks found executable errors and numerical discrepancies. App checks ran on copies, preserving original sources.

Research review inspected 103 recorded browser receipts, including failed/blocked pages. Tool success labels alone were not treated as evidence. Examples of checked factual defects:

- Task 44 misidentified ALFA-0701 and its primary endpoint; see the [FDA statistical review](https://www.accessdata.fda.gov/drugsatfda_docs/nda/2017/761060Orig1s000Orig1Orig2s000StatR.pdf).
- Task 45 invented an HICP owner-occupied-housing cap; see [Eurostat HICP information](https://ec.europa.eu/eurostat/web/hicp/information-data).
- Task 47 treated a keyboard alternative as sufficient for dragging; [WCAG’s dragging criterion](https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html) also requires a single-pointer alternative.
- Task 49 relied on search/API abstracts rather than opening the underlying papers, and confused chronology; a relevant [reanalysis abstract](https://arxiv.org/abs/2508.05961) does not replace review of the original claim and methods.

## Protocol and evidence

Both arms used mSwarm load-balanced `qwen-latest-flash-next`, 64k context, identical outer tool/budget allowances, alternating sequential first attempts, no result-based retuning or retries. Raw means **raw Qwen with tools**, not a text-only model. Fresh authoring cannot prove absence from pretraining. Prompts: 120k tokens / 20 model calls / 40 tool calls / 10 minutes. Apps: 1M tokens / 100 model calls / 240 tool calls / 60 minutes. See frozen manifests/settings and [README](README.md).

- All answers, original projects and evaluation copies: `/home/wodo/apps/codali-complex52-results/2026-11-05`.
- Detailed local execution and browser receipts: `/home/wodo/.local/state/codali-complex52-20261105`.
- [Machine-readable scores and notes](scores.json); [per-job CSV](scores.csv).
- Original submissions were not repaired. No package was published as part of scoring.
