# Orchestration configuration

The JSON file declares providers, model identities, role bindings, effort limits
and task-control policy. It contains credential references, never secret values.
The loader rejects unknown fields, undeclared models, alias cycles, unsafe URLs,
unsupported operations and policies that allow more than one workspace writer.
The packaged `config/orchestration.schema.json` describes the structural contract;
the runtime additionally validates references, backend intersections and URL trust.

Providers use `mswarm` or `openai-compatible`, with `baseUrl` and optional
`credentialRef: "env:VARIABLE"`. mSwarm requires a credential reference. Catalog
and usage URLs must share the provider origin. HTTPS is required except for local
loopback development. Redirects do not receive credentials.

Every model declares `provider`, `catalogId`, `revision`, `operations`,
`contextWindow` and `maxOutputTokens`. Optional properties identify `backend`,
`host`, `resourcePool`, tool/streaming support and embedding dimensions. A catalog
that does not expose an artifact revision must be labeled `catalog-unversioned`;
that label is not a verified weight checksum. Configuration hashes identify the
effective routing policy, not a physical model artifact.

Operations are `chat.completions`, `embeddings`, `images.generations`,
`audio.generations` and `videos.generations`. A binding declares ordered
`candidates`, aliases another binding using `useBinding`, or is explicitly
disabled. Aliases inherit all backend restrictions along their chain. Discovery
only filters declared candidates; it never adds unconfigured routes. If no
candidate is eligible, execution fails before dispatch. A submitted request is
not automatically replayed against another host.

The lead owns task progression. `reviewer` independently evaluates evidence;
`helper` accepts a bounded capsule and returns a draft with source references.
Helpers cannot execute tools or grant permissions. `image`, `audio` and `video`
bind generation operations. Media parameters are checked against advertised
formats and limits, and every artifact records its model, config hash and SHA-256.
Roles such as `planner`, `architect`, `worker`, `router`, `repair`, `compactor`,
`adjudicator`, `synthesizer` and `verifier` can explicitly alias the lead. Disabled
optional capabilities do not silently invoke a model from daemon defaults.

Effort controls shared limits, not a claim about hidden model reasoning:

| Effort | Steps | Model calls | Tool calls | Total tokens | Time |
| --- | ---: | ---: | ---: | ---: | ---: |
| low | 12 | 12 | 12 | 32,000 | 5 min |
| medium | 32 | 36 | 48 | 128,000 | 15 min |
| high | 64 | 72 | 128 | 320,000 | 30 min |
| max | 128 | 144 | 256 | 640,000 | 60 min |

An `effort` object may override positive integer limits by level. Provider output
and context limits remain enforced. Native `reasoning_effort`, `reasoning_budget`,
`reasoning_budget_tokens` or `enable_thinking` settings belong in that model's `reasoning` mapping only after
the adapter has been tested with them. Unreported usage is estimated and shown as
such; an unknown server balance is not treated as a known zero balance.

The Raijin/Suku example maps low to native `none`, medium to `low` with a
512-token thinking cap, and high/max to `high` with a 1,024-token cap. These are
request settings; `/status` and model-route events expose them without claiming
that an older server applied them. Both the mSwarm proxy and node must contain
the native-reasoning transport update before enabling this profile in service.
The CLI checks the proxy's authenticated model catalog before reserving inference
tokens. The selected model must advertise `native_reasoning.transport_version: 1`
and every requested parameter. The proxy publishes this contract for pinned nodes
advertising `native_reasoning_transport_version: 1`, and rejects native requests to older
nodes before dispatch. A generic `supports_reasoning` flag is insufficient.
Load-balanced aliases do not yet advertise this contract; configure explicit
candidate models on each host for native-reasoning failover. Direct compatible
providers retain their explicitly configured native parameter contract.
Node requests retain the approved model and endpoint, preserve the source
profile hash, and record a distinct effective hash when a request overrides
native reasoning. The shared output/token/deadline limits still apply. A native
thinking cap of zero means no separate thinking cap, not zero thinking tokens;
use `reasoning_effort: "none"` to disable it on Strata.

Configuration changes apply between turns using `/config reload`. Saved grants
are revoked when reloading. Jobs already submitted retain their pinned provider,
model and request. Switching a retrieval embedding space requires explicit index
migration; changing a role alias does not make incompatible vectors compatible.

The Raijin/Suku example deliberately leaves unqualified specialist and embedding
routes disabled. Use `setup` to generate identifiers authorized for your account,
then qualify and enable optional bindings. GPU free space alone is insufficient
to admit another resident model or a concurrent media workload.

An enabled `embedding` binding requires a pinned artifact revision, explicit
`embeddingDimensions`, and an `embedding` object declaring `queryPrefix`,
`documentPrefix`, `normalization` (`none` or `l2`) and `pooling`. All fallback
candidates must share that exact embedding contract. For example, a qualified
Nomic service may use `search_query: `, `search_document: `, `l2`, `mean` and 768
dimensions; confirm these against the deployed artifact before configuring it.
Use `mcoda agent add/update --config-model-digest sha256:<artifact checksum>`
and an `embeddings` operation with `limits.embeddingDimensions` to expose a
qualified runner. Declare its preprocessing with `--config-embedding-json`
using the four explicit fields above; `none` removes that metadata. Setup selects
healthy catalog entries only when digest, dimensions and preprocessing are all
present, and groups identical contracts as replicas. The mSwarm catalog and
response must attest the pinned digest.

With this binding enabled, the terminal controller owns a private Docdex process.
Repository embeddings pass through the configured provider and shared session
budget. Docdex text inference uses the configured helper, or the lead when no
helper is enabled. Private indexes live outside the repository, are separated by
embedding-space identity, and are reused on restart. The session also pins its
space; an incompatible upgrade requires a separate index and session. Query and
document receipts retain purpose, model, configuration hash and reported usage.

The managed daemon must advertise workspace-metadata control, query/document
embedding input types, strict repository embeddings and deterministic profile
embeddings. An older daemon fails startup with an explicit compatibility error.
`docdex.binary` selects an installed qualified binary; `binarySha256` pins its
bytes and is checked before every managed launch. `startupTimeoutMs` bounds
startup. Setup uses the packaged release artifact manifest for a private install,
or validates the explicit `--docdex-binary` path through `runtime-info`. It does
not rewrite Git ignore files or create repository-local metadata.
Global profile preferences use separate persistent deterministic hash storage,
which makes no LLM call and survives repository embedding upgrades. Failed remote
repository embeddings never substitute vectors from this hash space.

Large plans remain complete in durable storage. The model context reserves the
original goal, constraints, active task criteria and applicable architecture
decisions, while paging unrelated work out of the prompt. `work_status` supports
`offset`/`limit`, `taskIds` and `requirementIds`. Every required criterion remains
subject to the final completion gate. A changed prerequisite or superseded
decision invalidates dependent attempts before another write can proceed.

Before editing existing source, the controller requires a current file read and
successful symbols/AST plus impact-graph receipts for that content hash. Parser
skips and failed requests do not satisfy the gate. Index ingestion uses the bound
repository's absolute paths, independent of the daemon's working directory.
An empty dependency graph is still incomplete dependency evidence: review imports
and relevant callers, and verify behavior with tests.

Direct English instructions to add/write/extend tests have an additional
evidence check: the session must have changed a surviving test source relative
to its original workspace baseline. An unchanged passing suite, deleted test,
symlink or JSON fixture alone does not satisfy that check. This recognizes a
bounded set of direct instruction forms; it is not a general requirement
parser. Independent review still evaluates meaningful coverage and the full
request, including instructions outside those forms.

Review receives the actual changed-file list and scoped test source, including
unchanged tests. Source hashes must match the checked inputs. Review text is
bounded; large/truncated inputs are explicit and binary artifacts are represented
by checksums and tool receipts. Review must reject unavailable evidence needed
to decide correctness. Passing a test or obtaining reviewer approval alone does
not establish a universal correctness guarantee; observed false completions
remain release blockers and become regression fixtures.

Ordinary task review includes its assigned requirements, owned changes and diff,
plus relevant read-only dependencies. Other tasks' pending deliverables remain
in the canonical backlog. A task assigned the original whole-objective criterion
receives the complete current goal and all changes for integration review.
Both review scopes retain the same global validation and source-freshness checks.

Terminal `model_receipt` events link usage to `model_intent` by ID and identify
the role binding. Completed receipts include the reported route and usage;
missing usage is explicitly estimated. An unknown transport outcome retains its
reservation, while a native-capability preflight refusal records zero usage and
`not_dispatched`. Usage received during cancellation is settled before the
answer is discarded. These receipts allow helper/lead usage to be compared
without attributing another role's tokens to the helper.

Terminal shell commands default to a read-only workspace. `command` contains a
single executable and `args` contains its arguments. Optional `writePaths` names
existing files/directories inside the claimed task scope; existing source below
them needs the same read/analysis preconditions, including Git-ignored source.
Narrow writable paths avoid inspecting unrelated build and dependency trees.

Use `work_release` with the current task/attempt IDs and a reason before replanning
a claimed task. It preserves the goal, criteria and historical receipts while
invalidating the old attempt. A checkpoint saves context without releasing the
claim. Rejected tool attempts are recorded and consume the shared tool budget.

Resolved credentials are registered for exact-value redaction as well as common
token-pattern detection. Stream processing buffers incomplete words so credentials
split across chunks cannot expose their prefix or tail. Human-facing output also
removes terminal control sequences; approvals retain complete operation arguments
with credential fields redacted.

## Shared embedded model scope

`ConfiguredModelScope` pins a validated configuration and effort at invocation start. Every role provider shares call/token reservations, a deadline and cancellation. Missing or failed usage retains a conservative token reservation; `pendingCalls` counts unresolved accounting, not a claim that remote inference is still running. The caller persists `onEvent` intents/receipts when recovery is required.

Legacy automation can opt into the same configuration with `codali run --orchestration-config /path/models.json --effort high ...` or `codali ask --orchestration-config /path/models.json --effort low ...`. `CODALI_ORCHESTRATION_CONFIG` supplies the deployment default. For `run`, the old `--config` still selects workflow/validation settings. Explicit legacy model/provider/agent overrides are rejected when orchestration configuration is selected. Old commands without an orchestration file retain their compatibility behavior.

The configured entry points use these bindings:

| Entry point | Model bindings | Shared boundary |
| --- | --- | --- |
| Terminal `chat`/`exec` | Lead, configured helpers/reviewer, embedding and media | Durable session controller |
| Legacy `run` direct | `lead` | One scope for the command |
| Legacy `run` smart | `router`, `architect`, `worker`, optional `summarizer` and `repair` | One scope across retrieval, summarization and retries |
| Legacy `ask` and public `runCodali` API | `planner`, `worker`, `synthesizer` | One scope across classifier, planner, workers and final answer |
| `runCodaliTask` | Explicit binding or `lead` | Owned scope or validated parent scope |
| `runCodaliJob` | Each stage's explicit role or kind, including repair | One scope shared by parallel stages |

The public API accepts `{ orchestration: { resolved, effort, caller }, signal }` in its trusted dependency argument. `caller` contains the authenticated `clientIdentity` and `clientProduct`; it is pinned and accompanies both mSwarm catalog and inference calls. Do not copy model configuration or caller identity from an untrusted tenant request. Pass each tenant's approved credential reference in its resolved host configuration. Tenant tool context remains mandatory; configuring a model does not authorize operator credential fallback. Request-level media overrides are refused in configured API mode; a host can register approved media tools and explicitly authorize them through its tool context.

Runtime/job result accounting includes the configuration hash, actual selected catalog routes and cumulative shared usage. Borrowed scopes must match configuration, effort and any explicit caller identity; children never close their parent's scope. Nested tool hooks reserve from the shared tool budget. Configured CLI retrieval also meters every underlying Docdex HTTP attempt, including negotiation/retries, so a logical Docdex tool can consume more than one operation reservation. This conservative accounting is explicit rather than unmetered background work. Syntax validation uses cancellable processes.

These library and CLI paths are implemented. Production applications must still pass their trusted configuration/caller context and be deployed and tested.

The mSwarm node executor reads an operator-selected profile from the admitted
agent's registry `codaliOrchestrationPath`. Set it with
`mcoda agent update AGENT --config-orchestration-path /absolute/models.json`;
`none` restores legacy execution for rollback. This setting is never accepted
from a tenant invocation. Every declared provider must match the admitted
loopback runner and its catalog endpoint; every model must match the admitted
model, artifact when pinned, operations and capability/size limits. Calling the
public mSwarm gateway from this path is rejected. A node profile uses the same
schema and explicit role aliases as a terminal profile.

The executor resolves runner credentials from the trusted registry/auth store
into an invocation-local scope. It never sets process-global credential variables.
Direct calls, gateway planning/synthesis and job stages share that scope's model,
token, tool and cancellation limits. Required Docdex retrieval runs through the
ordinary authorized protocol/tool path without a synthetic model override or an
invented model-call receipt. A failed job propagates as a server error. The new
node path has regression coverage; production activation and live qualification
remain release requirements.

`runConfiguredGateway` uses that scope for planner and synthesizer calls; host workers obtain their role providers from the same scope. The host still owns tool policy, tool budgets and cancellation of external operations. Legacy provider/planner overrides are rejected. If the gateway requires a final large model, every configured synthesizer candidate must have an eligible assignment in the host inventory/policy before any model dispatch. Traces identify the selected catalog route; configuration host labels are not physical execution attestations.

## Existing mcoda project tasks

Use `mcoda codali chat --project-task TASK_KEY --workspace-root /path/to/repo`, or `mcoda codali exec "Complete the existing task" --project-task TASK_KEY` with the desired permission profile. This opens an existing workspace task database; it does not initialize a project in an ordinary repository. Resume attached sessions through `mcoda codali resume SESSION_ID`. The standalone library accepts the small `ProjectTaskAuthority` contract for embedded hosts.

The project task title/description remains part of the original objective. Terminal phases/subtasks describe execution of that one parent task. `McodaProjectTaskAuthority` uses the existing `WorkspaceRepository` transaction and `TaskStateService` status-event path. Canonical task revision and predecessor status fence claims; lease renewal and checks before model/tool execution stop stale owners. A running legacy task without a Codali lease cannot be taken over. Planning permissions read project state without claiming or submitting it.

Verified local completion writes a durable submission intent, hands the task to `ready_to_code_review`, then acknowledges local completion. mcoda review and QA remain required. Replaying a lost response checks the operation ID, evidence digest, original revision and accepted revision. Recovery refuses changed inputs or a changed project review state. Session evidence cannot be deleted until the project task is completed or cancelled. A local project execution fork is refused because it would introduce another status owner.

`runConfiguredPipeline` adapts the existing cognitive pipeline to the same model scope. Its retrieval-query, architect, builder and optional interpreter use the `router`, `architect`, `worker` and `repair` bindings. Builder tool calls share a counter across retries. The embedded host remains responsible for retrieval-tool metering, a configured Docdex client, policy checks/patch permissions, memory persistence and a validator using the scope signal. Legacy callbacks that silently swap providers are rejected. These adapters are available for migration; older application call sites still require rollout and qualification before the configuration migration is complete.

`ValidationRunner` executes checks asynchronously, accepts the host cancellation signal and an optional shell executor, and preserves timeout/failure outcomes. The terminal's executor remains the isolation boundary; using an allowlisted command alone is not isolation.

Media workers persist an artifact receipt before atomically publishing the complete, synced output file. A restarted client can validate the receipt's session/job/model/configuration identity, file format, byte count and checksum, then acknowledge success without another render. An incomplete or corrupt receipt leaves the job uncertain. Reconciliation probes the SQLite execution lock rather than trusting a PID that may have been reused. This closes the local receipt crash window; remote jobs whose responses never reached the client still require backend reconciliation support or an explicitly confirmed outcome.
Durable media providers can declare `mediaJobsUrl` on the same origin as
`baseUrl`. The `mswarm-media-jobs-v1` transport persists a client UUID before
submission and reconciles by that UUID after a disconnect. Reusing a UUID with
different input is rejected. Recovery reads the original job; it does not
resubmit an uncertain render. Job summaries include the server invocation and
node IDs, cancellation acknowledgement, expiry and available usage.

The server retains a completed artifact for one hour, or until the client
acknowledges its response checksum after persisting a verified local artifact.
Expired server artifacts cannot be recovered by regenerating them silently.
Cancellation that wins before the node start acknowledgement prevents
inference. Cancellation after that boundary remains requested and unconfirmed;
disconnecting an HTTP request does not prove that a native render stopped.
Synchronous providers remain supported with explicitly limited remote recovery.
`codali setup` negotiates this API; `codali doctor` reports the selected protocol.

The isolated executor discovers host Node/npm/pnpm/yarn/bun installations outside
the workspace. On Linux it mounts only the executable or a matching package root
read-only and installs sandbox PATH aliases. It does not mount the user's home,
adjacent packages, credentials or package-manager caches. Other tools already
under system runtime paths keep working; additional private toolchains are not
implicitly exposed. The installed Raijin pnpm has passed an isolated fixture
test. Linux and macOS Node 20/22 platform CI passes the isolation/toolchain suite;
this does not replace clean-package and production qualification. The macOS adapter creates a private
temporary directory for each command, points HOME/TMPDIR there, and removes it
after process cleanup. It grants no general read/write access to other users'
temporary files. Linux uses a private temporary filesystem and pins TMPDIR to
that filesystem.

Release qualification uses `scripts/verify-codali-package-install.mjs` after
the package build. It packs twice, compares archive hashes, installs the
Codali/shared/database tarballs into an empty project, and exercises the
installed executable, public API, native SQLite and session persistence.
Configuration failures must emit valid JSON without modifying user files;
local uninstall must preserve workspace data. The platform workflow covers
Linux x64 and macOS Intel/ARM on Node 20/22. Its recorded results, rather than
the matrix definition, determine which builds are qualified. The Intel runner
uses GitHub's explicit `macos-15-intel` label; see the
[runner architecture table](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

The packer canonicalizes the packed JSON manifest because pnpm can insert
rewritten workspace dependencies in a different order between packs. Other
archive entries remain unchanged. The publisher checks all manifests and
versions before registry writes, publishes those exact tarballs, and explicitly
uses `next` for prereleases and `latest` for stable versions. An existing
version must have identical registry integrity; rerunning a release does not
move its dist-tags. Registry errors other than an explicit missing version
stop publication.

CI now builds the Linux publication tarballs once and supplies those same bytes
to every terminal installation job. `package-artifacts.json` records package
identities, SHA256 values and the CI source revision. Consumers validate those
records before installation; the release publisher consumes the qualified
bundle through `MCODA_PUBLISH_ARTIFACTS_DIR` without repacking it. Release
publication waits for the six Node/platform installation jobs. Local checks can
use `--artifacts-dir PATH`; their report leaves source revision unknown when
they were not run with a CI revision.

Codali publication also requires checksum-pinned Docdex archives for Linux
x64 GNU, macOS Intel and macOS ARM. An empty development runtime manifest is
valid for local work with an explicit qualified binary, but cannot be
published through the release script. Clean installation does not substitute
for the live routing, media, long-session and canary gates in the build plan.

### Session storage

Session storage rejects redirected directories beneath its configured boundary,
symlink or hard-linked state files, unsafe summary references and unknown
metadata/transcript/summary versions. Host-selected external storage remains
supported; repository configuration cannot enable it. Atomic replacement syncs
the file and directory. An I/O error after rename can leave the new complete
state visible while the caller receives an error: recovery must reread the
durable revision instead of assuming rollback. These checks do not isolate the
CLI from a hostile process running as the same OS user.

### Planning evaluation

Planning mode uses a separate planning instruction set and refuses task claims,
execution verification and goal completion at the permission gate, even if a
model fabricates a call to an unadvertised tool. It records plans and decisions
while leaving the future implementation goal open.

`eval/PlanningCorpusRunner.runPlanningCorpus` runs six bounded planning probes
through the real session controller, configured provider and `plan` permission
profile. It accepts `configPath`, a new `outputRoot`, optional `caseIds`, `effort`
and cancellation `signal`. Use a frozen package installation and retain its
manifest; the runner refuses configuration or compiled-client changes between
cases. It does not publish, execute a planned task or modify the supplied
production repositories.

The probes cover additive migration, artifact recovery, embedding-space changes,
worker fencing, connector authorization and usage accounting. Grading checks
durable requirement IDs/text, ownership, dependency reachability, narrow paths,
phases, constrained architecture choices, original intent, workspace preservation
and compaction/resume. Invented criteria and premature completion fail. The
grader's reference plans and dependency answers stay outside model workspaces;
mutation tests deliberately break each major contract.

These are closed-world planning probes with explicit criterion labels and
architecture options. Rationale grading checks presence, not its semantic
quality. Docdex is disabled because the probes contain no code; retrieval,
implementation, multi-hour retention, helper benefit and unrestricted architecture
quality require separate evidence. Reports retain failures, routes, usage and
the actual work record. A rerun used to debug a failure is diagnostic evidence,
not a fresh held-out result.

### Workflow evaluation

Pass `terminalWorkflowCorpusDefinition()` from `eval/TerminalWorkflowCorpus`
as the `corpus` option to `runTerminalCorpus` to run twelve separate workflow
fixtures. Eight require coordinated changes in two modules and public regression
tests. Three require source-backed repository reports, and one researches pinned
fictional vendor documents. Report tasks permit only the report file to change;
their tests and source files remain immutable. This research fixture does not
measure live web retrieval.

Each corpus owns its version, content hash, task list and stated limitations.
Reference implementations and hidden assertions stay outside the agent's
workspace. The isolated grader checks behavior, public test outcomes, required
test extensions, protected files and exact change scope. Reference/starter checks
and deliberately wrong reports, test weakening and unauthorized edits validate
the grader before live runs. Retain the frozen installed client and configuration
with every result. First attempts are qualification observations; corrective
reruns must be labeled diagnostic, with the original failures preserved.

`eval/LongWorkflowJourney.runLongWorkflowJourney` composes four module contracts
into one durable goal. Select `data-delivery`, `service-adapters`, `billing-audit`
or `localized-export`, and supply `configPath` and a new `outputRoot`. Four child
processes perform planning, execution to a verified-task checkpoint, resumed
execution with an additional delivery requirement and concurrent user notes,
then final recovery. Five explicit compactions are required. Each boundary
compares the exact durable state; final grading checks the original requirements,
architecture history, dependency ordering, protected notes and module artifacts.

These journeys reuse coding contracts and measure continuity separately from
fresh coding accuracy. They retain failed stages instead of automatically
retrying them. `multiHourDurationReached` reports whether actual elapsed work
reached two hours; the runner never inserts idle time. Clean checkpoint recovery
does not replace crash/uncertain-side-effect fixtures or mixed-media tests. The
host-owned child launcher passes declared provider credentials to the CLI process
only; model-requested shell tools retain their separate restricted environment.

Focused replanning can use `work_plan` with `mode: "update"`: only the named
contracts change, and omitted tasks and phases remain canonical. The default
`replace` mode still requires the full plan. Both modes enforce required
coverage, verified task/phase immutability, dependency validity and the single
active writer rule.

Host-issued tool receipt references survive model-context truncation. Shell
receipts and independent-review excerpts preserve the beginning, a detected
failure region, and the end of bounded output; omission markers never imply
that an unretained full log is available. Successful test exit status remains
separate from whether the tests prove the requested behavior.
