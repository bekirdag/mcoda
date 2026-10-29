# Codali intelligence improvement experiments

This is development evidence from the .25 runtime, followed by a .26 word-repair correction. It does not establish broader intelligence or replace any earlier frozen result. [Results](results.json) and the [failure taxonomy](failure-taxonomy.json) distinguish dispatcher qualification, serving checks, the answer-quality ablation and installed follow-up checks.

The runtime now uses one versioned dispatch/output contract, checks final presentation on every interaction route, permits one bounded tool-free conversational repair, and preserves native tool history through the Raijin proxy. Correctness and full schema/code verification remain separate from these presentation checks.

Small resident models were tested on the same dispatcher cases. They did not qualify for the new contract. The selected large dispatcher passed 20/20 development fixtures after prompt refinement; the case set was exposed during development and is not a held-out result. A failed harness variant retained two unknown-usage attempts; they are not treated as zero cost or silently replaced.

Strata accepts JSON schema using `prompt_and_validate`, according to its live status endpoint. It does not advertise grammar-constrained decoding. GGUF metadata was read according to the [primary GGUF specification](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md); only header/tensor-table and embedded-template hashes were collected, not all tensor weights.

Private request/response traces, failed variants, configuration hashes, source/build fingerprints, reference/negative-control qualification and node rollback artifacts are retained under the operator's `codali-trust-benchmark/intelligence-20261029-v1` state directory. No secret-bearing configuration or raw user trace is included here.

The answer-quality comparison completed all 112 first attempts on 20 exposed development cases. All 224 model requests have matching responses; no outcomes are missing. One raw-tools attempt exhausted its inspection budget and remains a failure. Architecture review is complete and was performed without model/configuration labels. These synthetic tasks and agent reviews do not establish performance on realistic software-design projects.

| Configuration | Complete-contract success | Total tokens | Median answer time |
| --- | ---: | ---: | ---: |
| Raw, reasoning off | 14/20 | 4,341 | 2.61 s |
| Raw, native reasoning low/512 | 18/20 | 8,005 | 4.27 s |
| Codali, reasoning off, review off | 17/20 | 67,830 | 15.55 s |
| Codali, reasoning off, review on | 15/20 | 88,581 | 20.23 s |
| Codali, native reasoning low/512, review off | 17/20 | 59,595 | 14.38 s |

The selected experimental profile uses the large model for dispatch, native low/512 reasoning for answering, and no routine answer review. It ties the best Codali success count and uses fewer tokens. The dispatcher remains at reasoning off. No case-specific routing or answers were added.

Review corrected **zero** and damaged **one** of 17 reviewed drafts; 12 remained correct and four remained wrong. Three attempts did not enter review. This comparison binds each exact draft to its revision before common presentation repair. Same-model agreement is not independent verification.

On the six cases with matched tools, selected Codali passed 6/6 versus raw 4/6, using 23,623 versus 7,790 tokens (3.03 times). Two raw failures had correct values but violated JSON-only format. Across all 20 cases, selected Codali still trails the stronger raw baseline and uses 7.44 times its tokens. All queue-design answers omitted or mishandled a required safeguard; the selected configuration also failed an independently tested merge-intervals case. Those are substantive weaknesses that output formatting cannot repair.

There is one trial per configuration, no held-out inference in this study and no critical-case safety coverage in this derivative corpus. Timing is observational on a shared host. The previous 1,000/R1/U5/U6 scores remain unchanged. **Broader quality and stable/npm promotion remain unmet.** The next campaign needs realistic workflows, independent verification and new frozen family-disjoint material; rerunning these exposed cases cannot establish generalization.

The installed .25 suite passed 8/11: a word-limited answer still had 303 words after repair and was correctly withheld; without that answer, the intended compression/resume scenario did not form. The .26 follow-up targets the interior of a requested word range during repair, preserving the bounds and one-repair limit. It passed 2,058 tests (four optional skips), 30 exact-package checks and 10/11 fresh live capability checks. Word limits, planning, compression and exact archived-source recovery passed. Open-ended web discovery failed to retrieve the requested primary page; Codali disclosed that uncertainty. The direct primary-URL check passed. This retrieval weakness remains unresolved.

A separate controlled replay injected the original 310-word draft and its routing response, then made exactly one live call through the new repair path. It returned 253 words using 1,505 reported tokens. This proves the recorded repair path was exercised; it is not a fresh end-to-end benchmark or a replacement for the original failure. The .25 ablation remains bound to source `e652d79`, while .26 is source `56e34c6`.

The reversible Raijin preview launcher now runs .26 with the selected reasoning/review settings. A real TUI greeting used 1,239 tokens, one model call and no tools in about 3.1 seconds. Help/usage dialogs, navigation, resizing and terminal restoration passed. The first terminal script had failed to close its help modal before typing another command; that harness failure and its successful 1,264-token greeting are retained separately. [Runtime CI](https://github.com/bekirdag/mcoda/actions/runs/40884306269) and [Linux/macOS package qualification](https://github.com/bekirdag/mcoda/actions/runs/40884306271) passed on `56e34c6`.

To try the installed experimental TUI:

```sh
cd ~/apps/mcoda
~/.local/bin/codali-preview
```

The previous .24 launcher/profile are retained for rollback. The native node transport remains the qualified .25 build; the client is .26. Global/stable installations and npm publication are unchanged. The failed web-discovery check and unmet broader correctness/efficiency gates remain open.
