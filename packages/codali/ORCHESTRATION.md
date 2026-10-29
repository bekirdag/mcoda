# Orchestration configuration

## Native tools, skills and bounded context

The terminal controller exposes native function calls to capable configured models.
Read-only inspection uses Docdex for repository search, source reads and structural
analysis, and `docdex_web_research` for external research. Local searches use the
index-only batch endpoint; they cannot silently trigger web or model fallback.
Web calls pass the permission gate before starting the private Docdex runtime.
With an mswarm lead, discovery uses a capability-authenticated bridge owned by the
controller; the service credential is never written into the private daemon config.
An empty result does not automatically replay a metered web request.
Discovery links remain separate from fetched evidence, and generated summaries
are labeled. Nested Docdex inference respects its requested output limit and
cannot spend the token/call reserve needed for a final answer.
After the first native tool choice, inspection keeps related capability schemas
in context; other read tools remain available through discovery and explicit
enabling. This reduces repeated context without classifying prompts by keywords.

`server_time` reads the execution host clock, with UTC, Unix milliseconds and an
optional IANA timezone. `calculate` evaluates bounded numeric expressions without
running code. `browser_open` reads a rendered accessibility snapshot in an isolated
Chrome/Chromium process; `browser_read` pages through that captured snapshot without
another network request. The default snapshot covers the page's main landmark
when available; `scope: "page"` requests the whole page. Results retain valid bounded JSON and pagination
handles within the inspection loop's output limit.
Set `CODALI_BROWSER_PATH` to an absolute executable path
if automatic discovery cannot find Chrome. Browser navigation requires web
permission (`--allow-web` or an interactive approval); the planning permission
profile continues to allow read operations only. Browser contexts have no login
profile, block POST/form submissions, downloads, service workers and WebSockets,
and close after each navigation. Page content is untrusted evidence. This browser
surface supports reading and following URLs, not arbitrary browser automation.

Use `/skills` to inspect available `SKILL.md` packages. Codali discovers its bundled
planning skill, workspace `.codali/skills` and `.agents/skills`, and user
`~/.codali/skills`, `~/.agents/skills`, `~/.codex/skills` and `~/.claude/skills`.
Additional roots are configurable:

```json
"skills": {
  "enabled": true,
  "directories": ["~/shared-agent-skills", ".team/skills"]
}
```

Discovery is bounded to 128 skills, 256 directories and three directory levels.
Each text resource is limited to 64 KiB. Standard YAML `name` and `description`
metadata are required; optional `compatibility` is shown with the actual host
platform. A small workspace/builtin catalog enters tool-capable prompts;
`skill_list` discovers imported packages, `skill_load` reads instructions, and
`skill_read` retrieves referenced text in pages. Exact IDs disambiguate duplicate
names. Resources cannot escape their skill directory through traversal or
symlinks. Scripts and hooks never run automatically, and `allowed-tools` metadata
does not grant permission. A Mac-specific skill still needs its declared platform
and tools; loading its text does not provide those dependencies. Configuration
reload refreshes the skill roots.

The bundled planning skill uses durable goals, task dependencies, allowed paths,
decisions and verification receipts. Planning mode records future work and leaves
the implementation goal open. If inference budget runs out after a plan was
saved, the controller shows that record with an explicit partial-work notice;
it does not mark implementation complete. Markdown tables render as aligned boxes in the TUI,
or labeled fields on narrow screens, including in command overlays.

All model routes account for message content, tool schemas, response format,
reserved output and a context margin before dispatch. Near the configured model
window, deterministic compression shortens earlier assistant/tool content while
preserving user/system messages and native call/result identities. Conversation
history uses the same extractive approach instead of silently discarding older
user constraints. Abbreviated content identifies a saved source; `context_read`
recovers it in bounded pages or exact `offset`/`maxChars` spans, including after resume or conversation fork. Full
originals remain in the redacted private event transcript. The canonical work
record retains goals, requirements, decisions, pending tasks and verification
evidence. Compression makes no additional model calls and is not a semantic
summary. If immutable instructions and schemas cannot fit, the request fails
before dispatch with an actionable error rather than dropping constraints.

Design references: [Agent Skills specification](https://agentskills.io/specification),
[Playwright browser contexts](https://playwright.dev/docs/api/class-browsercontext),
[Playwright accessibility snapshots](https://playwright.dev/docs/api/class-page#page-aria-snapshot),
and [Browser Use browser configuration](https://docs.browser-use.com/open-source/customize/browser/basics).
These additions require separate installed/live qualification; the completed
original and R1 benchmark results remain frozen and did not pass quality promotion.

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
The CLI checks the proxy's authenticated model catalog before dispatching inference.
Discovery, authentication, capability and context refusals release provisional
token reservations and persist a `not_dispatched` receipt across resume. Failures
after the transport handoff retain provisional usage until server reconciliation.
Read-only model and native-capability discovery may retry an explicit temporary
service failure twice, with bounded backoff. Authentication, entitlement, quota
and malformed-response failures are not retried. Server backoff longer than five
seconds is returned to the caller; inference submissions are never replayed by
this discovery policy.
The selected model must advertise `native_reasoning.transport_version: 1`
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

The terminal loads its packaged `config/AGENTS.md` guide, optional
`~/.codali/AGENTS.md` user instructions, `.codali/instructions.md`, workspace
`AGENTS.md` files from the root through focused directories, then
`.codali/local.md`. More specific instructions take precedence within their
scope; none can widen host permissions or authorize unrelated actions. These
instructions also apply to ordinary conversation and explanations. The
dispatcher receives the short general part of the packaged guide; investigation
and execution receive its Docdex recipes. User/workspace instructions remain
intact. Sources, scopes and content hashes are recorded in `instructions_loaded`
events and shown in session status. Instructions reload at turn boundaries and
when execution changes its focused paths.

Instruction files must stay within their source directory boundary, be regular
files of at most 64 KiB, and fit a combined 24,000-character prompt budget.
Oversized bundles fail explicitly before inference; move supporting material
into linked documents instead of relying on silent truncation. Repository
instruction symlinks cannot disclose files outside the workspace.

Read-only investigations can use permitted Docdex search, source, structural and
continuity tools. The managed daemon starts only when the model requests a
Docdex tool; greetings and direct file reads do not start it. Indexing and
embedding usage share the turn budget. Host-denied calls cannot start the daemon.
An unavailable index leaves permitted ordinary file reads usable and is reported
as missing evidence. Inspection never exposes indexing commands, memory writes,
shell execution, delegation or work mutations. External research requires an
advertised tool and the existing web permission.

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
If a provider returns an explicit rejection with one finding as a string, the
controller retains that finding as a one-item list so the agent can repair the
defect. This normalization cannot turn a malformed approval into acceptance.

Review begins with separate specification-only calls, before implementation,
tests, diffs or claimed results are supplied. Each source is presented as a
lossless array of excerpts. The model selects a source ID and zero-based excerpt
index; the controller supplies the exact quotation, preserving whitespace and
Unicode boundaries. Invalid indexes, conflicting quotations and omitted sources
cannot establish acceptance. Legacy quoted responses remain valid only when
their text occurs verbatim in the identified source. Large
contracts use at most sixteen bounded source groups, with every original source
retained as context in every call. Text already contained verbatim in the current
goal is supplied once; all canonical criterion IDs remain in the actual review.
The review checklist stores repeated quotations once per source and retains each
check with a reference to that exact quotation; no expected behavior is dropped.
One format repair per group is permitted; invalid source attribution or missing coverage
cannot establish acceptance. The checklist supplements the full original
contract and does not prove correctness. Both preparation and source review use
the smaller of the configured effort output limit and reviewer model limits,
reserving that output space in the smallest compatible context window. Native
reasoning settings remain in the model configuration; no host defaults change.
Terminal review requests plain model output and strictly parses the JSON protocol
locally. This preserves the received response and usage when a model emits invalid
JSON; a native structured-output validator would otherwise reject it before the
controller can inspect it. Source review permits one format-only repair with the
complete original authority retained, at most six calls including four source
rounds and a verdict. This does not retry unknown transport failures or turn an
invalid or contradictory approval into accepted evidence. Explicit native
`structured_output_failed` errors elsewhere are classified as `invalid_response`
without exposing upstream response content.

The reviewer can request additional source pages before deciding. Requests are
read-only and restricted to the current review paths; each page rechecks the
validated file hash. Four request rounds, eight pages per round and the smallest
configured reviewer context bound the process. Every model call shares the
session's usage and effort budget. Repeated requests, exhausted context, missing
evidence or edits during review cannot establish acceptance. Secrets are redacted
before paging, including credentials that cross page boundaries.
Omitting a source-request offset continues at the controller's exact unread
cursor, including an initial page shorter than 8,000 characters. Whole-goal
reviews reference repeated requirement text by its exact position in the intact
goal and identify the checked snapshot with one digest. Full per-file hashes
remain in controller validation and durable evidence; this saves prompt space
without summarizing the contract or relaxing freshness checks.

Ordinary task review includes its assigned requirements, owned changes and diff,
plus relevant read-only dependencies. Other tasks' pending deliverables remain
in the canonical backlog. A task assigned the original whole-objective criterion
receives the complete current goal and all changes for integration review.
Both review scopes retain the same global validation and source-freshness checks.
Whole-goal integration also reviews every canonical refined criterion. When all
other active tasks are already verified, the controller first reassesses each
owner's criteria and read dependencies against the final files. It then supplies
those successful assessments, bound to one full-workspace digest, to the final
integration review and to later scoped reassessments, such as delivery inventories.
Assessed module source remains available for hash-checked
paging; only remaining source and diff are loaded initially. Initial source
allocation reserves context space for later pages. Original requirements,
constraints, architecture decisions and cross-task interactions still govern
integration acceptance. A failed scoped assessment stops the sequence without
renewing any proof. Only an accepted final-tree integration review records
new full-snapshot proofs for those owners, linked to the shared integration
assessment and their prior evidence. Original proofs remain in the audit trail.
An assigned-task review cannot renew siblings; partial coverage, unfinished or
reopened work, stale revisions, and omitted tracked inputs cannot use this path.
Any later change to the assessed files still invalidates completion.

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

Workflow corpus v5 additionally checks immediate dispatch stopping on synchronous
worker throws, waiting for already-started workers, and preserving falsy thrown
values. This closes a gap found by live review: public async-only coverage had
accepted a faulty pool. Earlier frozen runs retain their original version, hash
and outcomes; regrading known artifacts is diagnostic evidence.

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

## Terminal interaction dispatch and audit

Natural-language terminal messages first pass through a bounded semantic
dispatcher. It uses recent conversation and the active goal to choose a direct
answer, stronger no-tool answer, read-only investigation, action, or clarification.
It does not match a list of phrases. Conversation does not initialize a work
record, repository index or verification loop. Side questions preserve active
work. Action requests retain the original text and relevant conversation beside
the prepared brief; the brief cannot grant permissions or replace constraints.

`codali setup` configures the evaluated local Qwen3 4B Instruct route as `intent`
when it is advertised and healthy, with configured Strata candidates as fallback.
The older `router` binding used by automation is unchanged. Existing profiles
without an `intent` binding use a bounded lead call until the operator configures
one. No model is downloaded automatically.

The optional `interaction` object accepts:

```json
{
  "routerBinding": "intent",
  "answerBinding": "lead",
  "promptVersion": "my-interaction-v1",
  "maxInputChars": 24000,
  "historyChars": 6000,
  "maxOutputTokens": 768,
  "maxTotalTokens": 16000,
  "maxModelCalls": 8,
  "maxInspectionSteps": 6,
  "timeoutMs": 90000
}
```

Optional `routerPrompt` and `answerPrompt` strings replace the built-in prompts.
`routerResponseFormat: "json_schema"` optionally sends a native schema for the
five decision modes and a bounded string brief. The default remains JSON-object
mode for adapter compatibility. The selected endpoint must support the schema;
there is no automatic downgrade or replay after a rejected request. Output is
still parsed and validated because a schema does not establish correct intent,
and a response can be truncated or an endpoint can ignore the constraint.

`answerReview: { "enabled": true, "binding": "reviewer", "maxOutputTokens": 2048 }`
adds one revision pass to `reason` answers. It sees the original request,
conversation, applicable instructions and untrusted draft, and has no tools.
The pass shares the existing call/token/deadline limits; it is skipped when
there is insufficient budget. A failed optional check records its failure and
returns the original draft unless the user cancelled. It never changes a
greeting, claims independent verification, or runs automatically by default.
Use measured quality and latency results before enabling it.

`calculator: true` experimentally exposes the pure `calculate` tool only during
`reason` turns whose dispatcher returns `tools: "available"`. It is off by default. The model chooses whether to use it; the
dispatcher does not match arithmetic keywords or a list of request types.
It receives a capability note so requests requiring calculator verification
reach reasoning mode; the recorded router-prompt hash includes that note.
The tool accepts numeric expressions, parentheses, powers, signed remainder
and a small set of arithmetic functions. It cannot execute code, access files
or use the network. Expressions are limited to 4,096 characters, 1,024 tokens,
32 levels of nesting and 128 function arguments. Nonfinite results and unsafe
integers are rejected. Floating-point results are not exact decimal arithmetic.

Calculator calls honor host/repository tool restrictions, consume the shared
tool budget and create ordinary invocation receipts. The loop reserves capacity
for a final answer; greetings still use no tools. When answer review is also
enabled, it receives the actual calculation requests and results. A calculator
can verify an expression, but it cannot establish that the model chose the
correct formula, units or interpretation. Enable it only after evaluating that
tradeoff with the intended model and workload.

The router returns `{"mode":"answer","text":"Hello!","tools":"none"}` with mode
one of `answer`, `reason`, `inspect`, `execute`, `clarify`. For delegated modes,
text is a task brief of at most 500 characters, not a proposed solution. Invalid
output gets one bounded repair attempt; it cannot start execution. Model bindings
still enforce catalog entitlement, backend identity and context capacity.

The dispatcher interprets `tools` from the original request and conversation;
it is `none` or `available`. The host withholds tools for `none`, converting an
inconsistent inspection/execution decision into a tool-free answer. `available`
does not override host or repository permissions. Older two-field decisions
remain readable, but cannot enable the optional calculator. The runtime appends
this contract to custom router prompts and records the effective prompt hash.
This model-derived restriction still needs semantic evaluation; it is not proof
that every natural-language prohibition was understood correctly.

Session totals accumulate, while turn budgets restart per message. Unknown
remote outcomes retain their token reservations until reconciled. Execution
continues to use the selected effort budget and existing completion gate.

Private session `transcript.jsonl` records `interaction_request`, `model_request`,
`model_response`, and `interaction_result` or `interaction_failed`. Correlation
IDs, actual message/tool payloads, configuration and prompt hashes, model routes,
token receipts and final outcomes support later investigation. Registered
credentials and recognizable token formats are redacted; files have private
permissions and stay outside the repository. No training or log upload is enabled.
Cancellation may leave a remote model outcome unknown; the log preserves that
reservation rather than inventing a response or zero usage.

The reproducible conversation, code-answer and repository-inspection study is
documented in [`docs/benchmarks/codali-1000/README.md`](../../docs/benchmarks/codali-1000/README.md).
Its independent code checks and rubric reviews supplement the existing terminal
editing and long-workflow suites; they do not replace those release gates.
