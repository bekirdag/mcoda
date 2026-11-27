# Codali Complex52 issue inventory

Original evidence: REPORT.md and scores.json. Original submissions remain unchanged. Status: investigation and repairs in progress. A regression test is evidence of a guard, not a guarantee of universal model correctness.

Current scope: CX01–CX43 below, plus every scored shortfall from the frozen run. Runtime guards and tool repairs are implemented with regression coverage. End-to-end research accuracy and app completion/efficiency remain open. The ledger probe now delivers SQL/Python passing22 independent additional cases, but that is not universal SQL correctness. All reruns and assisted continuations are retained separately from original scores.

## Current repair status

This section describes the current implementation; the qualification history below preserves failed experiments and superseded approaches.

| Area | Current status | Evidence / limit |
|---|---|---|
| Response recovery, budgeting, accounting | Implemented with bounded retries and conservative unknown-usage retention | Partial prose is retained; incomplete tool calls never execute; explicit busy-capacity conflicts recover, unknown conflicts do not |
| File scopes, batched edits, context recovery | Implemented with regression coverage | Traversal, ownership, fresh-analysis and verification protections remain |
| Deterministic verification and SQL binding | Implemented; ledger probe qualified | SQL22/22 independent datasets; Python7 supplied tests plus22 independent subcases; named rows or explicit column order prevent ambiguous binding |
| Browser source retrieval and evidence review | Retrieval defects repaired; semantic accuracy OPEN | One bounded tool-free evidence review, not the earlier three-stage critique; real research still overgeneralizes source scope |
| Planning and complete app delivery | OPEN; fresh58 failed delivery | Earlier fresh50:23/24 independent checks. Fresh58:972,439tokens, missing build/start scripts, invalid test command, no final answer. Downstream API checks blocked by failed startup |
| Benchmark integrity | Original submissions and scores preserved | Failed probes retained; assisted continuations excluded from one-shot claims; Docdex service inference remains outside client totals |
| Validation | Package60:2,111pass,0fail,9skip | No new paired intelligence score or release qualification claimed |

## Runtime and workflow root causes

| ID | Issue | Evidence | Status |
|---|---|---|---|
| CX01 | Output-limit responses discard all useful text; no bounded recovery | 9 text attempts report output_limit | Implemented: preserve partial prose/known usage and bounded retry; provider regressions pass. Live qualification pending. |
| CX02 | Invalid native replies / HTTP 502 invalid_response terminate tasks | 2 invalid native replies; 4 HTTP502 failures | Implemented: remove arbitrary 12k reply rejection; bounded same-cap retries. Runtime regressions pass. |
| CX03 | Heavy repeated context and control overhead exhaust app budgets before features | 959k/969k tokens; only scaffold/storage delivered | Partial: tool schemas compacted; history retains its model-window allowance after an overaggressive cap caused reread loops. App delivery/efficiency still open. |
| CX04 | Tool protocol and work-state friction cause failed calls and repeated verification | Both app event streams | Partial: claim retries now idempotent; clearer planning/testing guidance. App workflow remains open. |
| CX05 | Read-only answer generation lacks execution-backed numeric/code verification | Tasks 01,03,16,17,19,20,31,32,35–39 | Partial: batched arithmetic, native Node/Python verification and code-check guidance. Python probe passes20 executed tests; JS rerun passes10/10 independently executed supplied tests. |
| CX06 | Research confuses blocked/search/abstract pages with primary evidence and makes unsupported factual claims | Tasks41–49 | Partial: source status, snapshot search/cache and bounded evidence audit. Research remains open: successive runs still misinterpret source scope and obsolete struck-through passages. |
| CX07 | Long research consumes budget/deadline without reliable final answer | Task50; ~100k tokens for most research answers | Implemented reserves for final answer/time/evidence review. Live research delivered at82,372tokens; quality qualification incomplete. |
| CX08 | Product acceptance does not establish domain functionality, dependencies or real UI | Both app builds incomplete; placeholder and missing entries | Open: product-acceptance guidance improved; fresh app still incomplete. Do not equate server readiness with product readiness. |
| CX09 | Measurement gaps: timeout labeled user cancellation, hidden Docdex inference, false-positive API security probes | Task50, app evaluator, client-only metering | Fixed evaluator timeout labeling and positive controls. System Docdex inference remains explicitly outside client token accounting; not a full-system efficiency claim. |

## Every scored Codali shortfall

### complex-01 — 70/100

Correct financial totals. Note-event classification is ambiguous (partial credit); executable SQL fails DuckDB syntax/function checks. Python lacks earlier-reference and once-only reversal guards, explicitly assumes repeat reversals restore amount again. SQL diagnostic in independent-code/complex-01-duckdb.json.

### complex-02 — 70/100

Misses valid return A3 correction and incorrectly declares all lot-attribution corrections unable to support scrap A2.

### complex-03 — 80/100

Correct manual KM headline, but executing supplied code gives custom A survival0.2083 versus5/12; claimed logrank .1875/.6651 differs from actual .2636/.6076. Independent execution receipt retained.

### complex-04 — 0/100

No delivered final answer; retained failure, no retry.

### complex-06 — 0/100

No delivered final answer; retained failure, no retry.

### complex-10 — 0/100

No delivered final answer; retained failure, no retry.

### complex-11 — 90/100

Missing strict valid_to > valid_from check; empty price intervals accepted.

### complex-12 — 0/100

No delivered final answer; retained failure, no retry.

### complex-13 — 0/100

No delivered final answer; retained failure, no retry.

### complex-14 — 0/100

No delivered final answer; retained failure, no retry.

### complex-15 — 0/100

No delivered final answer; retained failure, no retry.

### complex-16 — 80/100

Core Bellman-Ford correct. Demonstration with absent target z raises KeyError instead of graceful handling; executable presentation interrupted.

### complex-17 — 90/100

Rejects empty intervals although requested to ignore them; main union algorithm and metamorphic tests sound.

### complex-18 — 0/100

No delivered final answer; retained failure, no retry.

### complex-19 — 80/100

Correct offsets and fold/gap policies; lacks holiday-calendar versioning and idempotent emission tests. next_instant skips same-day upcoming occurrence.

### complex-20 — 80/100

CAS result ignored; response cache lacks payload hash, user/resource scope and transactional persistence. Incorrect RFC6571 attribution for428.

### complex-21 — 0/100

No delivered final answer; retained failure, no retry.

### complex-22 — 0/100

No delivered final answer; retained failure, no retry.

### complex-23 — 90/100

CSV escaping and export-only prefixing supplied; no typed-text XLSX alternative and unsupported consumer-specific assurances.

### complex-24 — 0/100

No delivered final answer; retained failure, no retry.

### complex-25 — 0/100

No delivered final answer; retained failure, no retry.

### complex-26 — 90/100

Correct uncertainty/provenance and injection rejection; verification omits key availability/restore test, openssl enc -list does not inspect artifact encryption.

### complex-27 — 0/100

No delivered final answer; retained failure, no retry.

### complex-28 — 0/100

No delivered final answer; retained failure, no retry.

### complex-29 — 70/100

Correct normalized timestamps but forces speculative root-cause narrative; recommends compensation simply on timeout, unsafe without reconciliation.

### complex-31 — 80/100

Correct rates/counts; says confounded count DiD answers prevented-incidents question, and sensitivity calculation -2.36 should be -3.64.

### complex-32 — 90/100

Correct phase energy result and melt threshold; displayed mass-weighted18/.7 incorrectly evaluated31.67 instead25.71.

### complex-33 — 90/100

All required probabilities correct; false caveat suggests date phenotype confirmed affects whether genotype is fixed.

### complex-34 — 0/100

No delivered final answer; retained failure, no retry.

### complex-37 — 80/100

Reconstruction and rounding bound correct; suppression claimed information-theoretically safe too broadly; DP example treats sensitive changing n as public and omits operational budget/auth controls.

### complex-39 — 90/100

Useful labels/status/table/manual testing patterns; custom focus trap includes disabled/hidden controls and does not inert background, though recommends robust library.

### complex-40 — 90/100

Appropriate ambiguity/public-data gate; read-only plan omits build/license verification.

### complex-41 — 70/100

Two retrieved primary pages only; same-host WAL rule correct. No explicit one-writer explanation, idempotent external-effects design absent; unsafe topology test wrongly expects deterministic corruption/busy. Sources verified against PG/SQLite docs.

### complex-42 — 90/100

Primary NIST/IETF receipts verified; correct standards/draft distinctions. Migration lacks concrete rollback gate and invents10-15year classical-signature horizon.

### complex-43 — 40/100

Admits no substantive storage documents retrieved. Efficiency/lifecycle numbers not sourced; seasonal-only maturity claim overbroad. Correctly refuses incomparable cost ranking.

### complex-44 — 40/100

Regulatory framework partly sourced; product marketing date is not approval verification. Misnames ALFA-0701 as0101, wrong endpoint/publication and original application number; FDA statistical review contradicts CR claim. No trial paper retrieved.

### complex-45 — 40/100

Exact real wage correct; one BLS page only. HICP1/12OOH cap/user-cost claims unsupported and wrong; net-acquisition vs rental equivalence confused, chained CPI incorrectly called Fisher.

### complex-46 — 50/100

Two WWA pages only, no second authority. Sound general distinction; missing FAR explanation and actual UK effect estimate; correction mixes150x/2C illustration with UK study.

### complex-47 — 70/100

W3C criteria verified; later recommendation treats keyboard as alternative to required single-pointer operation. NIST only navigation/TOC, checkbox accessibility not established.

### complex-48 — 50/100

Honest retrieval failure; only LGPLdefinitions/SFCcontext read, no AGPLtext. General source duties partly correct but relinking/installation conditions incomplete and LGPLsection6 attribution wrong.

### complex-49 — 60/100

Verified reanalysis abstracts but not original JWST paper/second publisher. Confuses2020pre-JWST paper and2023journal. No full papers opened; API search abstracts insufficient for requested deep comparison.

### complex-50 — 0/100

No delivered final answer; retained failure, no retry.

### build-01-custody — 10/100

- F01: Two seeded organizations North and South; hashed-password login/logout with server-side session cookies; viewer/operator/admin roles. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F02: All shipment, reading, incident and export routes enforce tenant membership from the session; reject guessed cross-tenant IDs. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F03: Create shipments with unique tenant-local reference, origin,destination and integer min/max temperature in tenths Celsius; require min<max. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F04: List shipments with reference search,status filter,stable pagination and meaningful empty states. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F05: Append custody transitions created->in_transit->delivered, with actor,time and location; reject backwards or skipped transitions. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F06: Import JSON temperature readings with immutable eventId,timestamp and integer temperature; duplicate identical events are no-ops; conflicting duplicate payload returns409 atomically. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F07: Accept out-of-order timestamps; recompute excursions as consecutive out-of-range samples in timestamp order; readings exactly at min/max are in-range. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F08: Show a timeline/chart and an accessible equivalent table; each excursion indicates start/end and maximum deviation without inventing continuous measurements. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F09: Operators open and resolve incidents with a required resolution note; retain chronological audit history. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F10: Viewer can read but cannot mutate; admin can manage local users without removing the final admin. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F11: CSV export obeys current filters, quotes correctly and neutralizes formula-leading customer text; no password/session fields. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F12: Dashboard counts derive from current tenant data; data survives server restart; invalid batches leave no partial writes. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- build1: Clean dependency install/setup/build succeeds — 2/4. Install/build commands run, but setup is a no-op and DB imports missing seed.js.
- build2: Server health and real UI launch — 2/4. Health endpoint runs; screenshot is only UI build pending, not a usable UI.
- build3: Documented commands and delivery claims accurate — 2/4. Commands and incomplete delivery manifest exist; README claims unimplemented sessions and request protections.
- security1: Negative tenant/role/session tests pass — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- security2: Validation,SQL/HTML/CSV andrequest-size protections — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- security3: Race/idempotency/transactional invariants hold — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- tests1: Meaningful automated domain tests execute and pass — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- tests2: Restart persistence and error paths verified — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux1: Coherent visual hierarchy/readability atdesktop — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux2: Mobile390px preservescontent/actions — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux3: Keyboard labels/focus/accessibility — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux4: Clear error/empty/loading/success states — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- code_quality1: Maintainable domain/storage/UI separation — 1/2. Some server/storage/config separation; domain/UI absent.
- code_quality2: Explicit errors/types/validation — 1/2. Explicit 404/path guards and password helper; domain validation missing.
- code_quality3: No core stubs/TODO orduplicatedunsafe logic — 0/2. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- delivery: All source and required assets present; no externally dependent missing component — 0/2. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
### build-02-workshop — 8/100

- F01: Two seeded organizations Birch and Pine; hashed-password session login/logout and member/manager roles. — 2/4. Setup actually seeds organizations and hashed users; login/session routes absent.
- F02: Server-enforced tenant scoping on resources,bookings,maintenance,inventory and CSV; never trust client role/tenant fields. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F03: Managers create resources with name and positive integer capacity; list/search/archive without deleting booking history. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F04: Members book a resource over half-open UTC intervals [start,end); duration15minutes..8hours, integer seats1..capacity, nonempty purpose. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F05: Concurrent reservations must not exceed capacity at ANY instant; touching endpoints do not overlap; enforce transactionally. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F06: Idempotency-Key is required for booking creation, scoped to user: same payload replays same booking, changed payload returns409. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F07: Members cancel own future bookings; managers cancel any with an audit note; cancellations release capacity. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F08: Managers add maintenance blocks that reject overlaps with active bookings; blocks prevent future bookings, with clear conflict feedback. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F09: Manager-only consumable stock adjustments use signed integers and immutable movement IDs; duplicates no-op, conflicts409, stock cannot become negative. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F10: Calendar and accessible list views share the same data; filters by resource/date/status and mobile layout preserve actions. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F11: Member cannot edit capacity,maintenance or inventory; all sensitive operations have actor/time audit entries. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- F12: Dashboard uses persisted counts/stock; safe filtered CSV export, clear invalid/loading/empty/success states, restart persistence. — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- build1: Clean dependency install/setup/build succeeds — 2/4. Install and setup succeed; build entry is missing.
- build2: Server health and real UI launch — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- build3: Documented commands and delivery claims accurate — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- security1: Negative tenant/role/session tests pass — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- security2: Validation,SQL/HTML/CSV andrequest-size protections — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- security3: Race/idempotency/transactional invariants hold — 0/4. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- tests1: Meaningful automated domain tests execute and pass — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- tests2: Restart persistence and error paths verified — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux1: Coherent visual hierarchy/readability atdesktop — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux2: Mobile390px preservescontent/actions — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux3: Keyboard labels/focus/accessibility — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- ui_ux4: Clear error/empty/loading/success states — 0/3. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- code_quality1: Maintainable domain/storage/UI separation — 1/2. Database, seed and clock separation; server/UI absent.
- code_quality2: Explicit errors/types/validation — 1/2. Schema constraints and password validation; domain operations missing.
- code_quality3: No core stubs/TODO orduplicatedunsafe logic — 0/2. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.
- delivery: All source and required assets present; no externally dependent missing component — 0/2. Not implemented or not demonstrated in submitted incomplete application; no credit for schema declarations alone.

## Additional issues found by fresh repair probes

- **CX10 — Test diagnostics hid the real failure.** Long runner stacks displaced timeouts; Python import failures became ENOENT for an absent report. Fixed bounded diagnostic preservation and native startup/zero-test error reporting; offline verifier regressions pass.
- **CX11 — Inspection reserved the wrong output size.** The host shrank native auto calls to512tokens, truncating verified code and spending the budget retrying. Removed shrinking and duplicate reserve accounting; added token/time reserve regressions.
- **CX12 — Requested test frameworks were changed.** The tool offered Vitest alone, encouraging incompatible assertion rewrites. Added native node:test and standard-library unittest in the same offline sandbox; imports, zero tests, skipped tests and failures cannot count as success.
- **CX13 — Repetitive calculations and page reads.** Batched up to16 formulas, retain four browser snapshots and query relevant passages. Risk probe fell from37,473 to16,809tokens with correct core results. Ordered-term fallback handles accessibility line breaks without claiming an exact quotation.
- **CX14 — Runnable code skipped verification.** A fresh JS answer failed7/10 of its own tests (undefined promise variable). A bounded host reminder now identifies unambiguous standalone source/test pairs and requests verification; it never auto-executes code or overrides prohibitions. Live rerun independently passes10/10 supplied tests at24,190tokens; this is evidence for this case, not universal code correctness.
- **CX15 — Coarse planning and interface drift still dominate app builds.** Fresh ParcelNest build spent981,724tokens and stopped on repeated unchanged reads while still in database/setup. Tests imported a nonexistent export; planning omitted test/data paths, causing repeated scope recovery. Shorter skills now emphasize cohesive vertical slices, actual export inspection, test paths and appropriate owned directory scope. This remains OPEN until a new app passes real acceptance.
- **CX16 — Bundled skills exceeded their one-load limit.** New guidance pushed skill bodies beyond2,400characters. Condensed planning, testing and tool-selection without raising the bound; full Codali regression suite passes:2077passed,0failed,8skipped.

## Repair qualification evidence

All development probes are retained under `/home/wodo/.local/state/codali-complex52-repairs-20261105`, including failed runs. These are iterative development probes, not a frozen paired benchmark or a new intelligence score. Original benchmark results are unchanged.

Pass2 Python output independently executes20tests successfully; its prose claimed21, so exact test-count fidelity is still imperfect. Pass2 JS independently fails7/10. Pass2 research completes and discloses unsupported claims but is incomplete. The app failure is retained, not patched into a successful benchmark submission.

## Later generic defects isolated during app and research reruns

- **CX17 — Inspection discovery hid execution capabilities.** A fresh app request spent repeated searches looking for write/shell tools inside the read-only registry and received unrelated read-only results. Discovery now returns execution-only metadata with the start_work handoff, without exposing mutation handlers or granting permissions. Query and explicit-name regressions preserve the read-only boundary.
- **CX18 — Directory scope accepted but not honored.** Plans accepted `src/`, while authorization compared descendants with `src//`; ownership and steering comparisons had the same inconsistency. Centralized POSIX-relative scope comparison normalizes harmless directory notation and retains traversal, absolute-path and sibling-prefix protection. Runtime, ledger and work-state overlap checks now share it.
- **CX19 — Evidence audit discarded useful earlier passages.** FIFO retention let later unsuccessful lookups replace source passages and made the audit incorrectly report them missing. Audit packets now omit failed matches, remove repeated metadata, retain source diversity and select relevant passages within a fixed budget. Current audit is a single bounded tool-free evidence review (CX38); a model audit is not independent factual proof.
- **CX20 — Original-goal coverage was repeatedly omitted from refined plans.** Complete replacement plans now retain the original canonical obligation on the unique terminal task when omitted. Ambiguous plans and other uncovered criteria still fail normal validation. Partial updates are unchanged; no criterion is removed.
- **CX21 — Required planning skill remained only catalog metadata.** Host-required planning now supplies the bounded bundled planning guidance before the first plan. It does not execute scripts or override user instructions. Guidance keeps a cohesive deliverable and its tests together; technical-layer task splitting is not mandatory.

Original app logs contained15 failed tool receipts:6 shell,5 write,3 verification,1 plan refinement. Some are legitimate guards (destructive command, stale analysis, missing tests); those protections remain. Their recurring causes—scope ambiguity, missing test paths, misleading validation and overhead—are addressed rather than disabling the guards.

Latest qualification: standalone JS rerun independently passes10/10 supplied tests at24,190tokens. Full Codali suite at pass15:2081passed,0failed,8skipped; subsequent scope/discovery/audit changes are undergoing their own full regression and live validation. Research still exhibited unsupported SQLite isolation claims in pass4, despite receiving correct passages; CX06 remains open pending counterevidence-enabled verification. Do not treat every issue in this list as closed.


### Latest qualification (2026-11-05, pass8 in progress)

- **CX22 — Browser text extraction erased revision and section semantics.** Accessibility snapshots flattened struck-through historical guidance into apparently current prose. Selected excerpts also omitted the enclosing mode/section. Browser snapshots now explicitly mark deleted/struck-through passages and return enclosing heading context; research packets and answer guidance retain those distinctions. Eight real-Chrome regressions pass. A fresh research run is required to establish the effect on factual accuracy.
- Scope normalization now covers both controller authorization paths and filesystem handlers, in addition to ledger/work-state comparisons. An integration regression initially caught a missed pre-tool check; after repairing it, SessionController passes81/81 and FileTools7/7. Harmless `src/` ownership works without permitting `src-other/` or traversal.
- Pass7 app was stopped because it used the incomplete scope repair. Its logs are retained. Pass8 uses a fresh build/workspace; no candidate artifacts were edited by the evaluator.
- Pass7 research completed at85,032tokens, but remained incomplete and repeated obsolete WAL limitations. It predates the source-fidelity repair. CX06 remains OPEN.

- **CX23 — Benchmark environment instructions contradicted non-iOS RFPs.** The shared app provisioning paragraph unconditionally required native delivery and forbade a web substitute for every platform. It now explicitly limits those requirements to an RFP requesting native iOS; other platforms follow their RFP. The provisioning regression covers this distinction. Earlier immutable attempts remain unchanged; this is a benchmark confound, not evidence that one model was uniquely at fault.
- **CX24 — Multiple same-file patches repeatedly invalidated preparation.** The first mutation correctly makes subsequent structural receipts stale. `write_file` now supports a bounded `edits` array resolved entirely against the same original contents. Missing, ambiguous or overlapping matches reject the whole batch before any write. Ownership, path and fresh-analysis checks remain; models receive guidance to combine related patches.
- Full package pass24:2088passed,0failed,8skipped. Two prior mock-only Docdex tests depended accidentally on live initialization; their fixtures now isolate initialization. The new two-stage research critique and batched edit support are undergoing focused/full validation.
- Research pass8:75,951tokens; no obsolete WAL transaction-size claims, but still unsupported isolation assertions. CX06 remains OPEN. The next pass separates adversarial critique from final synthesis instead of asking one polishing pass to do both.

- **CX25 — Overaggressive execution-history reduction caused code reread loops.** The repair's4,000token cap evicted a19KB working source file after small intervening calls. Pass8 spent over500ktokens repeatedly re-reading while the app remained incomplete. The cap has been removed: history again scales to the lead model's context window, with the existing provider guard and saved archives. Schema compression remains. This is a repair regression identified during live testing, not a cause asserted for the frozen original run.
- Pass8 was preserved and an explicitly labeled assisted continuation resumed its saved session under build27. Its pre-continuation workspace/state are archived. Any continuation success is NOT a successful one-shot benchmark, and cumulative costs must include the original attempt.
- Full package pass26:2089passed,0failed,8skipped; batched-file tests8/8. Build27 router108/108 after critique guidance; final app qualification remains open.
- Research pass9:89,212tokens; unsupported negative claims were narrowed into uncertainty, but the answer still omitted a necessary isolation source and misapplied a read-only claim across modes. Tightened generic review to retrieve an identified necessary primary source when authorized and budgeted, rather than defer it to the final answer. No database-specific fact was added to the runtime prompt.

- **CX26 — Source recovery rejected the handle actually shown to the model.** `context_read` now accepts an actual successful receipt handle or source hash, resolves short receipt references without ambiguous collisions, and remains confined to the current session. A new regression recovers a passage beyond12,000characters without repeating the file read.
- **CX27 — Nested tool-output truncation silently skipped source text.** Browser pages fit their own3,800-character JSON bound but the interaction envelope clipped at3,000, leaving invalid JSON and advancing to a nextOffset after text never delivered. Bounded JSON responses up to4,000characters now remain intact inside a bounded envelope. Larger/unstructured outputs still archive and truncate explicitly.
- **CX28 — Long receipt excerpts had no full-source recovery link; progress guidance was clipped.** Full tool output is now archived before shortening a receipt, with a persisted sourceSha256. Receipt recovery uses the complete archived source. Repeated-read guidance is prepended so output clipping cannot discard it. This preserves the actual guards rather than treating repeated reads as progress.
- Assisted continuation2 still looped on source reads and was stopped for these confirmed recovery defects. Its logs/costs are retained; an assisted continuation3 will exercise the fixes. No app success or new one-shot score is claimed.

- **CX29 — Preparation loops bypassed unchanged-read detection.** Nested reads deliberately avoided double-counting, but the outer `prepare_edit` was not tracked. It now fingerprints the actual source hash, normalized requested span and task attempt, excluding volatile receipt IDs. Pagination, changed source and new task attempts remain distinct. Five ProgressTracker regressions pass. Existing bounded warning/checkpoint behavior remains, with actionable guidance delivered before large output.
- Research review now requires a separate textual critique before any lookup/final synthesis. A native lookup response alone is not treated as a critique. Review checks that evidence and claims have the same subject, scope and quantifier. Calls remain metered within the shared budget; the whole output cap remains available so native reasoning cannot starve the critique into truncation.

- **CX30 — Final code diverged from executed code.** A new ledger probe produced the right1.85 total and correct reversal IDs, and executed SQL/Python checks, but the final answer included an obsolete invalid SQL draft and rewrote the executed query. The answer path now tracks exact executed SQL and successful verifier source files, detects changed final code fences, reserves one correction pass, and asks for the executed version or an explicitly authorized recheck. No claim is made that successful execution proves semantic correctness; the live ledger rerun is pending.
- **CX31 — Browser title search preferred table-of-contents links over source sections.** Confirmed in the research receipts: a Serializable Isolation Level query returned navigation near offset3602 rather than the actual section. Exact searches now prefer a non-link occurrence, retaining link-only fallback, bounded scanning and offsets. Nine real-browser/helper regressions pass.
- Full package pass38:2094passed,0failed,8skipped. The three-stage review reserve initially consumed the entire deadline on short turns; a regression caught it, and the review reserve is now capped at75% of the turn deadline. Router109/109 passes after repair.
- Independent copy of app continuation3:22/24 checks pass. Setup/repeated setup/build/health/auth/tenant isolation/concurrent checkout/idempotence/logout pass. `npm test` cannot start because its script passes a directory unsupported by this Node invocation; returning one's own loan incorrectly returns403. UI interaction and restart-persistence qualification remain separate. The app is not product-ready and the model is continuing its saved task; evaluator did not patch candidate source.

- **CX32 — Testing guidance remained optional catalog metadata during actual validation.** The bundled testing guide is now supplied once when a goal starts running verification commands, and restored when resuming a session with validation receipts. It executes no scripts or extra inference and cannot widen permissions. Guidance explicitly covers real documented commands, role/fixture positive controls, and invalid-to-valid state sequences. UI guidance now calls for real payload/role checks and hidden-state rendering; these are generic instructions, not app-specific fixes.
- Independent browser checks of continuation3: login succeeds,390px layout has no horizontal overflow, no browser runtime errors; visual inspection catches `[object Object]` in tenant display and member-visible admin controls. These UI findings remain open pending candidate repair and new independent checks.
- Independent execution of ledger first-run SQL: first presented block fails binding; second returns1.850 on the supplied rows but still1.850 after adding a later valid reversal of F (expected-1.20), incorrectly classifying it invalid. The rerun uses the new code-fidelity guard and remains under qualification.

- Ledger breadth2 now preserves the executed SQL and explicitly reports its failed additional cases and untested proposed fix, rather than presenting a rewritten query as verified. Python checks pass6/6, but SQL completion remains OPEN; truthful failure reporting is not successful delivery. This development probe is not a new intelligence score.
- Validation-guide hook regression suite:84/84pass. An additional failure-path repair clears completed-tool fences before optional guide loading, tolerates missing guide reads, and still propagates state-persistence errors.
- **CX33 — Timed-out shell diagnostics vanished before reaching the model.** Continuation4 repeatedly received only `ERROR[tool_timeout]: Process deadline exceeded`, although the executor retained partial test output in error details. Native loops render the message alone. Process errors now include bounded head/tail excerpts from BOTH stdout and stderr; full captured details remain available. Nonzero exits also retain test output even when stderr contains only a runtime warning. Timeout, isolation, failure codes and retry flags are unchanged. Regression qualification pending.

- Package42 qualification:2,099passed,0failed,8skipped. A skill-length regression was caught and repaired by shortening the full file including frontmatter, not increasing the load limit. Shell timeout/nonzero diagnostics tests pass.
- `query_data` now optionally compares explicit expectedRows against actual typed rows, ordered by default or unordered with duplicate multiplicity preserved. It reports validation.passed separately from successful query execution and scopes the result to supplied examples. Nine deterministic-tool integration tests pass, covering order, duplicates, types, empty/null results and offline restrictions. This is a generic verification facility, not a claim that model-written expectations are independent ground truth.
- **CX34 — Research compression removed the handles needed for follow-up tools.** Research pass13's review invented URL-shaped snapshot IDs because source packets omitted actual browser handles. Packets now preserve bounded snapshotId, offset, nextOffset and totalChars; audit guidance uses exact IDs and short literal queries. The pass13 answer at86,094tokens was more cautious but incomplete; do not label it a solved research task. A fresh qualification is running.
- App continuation4 consumed907,757additional tokens and stopped at its turn budget. Independent copy remains22/24: tests hang, own-loan return403 persists. No candidate source was patched by the evaluator. Continuation5 is explicitly assisted and uses build44 with timeout diagnostics and automatic validation guidance; its eventual result cannot be counted as a one-shot success.

- Package44 qualification:2,101passed,0failed,8skipped, including exact SQL example checks and retained browser recovery handles.
- **CX35 — Phrase-only browser lookup failed on natural keyword queries.** Multiple research runs issued paraphrased/keyword queries that existed only as nearby unordered words, producing no-match loops. Browser retrieval now retains exact/ordered priority and adds a bounded1200-character keyword-window fallback with minimum overlap. Approximate results are labeled ranked_terms, include matched terms, and explicitly do not verify the query's claim. Query metadata is included before JSON pagination bounds so it cannot recreate CX27. No model-specific topic routing or benchmark facts were added; live qualification remains pending.

- Package47 final regression check:2,102passed,0failed,8skipped. Real Chrome/helper checks10/10passed, including approximate-match metadata within the serialized pagination bound. Research pass14 preserved usable snapshot handles but still missed critical passages after literal-query failures;90,369tokens, incomplete. Pass15 qualifies the new keyword fallback separately. No frozen benchmark scores were changed.

- **CX36 — Missing semantic main landmarks made initial reads navigation-only.** When the user requests main content but the worker must fall back to a whole-page snapshot, the first read now starts at a level1/2 document heading within a bounded prefix if available. Explicit page-scope reads still start at0; no snapshot text is deleted and the prefix remains recoverable by offset. Twelve real-browser/helper checks pass. This is a starting-position heuristic, not a claim that the first heading proves relevance.
- Research pass15 retrieved key passages at83,166tokens but still overgeneralized nonblocking predicate locks into nonblocking writers, and misrepresented uncaptured SQLite material as absent from the page. Source access improved; semantic reliability remains OPEN. A separate pass16 settings experiment increases native reasoning from low1024 to medium2048 on the same local Qwen endpoint, without increasing fixed turn/output caps or changing deployed defaults.

- **CX37 — Relay-normalized success concealed output exhaustion.** Research pass16 consumed exactly4096 output tokens and ended mid-backtick/sentence, yet arrived as a successful response and passed the text review's nonempty check. SessionController now conservatively rejects nonempty prose at the requested output cap, preserving partial text and exact usage before its existing bounded concise retry. Complete native tool calls are excluded from this prose guard and are not replayed. A genuinely complete answer exactly at the cap can incur a conservative retry; caps and shared-budget enforcement are unchanged. Regression qualification pending.
- Pass16 at96,557tokens corrected the major writer-blocking and SQLite-isolation mistakes but was incomplete from output exhaustion. More reasoning is not yet a qualified default; the configuration remains private to this development experiment.

- Assisted app continuation5 independently improves to23/24 API/build checks: own-loan returns now pass along with tenant isolation and concurrency/idempotency. The documented npm test command still hangs. Continuation5 cost913,334additional tokens; cumulative saved-session accounting4,024,324tokens is estimated because earlier interrupted invocations retain reservations. This is not an efficiency or one-shot success, and UI qualification is still open.

- Package51:2,105passed,0failed,9skipped. Capped-prose recovery and complete-native-call non-replay both pass; an initially wrong tool-exposure test fixture was corrected without weakening execution checks.
- New unseen synthetic venue manuals:7/7 core factual criteria passed at36,012tokens, including current-vs-struck-through capacity, component-vs-system concurrency, retry keys and unknown refund terms. The final answer nevertheless asserted an unprovided own refund policy and overstated identical single-hall behavior. Core extraction improved, but unsupported advice remains an open semantic limitation; this is not a broad intelligence score. Gold answer was never served or supplied to the model.
- Fresh ParcelNest qualification now starts from an empty workspace with the original RFP and fixed effort limits using all current runtime fixes. This is separate from the assisted4M-token development history; no evaluator findings were passed to the model.

- **CX38 — Unconditional multistage self-critique added cost and sometimes invented defects.** Research pass17 consumed91,914tokens and still incorrectly generalized read-only transaction safety; its critique also rejected a valid inherited concurrency condition. The three-stage critique/lookup/rewrite sequence is replaced by one bounded tool-free evidence review after normal retrieval. It may preserve a correct draft, must not force criticism, and must distinguish documented facts from suggested policies. Budget reserves now match one review call. This is a reduction in speculative review overhead, not proof of factual correctness; fresh qualification is running. Router111/111 passes.
- Fresh app planning trace: the first phase plan omitted task.phaseId and correctly failed validation. The next call supplied phaseId and succeeded. The full receipt disproves the interim suspicion of a host planning-state bug; no validation invariant was relaxed.

- Package52 full suite:2,105passed,0failed,9skipped after the single-pass research review change. Fresh app, synthetic-source comparison, database research and ledger probes are running separately; passing runtime regressions does not close their semantic delivery issues.

- Single-pass synthetic-docs rerun:19,817tokens versus36,012 before (45% less), still7/7 core criteria. Unsupported existing refund policy and identical single-hall claims disappeared, but the recommendation confuses capacity with throughput and treats fixed capacity as an unknown configuration feature. Exact independent review is retained; semantic reliability remains OPEN.
- Live research18 and ledger3 failed with HTTP409 classified as invalid_request. A subsequent69-token health probe succeeded. The failed request usage lookup returned404, so no usage was invented and uncertain reservations remain. Safe upstream-code capture is enabled only in a separate diagnostic rerun while the cause is investigated; no blind conflict retries were added.

- **CX39 — HTTP409 conflicts were mislabeled as invalid requests with no uncertainty guidance.** Unknown409 now maps to request_conflict with a static explanation that completion/usage are unconfirmed and status should be inspected before retrying. Existing more-specific quota/invalid-response classifications retain precedence; upstream bodies remain private and no automatic conflict retry is introduced. Seven provider-error regressions pass, including one-request-only transport behavior. The external cause of the two live409 responses remains unconfirmed; a separate rerun is making progress.

- **CX40 — SQL tool metadata missed broad SQL/Python discovery.** Actual mixed-capability discovery returned generic calculators/verifiers/browser metadata without query_data. Reproduced ranking placed it outside the top8; describing its actual capability as Execute DuckDB SQL SELECT moved it to2nd. Only tool metadata changes; no request-type table, new permission or execution fallback. Added full-controller discovery regression for query_data plus verify_tests and continued shell exclusion.
- Package53:2,106passed,0failed,9skipped. Research19 completes at87,221tokens without409 but still falsely generalizes nonblocking SSI monitoring to all writers and omits SQLite retry semantics. This remains a substantive correctness failure despite improved retrieval and delivery. Do not claim CX06 is solved or adopt the tested settings as qualified.

- **CX41 — SQL positional rows depended on JSON object key order.** Ledger4 reordered columns while preserving row arrays, producing conversion failures; same-typed columns could silently swap values. query_data now accepts named row objects or explicit columnOrder for multi-column arrays, validates exact columns/width/order and rejects ambiguity before execution. Empty/single-column inputs remain compatible. This deliberately rejects formerly ambiguous multi-column arrays without columnOrder; callers should use named rows. Generic schema/worker regressions cover reordered keys, duplicate/missing/extra columns and mixed row formats. Ledger4 was stopped and retained because worker code changed during the attempt; fresh consistent-runtime qualification required.
- Package54 full suite:2,107passed,0failed,9skipped. SQL/Python discovery112/112Router checks passed before the row-contract repair.

- CX39 follow-up: a real pinned Docdex delegation returned HTTP409 `conflict` with `details.reason_code=all_compatible_nodes_busy`. Only that explicit capacity-rejection contract now maps to existing bounded rate-limit recovery (two retries, shared budgets, Retry-After honored); other409 conflicts remain non-retryable. Failed usage reservations remain uncertain, not invented zero usage. No alternate model or cloud fallback was used. Recovery qualification pending.
- **CX42 — Required tests were planned behind the implementation they must verify.** Fresh app assigned npm-test acceptance to implementation T2 while test-writing T3 depended on verified T2. This creates a latent verification dependency cycle; it is not proof this alone caused the budget stop. Execution/planning guidance now defaults a single app to one cohesive implementation/tests/delivery task and explicitly warns against that cycle. Independent deliverables may still have separate tasks; verification gates are unchanged. This guidance needs live qualification and cannot guarantee model plan quality.
- Fresh app outcome:973,809tokens,27.8minutes,44modelcalls,60toolcalls; stopped at fixed budget with no final answer. Independent copy passes23/24 API/build checks, with npm test failing because test/ does not exist. Browser login, mobile-overflow and runtime-error checks pass; tenant display now renders Oak and member view no longer exposes the admin form. No evaluator patch or assisted continuation is counted. Improved delivery, still incomplete and not an efficiency-target pass.
- SQL binding regressions10/10 pass after adapting the union schema to the registry's supported type-array contract. Named-row cell types are checked inside the isolated worker; malformed nested cells, mixed rows and ambiguous positional inputs reject. Package57 full suite:2,108passed,0failed,9skipped. Earlier failed tests are retained as development evidence.

- Ledger5 build57 qualification:74,099tokens; delivered SQL/Python retained executed code and matched the requested main/additional results. Independent SQL rerun passes22/22 newly generated datasets (seed19283, empty/single rows, non-contiguous seq, negative amounts, forward/missing/reversal targets and repeated reversals). Delivered Python passes its7 tests plus an independent test containing the same22 subcases with reversed input ordering. These close the observed ledger-delivery failure for this probe; they do not establish a new broad intelligence score or every possible ledger contract. Evidence is in breadth5-runtime57/probe-07-ledger/independent-*.
- Build58 Router113/113 passes, including explicit busy-capacity retry with uncertain usage preserved. New fresh app run uses the original RFP/limits and no evaluator hints; it tests strengthened cohesive-task guidance independently of the prior973,809-token incomplete run.

- Package59 full suite:2,110passed,0failed,9skipped. The previous full-run failures were an obsolete planning-guide assertion and a mocked Docdex test that accidentally called live initialize; fixtures now reflect the new instruction and isolate initialization while retaining permission/index checks. Runtime58 and59 production behavior is identical. Final fresh app remains in progress.

- Fresh-runtime50 model-call breakdown (requested operations, not all avoidable overhead): file mutation12calls/293,578tokens; retrieval/discovery14/266,990; execution/verification10/241,817; work control7/160,306; prose/review1/11,118. Wall times include relay waiting and inference, so this does not isolate host latency or support a raw-speed claim. Exact rows retained in usage-breakdown.json. Independent UI flow additionally passes checkout and own-loan return. An initial evaluator selector expected the visible text only; the app correctly used descriptive accessible names, and that evaluator error is retained separately.

- Inventory coverage check confirms all42 below-perfect Codali text cases from the frozen scores are represented, alongside both app criteria breakdowns. The42 CX identifiers group root causes and newly found repair defects; they are not42 proven-closed bugs. Independent previous-fresh-app stored-HTML rendering check passes together with UI checkout/return.

- **CX43 — Schema compression discarded parameter semantics.** Native tool schemas stripped all descriptions, including shell cwd/writePaths instructions. Fresh58 attempted a literal `$TMPDIR` workspace grant and shell operators as executable arguments. Full function descriptions already contained guidance, so stripping is a contributing risk, not proven sole causality. Compression now preserves complete parameter descriptions at every depth; only presentation metadata is removed. Long descriptions are not truncated into incomplete constraints. Property names and enum/const/default data remain untouched. No permissions are broadened. Regression validation pending.
- Fresh58 independent qualification:972,439tokens (932,683input/39,756output),45modelcalls,70toolcalls,33.8minutes, no final answer. Setup and repeated setup pass; build/start target missing scripts, npm test passes an unsupported directory argument. Server startup fails, so downstream API checks cannot run. This is2/5 executed checks, **not**2/24 or a new app score. The stronger cohesive-task guide produced one task, but did not solve completion or efficiency. Original workspace and failed evaluator logs retained under fresh-runtime58/probe-06-app.
- Local schema-repair review receipt27db3e25-0dc7-444d-ad4e-19930d4d7903 used the pinned mswarm qwen-latest-flash-next agent. The review correctly highlighted loss of long semantic descriptions; final implementation preserves them verbatim rather than inventing a summary field.

- Package60 final regression result:2,111passed,0failed,9skipped. CX43 complete-description preservation regression passes, including long guidance and literal property/enum data. `git diff --check` passes. No model probe is left running. This is a repair checkpoint, not full benchmark qualification: research correctness and app completion/efficiency remain OPEN. No npm publication.

## 2026-11-06 generic repairs and remaining qualification

These are development probes, not revised scores for the original frozen benchmark. Original results and failed attempts remain intact. See docs/planning/codali-generalization-20261106-plan.md and progress log.

- **CX44 — Repeated unchanged observations and oversized activity inventories consumed context.** Execution-history compression now archives duplicate identical read_file/docdex_open/prepare_edit observations, preserving the latest complete native call/result group. Mutation/error barriers prevent deduplication across intervening actions; changed outputs and user constraints remain. Inventory reduced to the newest12 bounded entries with full recovery archives. Eight focused context checks pass. This reduces one overhead source; fresh app probes still consumed about1Mtokens without completion, so overall efficiency remains OPEN.
- **CX45 — Scratch-path errors suggested invalid workspace grants.** Literal `$VAR`/`${VAR}` writePaths now receive an actionable explanation that shell variables are not workspace paths. The regression rejects the bad grant, then permits actual isolated scratch use without widening workspace permission. Early delivery guidance covers actual scripts, imports/exports and shell argument semantics. Model compliance is not guaranteed.
- **CX46 — Redundant gateway envelopes wasted valid tool attempts.** Development62 research nested `codali` wrappers or args-only wrappers around already valid tool calls. A bounded exact-shape normalizer removes at most3 redundant layers before the normal schema, capability, batch and permission checks. No tool-name guessing or dropping unrelated keys. Forbidden writes and nested finalization in batches remain rejected. Focused router117/117 passed. Unknown tools_describe requests now identify permitted names in the request without enabling anything on error.
- **CX47 — Research snapshots spent their page allowance on ARIA formatting/navigation.** Browser research reads use rendered main/body text while retaining headings and bounded visible non-navigation links; explicit whole-page accessibility reads still use ARIA. Struck-through/deleted text remains labeled, full snapshot paging stays available, and source-format limitations are explicit.13/13 real Chrome checks pass. This improves evidence access, not factual entailment by itself.
- **CX48 — Evidence audit overquotation exhausted output and recovery time.** Development64 research reached4096outputtokens, was correctly rejected as incomplete, then timed out during recovery. The generic audit now prioritizes a complete synthesis, inline links and short quotations, with a500word default that yields to user requirements. Development65 completed352758ms/78686tokens with better predicate-lock/SQLite-isolation scope; it still produced1038words and needs semantic scrutiny. Repeated same-model review experiments failed to justify additional stages and were not promoted. Research reliability remains OPEN pending fresh comparison.
- **CX49 — Mocked Docdex tests accidentally depended on live initialization.** Two tests mocked waitForIndex/search but still called the real singleton initialize. Under daemon timeouts they failed before the intended mock. They now mock binding explicitly while retaining actual controller permission checks and index/search invocation assertions. Full65 failures remain recorded; follow-up validation pending. Separate mocked-answer timeouts under severe system IO pressure are retained as infrastructure observations, not hidden as passing tests.
- **CX50 — Build completion cannot be inferred from passing portions of acceptance.** Development62 independently passed22/24API/build checks but failed its own tests and changed-payload idempotency conflict; browser showed `undefined` signed-in details. Development64 reduced initial tool schemas but failed login/session tests and exhausted969631tokens. The narrower initial-tool setting is not promoted. Runtime guidance alone has not proven end-to-end delivery. User expanded prospective app budgets equally to10Mtokens/1000modelcalls/2400tools/1600steps/10hours; earlier capped failures remain incomplete, never relabeled successes.

A new50question+2app corpus is authored privately with independent numerical/code/business-rule controls. No held-out inference has started. The prospective comparison includes verified pre-fix build60, repaired runtime and raw sameQwen with tools. Shared Docdex is currently unhealthy under concurrent host pressure; benchmark preflight waits for the required service rather than silently treating outages as intelligence scores. No npm publication.

## Numerical reliability follow-up after stopped40k run

- Calculator malformed arguments produced repeated failures without an immediately usable schema example. Build67 adds valid single/batch examples in schema descriptions and error feedback.
- exp/log/ln were unavailable in the bounded calculator, causing expensive repeated attempts and discovery of alternate tools. Build67 adds an explicit scientific-function allowlist; assignments, property access and arbitrary code remain rejected.
- A successful calculator receipt was treated as proof that an incomplete weighted formula matched the user request. Build67 strengthens generic formula completeness, coefficient, units and independent-check instructions. This is model guidance, not a formal correctness guarantee; live validation and comparative results are required.
- Original and40k benchmark results remain retained. The latest interruption is user-directed, not a model failure. Revised comparison must be labeled repeated/exposed regression, not a fresh unseen evaluation.

## 2026-11-08 repairs from the stopped specialists run (88/104 attempts)

Evidence: `~/.local/state/codali-specialists-20261107/benchmark/results-v2`. Private gold was not read for this analysis. Original results stay unchanged.

| ID | Issue | Evidence | Repair |
|---|---|---|---|
| CX51 | Compaction erased the investigation. A 40,960 output ceiling inside a 65,536 window left 24k for input, and folding replaced every old marker with one bare hash. | specialist-45: 643 compactions down to ~7 messages/11k chars; same EUR-Lex URL opened 96 times over 8h07m. | Output reservation capped at 30% of the window with generation clamped to what fits. Folding keeps the newest 8 markers and a readable inventory. |
| CX52 | Nothing stopped an investigation that had quit learning, because budgets are deliberately huge. | specialist-41/43/45: 88/134/540 model requests, no answer. | `InspectionConvergence`: finalize after 8 rounds with no new evidence or at 20/48/96 rounds by effort. |
| CX53 | Retained evidence never reached the model after compaction. | `researchEvidence` was used only by the final audit. | A bounded evidence digest accompanies requests from step 4 on. |
| CX54 | Schemas were withheld while their use was still invited, so Qwen printed the call as text. | specialist-41 lacked `context_read` while markers told it to use it; specialist-44 lacked `browser_read`. | `browser_read` follows `browser_open`; `context_read` is exposed once an archive exists. |
| CX55 | Printed tool markup or a late tool call failed runs that had already paid for evidence. | specialist-41: 1.52M tokens, specialist-44: 469k tokens, no answer. | Corrected, then finished as a plain-text answer. Printed text is still never executed. |
| CX56 | Capacity refusals failed attempts after 2 retries over ~2.5s and were charged as usage. | 16 failures, 11 of them raw-arm, some charged ~42k tokens for zero inference. | Backoff up to 30 minutes, bounded by the deadline; explicit refusals are refunded. |
| CX57 | The raw arm had no capacity retry at all, so 409s scored as raw failures. | raw specialist-04/11/23/24/30/31/32 failed on contention. | Raw shares the same wait and refund. This inflated Codali's lead in the stopped run. |
| CX58 | Only four browser snapshots stayed readable, and reopening a URL relaunched Chrome. | 16-26 "snapshot unavailable" errors per research run. | 48 snapshots with LRU and a size cap, reuse of captured URLs, short `snap-N` ids, and an error listing readable snapshots. One retry on `ERR_NETWORK_CHANGED`. |

Not repaired: quantitative overhead (about 4 model calls and 12k tokens against raw's 2 and 3.5k) remains, as the equation review is what those calls buy. Research accuracy and complete app delivery are unproven until the rerun is graded.
