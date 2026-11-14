# Codali issues — five app builds and the earlier50-job benchmark

Audit date: 2026-11-05 UTC. Benchmark attempts: 2026-11-04–05. Historical audit status: **open inventory; no fixes applied by the audit itself**. Active remediation is tracked in [REMEDIATION_STATUS.md](REMEDIATION_STATUS.md); historical evidence below is preserved.

This inventory includes the previous root-cause findings, a fresh pass through every event log and result receipt, all ten reviews, all47 original issue records and additional review findings. It is exhaustive for the recorded failed-tool receipts and imported issue records, not a claim that every latent defect has been found. Generated-app defects and raw-only failures are deliberately separated from Codali orchestration defects.

## Outcome and interpretation

Codali averaged4.9/100; raw Qwen with tools17.1/100. Neither delivered a complete runnable app. Codali lost web/game/Android, tied desktop and slightly won iOS. These are delivery-quality scores, not calibrated intelligence percentages. Reported tokens were1.29× and observed attempt time1.88× raw; service usage gaps and shared-host timing prevent exact end-to-end cost/speed claims.

The evidence supports a combination of requirement loss, write-policy friction, ineffective recovery and absent incremental integration. It does not establish the causal contribution of each mechanism. More tooling or tokens alone is not a demonstrated fix.

## How to use this backlog

- COD IDs cover orchestration, tools, shared infrastructure and evaluation gaps. Scope identifies responsibility; raw-only/shared failures must not be attributed solely to Codali.
- APP IDs preserve the47 original issue records; APP-X IDs add findings present in narrative reviews but missing from the original short lists. Some overlap is intentional for traceability; counts are backlog entries, not independent root causes.
- P0: foundational requirement/execution failure; P1: serious correctness/recovery/delivery issue; P2: portability, telemetry or evaluation improvement. These are remediation priorities, not CVSS security scores.
- All entries are OPEN. “Confirmed” describes an observed occurrence, not proven causality. Static findings need targeted reproduction before claiming exploitability.
- Each entry includes evidence and a closure check. Do not close a broad system issue merely by repairing one generated app.

## Review coverage

| Build | Codali score | Raw score | Codali failed/receipts | Raw failed/receipts |
|---|---:|---:|---:|---:|
| app-01-web | 14.5 | 36 | 25/104 | 8/50 |
| app-02-desktop | 1.5 | 1.5 | 52/112 | 7/35 |
| app-03-ios | 7 | 4.5 | 25/123 | 23/59 |
| app-04-ios-game | 0 | 23 | 29/111 | 7/47 |
| app-05-android | 1.5 | 20.5 | 23/73 | 8/43 |

Read 8,360 JSONL events across10 logs; reconciled777 tool receipts and207 failures against the saved tool-analysis files. Codali:154/523. Raw:53/234. Raw adapters encode failure as ok=false; Codali uses status=failed. Both schemas were handled.

[Complete failed-receipt evidence appendix](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/CODALI_ISSUES_LOG_EVIDENCE.md); [original report](/home/wodo/apps/codali-appbuild-results/2026-11-04/REPORT.md); [all600 rubric judgments](/home/wodo/apps/codali-appbuild-results/2026-11-04/criteria.csv).

## Remediation order

1. Preserve immutable requirements and correct repository binding (COD-001–003,015).
2. Make dependency/bootstrap paths work under scoped protection (COD-004–014).
3. Recover from stalls, bad calls, service failures and budget/context stops without losing work (COD-017–021,026–028).
4. Establish a runnable app early; compile, test and verify UI continuously (COD-022–025 and APP defects).
5. Improve accounting/portability and run fresh comparisons after isolated regressions pass (COD-029–031).


## Earlier50-job audit — comparison correction and findings

**The earlier run used raw_direct, not raw Qwen with tools.** All100original attempt logs/results were rechecked. Audited semantic accuracy tied at97.6%; the frozen strict scores were89.6%Codali versus92.0%raw. Codali used6.268×tokens and2.468×time. Its two audited losses were SLO fractional-minute precision and Unicode sorting; it won three other jobs and tied45. The problem demonstrated here is substantially worse efficiency without aggregate accuracy gain.

The inventory now has **115open entries**: the original99 plus16industry50entries. These are traceable backlog items and controls, not115independent root causes. Existing COD-018/029/031 are extended by references below rather than silently replaced.

Fresh log analysis: intent classification alone used50calls/75973tokens (32.36%of Codali tokens); eight formatting repairs used6892tokens. A formatting-only repair changed industry35held_ids even though it was only supposed to strip fences. Numerical validation/tool selection failed on industry02and11, and explicit sorting failed on30. No provider errors or Docdex calls occurred in this run.

[Detailed100-attempt evidence and50paired rows](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/CODALI_ISSUES_INDUSTRY50_EVIDENCE.md); [reconciled usage, repair diffs and fingerprints](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/codali-industry50-issues-audit.json).

## Issue index

| ID | Priority | Scope | Issue |
|---|---|---|---|
| COD-001 | P0 | Codali / game | [Original requirements omitted from execution handoff](#cod-001) |
| COD-002 | P0 | Codali / game | [Immutable RFP overwrite admitted](#cod-002) |
| COD-003 | P0 | Codali / game | [False provenance and unrelated task drift](#cod-003) |
| COD-004 | P0 | Codali / desktop, web, Android | [Task-scope recovery repeatedly blocks implementation](#cod-004) |
| COD-005 | P1 | Codali / multiple | [Plan/requirement lifecycle is difficult for the model to repair](#cod-005) |
| COD-006 | P1 | Codali / web, Android | [Read-only shell discovery requires a work claim](#cod-006) |
| COD-007 | P0 | Codali / Android | [Dependency archives exceed task-preimage limits](#cod-007) |
| COD-008 | P0 | Codali / desktop | [Normal esbuild hard link terminates desktop attempt](#cod-008) |
| COD-009 | P1 | Codali / web | [Dependency files trigger source fresh-read requirements](#cod-009) |
| COD-010 | P1 | Codali / web, desktop, game, Android; shared sandbox also affects raw | [Write mounts and missing directories make bootstrap fragile](#cod-010) |
| COD-011 | P1 | Shared shell layer; Codali and raw | [Command policy rejects development/discovery tools](#cod-011) |
| COD-012 | P1 | Shared shell layer; particularly raw iOS | [Destructive-operation detection has false positives](#cod-012) |
| COD-013 | P1 | Shared sandbox / iOS, desktop, Android | [Advertised/expected sandbox tools are missing](#cod-013) |
| COD-014 | P1 | Both arms / multiple | [Temporary paths and working directories are not used reliably](#cod-014) |
| COD-015 | P0 | Codali / web, desktop, iOS app, Android | [System Docdex repository binding fails in four Codali builds](#cod-015) |
| COD-016 | P1 | Raw baseline adapter / all five | [Raw adapter uses unsupported managed Docdex startup argument](#cod-016) |
| COD-017 | P1 | Codali / iOS app and game | [Stall detection warns but does not restore progress](#cod-017) |
| COD-018 | P1 | Codali / all five | [Model context/call cost grows without sufficient implementation](#cod-018) |
| COD-019 | P1 | Codali / web, iOS app, game; benchmark-imposed ceiling | [Budget exit and verification reserve do not yield useful handoff](#cod-019) |
| COD-020 | P1 | Raw baseline / game, Android | [Context ceiling stops raw long builds without successful compaction](#cod-020) |
| COD-021 | P1 | Codali Android; raw web/desktop | [Provider errors terminate delivery](#cod-021) |
| COD-022 | P0 | Both arms / all five pairs | [No early runnable application milestone survives](#cod-022) |
| COD-023 | P1 | Generated code / Codali web and iOS; raw also affected | [Cross-file API/schema contracts drift](#cod-023) |
| COD-024 | P1 | Both arms / all five pairs | [No meaningful delivered tests or final delivery documentation](#cod-024) |
| COD-025 | P1 | Both arms / all five pairs | [No usable UI or interaction validation](#cod-025) |
| COD-026 | P1 | Both arms / Android, iOS, game | [Invalid tool arguments and shell/source syntax waste calls](#cod-026) |
| COD-027 | P2 | Both arms / multiple | [Missing files are repeatedly assumed to exist](#cod-027) |
| COD-028 | P2 | Both arms / native jobs | [Platform/toolchain setup consumes substantial work](#cod-028) |
| COD-029 | P2 | Benchmark/reporting / both arms | [Cost/receipt accounting needs clearer semantics](#cod-029) |
| COD-030 | P2 | Raw game; Codali desktop | [Vendor snapshots and absolute configuration reduce portability](#cod-030) |
| COD-031 | P2 | Evaluation / both arms | [Benchmark isolation/setup limits causal conclusions](#cod-031) |
| APP-001 | P1 | app-01-web-codali_candidate | [Server absent; frontend, tests and delivery documentation also absent.](#app-001) |
| APP-002 | P1 | app-01-web-codali_candidate | [npm ci fails because dependency lock and manifest differ.](#app-002) |
| APP-003 | P1 | app-01-web-codali_candidate | [Imports openDb/tx that db module does not export; schema expectations also differ.](#app-003) |
| APP-004 | P1 | app-01-web-codali_candidate | [Imports nonexistent STATUSES export.](#app-004) |
| APP-005 | P1 | app-01-web-codali_candidate | [Ticket creation mismatches actual migration columns; SLA value mislabeled as seconds.](#app-005) |
| APP-006 | P1 | app-01-web-codali_candidate | [P2/P3 SLA durations are60times too small and disagree with ticket helper.](#app-006) |
| APP-007 | P1 | app-01-web-raw_tools | [Startup import resolves to absent server/scripts/seed-data.mjs](#app-007) |
| APP-008 | P1 | app-01-web-raw_tools | [Requester can comment on another requester ticket](#app-008) |
| APP-009 | P1 | app-01-web-raw_tools | [Requester can upload to another requester ticket](#app-009) |
| APP-010 | P1 | app-01-web-raw_tools | [Disabled owners count toward last-owner protection; zero active owners possible](#app-010) |
| APP-011 | P2 | app-01-web-raw_tools | [Text spoofed as PNG is accepted](#app-011) |
| APP-012 | P2 | app-01-web-raw_tools | [Deletes database after import opened it,causing disk I/O error](#app-012) |
| APP-013 | P1 | app-02-desktop-codali_candidate | [No application source, entry point, renderer, IPC/preload code, tests or distributable.](#app-013) |
| APP-014 | P1 | app-02-desktop-codali_candidate | [Build/package fail missing Electron entrypoint; dev exits without launching an application.](#app-014) |
| APP-015 | P1 | app-02-desktop-codali_candidate | [Attempt ends on hard-linked writable esbuild binary guard after repeated scope/claim failures.](#app-015) |
| APP-016 | P1 | app-02-desktop-raw_tools | [Only npm package/lock beyond inputs; no app source, entrypoint, tests or documentation.](#app-016) |
| APP-017 | P1 | app-02-desktop-raw_tools | [Build/dev/package scripts absent and default npm test fails.](#app-017) |
| APP-018 | P1 | app-02-desktop-raw_tools | [Generation stops on provider HTTP502 invalid_response; failed-request token usage unknown.](#app-018) |
| APP-019 | P1 | app-03-ios-codali_candidate | [Money typecheck fails: missing rounded API/extension](#app-019) |
| APP-020 | P1 | app-03-ios-codali_candidate | [Conditional binding of nonoptional String fails](#app-020) |
| APP-021 | P1 | app-03-ios-codali_candidate | [Invalid custom totals silently rewritten](#app-021) |
| APP-022 | P1 | app-03-ios-codali_candidate | [Fixed shares above total can create negative equal share](#app-022) |
| APP-023 | P1 | app-03-ios-codali_candidate | [Wrapping integer addition can silently overflow](#app-023) |
| APP-024 | P1 | app-03-ios-codali_candidate | [Duplicates Models/ExpenseMath.swift and uses incompatible model APIs](#app-024) |
| APP-025 | P1 | app-03-ios-raw_tools | [Missing MoneyRounding type prevents compilation.](#app-025) |
| APP-026 | P1 | app-03-ios-raw_tools | [Int32 exponent incompatible with Foundation Int16 parameter; also line58.](#app-026) |
| APP-027 | P1 | app-03-ios-raw_tools | [Release-disabled currency assert and wrapping arithmetic can silently produce invalid amounts; static finding.](#app-027) |
| APP-028 | P1 | app-03-ios-raw_tools | [No app project, entry point, screens, persistence, tests or delivery documentation.](#app-028) |
| APP-029 | P1 | app-04-ios-game-codali_candidate | [Overwrites immutable original requirements with different game and false missing-file claim, contradicted by prior reads/listing.](#app-029) |
| APP-030 | P1 | app-04-ios-game-codali_candidate | [No game/app/project/Swift source/tests/delivery artifacts.](#app-030) |
| APP-031 | P1 | app-04-ios-game-codali_candidate | [Unrelated placeholder, not executable implementation.](#app-031) |
| APP-032 | P1 | app-04-ios-game-raw_tools | [Duplicate StageLibrary also declared in Stage.swift:303 prevents package build.](#app-032) |
| APP-033 | P1 | app-04-ios-game-raw_tools | [Missing to: argument label prevents engine compilation.](#app-033) |
| APP-034 | P1 | app-04-ios-game-raw_tools | [Player created without initial energy, defaulting to0.](#app-034) |
| APP-035 | P1 | app-04-ios-game-raw_tools | [Normal retained dead enemy at health -1 rejected on reload; duplicate player/core and invalid won/next-ID states accepted.](#app-035) |
| APP-036 | P1 | app-04-ios-game-raw_tools | [Stage3 map has unreachable core/enemies; BFS receipt retained.](#app-036) |
| APP-037 | P1 | app-04-ios-game-raw_tools | [Persistence failures swallowed; stage start bypasses unlock check.](#app-037) |
| APP-038 | P1 | app-04-ios-game-raw_tools | [No iOS app/rendering/project source delivered.](#app-038) |
| APP-039 | P1 | app-05-android-codali_candidate | [Missing manifest stops independent Gradle build; all application source/resources/screens/tests also absent.](#app-039) |
| APP-040 | P1 | app-05-android-codali_candidate | [No wrapper/bootstrap or delivery documentation supplied.](#app-040) |
| APP-041 | P1 | app-05-android-codali_candidate | [Task-preimage limits block downloaded dependency-cache writes; repeated scope failures consume generation operations.](#app-041) |
| APP-042 | P1 | app-05-android-codali_candidate | [Provider HTTP429 rate_limited terminates original attempt.](#app-042) |
| APP-043 | P1 | app-05-android-raw_tools | [Missing AndroidX enablement stops actual Gradle build.](#app-043) |
| APP-044 | P1 | app-05-android-raw_tools | [Invalid enum interpolation confirmed by Kotlin compiler.](#app-044) |
| APP-045 | P1 | app-05-android-raw_tools | [References missing application/activity and resources; no UI/source classes delivered.](#app-045) |
| APP-046 | P1 | app-05-android-raw_tools | [Missing DAO methods, missing evidence cleanup method, missing combine import and invalid Flow.first usage; static integration failures.](#app-046) |
| APP-047 | P1 | app-05-android-raw_tools | [Submission/outbox not atomic; imported templates and evidence references/ownership not validated.](#app-047) |
| APP-X01 | P1 | app-01-web-codali_candidate | [Web domain writes lack transaction boundaries](#app-x01) |
| APP-X02 | P1 | app-01-web-codali_candidate | [Web authorization helpers are not wired to endpoints](#app-x02) |
| APP-X03 | P1 | app-01-web-codali_candidate | [Web schema mismatch extends beyond ticket columns](#app-x03) |
| APP-X04 | P1 | app-02-desktop-codali_candidate | [Desktop typecheck references missing configuration](#app-x04) |
| APP-X05 | P1 | app-03-ios-codali_candidate | [iOS required domain fields are absent](#app-x05) |
| APP-X06 | P1 | app-03-ios-codali_candidate | [iOS currency catalog and accepted currencies disagree](#app-x06) |
| APP-X07 | P1 | app-03-ios-codali_candidate | [iOS financial serialization silently discards errors](#app-x07) |
| APP-X08 | P1 | app-03-ios-codali_candidate | [iOS decoding bypasses parse caps and parsing is inconsistent](#app-x08) |
| APP-X09 | P1 | app-03-ios-codali_candidate | [iOS references absent services and incompatible conversion signature](#app-x09) |
| APP-X10 | P1 | app-01-web-raw_tools | [Raw web frontend/build/test/delivery files incomplete](#app-x10) |
| APP-X11 | P1 | app-03-ios-raw_tools | [Raw iOS minimum-integer abs/negation can trap](#app-x11) |
| APP-X12 | P1 | app-04-ios-game-raw_tools | [Raw game documented tie-break branch is unreachable](#app-x12) |
| APP-X13 | P1 | app-04-ios-game-raw_tools | [Raw game win message can disagree with final score](#app-x13) |
| APP-X14 | P1 | app-05-android-raw_tools | [Raw Android required photo accepts nonexistent evidence](#app-x14) |
| APP-X15 | P1 | app-05-android-raw_tools | [Raw Android numeric model and validator disagree](#app-x15) |
| APP-X16 | P1 | app-05-android-raw_tools | [Raw Android evidence paths lack confinement checks](#app-x16) |
| APP-X17 | P1 | app-05-android-raw_tools | [Raw Android corrupt values are silently defaulted](#app-x17) |
| APP-X18 | P1 | app-05-android-raw_tools | [Raw Android fake-server idempotency state is volatile](#app-x18) |
| APP-X19 | P1 | app-05-android-raw_tools | [Raw Android demo photos are not complete encoded images](#app-x19) |
| APP-X20 | P1 | app-05-android-raw_tools | [Raw Android serializer calls are invalid](#app-x20) |
| APP-X21 | P1 | app-05-android-raw_tools | [Raw Android source comments overstate delivered checks](#app-x21) |
| IND-001 | P1 | Industry50 | [Earlier50-job comparator was raw inference, not raw with tools](#ind-001) |
| IND-002 | P1 | Industry50 | [Intent classification uses the answer-model alias and dominates avoidable overhead](#ind-002) |
| IND-003 | P1 | Industry50 | [Tool selection omits verification on a financial calculation that fails](#ind-003) |
| IND-004 | P1 | Industry50 | [Partial calculator use leaves the difficult arithmetic unverified](#ind-004) |
| IND-005 | P1 | Industry50 | [Explicit Unicode sorting is ignored](#ind-005) |
| IND-006 | P1 | Industry50 | [Output validation passes structurally valid but wrong answers](#ind-006) |
| IND-007 | P2 | Industry50 | [Eight model calls repair only JSON presentation](#ind-007) |
| IND-008 | P1 | Industry50 | [Presentation-only repair changes semantic data](#ind-008) |
| IND-009 | P2 | Industry50 | [Calendar request sent to an arithmetic-only calculator](#ind-009) |
| IND-010 | P2 | Industry50 | [Financial calculator exposes binary floating-point intermediates](#ind-010) |
| IND-011 | P2 | Industry50 | [File-inspection path is expensive without measured accuracy gain](#ind-011) |
| IND-012 | P2 | Industry50 | [Industry50 provides no evidence of Docdex benefit](#ind-012) |
| IND-013 | P2 | Industry50 | [Underspecified answer schemas inflated the apparent strict-score gap](#ind-013) |
| IND-014 | P2 | Industry50 | [Equal-weight near-ceiling scoring hides error severity and generalization limits](#ind-014) |
| IND-015 | P2 | Industry50 | [Completed=false is ambiguous for successful answer-only interactions](#ind-015) |
| IND-016 | P2 | Industry50 | [Raw-only errors and Codali wins must remain visible](#ind-016) |

<a id="cod-001"></a>
## COD-001 — Original requirements omitted from execution handoff

**OPEN · P0 · Codali / game**

Evidence status: Observed context gap; causality not isolated.

The original RFP read succeeded, but an execution request before the overwrite omitted that read. A retained listing still showed RFP.md; omission alone does not explain the model contradiction.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/REVIEW.md); [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/protocol/codali-game-rfp-rewrite-evidence.json).

Closure check: Pin the immutable original goal and acceptance criteria across planning, execution, retry and compaction; test exact preservation.

<a id="cod-002"></a>
## COD-002 — Immutable RFP overwrite admitted

**OPEN · P0 · Codali / game**

Evidence status: Confirmed.

write_file replaced the supplied tactical-game RFP with an ignite/burn puzzle specification despite the explicit no-rewrite instruction.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:146).

Closure check: Reject edits to user-designated immutable inputs through every write mechanism; preserve their hashes.

<a id="cod-003"></a>
## COD-003 — False provenance and unrelated task drift

**OPEN · P0 · Codali / game**

Evidence status: Confirmed output; origin of unrelated task unknown.

The model claimed the original RFP was absent despite successful read/list receipts, then pursued dashboard harvesting and wrote placeholder files instead of a game. This is not evidence of cross-repository memory leakage.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/REVIEW.md).

Closure check: Check task actions against the original goal; contradictions trigger re-reading authoritative inputs, not inventing replacements.

<a id="cod-004"></a>
## COD-004 — Task-scope recovery repeatedly blocks implementation

**OPEN · P0 · Codali / desktop, web, Android**

Evidence status: Confirmed rejection pattern; some individual rejections are valid.

Desktop has 11 write_file and 12 run_shell receipts explicitly outside the claimed scope. Repeated plan/claim/release negotiation did not produce application source.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:247); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:284).

Closure check: Provide a deterministic scope-adjustment/recovery path while preserving ownership and authorization; a scaffold can create its declared source tree.

<a id="cod-005"></a>
## COD-005 — Plan/requirement lifecycle is difficult for the model to repair

**OPEN · P1 · Codali / multiple**

Evidence status: Confirmed.

Cannot replace R1, uncovered R1, active-attempt plan replacement, stale release and inline-scope restrictions recur. Errors expose state-machine procedures without reliable recovery.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:722); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:509).

Closure check: Exercise refine→release→replan→claim sequences with invalid/stale inputs and demonstrate recovery without losing requirements.

<a id="cod-006"></a>
## COD-006 — Read-only shell discovery requires a work claim

**OPEN · P1 · Codali / web, Android**

Evidence status: Confirmed policy behavior; usability defect candidate.

The receipt explicitly requires work_claim even for read-only shell checks, creating task-administration overhead before environment discovery.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:80).

Closure check: Allow bounded read-only discovery under appropriate authorization without opening an implementation claim, or make claiming transparent and reliable.

<a id="cod-007"></a>
## COD-007 — Dependency archives exceed task-preimage limits

**OPEN · P0 · Codali / Android**

Evidence status: Confirmed.

Gradle setup receives three preimage rejections: 64 MiB ledger or 8 MiB file limit. Dependency/cache bytes are treated like small editable source preimages.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:465).

Closure check: Install Gradle and normal dependency caches in a confined cache lifecycle without capturing entire vendor archives as editable-source preimages.

<a id="cod-008"></a>
## COD-008 — Normal esbuild hard link terminates desktop attempt

**OPEN · P0 · Codali / desktop**

Evidence status: Confirmed terminal failure.

Attempt ends with Hard-linked writable file requires an independent copy for node_modules/@esbuild/linux-x64/bin/esbuild.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/result.json).

Closure check: Safely isolate/copy dependency hard links where necessary; retain protection against writes through aliases outside the workspace.

<a id="cod-009"></a>
## COD-009 — Dependency files trigger source fresh-read requirements

**OPEN · P1 · Codali / web**

Evidence status: Confirmed.

run_shell asks the model to read backend/node_modules/accepts/index.js before editing during dependency work. Source freshness rules and package-manager writes are not distinguished effectively.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:365).

Closure check: Package installs update vendor files within controlled mounts without requiring the model to individually read each dependency.

<a id="cod-010"></a>
## COD-010 — Write mounts and missing directories make bootstrap fragile

**OPEN · P1 · Codali / web, desktop, game, Android; shared sandbox also affects raw**

Evidence status: Confirmed.

Create-directory-first rejections, read-only package-lock writes, inaccessible cwd and cache creation failures recur. Approved source scope alone does not establish a usable install environment.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:366); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/receipts/events.jsonl:673).

Closure check: Bootstrap declared directories/cache/lockfile writes in one predictable operation and report actual writable mounts.

<a id="cod-011"></a>
## COD-011 — Command policy rejects development/discovery tools

**OPEN · P1 · Shared shell layer; Codali and raw**

Evidence status: Confirmed.

Logs reject swift, xcodegen, which, mkdir, curl, wget and other commands. Availability is distinct from permission; rejection does not prove a binary exists.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:183); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:143).

Closure check: Publish accurate permitted/available capabilities and provide safe supported paths for compilers and dependency downloads; do not simply disable policy.

<a id="cod-012"></a>
## COD-012 — Destructive-operation detection has false positives

**OPEN · P1 · Shared shell layer; particularly raw iOS**

Evidence status: Confirmed benign probe rejection; not every rejection is false.

A Swift String(format:) probe is rejected as destructive. Prior source inspection found destructive keyword scanning across argument text. Other rejected commands must be assessed individually.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/receipts/events.jsonl:108); [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md).

Closure check: Parse executable actions separately from quoted source/data; test benign format strings and genuine destructive commands.

<a id="cod-013"></a>
## COD-013 — Advertised/expected sandbox tools are missing

**OPEN · P1 · Shared sandbox / iOS, desktop, Android**

Evidence status: Confirmed environment gap.

bwrap cannot execute rg; raw Android cannot find unzip. Compiler/toolchain probes also discover absent tools.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:1181); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:62).

Closure check: Preflight tool existence inside the actual sandbox and expose reliable alternatives; host availability is insufficient.

<a id="cod-014"></a>
## COD-014 — Temporary paths and working directories are not used reliably

**OPEN · P1 · Both arms / multiple**

Evidence status: Confirmed missing-path symptoms; persistence versus wrong-path cause needs isolation.

Later calls cannot find /tmp/swift, /tmp/gw.zip, /tmp/home/swift-dl or prior temporary working directories; web also constructs backend/backend/src paths.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:56); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:371); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:559).

Closure check: Document and test per-call temporary storage lifetime; use persistent workspace tooling paths and explicit normalized cwd.

<a id="cod-015"></a>
## COD-015 — System Docdex repository binding fails in four Codali builds

**OPEN · P0 · Codali / web, desktop, iOS app, Android**

Evidence status: Confirmed.

Each has docdex_degraded with System Docdex bound a different repository. Game connects successfully. Local file fallback works, but indexed analysis/memory are unavailable in the affected attempts.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:22); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:22).

Closure check: Initialize and verify explicit repository identity per request; exercise concurrent isolated workspaces against the singleton without cross-binding.

<a id="cod-016"></a>
## COD-016 — Raw adapter uses unsupported managed Docdex startup argument

**OPEN · P1 · Raw baseline adapter / all five**

Evidence status: Confirmed; not a Codali-only failure.

18 raw Docdex tool receipts fail on unsupported --workspace-metadata. This is distinct from Codali singleton binding and prevents a healthy retrieval comparison.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/events.jsonl:6); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:6).

Closure check: Use the supported shared-service integration and capability negotiation; verify an actual repository-scoped retrieval in both arms.

<a id="cod-017"></a>
## COD-017 — Stall detection warns but does not restore progress

**OPEN · P1 · Codali / iOS app and game**

Evidence status: Confirmed warning pattern; recovery effectiveness inferred from outcome.

Each attempt emits five progress_stalled events for repeated unchanged reads and still ends incomplete. One iOS progress_resumed event does not establish successful delivery.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:777); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:668).

Closure check: After repeated unchanged failures, trigger a bounded diagnosis/change of approach; measure working artifacts instead of counting calls.

<a id="cod-018"></a>
## COD-018 — Model context/call cost grows without sufficient implementation

**OPEN · P1 · Codali / all five**

Evidence status: Confirmed aggregate cost; waste attribution not fully measured.

Codali makes 422 reported model calls versus 197, with 154/523 failed tool receipts versus 53/234. About 96.5% of Codali reported tokens are input tokens; repeated input is not all waste.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/usage.json); [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/comparison.csv).

Closure check: Track cost by planning/execution/review/retry and retained context; reduce repeated policy/setup loops without dropping requirements.

<a id="cod-019"></a>
## COD-019 — Budget exit and verification reserve do not yield useful handoff

**OPEN · P1 · Codali / web, iOS app, game; benchmark-imposed ceiling**

Evidence status: Confirmed stop under frozen limits; not proof production must be unlimited.

Web/game reject work because remaining budget is reserved for verification, yet no usable final delivery report appears. Frozen common ceilings were intentional; this audit must not retroactively remove them.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/receipts/events.jsonl:1477); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1748).

Closure check: Checkpoint early with truthful completed/missing requirements, resumable tasks and artifact paths; qualify continuation separately under declared budgets.

<a id="cod-020"></a>
## COD-020 — Context ceiling stops raw long builds without successful compaction

**OPEN · P1 · Raw baseline / game, Android**

Evidence status: Confirmed comparator limitation.

Both stop with Context budget exceeded; checkpoint and compact before continuing. These runs do not establish a Codali context-compaction defect.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/receipts/result.json); [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/result.json).

Closure check: For future comparisons, declare baseline context behavior and test lossless compaction/continuation separately from original frozen results.

<a id="cod-021"></a>
## COD-021 — Provider errors terminate delivery

**OPEN · P1 · Codali Android; raw web/desktop**

Evidence status: Confirmed final errors; exhaustion of any internal retry policy not determined.

Codali stops on HTTP429; raw web/desktop on HTTP502. Android preflight explicitly says inferenceDispatched=false. Do not equate that failed preflight with a completed model generation.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:1066); [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/receipts/result.json).

Closure check: Test bounded backoff, Retry-After handling, resumable checkpoints and no duplicate side effects; report persistent outages honestly.

<a id="cod-022"></a>
## COD-022 — No early runnable application milestone survives

**OPEN · P0 · Both arms / all five pairs**

Evidence status: Confirmed absence; workflow cause is an inference.

None delivers a complete runnable app. Missing app entrypoints, screens/projects/build files persist while partial modules or setup consume the attempt.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/REPORT.md).

Closure check: Require a minimal bootable app and build command before broad feature expansion; maintain it with incremental integration tests.

<a id="cod-023"></a>
## COD-023 — Cross-file API/schema contracts drift

**OPEN · P1 · Generated code / Codali web and iOS; raw also affected**

Evidence status: Confirmed source/compiler evidence.

Export/import names, database columns, enum declarations and API optionality disagree. The delivered results show ineffective integration validation, not proof no validation was attempted.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md).

Closure check: Compile/import modules and run migrations plus a vertical feature test after each dependent change.

<a id="cod-024"></a>
## COD-024 — No meaningful delivered tests or final delivery documentation

**OPEN · P1 · Both arms / all five pairs**

Evidence status: Confirmed missing artifacts.

Required README/DELIVERY.md/delivery.json and meaningful app tests are absent. Evaluator tests are independent and do not count as authored deliverables.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/REPORT.md); [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/criteria.csv).

Closure check: Generate and execute behavior tests during implementation; final report must enumerate real commands, artifacts, failures and missing features.

<a id="cod-025"></a>
## COD-025 — No usable UI or interaction validation

**OPEN · P1 · Both arms / all five pairs**

Evidence status: Confirmed absence, not aesthetic judgment.

All UI/UX scores are zero because no usable app UI was delivered. CSS or model files do not demonstrate screens, navigation, accessibility or device behavior.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/REPORT.md).

Closure check: Build a usable screen/navigation flow early and validate with browser/desktop/device tooling when available.

<a id="cod-026"></a>
## COD-026 — Invalid tool arguments and shell/source syntax waste calls

**OPEN · P1 · Both arms / Android, iOS, game**

Evidence status: Confirmed.

Raw logs contain Missing required argument / Invalid argument type; Codali game sends Python text beginning python3 - <<... to Python, producing SyntaxError.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/receipts/events.jsonl:38); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:1710).

Closure check: Validate arguments with actionable typed diagnostics; distinguish shell scripts from interpreter source and retry only corrected calls.

<a id="cod-027"></a>
## COD-027 — Missing files are repeatedly assumed to exist

**OPEN · P2 · Both arms / multiple**

Evidence status: Confirmed symptoms; no proof of fabricated tool success.

Attempts read or execute absent services, scripts and directories. iOS reads ExchangeRateStore/CanonicalInput/ImportIssues that were not delivered; game probes missing harvester scripts.

Evidence: [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/receipts/events.jsonl:606); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/receipts/events.jsonl:995).

Closure check: Use confirmed tool receipts/file inventory as authority and track rejected writes as not created.

<a id="cod-028"></a>
## COD-028 — Platform/toolchain setup consumes substantial work

**OPEN · P2 · Both arms / native jobs**

Evidence status: Observed activity; exact time attribution not measured.

Swift probing/downloads and Gradle bootstrap occupy many calls before useful app source. No Mac/Xcode was available; Linux Swift cannot validate native UI.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/REVIEW.md); [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md); [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/REVIEW.md).

Closure check: Preflight supported platform runners and provide reusable confined toolchains; label native checks unavailable without inventing success.

<a id="cod-029"></a>
## COD-029 — Cost/receipt accounting needs clearer semantics

**OPEN · P2 · Benchmark/reporting / both arms**

Evidence status: Confirmed measurement limitation.

Failed 502 request usage remains unknown; budget reservations differ from confirmed tokens. Charged tool calls differ from receipts. Docdex-owned inference is excluded. Codali Android has64 model_receipt events but63 reported calls and a failed preflight.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/REPORT.md); [log](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/receipts/events.jsonl:1066).

Closure check: Separate dispatched/completed/preflight/reserved usage and external-service usage; do not double-count cumulative usage events.

<a id="cod-030"></a>
## COD-030 — Vendor snapshots and absolute configuration reduce portability

**OPEN · P2 · Raw game; Codali desktop**

Evidence status: Confirmed.

Raw game bundles downloaded Swift under tools plus an absolute host-library symlink; hashing adds133.554seconds. Codali desktop npm cache configuration required evaluator path override.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/REVIEW.md).

Closure check: Keep reproducible toolchain provenance separate from app source; use relocatable cache/config paths and report finalization separately.

<a id="cod-031"></a>
## COD-031 — Benchmark isolation/setup limits causal conclusions

**OPEN · P2 · Evaluation / both arms**

Evidence status: Confirmed limitations, not an app bug.

Five pairs, one attempt each, unblinded review, degraded retrieval, service failures, shared-host timing and no native iOS runner. workspacePreserved=false means contents changed, not that projects were deleted.

Evidence: [evidence](/home/wodo/apps/codali-appbuild-results/2026-11-04/protocol/EVALUATION.md).

Closure check: Fix infrastructure first, rerun fresh held-out jobs with declared protocol and retain original results; avoid intelligence or precise speed claims from this sample.

<a id="app-001"></a>
## APP-001 — Server absent; frontend, tests and delivery documentation also absent.

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `backend/src/server.js`. Server absent; frontend, tests and delivery documentation also absent.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-002"></a>
## APP-002 — npm ci fails because dependency lock and manifest differ.

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `package-lock.json`. npm ci fails because dependency lock and manifest differ.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-003"></a>
## APP-003 — Imports openDb/tx that db module does not export; schema expectations also differ.

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `backend/scripts/seed.js`. Imports openDb/tx that db module does not export; schema expectations also differ.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/source/backend/scripts/seed.js).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-004"></a>
## APP-004 — Imports nonexistent STATUSES export.

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `backend/src/queue.js`. Imports nonexistent STATUSES export.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/source/backend/src/queue.js).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-005"></a>
## APP-005 — Ticket creation mismatches actual migration columns; SLA value mislabeled as seconds.

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `backend/src/tickets.js`. Ticket creation mismatches actual migration columns; SLA value mislabeled as seconds.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/source/backend/src/tickets.js).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-006"></a>
## APP-006 — P2/P3 SLA durations are60times too small and disagree with ticket helper.

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `backend/src/validate.js`. P2/P3 SLA durations are60times too small and disagree with ticket helper.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/source/backend/src/validate.js).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-007"></a>
## APP-007 — Startup import resolves to absent server/scripts/seed-data.mjs

**OPEN · P1 · app-01-web-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `server/src/main.js`. Startup import resolves to absent server/scripts/seed-data.mjs

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/checks/start.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/source/server/src/main.js:5).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-008"></a>
## APP-008 — Requester can comment on another requester ticket

**OPEN · P1 · app-01-web-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `server/src/tickets.js`. Requester can comment on another requester ticket

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/checks/components.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/source/server/src/tickets.js:110).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-009"></a>
## APP-009 — Requester can upload to another requester ticket

**OPEN · P1 · app-01-web-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `server/src/kb.js`. Requester can upload to another requester ticket

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/checks/adversarial.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/source/server/src/kb.js:96).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-010"></a>
## APP-010 — Disabled owners count toward last-owner protection; zero active owners possible

**OPEN · P1 · app-01-web-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `server/src/admin.js`. Disabled owners count toward last-owner protection; zero active owners possible

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/checks/adversarial.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/source/server/src/admin.js:33).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-011"></a>
## APP-011 — Text spoofed as PNG is accepted

**OPEN · P2 · app-01-web-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: medium. Location: `server/src/kb.js`. Text spoofed as PNG is accepted

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/checks/components.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/source/server/src/kb.js:89).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-012"></a>
## APP-012 — Deletes database after import opened it,causing disk I/O error

**OPEN · P2 · app-01-web-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: medium. Location: `scripts/seed.mjs`. Deletes database after import opened it,causing disk I/O error

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/checks/seed.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/source/scripts/seed.mjs:10).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-013"></a>
## APP-013 — No application source, entry point, renderer, IPC/preload code, tests or distributable.

**OPEN · P1 · app-02-desktop-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `.`. No application source, entry point, renderer, IPC/preload code, tests or distributable.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-014"></a>
## APP-014 — Build/package fail missing Electron entrypoint; dev exits without launching an application.

**OPEN · P1 · app-02-desktop-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `package.json`. Build/package fail missing Electron entrypoint; dev exits without launching an application.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/source/package.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-015"></a>
## APP-015 — Attempt ends on hard-linked writable esbuild binary guard after repeated scope/claim failures.

**OPEN · P1 · app-02-desktop-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `receipts/events.jsonl`. Attempt ends on hard-linked writable esbuild binary guard after repeated scope/claim failures.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-016"></a>
## APP-016 — Only npm package/lock beyond inputs; no app source, entrypoint, tests or documentation.

**OPEN · P1 · app-02-desktop-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `.`. Only npm package/lock beyond inputs; no app source, entrypoint, tests or documentation.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-017"></a>
## APP-017 — Build/dev/package scripts absent and default npm test fails.

**OPEN · P1 · app-02-desktop-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `package.json`. Build/dev/package scripts absent and default npm test fails.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/source/package.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-018"></a>
## APP-018 — Generation stops on provider HTTP502 invalid_response; failed-request token usage unknown.

**OPEN · P1 · app-02-desktop-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `receipts/result.json`. Generation stops on provider HTTP502 invalid_response; failed-request token usage unknown.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-raw_tools/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-019"></a>
## APP-019 — Money typecheck fails: missing rounded API/extension

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `TrailLedger/Models/Money.swift`. Money typecheck fails: missing rounded API/extension

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/checks/portable-typecheck.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/source/TrailLedger/Models/Money.swift:45).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-020"></a>
## APP-020 — Conditional binding of nonoptional String fails

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `TrailLedger/Models/Money.swift`. Conditional binding of nonoptional String fails

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/checks/portable-typecheck.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/source/TrailLedger/Models/Money.swift:112).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-021"></a>
## APP-021 — Invalid custom totals silently rewritten

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `TrailLedger/Models/SplitEngine.swift`. Invalid custom totals silently rewritten

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/checks/components-varied.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/source/TrailLedger/Models/SplitEngine.swift:60).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-022"></a>
## APP-022 — Fixed shares above total can create negative equal share

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `TrailLedger/Models/SplitEngine.swift`. Fixed shares above total can create negative equal share

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/issues.json); [check receipt](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/checks/components-varied.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/source/TrailLedger/Models/SplitEngine.swift:50).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-023"></a>
## APP-023 — Wrapping integer addition can silently overflow

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source finding; no end-to-end exploit/runtime reproduction claimed.

Original severity: high. Location: `TrailLedger/Models/Money.swift`. Wrapping integer addition can silently overflow

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/source/TrailLedger/Models/Money.swift:66).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-024"></a>
## APP-024 — Duplicates Models/ExpenseMath.swift and uses incompatible model APIs

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source finding; no end-to-end exploit/runtime reproduction claimed.

Original severity: high. Location: `TrailLedger/Services/ExpenseMath.swift`. Duplicates Models/ExpenseMath.swift and uses incompatible model APIs

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/source/TrailLedger/Services/ExpenseMath.swift:50).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-025"></a>
## APP-025 — Missing MoneyRounding type prevents compilation.

**OPEN · P1 · app-03-ios-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `Packages/TrailLedgerCore/Sources/TrailLedgerCore/Money.swift`. Missing MoneyRounding type prevents compilation.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/source/Packages/TrailLedgerCore/Sources/TrailLedgerCore/Money.swift:19).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-026"></a>
## APP-026 — Int32 exponent incompatible with Foundation Int16 parameter; also line58.

**OPEN · P1 · app-03-ios-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `Packages/TrailLedgerCore/Sources/TrailLedgerCore/Money.swift`. Int32 exponent incompatible with Foundation Int16 parameter; also line58.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/source/Packages/TrailLedgerCore/Sources/TrailLedgerCore/Money.swift:50).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-027"></a>
## APP-027 — Release-disabled currency assert and wrapping arithmetic can silently produce invalid amounts; static finding.

**OPEN · P1 · app-03-ios-raw_tools**

Evidence status: Static source finding; no end-to-end exploit/runtime reproduction claimed.

Original severity: high. Location: `Packages/TrailLedgerCore/Sources/TrailLedgerCore/Money.swift`. Release-disabled currency assert and wrapping arithmetic can silently produce invalid amounts; static finding.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/source/Packages/TrailLedgerCore/Sources/TrailLedgerCore/Money.swift:68).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-028"></a>
## APP-028 — No app project, entry point, screens, persistence, tests or delivery documentation.

**OPEN · P1 · app-03-ios-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `.`. No app project, entry point, screens, persistence, tests or delivery documentation.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-029"></a>
## APP-029 — Overwrites immutable original requirements with different game and false missing-file claim, contradicted by prior reads/listing.

**OPEN · P1 · app-04-ios-game-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `RFP.md`. Overwrites immutable original requirements with different game and false missing-file claim, contradicted by prior reads/listing.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/source/RFP.md).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-030"></a>
## APP-030 — No game/app/project/Swift source/tests/delivery artifacts.

**OPEN · P1 · app-04-ios-game-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `.`. No game/app/project/Swift source/tests/delivery artifacts.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-031"></a>
## APP-031 — Unrelated placeholder, not executable implementation.

**OPEN · P1 · app-04-ios-game-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `tools/vendor/harvest_dashboard.py`. Unrelated placeholder, not executable implementation.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-codali_candidate/source/tools/vendor/harvest_dashboard.py:1).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-032"></a>
## APP-032 — Duplicate StageLibrary also declared in Stage.swift:303 prevents package build.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `Sources/EmberGridCore/StageLibrary.swift`. Duplicate StageLibrary also declared in Stage.swift:303 prevents package build.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/source/Sources/EmberGridCore/StageLibrary.swift:7).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-033"></a>
## APP-033 — Missing to: argument label prevents engine compilation.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `Sources/EmberGridCore/EnemyAI.swift`. Missing to: argument label prevents engine compilation.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/source/Sources/EmberGridCore/EnemyAI.swift:129).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-034"></a>
## APP-034 — Player created without initial energy, defaulting to0.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `Sources/EmberGridCore/Stage.swift`. Player created without initial energy, defaulting to0.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/source/Sources/EmberGridCore/Stage.swift).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-035"></a>
## APP-035 — Normal retained dead enemy at health -1 rejected on reload; duplicate player/core and invalid won/next-ID states accepted.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `Sources/EmberGridCore/SaveSystem.swift`. Normal retained dead enemy at health -1 rejected on reload; duplicate player/core and invalid won/next-ID states accepted.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/source/Sources/EmberGridCore/SaveSystem.swift).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-036"></a>
## APP-036 — Stage3 map has unreachable core/enemies; BFS receipt retained.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `Sources/EmberGridCore/StageLibrary.swift`. Stage3 map has unreachable core/enemies; BFS receipt retained.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/source/Sources/EmberGridCore/StageLibrary.swift).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-037"></a>
## APP-037 — Persistence failures swallowed; stage start bypasses unlock check.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `Sources/EmberGridCore/GameSession.swift`. Persistence failures swallowed; stage start bypasses unlock check.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/source/Sources/EmberGridCore/GameSession.swift).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-038"></a>
## APP-038 — No iOS app/rendering/project source delivered.

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `App`. No iOS app/rendering/project source delivered.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-039"></a>
## APP-039 — Missing manifest stops independent Gradle build; all application source/resources/screens/tests also absent.

**OPEN · P1 · app-05-android-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `app/src/main/AndroidManifest.xml`. Missing manifest stops independent Gradle build; all application source/resources/screens/tests also absent.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-040"></a>
## APP-040 — No wrapper/bootstrap or delivery documentation supplied.

**OPEN · P1 · app-05-android-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `gradlew`. No wrapper/bootstrap or delivery documentation supplied.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-041"></a>
## APP-041 — Task-preimage limits block downloaded dependency-cache writes; repeated scope failures consume generation operations.

**OPEN · P1 · app-05-android-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `receipts/events.jsonl`. Task-preimage limits block downloaded dependency-cache writes; repeated scope failures consume generation operations.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-042"></a>
## APP-042 — Provider HTTP429 rate_limited terminates original attempt.

**OPEN · P1 · app-05-android-codali_candidate**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `receipts/result.json`. Provider HTTP429 rate_limited terminates original attempt.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-codali_candidate/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-043"></a>
## APP-043 — Missing AndroidX enablement stops actual Gradle build.

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `gradle.properties`. Missing AndroidX enablement stops actual Gradle build.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/issues.json).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-044"></a>
## APP-044 — Invalid enum interpolation confirmed by Kotlin compiler.

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `app/src/main/java/com/fieldcheck/app/domain/sync/SyncTransport.kt`. Invalid enum interpolation confirmed by Kotlin compiler.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/source/app/src/main/java/com/fieldcheck/app/domain/sync/SyncTransport.kt:68).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-045"></a>
## APP-045 — References missing application/activity and resources; no UI/source classes delivered.

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: blocker. Location: `app/src/main/AndroidManifest.xml`. References missing application/activity and resources; no UI/source classes delivered.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/source/app/src/main/AndroidManifest.xml).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-046"></a>
## APP-046 — Missing DAO methods, missing evidence cleanup method, missing combine import and invalid Flow.first usage; static integration failures.

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Static source finding; no end-to-end exploit/runtime reproduction claimed.

Original severity: high. Location: `app/src/main/java/com/fieldcheck/app/data/repo/FieldCheckRepository.kt`. Missing DAO methods, missing evidence cleanup method, missing combine import and invalid Flow.first usage; static integration failures.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/source/app/src/main/java/com/fieldcheck/app/data/repo/FieldCheckRepository.kt).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-047"></a>
## APP-047 — Submission/outbox not atomic; imported templates and evidence references/ownership not validated.

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Original review finding; see linked review/check for executed versus static evidence.

Original severity: high. Location: `app/src/main/java/com/fieldcheck/app/data/repo/FieldCheckRepository.kt`. Submission/outbox not atomic; imported templates and evidence references/ownership not validated.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md); [original issue](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/issues.json); [source](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/source/app/src/main/java/com/fieldcheck/app/data/repo/FieldCheckRepository.kt).

Closure check: Reproduce the specific defect, add an independent behavioral/build regression and verify the complete app; scope to this generated submission, not automatically a Codali runtime bug.

<a id="app-x01"></a>
## APP-X01 — Web domain writes lack transaction boundaries

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Static source review.

Create/status/comment helpers perform multiple writes without wrapping them; a transaction helper existing elsewhere is insufficient.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x02"></a>
## APP-X02 — Web authorization helpers are not wired to endpoints

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Confirmed absence.

Server/routes are absent, so passing isolated visibility/password helpers cannot establish endpoint enforcement.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x03"></a>
## APP-X03 — Web schema mismatch extends beyond ticket columns

**OPEN · P1 · app-01-web-codali_candidate**

Evidence status: Reviewed source and component failures.

Domain/seed expects status_history/articles and org/user fields differing from ticket_events/knowledge and actual migrations.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x04"></a>
## APP-X04 — Desktop typecheck references missing configuration

**OPEN · P1 · app-02-desktop-codali_candidate**

Evidence status: Executed checks.

tsconfig.web.json and actual source inputs are absent; dev exits without a launched app.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-02-desktop-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x05"></a>
## APP-X05 — iOS required domain fields are absent

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source review.

Trip lacks budget/date-range fields and Expense lacks category.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x06"></a>
## APP-X06 — iOS currency catalog and accepted currencies disagree

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source review.

Catalog lists29currencies while Currency accepts3; missing Locale helper APIs and Currency(code:) callsites prevent consistency.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x07"></a>
## APP-X07 — iOS financial serialization silently discards errors

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source risk; not reproduced in native app.

Several decode/encode failures fall back to empty arrays/data, risking silent loss of financial state.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x08"></a>
## APP-X08 — iOS decoding bypasses parse caps and parsing is inconsistent

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source review; validation behavior needs targeted tests.

Synthesized Codable bypasses parse caps; locale normalization and misplaced minus handling are inconsistent.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x09"></a>
## APP-X09 — iOS references absent services and incompatible conversion signature

**OPEN · P1 · app-03-ios-codali_candidate**

Evidence status: Static source review.

ExchangeRateStore, ReceiptStore/TripCompute references are not implemented; conversion caller assumes optional result while implementation returns Money.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-codali_candidate/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x10"></a>
## APP-X10 — Raw web frontend/build/test/delivery files incomplete

**OPEN · P1 · app-01-web-raw_tools**

Evidence status: Executed build failures and file inventory.

Frontend fragments lack app entrypoint/screens; build script, tests and delivery docs are absent.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-01-web-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x11"></a>
## APP-X11 — Raw iOS minimum-integer abs/negation can trap

**OPEN · P1 · app-03-ios-raw_tools**

Evidence status: Static source risk; module does not compile.

Int64 minimum edge cases and wrapping operations are unsafe in financial helpers.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-03-ios-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x12"></a>
## APP-X12 — Raw game documented tie-break branch is unreachable

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Static source review.

Strict d<bestDist guard prevents equal-distance Manhattan tie branch from running; deterministic direction order is not the promised priority.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x13"></a>
## APP-X13 — Raw game win message can disagree with final score

**OPEN · P1 · app-04-ios-game-raw_tools**

Evidence status: Static source review.

Win-event score is read before winning-turn increment, producing a five-point mismatch.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-04-ios-game-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x14"></a>
## APP-X14 — Raw Android required photo accepts nonexistent evidence

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Component/source finding; no UI exploit claimed.

Photo-count validator accepts a fabricated evidence ID and submission does not resolve it against evidence storage.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x15"></a>
## APP-X15 — Raw Android numeric model and validator disagree

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Component/source finding.

Answer.numeric is ignored by numeric validation, which reads Answer.value. Passing26 intended-input cases does not cover this interface mismatch.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x16"></a>
## APP-X16 — Raw Android evidence paths lack confinement checks

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Static defensive gap; external reachability unproven.

Path construction trusts inspectionId/fileName and deletion/replacement lacks ownership verification.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x17"></a>
## APP-X17 — Raw Android corrupt values are silently defaulted

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Static source review.

Unknown severity becomes LOW and unknown statuses fall back; malformed data can be concealed.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x18"></a>
## APP-X18 — Raw Android fake-server idempotency state is volatile

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Static source review.

Acceptance IDs exist only in memory and are lost on fake-server recreation.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x19"></a>
## APP-X19 — Raw Android demo photos are not complete encoded images

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Static fixture review; native decoding unverified.

Seed bytes contain JPEG-like markers rather than valid image encoder output.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x20"></a>
## APP-X20 — Raw Android serializer calls are invalid

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Static integration review.

Uses kotlinx.serialization.builtins.String.serializer rather than valid String serializer extension calls.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

<a id="app-x21"></a>
## APP-X21 — Raw Android source comments overstate delivered checks

**OPEN · P1 · app-05-android-raw_tools**

Evidence status: Source/file inventory mismatch; not a fabricated executed receipt.

Comments claim mapping tests/settings confirmation but no matching delivered files/screens exist.

Evidence: [review](/home/wodo/apps/codali-appbuild-results/2026-11-04/app-05-android-raw_tools/REVIEW.md).

Closure check: Add a focused regression for the stated condition and verify integration; do not count static risks as reproduced exploits.

## Additional limits and non-issues

- No Mac/Xcode runner was available. Portable Swift results do not establish native UI or lifecycle correctness; missing native projects/screens are still definite delivery failures.
- The raw web pagination expectation was corrected for archived fixture rows; that initial evaluator assertion is not an app defect.
- SDK XML compatibility warnings were not the Android stopping errors. Codali failed on missing manifest; raw on missing AndroidX enablement.
- Game Docdex connectivity succeeded. A healthy connection/tree call does not prove all Docdex features were used effectively.
- Existing source snapshots are sealed. A prior Docdex metadata-only mutation was detected/restored during benchmark evaluation and documented; it is not a generated-code defect.
- Token/service limits in the frozen protocol were deliberate comparison ceilings. Increasing them retrospectively would invalidate the original comparison.
- A local Docdex delegation was used only for a small classification caution draft. Its unsupported characterization of raw failures as unverified was rejected; confirmed receipts govern this inventory. No automatic delegation output was treated as evidence.

## Industry50 additions

<a id="ind-001"></a>
## IND-001 — Earlier50-job comparator was raw inference, not raw with tools

**OPEN · P1 · Industry50 / Confirmed protocol/trace correction**

All50raw attempts are raw_direct with one model request and zero tools; source fixtures were inline. Prompt metadata toolParity=full does not prove a tool-equipped arm. Audited accuracy ties97.6/97.6; strict scores89.6/92.0. The run demonstrates higher Codali cost, not an audited aggregate accuracy loss against raw-with-tools.

Evidence: [protocol](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/README.md); [100-attempt audit](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/CODALI_ISSUES_INDUSTRY50_EVIDENCE.md).

Closure check: Use accurate arm names in every report; run a separately frozen raw_tools arm before claiming tool-parity conclusions.

Related existing items: COD-031.

<a id="ind-002"></a>
## IND-002 — Intent classification uses the answer-model alias and dominates avoidable overhead

**OPEN · P1 · Industry50 / Confirmed usage; best replacement not tested**

Every job pays an intent call:50calls/75973tokens,32.36%of Codali tokens and2.03×the entire raw run. All route to qwen-latest-flash-next; balanced-qwen is a binding label, not evidence of a smaller model. Intent request→response intervals total219.584seconds; these include queue/service time.

Evidence: [industry-02 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/events.jsonl:12); [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/codali-industry50-issues-audit.json).

Closure check: Compare a simpler adaptive route or smaller qualified classifier on fresh jobs; preserve ambiguous-intent handling and validate quality/cost before adoption.

Related existing items: COD-018.

<a id="ind-003"></a>
## IND-003 — Tool selection omits verification on a financial calculation that fails

**OPEN · P1 · Industry50 / Confirmed routing and final error; internal formula choice unknown**

Industry02 routes tools=none and supplies no tool schemas to the lead. Codali returns NRR103.57/GRR93.09 instead98.68/93.05. Raw also misses both by0.01. The large Codali NRR error is not equivalent business impact to the raw rounding error despite equal lost criteria.

Evidence: [industry-02 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/events.jsonl:14); [industry-02 result](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/result.json).

Closure check: Use deterministic verification of derived numeric outputs when needed, preserving financial definitions and excluding new customers from NRR. Do not hard-code only this prompt.

<a id="ind-004"></a>
## IND-004 — Partial calculator use leaves the difficult arithmetic unverified

**OPEN · P1 · Industry50 / Confirmed model-answer error; calculator itself returned correct results**

Industry11 calculates only total minutes43200 and incident sum31. The model returns allowed43/remaining12 instead43.2/12.2. No calculator request computes the fractional budget. Raw answers correctly. This is not a calculator rounding bug.

Evidence: [industry-11 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-11-codali_selected-ffd0d96f-74ca-4d90-be02-fa3e71021976/events.jsonl:28); [industry-11 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-11-codali_selected-ffd0d96f-74ca-4d90-be02-fa3e71021976/events.jsonl:42); [industry-11 result](/home/wodo/.local/state/codali-industry50/run/attempts/industry-11-codali_selected-ffd0d96f-74ca-4d90-be02-fa3e71021976/result.json).

Closure check: Verify derived budget and remaining values with explicit precision; preserve fractions unless the user requests rounding.

<a id="ind-005"></a>
## IND-005 — Explicit Unicode sorting is ignored

**OPEN · P1 · Industry50 / Confirmed answer defect**

Industry30 correctly classifies identifiers but orders both arrays incorrectly. Valid must be[AB3,A_2,Z99_]; invalid must be[spaceABC,A12345678,AB,aB3,ÅBC]. The original request explicitly says Unicode code-point order. The brief says only sorted; the original request remains available, so causality from shortening is unproven.

Evidence: [industry-30 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-30-codali_selected-1cbe1f64-8d71-4278-a15d-a10a1ec31bf3/events.jsonl:14); [industry-30 result](/home/wodo/.local/state/codali-industry50/run/attempts/industry-30-codali_selected-1cbe1f64-8d71-4278-a15d-a10a1ec31bf3/result.json).

Closure check: Use deterministic regex/sort checks for explicit ordering and preserve comparator semantics in derived task contracts.

<a id="ind-006"></a>
## IND-006 — Output validation passes structurally valid but wrong answers

**OPEN · P1 · Industry50 / Confirmed validation scope gap**

Industry02,11,30 end with interaction_output_checked violations=[] despite numeric or sorting errors. Current format/required-key checks are useful but do not establish semantic correctness. Do not label the absence of presentation violations as full verification.

Evidence: [industry-02 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/events.jsonl:33); [industry-30 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-30-codali_selected-1cbe1f64-8d71-4278-a15d-a10a1ec31bf3/events.jsonl:23).

Closure check: Separate format-valid, tool-verified and semantically-unverified status; check task-derived invariants where deterministic verification is possible.

Related existing items: COD-023.

<a id="ind-007"></a>
## IND-007 — Eight model calls repair only JSON presentation

**OPEN · P2 · Industry50 / Confirmed overhead; final JSON formatting is a real benefit**

Eight fenced-JSON drafts trigger6892tokens and43.262seconds of request→response time. Seven have identical parsed values after repair. Industry02 spends an extra call removing fences while retaining wrong financial values. Raw violates JSON-only presentation50/50 but its usable JSON is scored separately.

Evidence: [industry-02 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-02-codali_selected-0a335532-525f-4d22-848b-1d8090e5ced2/events.jsonl:25); [repair comparison](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/CODALI_ISSUES_INDUSTRY50_EVIDENCE.md).

Closure check: For a single unambiguous valid fenced object, use validated deterministic extraction or constrained output where supported; use model repair only when needed, without changing data.

Related existing items: COD-018.

<a id="ind-008"></a>
## IND-008 — Presentation-only repair changes semantic data

**OPEN · P1 · Industry50 / Confirmed transformation; no new semantic-score deduction**

Industry35 changes held_ids from[rC] to[rB,rC,rE] while repairing only Markdown fences. The repair instruction says preserve factual content. Both interpretations satisfy the existing ambiguity erratum, so this is a breached preservation contract rather than proof the final answer is wrong.

Evidence: [industry-35 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-35-codali_selected-7b2d65e8-300b-40f3-ae90-a7d792bbdd12/events.jsonl:23); [industry-35 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-35-codali_selected-7b2d65e8-300b-40f3-ae90-a7d792bbdd12/events.jsonl:33); [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/scoring-errata.json).

Closure check: Assert parsed values remain identical for presentation-only repair; semantic changes require an explicitly separate correction path and evidence.

<a id="ind-009"></a>
## IND-009 — Calendar request sent to an arithmetic-only calculator

**OPEN · P2 · Industry50 / Confirmed recoverable tool-selection error**

Industry42 sends expression2027-08-31 minus45days; calculate rejects Unexpected token minus. A later arithmetic call returns42 for(31−20)+31; final date answer is correct. This is the sole failed tool receipt, not a general service outage.

Evidence: [industry-42 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-42-codali_selected-bef70bfa-5f3c-4082-8da6-60259f276679/events.jsonl:28).

Closure check: Advertise arithmetic grammar accurately and expose a deterministic date operation with explicit timezone/calendar rules; test month/year boundaries.

<a id="ind-010"></a>
## IND-010 — Financial calculator exposes binary floating-point intermediates

**OPEN · P2 · Industry50 / Confirmed numeric representation; no demonstrated wrong final invoice from this case**

Industry01 returns3996.2900000000004 and1727.9099999999999, explicitly labeled IEEE-754 rather than exact decimal. Final invoice is correct, and calculator use wins industry05; still, decimal rounding is left to the language model.

Evidence: [industry-01 log](/home/wodo/.local/state/codali-industry50/run/attempts/industry-01-codali_selected-bb79fc85-94f7-4409-8a03-09f3e3214ca1/events.jsonl:28); [industry-05 result](/home/wodo/.local/state/codali-industry50/run/attempts/industry-05-codali_selected-70c61e4a-fc4d-471d-ba8a-67d4c5029fdb/result.json).

Closure check: Provide exact decimal/minor-unit operations and explicit rounding policy for money; keep useful tool wins and avoid claiming this limitation caused the SLO error.

<a id="ind-011"></a>
## IND-011 — File-inspection path is expensive without measured accuracy gain

**OPEN · P2 · Industry50 / Confirmed cost; asymmetric input delivery limits attribution**

Five file jobs18,21,26,40,47 issue17read_file calls and all tie raw at100audited. Codali uses11.51–15.44×raw tokens on those jobs. Raw gets complete files inline, so retrieval cost is not comparable to a raw-with-tools arm and should not be called useless universally.

Evidence: [paired job table](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/CODALI_ISSUES_INDUSTRY50_EVIDENCE.md).

Closure check: Measure bounded/batched file context against a tool-parity comparator; optimize context/schema reuse without removing required evidence.

Related existing items: COD-018, COD-031.

<a id="ind-012"></a>
## IND-012 — Industry50 provides no evidence of Docdex benefit

**OPEN · P2 · Industry50 / Confirmed zero usage; not proof of malfunction**

All52tool receipts are calculate/read_file; zeroDocdex calls. These small read-only jobs do not qualify system-wide Docdex integration, browser research, memory or long-agent reliability. Memory/web/media were intentionally disabled.

Evidence: [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/execution-evidence.json); [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/README.md).

Closure check: Add fresh tasks that actually require repository search/impact/memory and verify selected tools and correct bindings. Do not force irrelevant Docdex calls just to increase counts.

Related existing items: COD-015, COD-031.

<a id="ind-013"></a>
## IND-013 — Underspecified answer schemas inflated the apparent strict-score gap

**OPEN · P2 · Industry50 / Confirmed evaluator/specification limitation**

Strict scores show Codali89.6 versus raw92.0; symmetric post-response errata raise both to97.6. Examples: capacity units, critical-path string versus array, capability synonyms, retention semantics and numeric strings. Explicit Unicode sorting and arithmetic mistakes remain failures.

Evidence: [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/scoring-errata.json); [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/results.json).

Closure check: Specify units/types/order/meaning before new runs; preserve frozen strict and audited scores separately and do not tune against exposed jobs as if unseen.

Related existing items: COD-031.

<a id="ind-014"></a>
## IND-014 — Equal-weight near-ceiling scoring hides error severity and generalization limits

**OPEN · P2 · Industry50 / Confirmed measurement limitation**

Both lose6of250criteria, yet Codali NRR is materially farther from the correct value than raw. Both score97.6on short supplied-evidence jobs but later fail complete apps. No service errors occurred here; app-build502/429 explanations do not apply.

Evidence: [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/results.json); [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-industry50/README.md).

Closure check: Add predefined severity/error-magnitude metrics and harder held-out tasks, retaining the original rubric; report task-family coverage rather than general intelligence.

Related existing items: COD-031.

<a id="ind-015"></a>
## IND-015 — Completed=false is ambiguous for successful answer-only interactions

**OPEN · P2 · Industry50 / Confirmed telemetry value; not50failed answers**

All50Codali result receipts set completed=false in reason/inspect mode while returning answers with no error. Published completion counts correctly count50attempts; consumers could confuse goal completion with delivered-answer completion.

Evidence: [industry-50 result](/home/wodo/.local/state/codali-industry50/run/attempts/industry-50-codali_selected-5e801fad-7427-47fb-803b-f051e92ed9eb/result.json); [evidence](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/codali-industry50-issues-audit.json).

Closure check: Separate attempt-finished, answer-delivered, active-goal-complete and error fields; document existing semantics before changing reports.

Related existing items: COD-029.

<a id="ind-016"></a>
## IND-016 — Raw-only errors and Codali wins must remain visible

**OPEN · P2 · Industry50 / Confirmed comparator controls, not Codali regressions**

Codali wins industry05cloud allocation(100/60),13release decision(100/80),27SQL excluded-row count(100/80). Raw additionally misses NRR/GRR with Codali. Codali loses11SLO and30Unicode(60/100), ties45. Do not turn the inventory into a claim every Codali answer is worse.

Evidence: [all failures and pairs](/home/wodo/apps/mcoda/docs/benchmarks/codali-appbuild5/CODALI_ISSUES_INDUSTRY50_EVIDENCE.md).

Closure check: Use these as regression/control cases; report wins/losses/ties and semantic versus format performance for any future change.

## Updating this file

Keep IDs stable. Append new findings with project/arm, receipt line or source/check evidence, reproduction status and closure criteria. For fixes, record code revision and tests in a new validation field; preserve the original observation and benchmark artifacts.
