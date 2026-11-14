# Repair68 observed Codali issues

Evidence: finalized repair68 artifacts. This is a remediation inventory, not a claim that model reasoning defects have been eliminated. The after arm is the latest candidate; before-arm defects remain in archived review notes.

## Runtime and delivery failures

- Execution handoff removed by inspection finalization: authorized app build returned a read-only summary. Patch under test.
- Repeated preparation counted across real file changes: app halted after repeated prepare_edit. Progress reset patch under test; recovery still needs validation.
- Completed native write arguments survived context compression. Shared provider patch under test.
- Research audit reservation can consume most of the question budget before sources are recovered. Pending.
- Partial app lacked runnable entrypoints, build/test scripts, UI and delivery artifacts; module exports and SQL schema disagreed with tests. Pending generic build contract verification.
- Source retrieval sometimes returned unrelated pages or only document front matter; unsupported section citations remained. Pending recovery/evidence validation.

## Per-request semantic and feature findings

### unseen-31 — 90%

- 20 points — Atomic capacity reservation before charge prevents oversell including concurrent requests: Seat allocation is transactional before charge (§1,TX1).
- 10 points — Stable payment identity plus payload fingerprint and durable state prevents duplicate logical charges: Stable command keys and amount mismatch quarantine exist, but no explicit durable request-payload fingerprint/reuse-conflict policy.
- 20 points — Unknown outcomes reconciled by lookup/webhooks; no automatic blind fresh-key retry: Unknown outcomes use same-key lookup/reconciliation.
- 20 points — Compensation/refunds and expiry race are explicit; no impossible cross-system atomic guarantee: Expiry ownership guard and orphan-charge refund are explicit.
- 20 points — Crash injection/duplicate/reordered callbacks/concurrency tests verify invariants and reconciliation: Crash matrix, concurrent reservations and reordered webhook tests specified.

### unseen-32 — 80%

- 20 points — Identifies backup wrapped-key recoverability with surviving shared root: Identifies wrapped DEK recoverability from90day backups.
- 20 points — Per-tenant irreversible revocation/key destruction or honest delayed deletion guarantee: Separate non-backed-up tenant shred secret breaks root-key decryption path.
- 10 points — Enumerates cached plaintext/keys, replicas, exports and recovery copies without false guarantees: Quorum cache acknowledgement does not establish deletion from every plaintext/key cache; claims conflict with unreachable-cache discussion.
- 20 points — Restore applies durable deletion tombstones and does not resurrect tenant access; legal holds handled before delete: Durable shred ledger and pre-deletion legal-hold gate specified.
- 10 points — Verifiable drills include old backup restore/key unavailable and other tenant intact; threat assumptions explicit: Restore/other-tenant tests included, but declares failing quorum tests mere harness bugs and promises corrected success without evidence.

### unseen-33 — 70%

- 20 points — Base revision or per-field base values distinguish independent from conflicting edits: Base/server/incoming comparison defined.
- 20 points — Result preserves B assignee while A status conflicts with escalated: Worked trace retains Bo and escalated with manual status conflict.
- 10 points — Atomic compare-and-set/version increment prevents races during resolution: Revision check then increment is stated without atomic CAS implementation.
- 10 points — Stable operation IDs and tombstones handle retries and deletion versus update: Deletion pseudocode accepts unchanged deletion flag before checking concurrent field edits, contradicting claimed conflict invariant.
- 10 points — Tests cover offline reorder, duplicate upload, stale resolution and visible conflict UI: Relevant tests listed, but unresolved model failures and contradictory deletion fix prevent complete validation credit.

### unseen-34 — 80%

- 10 points — Stable unique event identity with durable dedup and explicit conflict policy: Stable event identity/dedup present; conflicting payload for same identity is not explicitly handled.
- 20 points — Event time versus ingestion time and late correction window correctly separated: Event-time watermark versus arrival and late correction path explicit.
- 20 points — Deterministic recompute/upsert aggregates avoiding double count: Full partition recompute and atomic publication.
- 20 points — Deletion tombstones/exclusion propagate to raw data/backups/replay with retention limits honestly stated: Deletion ledger gates ingestion/rebuild/restore and tombstone GC waits for purge.
- 10 points — Tests combine duplicate/out-of-order data, late corrections, erase then replay and tenant isolation: Duplicate/late/erase tests present; tenant-isolation and payload-conflict coverage incomplete.

### unseen-35 — 100%

- 20 points — Shows stale worker resuming after replacement can otherwise overwrite data: Paused-worker stale write trace explicit.
- 20 points — Monotonic fencing token atomically issued for lease acquisition: Atomic DB-issued increasing fencing generation.
- 20 points — Target storage atomically rejects stale token on every protected write: Protected DB writes require current fence.
- 20 points — Renewal/expiry use authoritative time and ownership checks; partition tradeoff not unsafe split brain: DB-time expiry, ownership renewal and strong coordination.
- 20 points — Pause/resume, stale renewal and concurrent-acquire tests plus irreversible external side-effect limitation: Pause/renew/acquire tests and external effect assumptions explicit.

### unseen-36 — 50%

- 10 points — Expand/backfill/switch/contract sequence preserves old/new overlap: Expand/contract phases present but old/new overlap inconsistent.
- 20 points — USD default historical mapping and exact numeric semantics explicit: USD-only exact integer projection through rollback window.
- 0 points — Atomic dual-write or equivalent single authoritative representation avoids divergence: Untouched old binaries write only cents; asynchronous reconciliation cannot meet no-divergence guarantee.
- 10 points — Chunked resumable backfill with concurrent write reconciliation and verification: NULL-only backfill fails to track subsequent old-writer changes to non-NULL rows.
- 10 points — Rollback retains old compatible fields/writes until window closes; staged tests and metrics: Rollback window retained but stale compatibility representation undermines correctness.

### unseen-37 — 90%

- 20 points — Retrieved text explicitly untrusted data, not higher-priority instructions: Quoted ticket imperative is data, not authority.
- 20 points — Tool capability/argument checks outside model prevent exfiltration and unauthorized refund: Restricted egress and token-enforcing refund API.
- 20 points — Summary can use factual content without obeying embedded commands: Complaint summary remains allowed.
- 20 points — Refund needs explicit scoped authorization tied to actual user intent and validated target: Explicit user refund request plus supervisor approval token.
- 10 points — Adversarial tests cover tool-output injection, hidden markup, benign quotes and legitimate allowed flow: Partial failing test evidence and egress integration still untested.

### unseen-38 — 90%

- 20 points — Equivalent keyboard/button movement and understandable names/states: Keyboard move mechanism and named states.
- 20 points — Stable focus after updates/moves, no unsolicited focus theft, accessible dialog return: Rejects focus stealing and specifies user-controlled focus.
- 20 points — Bounded appropriate live regions with urgent versus routine announcement policy: Urgency-sensitive announcements with limits.
- 10 points — Responsive semantic layout, readable contrast and non-color status cues: Responsive/non-color design present, but aria-pressed on article container and menu semantics are not consistently valid.
- 20 points — Concrete keyboard/screenreader/mobile/reduced-motion tests and usable error/empty/loading states: Assistive-tech, reduced-motion and error-state testing specified.

### unseen-39 — 80%

- 10 points — Reject absolute/traversal/encoded ambiguity paths and enforce containment at actual filesystem access: Structural checks present, but realpath then write leaves filesystem access race unaddressed.
- 10 points — Reject symlink/hardlink/device entries and race-safe extraction in isolated staging: Rejects link/device entries, but relies on earlier checks rather than descriptor-level no-follow creation.
- 20 points — Enforce cumulative expanded bytes and entry count during streaming, not just headers: Cumulative streaming budgets and entry caps.
- 20 points — Deterministic duplicate/collision policy and atomic publish only after validation: Case/Unicode collision policy and publish after complete extraction.
- 20 points — Tests include zip bomb, symlink traversal, duplicate/case collision, interrupted cleanup and no partial index: Bomb/traversal/collision/cleanup test plan included; honestly states no successful test run.

### unseen-40 — 80%

- 10 points — Rejects certain root-cause claim; connection contention/shared downstream bottleneck plausible: Labels DB hypothesis, but treats raising capacity as definitive falsification and predicts4–8x p99 without evidence.
- 20 points — Measures service time/queue wait/pools/locks/downstream latency and resource saturation: Measures pool waits, DB and downstream stages.
- 20 points — Controlled concurrency sweep with fixed workload, warmup, percentiles and error rates: Controlled concurrency/load experiments specified.
- 10 points — Backpressure/bounded queues and pool sizing before uncontrolled worker multiplication: Pool sizing considered; bounded queues/backpressure not explicit.
- 20 points — Rollback thresholds, reproducible load and correctness checks; no invented measurements: Correctness checks and go/no-go stages specified; no claimed measured new results.

### unseen-41 — 80%

- 20 points — Must-revalidate forbids stale reuse despite client max-stale: Correct directive behavior and 504; required normative passages not retrieved.

### unseen-42 — 80%

- 20 points — Rejects signature-only authorization and cross-audience substitution: Rejects signature-only validation with audience, issuer, algorithm and purpose binding; RFC front matter only.

### unseen-43 — 50%

- 10 points — Public client refresh tokens require sender constraint or rotation: Rotation/reuse described, but sender constraint framed as recommendation and revocation conditional on confirmed compromise; overview instead of normative RFC.

### unseen-44 — 50%

- 10 points — Crash trace causes duplicate external charge on replay; commit-before-charge risks loss: Explains charge-before-offset duplicate, Kafka transaction scope and external idempotency; omits commit-first loss and read_committed; no requested Apache primary evidence.

### unseen-45 — 80%

- 20 points — Zero-RTT can be replayed; encryption/authentication not sufficient: Correct core replay/PSK/deployment conclusions; nonexistent 9.2.3 reference and no primary source.

### unseen-46 — 90%

- 20 points — AA minimum target24x24 with exceptions,44x44 relates to enhanced criterion: Correct AA/AAA, drag, keyboard and focus principles; inline exception covered but only secondary pages retrieved.

### unseen-47 — 70%

- 20 points — Reject second stale different edit, normally412; do not overwrite: Correct reject/strong/exception; no atomic implementation and does not explicitly ignore date condition when If-Match exists. Wrong section references and no normative passage.

### unseen-48 — 90%

- 20 points — Population variation statistic, not fraction of individual trait: Correct population and environment interpretation; SEP opening passage provides partial population framing, not requested detailed evidence.

### unseen-49 — 80%

- 20 points — Axial tilt changes sunlight angle/daylength as principal seasonal mechanism: Mechanism, opposite hemispheres, dates and distance nuance correct; only Spaceweather retrieved, not NASA plus second institutional source.

### unseen-50 — 90%

- 20 points — Confirms1.09 and assessed range0.95-1.20 relative1850-1900 for2011-2020: Correct range/baseline, scale and event attribution; honest retrieval failure but no IPCC primary evidence.

### unseen-51 — 16%


### unseen-52 — 4%


## Additional numerical narrative issues

- Case 5: dimensionless error-budget burn confused with elapsed exhaustion time.
- Cases 4, 7, 9: unsupported marginal-cost, ordering and margin claims contradicted the calculations.
- Cases 13 and 15: pooling/correlation/implication explanations reversed direction.
- Case 16: DISTINCT and inner-join semantics misstated.

## Evaluation limitation

Design and prose failures require fresh outcome validation. Adding instructions or tests does not prove all future reasoning errors are fixed. Fresh validation status is recorded in the Repair73 disposition and docs/benchmarks/codali-fresh73/PROGRESS.md.

## Repair73 disposition before fresh holdout

- Authorized build handoff: repaired in InspectionBudget/SessionController; initial native start_work exposed, final inspection keeps only that control. Existing permission and durable completion gates retained. Integration tests and live completed module validate the transition.
- False stalled-work detection across real mutations: actual owned-file changes/accepted verification clear prior counters. Unchanged loops remain guarded.
- Large completed native arguments: atomic call/result archival in ContextCompression preserves recoverable full records and all user/system instructions. Regression passes; raw receives this shared transport repair too.
- Research starvation: optional second synthesis no longer reserves two maximum output responses before first retrieval. Admission still meters actual calls and shared limits.
- Long primary-source truncation: browser snapshots/search offsets increased100k→1M, excerpts remain<=3800 serialized chars; plaintext section body preferred over TOC. Real Chrome tail-retrieval test passed.
- Numeric dimensional contradictions: generic invariant guidance alone failed a live regression; separately metered equation review corrected it. This is a mitigation requiring fresh validation, not proof of universal accuracy.
- Design/concurrency/security omissions and unsupported prose: generic final invariant review is retained through budget finalization. Fresh semantic grading is required; these reasoning failures are not declared eliminated merely because instructions changed.
- Partial app deliverables: handoff/progress/context repairs remove observed runtime blockers; existing real-entrypoint/verification/completion requirements retained. Independent module probe passed, but complete-app improvement remains unqualified until the fresh TenderDesk/StudyBoard builds finish.
- New development finding: work_claim rejected identical planned scope. Repeated identical scope is now accepted without changing plan or authority; targeted test passes.
- External search infrastructure remains degraded: configured SearXNG has suspended/rate-limited engines and weak unrelated results. Direct primary-source browsing works. No claim that Codali code repairs eliminate upstream provider failures.

Validation: package suite2124passed/0failed/10skipped; subsequent relevant139passed/0failed/0skipped including real Chrome. Separate reference implementation passed all50 private code grading checks. Frozen fresh52×3-arm study started2026-11-07T11:53:08Z; results pending.
