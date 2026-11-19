# Findings from the frozen fresh73 run

The candidate remains unchanged throughout the prospective run. These are observed new failures, not repaired or reclassified attempts.

- fresh-01 after: exactlyOne requested a probability; output8272 was an expected population count instead of0.08272. Four other fields correct. Short structured calculated answer did not trigger the >400-character equation-review condition. Score80.
- fresh-06 after: a single model response emitted repeated empty calculate arguments. Four identical failures triggered the repeated-failure guard before a new model turn could consume feedback. Final answer absent. Generic recovery should distinguish repeated calls within one batch from retries after feedback; no candidate change during holdout. Score0.
- fresh-07 after and several raw attempts: correct JSON values wrapped in Markdown despite JSON-only request. Primary strict score remains0; separate post-hoc single-fence-normalized diagnostic records content accuracy equally for all arms. Do not equate format compliance with intelligence.

This list is preliminary and will be expanded from completed evidence.

## Raw comparator protocol delivery failure

Fresh-21 raw_tools emitted a textual XML-like write_file tool call instead of a native tool call or the requested fenced Python module. The receipt reports one model call, zero tool calls and unchanged workspace. Primary delivered-module score is zero; the embedded source is not an executed tool or a valid final delivery. Preserve this comparator failure rather than crediting an invented execution.

## Fresh-21 repaired candidate: answer-only code request enters durable work

The user requested a single fenced Python module. Initial discovery plus start_work batch was rejected; a unittest generation error (`class TestRoute(unittest)` instead of unittest.TestCase) was fed back. Inspection finalization then exposed only start_work and the model entered durable execution instead of returning the module. The run failed budget admission after7 calls/63,930 actual tokens; next maximum-output reservation did not fit the120,000-token study budget. No final answer. Before scored100. Repairs must distinguish answer delivery with sandbox verification from workspace implementation, retain direct final delivery during finalization, and prevent maximum-output reservation from suppressing an affordable final answer. Do not claim this frozen candidate fixes these newly observed failures.

## Shared mSwarm pool catalog excludes degraded nodes

At approximately12:50UTC the run began accumulating zero-inference route failures. Paused launch PID3067068 after122 persisted attempts,33 catalog failures (starting fresh-28:before); another child may have completed while the parent was paused. Authenticated node inventory showed both nodes degraded, Qwen agents healthy, Raijin free_slots1 and drain_modefalse. Required Docdex delegation succeeded with receipt e445ee0d-1f39-44b9-ae88-facdc5903d5e. Current upstream self-hosted-nodes.ts serializeLoadBalancedCatalogAgent restricts availableMembers to node.status===online, incorrectly excluding usable degraded nodes. Do not bypass backend identity or switch models; repair shared classification and preserve outage attempts separately.

### Root cause and operational repair

Production /srv/mswarm already contained equivalent pool-health fix e031a9446 from Nov5. Gateway/proxy were recreated at12:56UTC onNov7 using older default image tags without that fix. Saved corrected runtime-20261027n images were verified: their self-hosted-nodes.ts SHA256 matches production checkout420a0a9a... exactly. Both nodes were drained, actual telemetry reached0active/0queued, corrected loaded images were restored with no build/pull, and immutable image IDs were persisted in /etc/raijin-webapps/compose-profiles/mswarm.override.yaml (rollback copy retained). Admissions reopened. Both physical nodes now appear in healthy owner pool. Live Docdex receipt e44e2919-559a-4b8e-828c-11f75753f64c succeeded. This is an infrastructure change during the study, disclosed separately from unchanged frozen candidates.

Fresh-42 after began during brief earlier recovery and failed after3 completed calls/9602tokens when the catalog degraded again. It is not eligible for the zero-inference recovery pass and remains failed. Recovery selection freezes42 zero-model-call/no-model-request attempts (fresh28..41,allarms); no failed inference outputs are silently replaced.

## Native tool protocol can leak as final text

Fresh43 before/raw outputs are solely XML-like browser tool calls; no user answer despite retrieved sources. Fresh21 raw showed the same pattern. A provider response classified as terminal text is not necessarily a valid user deliverable. Generic recovery should validate supported tool markup against exposed schemas/permissions and request native correction, never blindly execute arbitrary prose or claim a printed call ran.

## Browser identifiers and evidence recovery

Fresh43 after combined parts of two snapshot UUIDs in browser_read, yielding unavailable snapshot, then finalized with howto evidence incomplete. Stable session-scoped short references and clear recovery metadata can reduce identifier copying errors. After still answered core Git semantics correctly, independently scored90; before/raw0 for absent answer.

## Research completion and output constraints

The shared benchmark accounting reserves estimated input plus the full requested40,960 output allowance. Raw research attempts fresh42,44,45,46 exhausted admission around64–72k actual tokens within a120k aggregate ceiling and returned no answer. This is a common harness admission limitation, not evidence of model inability to answer the questions. Future protocols should negotiate remaining output allowance before dispatch while keeping accounting equal across arms; the frozen protocol remains unchanged.

Research fresh44after (814words), fresh45before (842words), and fresh45after (717words) exceed the requested700-word limit. Semantic rubric scores are preserved and instruction-compliance fields record violations independently because the frozen rubric did not define a length penalty. Fresh45after retrieved normative assertion/counter text but omitted signature construction and rejection details; scored70 versusbefore60. Fresh46after retrieved body definitions and scored100 versusbefore90 with front-matter-only evidence. These are individual cases, not a final improvement claim.

## Unnecessary unverified quantitative additions in research

Fresh49after correctly explains redshift but adds model-dependent comoving/emission distances as “my calculation” without a calculator receipt or shown integral. At the stated nominal flat H0=70,Omega_m=.3 parameters, independent quadrature yields30.040Gly/3.004Gly rather than~29/~2.9; lookback12.93Gyr is correct. Parameters were approximate, so this is chiefly unsupported extra precision rather than a strict exact-value contradiction. Evidence criterion earns10/20; total90 versusbefore100. Generic repair should verify substantial numerical claims even when no prior calculate tool was invoked, or omit unneeded numerical assertions; current numeric audit only triggers after existing calculation evidence.

## Follow-up implementation order (not part of frozen73)

1. Count unchanged failures per model feedback round, not per tool in one response. SessionController.afterTool currently increments repeatedFailures for every identical invocation; ProgressTracker similarly counts repeated reads/preparation within a batch. Preserve cumulative protection across real retry rounds and reset only on real progress. Use a delivered-model-response epoch rather than total billed calls (embeddings/reservations are not feedback). Regression: four bad calls in one response allow a corrected second response; identical failures across successive responses still halt.
2. Keep answer-only code generation distinct from authorized workspace delivery. A verification sandbox does not implicitly authorize a durable build. Finalization must explicitly allow the requested direct output and preserve its output contract; do not implement a keyword router.
3. Validate terminal protocol-shaped output before accepting a final answer. Request bounded native correction with accurate accounting; never execute arbitrary printed XML or quoted examples as tool authority.
4. Negotiate a feasible output allowance from the remaining aggregate budget before reserving it, preserving model/context ceilings and accounting all retries. Apply equally to future comparison arms; never change frozen study accounting retrospectively.
5. Verify substantial numerical assertions regardless of whether an earlier calculate call exists; avoid forced review overhead for greetings or unsupported extra calculations.

Docdex impact reviewed: ProgressTracker feeds SessionController and its tests; SessionController feeds CLI/TUI and workflow evaluators. Follow-up tests must exercise user-visible delivery and cross-round halt behavior, not merely prompt strings. No follow-up code change is included in original/recovery73 scores.

## App-build environment exposes broken Chrome launchers

Fresh51raw_tools spent many calls discovering browser runtime. Actual shell receipts show /usr/bin/google-chrome -> /etc/alternatives/google-chrome and google-chrome-stable -> /opt/google/chrome/google-chrome, but target stat failsENOENT inside isolation; /usr/lib/chromium is absent. Do not label this a reasoning defect or infer that a failed browser self-check proves the delivered UI fails. Frozen workflow uses network:false shell and workspace permission profile; independent evaluation can render completed projects outside that attempt sandbox. Future fixture preflight must verify a working isolated browser and a runnable local server/browser journey before promising that capability. Do not alter the frozen environment mid-attempt or credit invented browser execution. Current app scores must disclose this self-verification limitation and rely on independent rendered evidence.

## Long-run context markers accumulate until compression fails

Fresh51raw_tools terminated after117model calls,137tools,2,128,160tokens and2,018,962ms with a context-capacity error and no final answer. Last admitted request had119messages; completed_tool_history markers occupied53,711characters while system/user text totaled457characters and tool schema JSON6,898characters. The archival markers themselves are not recursively bounded. The error blames user instructions/current request/tool schemas, obscuring accumulated history metadata. Generic repair must hierarchically archive old marker groups with bounded retrievable references while preserving current instructions, pending tool-call pairing and recent evidence. Apply common transport correction equally in future arms; frozen73 remains unchanged.

Independent raw TenderDesk evaluation: install only passed1/35checks (installation excluded from delivery points), no root server.js, setup/build/tests/README/DELIVERY/UI missing. Four backend modules survive. Static getTender exposes supplier IDs/names while sealed and omits own supplier bid values; API field conventions drift to snake_case and empty lines accepted. Score2/100 for limited inspectable source; no working-delivery/domain/security/UI credit. Do not count downstream prerequisite failures as35separate functional bugs. Source archive saved under projects/tenderdesk-raw_tools.tar.gz.

Fresh51before reproduced the original authorized-build handoff defect: returned a long honest read-only RFP summary with no implementation, while claiming tool access must be restored. Repaired after arm is running; do not infer its outcome yet.

## Phantom test paths and masked shell failures during app work

Fresh51after invoked node tests/api.test.js before that file existed. Piping its output through grep/head yielded a successful shell receipt with empty output; another command printed rc=1 but ended with successful tail, again a shell success. A follow-up head of $TMPDIR/t.out failed because scratch files are per-call. Later full output explicitly showed MODULE_NOT_FOUND. A successful shell invocation is not passing test evidence. Generic verification must require actual test execution evidence and retain underlying failure information; prefer direct test commands/unfiltered captured output and persist requested logs in workspace rather than assuming per-call scratch survives. This is observed in the active run, not yet its terminal outcome.

## Correction: the active comparator already shares the command allowlist

A prior inspection mistakenly attributed trust-workflow-attempt.mjs's older24-command allowlist to this run. The active run-generalization-study.mjs dispatches frozen benchmarks/complex52-attempt.mjs, which imports appbuild-tools.mjs; that adapter imports the same DEVELOPMENT_COMMANDS as SessionController. Therefore direct-command allowlist drift is NOT an established defect or confound in fresh73. The unselected legacy trust-workflow adapter still has a separate list, but must not be used to explain this study's outcomes. The observed broken isolated Chrome bundle and context-marker accumulation remain independently evidenced.

## Follow-up74 status (not included in73 scores)

Working-tree follow-up now implements bounded archive-of-archives indices and bounded per-batch receipt summaries; feedback-round repetition counters; direct native final_answer at inspection finalization without new checks; code-answer versus workspace handoff guidance; native/gateway printed-markup correction; affordable remaining-output negotiation shared with future raw comparator; short calculated-answer equation review; and omission of unsupported optional research quantities. Focused runtime/shell tests168pass0fail1platformskip. Real isolated local-HTTP Chrome rendering/font test plus isolation regressions12pass0fail0skip. Complete suite and live follow-up validation remain pending.

The active73 runtime, prompts, grading and recovery corpus are unchanged. One required bounded Docdex regression-drafting call88e43d30-1e9a-4d52-adb0-9bd4495af938 overlapped fresh51after around16:05UTC; development builds/unit tests also ran on the shared host. Treat elapsed time as shared-host operational performance, not an isolated microbenchmark.
