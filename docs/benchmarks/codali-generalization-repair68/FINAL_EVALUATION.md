# Final Codali repair68 evaluation

Finalized 2026-11-07T10:17:19.439410+00:00. All 156/156 attempts graded:52 jobs × three arms. All model inference has ended. Evaluation complete; release qualification failed.

## Verdict

Repaired Codali improves the 50-question average from 81.8% to 91.0% (+9.2 percentage points) and leads raw Qwen with tools80.8% by 10.2 points. It uses 0.763× raw client tokens and0.987× accumulated elapsed time for questions. This narrowly meets the numerical question-only target in this run. It does not establish broader intelligence superiority: the lead is largely research answer delivery versus raw budget exhaustion.

Both app builds fail end-to-end in every arm. Repaired Codali averages10.0%, raw22.0%; Codali spends2.869× raw tokens and1.569× time on apps. Across all 52 equally weighted jobs, the lead is9.35 points, below the 10-point target. Do not publish based on this evaluation.

## Scores by workload

| Workload | Earlier Codali (build66) | Repaired Codali (build68) | Raw Qwen + tools (build68) |
|---|---:|---:|---:|
| Numeric/data (20) | 92.00% | 99.00% | 100.00% |
| Python implementation (10) | 76.00% | 100.00% | 100.00% |
| Architecture/design (10) | 86.00% | 81.00% | 98.00% |
| Research (10) | 63.00% | 76.00% | 6.00% |
| All questions (50) | 81.80% | 91.00% | 80.80% |
| App builds (2) | 4.00% | 10.00% | 22.00% |
| All jobs (52; equal task weight) | 78.81% | 87.88% | 78.54% |

Numeric scores measure the five frozen output fields. The separate narrative review found incorrect incidental explanations even in100%-field answers; see numeric-narrative-review.json. Code scores are five private test-group outcomes plus source/tampering review, not universal correctness. Design/research scores use frozen0 / 10 / 20 criteria; review-notes.json records deductions.

Raw failed to deliver nine research answers because it exhausted the common aggregate workflow allowance. Codali delivered all ten, often with honest source-retrieval caveats. On the 40 questions with final answers from all three arms (a survival-biased diagnostic, NOT the primary score), earlier Codali scores 88.50%, repaired94.25%, raw98.50%. This makes the delivery advantage and remaining answer-quality deficit explicit.

## Resource accounting

| Scope / arm | Client tokens | Accumulated elapsed minutes |
|---|---:|---:|
| question / before | 992,947 | 140.29 |
| question / after | 949,328 | 127.91 |
| question / raw_tools | 1,244,476 | 129.59 |
| app / before | 62,283 | 2.55 |
| app / after | 1,049,747 | 21.97 |
| app / raw_tools | 365,857 | 14.00 |
| All 52 / before | 1,055,230 | 142.85 |
| All 52 / after | 1,999,075 | 149.88 |
| All 52 / raw_tools | 1,610,333 | 143.59 |

All 52 repaired/raw ratios: tokens 1.241×; time 1.044×. Repaired-minus-earlier score: 9.08 points. Repaired-minus-raw:9.35 points.

Elapsed minutes are summed attempt durations, not calendar runtime; shared service load and one trial limit speed conclusions. All failed attempts are included. Client usage is reported as measured by the harness; Docdex service-side inference is excluded, so this is not total-system cost. Per-attempt input/output tokens, calls and durations are in scores.csv; aggregate input/output and calls are in accounting.json.

## App results

| App / arm | Score | API checks | Delivered end-to-end |
|---|---:|---:|---|
| unseen-51 before | 4% | 0/27 | No |
| unseen-51 after | 16% | 0/27 | No |
| unseen-51 raw_tools | 24% | 2/27 | No |
| unseen-52 before | 4% | 0/26 | No |
| unseen-52 after | 4% | 0/26 | No |
| unseen-52 raw_tools | 20% | 1/26 | No |

RecallDock: earlier Codali stopped after investigation. Repaired Codali produced partial server modules, then stopped on repeated prepare_edit without progress after 1,017,805 client tokens; required setup/build/test/start entrypoints and UI were absent. Raw produced more artifacts but stopped on context/schema compression failure; setup worked, but health/login and delivery failed.

ShiftRelay: both Codali arms stopped after read-only investigation. Raw again stopped on context/schema compression failure. Its repeat setup assigns to a const, login calls res.append on a native Node response (HTTP500), build/test files are missing, and UTC timestamp validation rejects required input format.

Partial app credit covers source evidence only: existing security/domain/persistence code, initial setup, or honest non-completion disclosure. All business and UI workflow categories score0. Browser checks retained desktop/mobile and post-login screenshots for both raw submissions; neither authenticated. Codali attempts lacked runnable UI entrypoints, so browser blockers are recorded instead of fabricated screenshots.

All six original projects are preserved at paths in app-projects.json, and app-submissions.tar.gz contains their source snapshots. Screenshots/logs remain beside each attempt under independent/.

## Remaining issues and next repair order

1. Restore build-task continuation: investigation must transition to implementation, and prepare_edit retries must change inputs or take a different safe action. Require a minimal runnable vertical slice before expanding files.
2. Bound tool-schema/context overhead through lazy tool discovery and recoverable compaction; raw research and app failures show that raising token caps alone is insufficient.
3. Repair source retrieval: direct primary-URL opening, relevant-section extraction, pagination, and relevance checks. Current research often returns unrelated pages or only RFC front matter. Preserve honest evidence gaps.
4. Validate multi-file contracts and execute setup/build/test/start early: missing scripts, mismatched exports/schema columns, Express/native HTTP confusion, repeat-seed const assignment and date-format bugs should be caught during the build.
5. Strengthen design validation: durable cryptographic deletion, migration compatibility, atomic conflict resolution, symlink/TOCTOU boundaries and causal performance claims. Repaired design average 81% remains below raw98%.
6. Check formulas and units as well as calculator arithmetic: the error-budget answer still says0.14minutes instead of 280; other scored-correct answers contain explanatory errors.
7. After generic fixes, freeze a genuinely fresh holdout, run repeated paired trials, and require completed apps and the whole-workload quality/cost/speed target before release.

## Method and limitations

- Final comparison uses study-repair68 only. Earlier stopped runs remain retained and are not pooled. Before is build66, after build68, raw uses build68 tools without Codali orchestration. All request qwen-latest-flash-next through the same mswarm pool; this is a tool-enabled raw baseline, not a bare no-tools model.
- This restarted corpus was already exposed during debugging. It is a regression comparison, not fresh unseen qualification, despite historic unseen-* identifiers and held_out metadata. No tuning or new inference occurred during final grading.
- Equal per-response allowance40960; questions120000 aggregate tokens/20 model calls/40 tool calls/600 seconds; apps10000000 tokens/1000 model calls/2400 tool calls/36000 seconds (effective step allowance1620); model context65536. These are actual study settings, not a claim of unlimited generation. Earlier frozen scoring document has older response-cap values; restart settings and retained protocol notes supersede them.
- Primary Codex assistant authored and evaluated the rubric; semantic review used anonymized packets initially but final reconciliation was not fully blind. No candidate Qwen judge was used. No inter-rater or statistical confidence claim.
- Missing final question answers score0. App artifact partial credit follows the separately frozen rubric. Failed prerequisites remain failures in fixed denominators. No candidate code was patched during evaluation.
- Evaluator corrections: interval objects accepted as equivalent bounds in question9, applied equally; HTTP Set-Cookie header lookup made case-insensitive with multi-header support before app acceptance. Original files/evidence retained. Browser runner initially lacked its default Chromium revision; existing Chromium1248 was explicitly selected and browser checks completed.
- Setup-repeat verifies command success and the available persistence checks, not exhaustive invariance of every row. Security review is targeted, not a complete audit. API controls validate the harness sequences, not production readiness.

## Every job

| Job | Earlier | Repaired | Raw + tools |
|---|---:|---:|---:|
| 01. Common cause replicas | 100.0% | 100.0% | 100.0% |
| 02. Rework absorbing process | 0.0% | 100.0% | 100.0% |
| 03. Mixed tank conservation | 100.0% | 100.0% | 100.0% |
| 04. Discrete procurement decision | 100.0% | 100.0% | 100.0% |
| 05. Error budget consumption | 80.0% | 80.0% | 100.0% |
| 06. Weighted reservation selection | 100.0% | 100.0% | 100.0% |
| 07. Bloom storage sizing | 60.0% | 100.0% | 100.0% |
| 08. Integer production bottlenecks | 100.0% | 100.0% | 100.0% |
| 09. Clock bounded incident order | 100.0% | 100.0% | 100.0% |
| 10. Capacitor energy audit | 100.0% | 100.0% | 100.0% |
| 11. Datagram framing overhead | 100.0% | 100.0% | 100.0% |
| 12. Cardinality estimator correction | 100.0% | 100.0% | 100.0% |
| 13. Tier scope commission audit | 100.0% | 100.0% | 100.0% |
| 14. Retry deadline schedule | 100.0% | 100.0% | 100.0% |
| 15. Dependent component bounds | 100.0% | 100.0% | 100.0% |
| 16. Join multiplicity audit | 100.0% | 100.0% | 100.0% |
| 17. Quantile mixture distinction | 100.0% | 100.0% | 100.0% |
| 18. Quorum placement failure | 100.0% | 100.0% | 100.0% |
| 19. Frame dependency closure | 100.0% | 100.0% | 100.0% |
| 20. Retention race contract | 100.0% | 100.0% | 100.0% |
| 21. Fragmented binary frames | 0.0% | 100.0% | 100.0% |
| 22. Pure merge patch | 100.0% | 100.0% | 100.0% |
| 23. Closed time windows | 100.0% | 100.0% | 100.0% |
| 24. Exact token bucket | 20.0% | 100.0% | 100.0% |
| 25. Recursive secret redaction | 100.0% | 100.0% | 100.0% |
| 26. TTL LRU cache | 100.0% | 100.0% | 100.0% |
| 27. Topological execution layers | 100.0% | 100.0% | 100.0% |
| 28. Stable decimal allocation | 100.0% | 100.0% | 100.0% |
| 29. Atomic original span edits | 100.0% | 100.0% | 100.0% |
| 30. Bounded route normalization | 40.0% | 100.0% | 100.0% |
| 31. Reservation compensation boundary | 80.0% | 90.0% | 100.0% |
| 32. Tenant cryptographic deletion | 60.0% | 80.0% | 90.0% |
| 33. Offline edit conflict contract | 90.0% | 70.0% | 100.0% |
| 34. Privacy aware analytics rebuild | 100.0% | 80.0% | 100.0% |
| 35. Multi region lease fencing | 80.0% | 100.0% | 90.0% |
| 36. Schema migration rollback window | 80.0% | 50.0% | 100.0% |
| 37. Prompt injection boundary review | 90.0% | 90.0% | 100.0% |
| 38. Accessible incident command board | 100.0% | 90.0% | 100.0% |
| 39. Unsafe archive ingestion review | 90.0% | 80.0% | 100.0% |
| 40. Capacity regression investigation | 90.0% | 80.0% | 100.0% |
| 41. Disconnected cache decision | 70.0% | 80.0% | 0.0% |
| 42. Cross audience JWT review | 0.0% | 80.0% | 0.0% |
| 43. Refresh token reuse response | 50.0% | 50.0% | 0.0% |
| 44. Kafka external charge boundary | 40.0% | 50.0% | 0.0% |
| 45. TLS early payment replay | 80.0% | 80.0% | 60.0% |
| 46. WCAG target and dragging audit | 70.0% | 90.0% | 0.0% |
| 47. Conditional update race | 70.0% | 70.0% | 0.0% |
| 48. Heritability claim review | 80.0% | 90.0% | 0.0% |
| 49. Seasons mechanism rebuttal | 80.0% | 80.0% | 0.0% |
| 50. Climate baseline attribution audit | 90.0% | 90.0% | 0.0% |
| 51. RecallDock | 4.0% | 16.0% | 24.0% |
| 52. ShiftRelay | 4.0% | 4.0% | 20.0% |

## Evidence

- Full retained run root: `/home/wodo/.local/state/codali-generalization-20261106`.
- Active study manifest: `/home/wodo/.local/state/codali-generalization-20261106/study-repair68/study.json`.
- Frozen criteria/oracles: `/home/wodo/.local/state/codali-generalization-20261106/study-v1/private/SCORING.md` and `grading.json` (not fed to candidates).
- scores.csv / results.json: all 156 scores and usage.
- review-notes.json:60 semantic and6 app rubric assessments.
- artifact-manifest.json: hashes of result/score/review files.
- numeric-narrative-review.json: field-score limitations and concrete explanatory mistakes.
- app-projects.json / app-submissions.tar.gz: reviewable projects and evidence locations.
- PLAN.md / PROGRESS.md: evaluation completion checklist; product release remains blocked.
