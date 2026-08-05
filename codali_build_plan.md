# Codali Orchestrator — Build Plan (v2)

Source requirements: `codali_workflow.txt`
Prior design: `docs/planning/codali-agentic-orchestration-gateway.md`, `docs/planning/codali-agentic-orchestration-gateway-build-guide.md`
Target: make `codali` a standalone, general-purpose orchestrator that okacam AI chat, line items, badges, and employee-log review can all call, instead of each product rebuilding its own agent loop.

> **v2 supersedes v1.** v1 was reviewed and rejected as over-abstracted: it turned a small orchestrator into a second platform (12 configurable agent roles, four nested loops, two tool registries, four provisioning implementations, a credential broker, generic OpenAPI compilation, multi-tenant pools, vector retrieval over tool descriptions). That conflicted with the "plain, simple and strong" requirement in `codali_workflow.txt:16`. v2 adopts the review. §10 records what changed and why.

---

## 1. Verdict after reading the codebase

The orchestrator described in `codali_workflow.txt` is **already largely built** inside `packages/codali/src/gateway/`. It compiles clean (`pnpm --filter @mcoda/codali run build` passes on `0.1.108`; ~83k LOC in `src/`).

What it is **not** is *reachable*, *connectable*, or *bounded*:

- No CLI entry point — you cannot ask it a question from a terminal today.
- It cannot connect to a tool by itself. Every external tool must be injected by the calling application.
- The planner is told tool **names** but never tool **descriptions or schemas**.
- Iteration is owned by two components at once, nested.

This is not a rebuild. It is: wire it up, bound the loop, give the planner real tool knowledge, and add one connector standard.

---

## 2. What already exists (do not rebuild)

### 2.1 The orchestration gateway — `packages/codali/src/gateway/`

| File | Role |
|---|---|
| `CodaliGateway.ts` (1193 L) | `runCodaliGateway(request, options)` — plan → workers → synthesize |
| `GatewayPlanner.ts` (1027 L) | Classifier + planner stages, JSON-schema constrained, with repair retries |
| `GatewayStateMachine.ts` (1493 L) | Worker task execution, iteration, verification, follow-up tasks, budgets |
| `AgentTierResolver.ts` (795 L) | Maps agent roles onto the mcoda agent inventory by tier/capability |
| `ToolCapabilityCompiler.ts` (714 L) | Compiles allowed/denied/visible tool sets from policy |
| `GatewayPolicyCompiler.ts` | Normalizes policy, limits, docdex operations |
| `EvidenceNormalizer.ts` (668 L) | Raw worker output → typed evidence with provenance |
| `ContextPackBuilder.ts` | Ranks + compresses evidence for the synthesizer |
| `GatewaySecurityPolicy.ts` | Prompt hardening, tool risk categories, tenant limit profiles |
| `GatewayTraceReplay.ts` | Run trace, replay fixtures |
| `CodaliGatewayStore.ts` | Run/task/evidence persistence abstraction |

`AgentTierResolver.ts:106-117` defines 12 roles, **each with a working default**. v2 does not delete them — it stops requiring them to be *configured*. See §4.1.

### 2.2 Execution runtime — `packages/codali/src/runtime/`

`CodaliRuntime.ts` (2734 L) runs a tool loop over a validated registry (`tools/ToolRegistry.ts` — JSON-schema arg validation, typed error codes): filesystem, diff, search, shell (gated off in gateway mode), **27 docdex tools**, plus dynamic app tools.

### 2.3 Docdex — `packages/codali/src/docdex/DocdexClient.ts` (1357 L)

HTTP + MCP-over-HTTP client, repo binding, capability negotiation, **encrypted repo support** (`/v1/docdex/encrypted`, `x-api-key`, `allowedOperations` enforcement). Local→web waterfall via `docdex_web_research`.

### 2.4 Providers

`OpenAiCompatibleProvider`, `OllamaRemoteProvider`, `MswarmWorkerProvider`, `ClaudeCliProvider`, `CodexCliProvider`, behind `ProviderRegistry`.

### 2.5 Downstream

Dataset collection, privacy engine, eval suites, regression gates, improvement/fine-tune planning, live Suku harness. `packages/mswarm/src/codali-executor.ts:2258` calls `runCodaliGateway` for cloud jobs.

---

## 3. Gap analysis — requirement vs. reality

| # | Requirement | Status | Gap |
|---|---|---|---|
| G1 | "build codali locally first… ensure it works on the terminal" | ❌ | `cli.ts` exposes run/fix/review/explain/test/eval/dataset/improvement/learn. **No gateway command.** |
| G2 | "flexible api/mcp tool connections" | ❌ | **Zero MCP client code.** Only docdex's own MCP endpoint is spoken. |
| G3 | "talk to… github, jira, microsoft etc." | ❌ | Only `AppToolGatewayDispatcher` — a signed proxy back to one endpoint the calling app must implement. Codali owns no connector. |
| G4 | "perfectly understand what tools and what tool features are available" | ⚠️ | `GatewayPlanner.ts:32` accepts `toolDescriptions`; `CodaliGateway.ts` **never populates it**. Planner sees bare names. |
| G5 | "codali llms configurable with mcoda agents" | ⚠️ | `AgentTierResolver` is complete, but nothing loads `mcoda agent list --json` into `agentInventory`. mswarm passes one agent, so multi-role resolution never happens. |
| G6 | Answer simple questions without the synthesizer | ❌ | Classifier emits `directAnswerCandidate` (`GatewayPlanner.ts:449`); nothing consumes it. |
| G7 | "image generation llm connected to codali" | ⚠️ | `image_worker` role, `"image"` tier, `maxImageArtifacts` budgets exist. **No image provider, and no `artifacts` field on the result.** |
| G8 | "connect to docdex encrypted server repos" | ⚠️ | Client support complete; no config path wires base URL + mswarm API key. |
| G9 | "standard… whatever other ai systems use" | ❌ | Tool contracts are a bespoke mcoda shape. |
| G10 | One tool serving okacam chat / line items / badges / daily logs | ⚠️ | Reachable only as an mswarm cloud job. No stable API surface. |
| G11 | Tools/config resolved **per tenant, dynamically from the product** | ❌ | Tenant scope exists (`request.tenant`, tenant limit profiles at `GatewaySecurityPolicy.ts:150-183`, tenant-scoped evidence). Tool config is **static per process** — one process cannot serve two tenants with different tools. |
| G12 | Callers get a predictable, schema-conformant result | ⚠️ | `CodaliGatewayResponsePolicy` has `format`/`schema`/`finalAnswerRequired`, and `CodaliGatewayResult` already carries status/answer/sources/confidence/evidence/trace. But only `response.format === "json"` is read (`CodaliGateway.ts:331,736`) — **`response.schema` is accepted and never validated**, and there is **no `artifacts` field**. |
| G13 | Bounded, debuggable iteration | ❌ | **Iteration is nested.** `createGatewayTaskRunner` (`codali-executor.ts:2080`) runs each gateway worker task through `runCodali` — the full `CodaliRuntime` tool loop with its own `maxSteps`/`maxToolCalls`. So the gateway's round loop wraps a per-task agent loop. Two components own iteration; neither can bound the other. |

Four structural notes:

- **Codali is a library with one caller.** Built for mswarm's cloud job path, not as a thing you run.
- **Tool connectivity is inverted.** Today: app declares tools → pushes them in → codali proxies back. Needed: codali connects, discovers, and offers to any product.
- **Tool configuration is static per process.** Multi-tenant needs it resolved per request.
- **Nobody owns the loop.** G13 is the highest-risk item and is fixed first.

---

## 4. Architecture

```text
Request (messages, runContext, responseSchema?)
  │
  ▼
Orchestrator  ── one model, three prompts (route/plan, assess, repair)
  ├─ answer now              → canAnswerNow = true
  ├─ ask for clarification   → needsClarification
  └─ emit structured tasks
          │
          ▼
Deterministic Executor  ── code, not an LLM
  ├─ validates every call against ONE ToolRegistry
  ├─ runs independent read-only calls in parallel
  ├─ enforces budgets and tenant scope
  └─ normalizes results into evidence with provenance
          │
          ▼
Orchestrator assessment  ── complete | partial | more tasks (max 2 extra rounds)
          │
          ▼
Finalizer
  ├─ deterministic formatter  — single clean structured result
  ├─ synthesizer (large model) — multiple / conflicting / unstructured sources
  └─ artifact formatter        — media
          │
          ▼
CodaliResult { status, output, sources, artifacts, warnings, traceId }
```

Design rules:

1. **One iteration owner.** The orchestrator decides whether to continue. The executor runs a validated batch and returns. Hard caps: `maxRounds: 3`, `maxToolCalls: 20`, `deadlineMs`. No "iterate until happy."
2. **One tool registry.** `ToolRegistry` is the single source of truth. The model-facing catalog is a *derived view*, never a second store — otherwise the planner sees one schema and the executor uses another.
3. **The internal tool contract is neutral, not MCP-shaped.** MCP is an adapter into it, so codali's internals aren't coupled to MCP's evolution.
4. **Everything is finished.** No path returns raw tool output to a user.
5. **Tool config is resolved, not read.** One seam (`RunContextResolver`); the host supplies context. No callback into the product.
6. **Credentials never touch a prompt or disk.**

### 4.1 Model roles: four configurable, not twelve

```text
orchestrator   route + plan + assess completeness + repair
worker         make the tool calls
synthesizer    multi-source answers
media          image / artifact generation
```

`worker` was added on 2026-08-05 after measuring real runs (§15). Tool calling
and planning have different needs: planning wants speed because it happens on
every question, tool calling wants accuracy because bad arguments mean the run
gathers nothing. Leaving `worker` unset makes it follow the orchestrator, so
the common case is still a two-line config.

"Classifier", "planner", "verifier", "repair" stay as distinct *prompts* against the orchestrator model. The 12 roles in `AgentTierResolver` keep their defaults and remain available for advanced tuning, but **only these three appear in configuration**, and unset roles resolve by tier as they do today. The tool executor is deterministic code — never a fourth model.

### 4.2 Tool contract

Extend the existing `ToolRegistry` entry rather than adding a parallel type:

```ts
interface Tool {
  id: string;                       // "docdex.search", "github.list_issues"
  description: string;
  inputSchema: JSONSchema;
  outputSchema?: JSONSchema;        // not a `resultContract` string
  readOnly: boolean;
  capability: string;               // "github" | "jira" | "docdex" | "web" | "media"
  execute(ctx: RunContext, args: unknown): Promise<ToolResult>;
}
```

Sources adapt *into* this:

```text
Built-in tools ─┐
Docdex tools    ├─→ ToolRegistry ─→ (derived) model-facing catalog
MCP tools       ┤
HTTP tools      ┤
Image models   ─┘
```

### 4.3 Two-level tool exposure

Sending every allowed tool's full schema to the orchestrator does not scale, so exposure is hierarchical:

1. **Capability selection** — the orchestrator first sees one line per capability:
   ```text
   github  — repositories, commits, pull requests, issues
   jira    — projects, tickets, users, sprints
   teams   — messages, meetings, transcripts
   docdex  — repository index and organizational memory
   web     — current external information
   media   — image generation
   ```
2. **Tool selection** — once it picks `github` and `jira`, only those capabilities' full tool schemas are expanded.

No BM25, no embeddings, no second retrieval index. Semantic tool retrieval is added only if real tests show hierarchical selection failing.

### 4.4 Plan shape

Route is not an enum — the concepts are independent (code generation may need repo tools; a direct answer may need a web tool):

```ts
interface Plan {
  outputType: "text" | "json" | "artifact";
  tasks: Task[];
  canAnswerNow: boolean;
  needsClarification?: string;
}
```

| Example (`codali_workflow.txt`) | outputType | tasks | canAnswerNow |
|---|---|---|---|
| #1 pingpong code | `text` | `[]` | `true` |
| #2 GDP of France | `text` | one `web` task | `false` |
| #3 puppy image | `artifact` | one `media` task | `false` |
| #4 Bekir's performance | `text` | several connected-tool tasks | `false` |

Image generation is therefore a normal model-backed **tool** returning an `ArtifactRef` — not a separate orchestration pipeline.

### 4.5 Request and result contract

`CodaliGatewayResponsePolicy` and `CodaliGatewayResult` already cover most of this (G12). The work is **enforcement plus artifacts**, not a new contract:

```ts
interface CodaliRequest {
  messages: Message[];
  runContext?: RunContext;          // tenant, repo, tools, credentials — resolved by host
  responseSchema?: JSONSchema;      // exists on the request today; currently ignored
  responseMode?: "text" | "json" | "artifact";
}

interface CodaliResult {
  status: "complete" | "partial" | "needs_clarification" | "failed";
  output: unknown;                  // validated against responseSchema when present
  sources: SourceRef[];
  artifacts: ArtifactRef[];         // NEW — no artifacts field exists today
  warnings: string[];
  traceId: string;
}
```

Validate `output` against `responseSchema` in the finalizer, with one repair attempt on failure and `partial` if it still fails. Without this, every consuming product writes its own parsing and correction logic — exactly the duplication codali exists to remove.

### 4.6 Run context: one seam

```ts
interface RunContextResolver {
  resolve(request: CodaliRequest): Promise<RunContext>;
}
```

- **Local CLI** — resolves from trusted user config (`~/.codali/config.json`).
- **Embedded in a product** — the host passes `runContext` directly on the request. okacam looks up the tenant's MCP servers, connector configs, and credential references in its own database and hands them over per request.

This satisfies the per-tenant requirement — tool config is resolved per request from the product, never read from a file on the codali host — **without** codali calling back into the product. A callback would create a circular distributed dependency (`product → codali → product → credentials`) plus the caching, invalidation, and failure-mode machinery that comes with it. The authenticated host already holds this data; it should pass it.

Remote provisioning callbacks, a credential broker, and per-tenant connection pools are deferred until a real product integration proves they are needed (§8).

### 4.7 Trust boundary for configuration

A checked-out repository must never be able to make codali execute a command or reach a new endpoint:

| Config source | May define |
|---|---|
| **User / host** (`~/.codali/config.json`, host-supplied `runContext`) | executable MCP servers, URLs, credentials, agent bindings |
| **Repository** (`.codali/config.json`) | *only* narrowing of allowed tools, repo context identification, harmless formatting defaults |

Repo config that attempts to define `command`, `args`, `env`, `url`, or credentials is **rejected with a warning**, not merged. Enabling executable repo config requires an explicit, recorded trust action.

Equally: in service mode a tenant ID from a request body or header is **not authoritative**. It must be derived from, or cryptographically bound to, the authenticated caller.

---

## 5. Build plan

### Phase 1 — Working vertical slice ✅ **COMPLETE** (2026-08-04)

> Delivered and verified live. 911 unit tests pass; `@mcoda/codali` and `@mcoda/mswarm` both build.
> `codali ask "Which file defines the CodaliGatewayPlanner class?"` returns
> `packages/codali/src/gateway/GatewayPlanner.ts` with an evidence citation, after
> 3 real docdex tool calls. See §12 for what was found along the way.

**Goal:** one complete path end to end. Not a CLI wrapper — a working orchestrator.

- `codali ask "<query>"` running the gateway **in-process**.
- Resolve only **`orchestrator`** and **`synthesizer`**. Load the mcoda agent inventory **once at startup** — never shell out to `mcoda agent list` per query.
- Use the existing `ToolRegistry` and the existing **native** docdex tools. No MCP yet.
- **Populate `GatewayPlannerInput.toolDescriptions` from the registry** — the one-line gap that blinds the planner (G4).
- **Collapse the nested loop (G13).** The gateway owns rounds; the task runner executes one validated task or batch and returns. `CodaliRuntime` must not independently decide to keep researching. Enforce `maxRounds: 3`, `maxToolCalls: 20`, `deadlineMs`.
- Introduce `CodaliResult` with `status` / `output` / `sources` / `artifacts` / `warnings` / `traceId`, and **enforce `responseSchema`** in the finalizer.
- Add the `RunContextResolver` seam with the local-config implementation.
- **Minimal tracing, in this phase — not deferred.** Every run prints, and records: selected plan, model used per step, tools selected, sanitized arguments, tool latency and status, round number, completion reason. Without this, tool-selection and iteration failures are near-undiagnosable.

**Acceptance:**
```sh
codali ask "Write me a simple html/js pingpong game"    # canAnswerNow, no tools
codali ask "Where is the gateway planner defined?"      # docdex search, cited
codali ask "What is the GDP of France in 2025?"         # web research, cited
```
Plus: a run that exceeds budget returns `partial` rather than fabricating; a request with `responseSchema` returns conforming JSON.

---

### Phase 2 — Minimal MCP ✅ **COMPLETE** (2026-08-04)

> Delivered and verified live against a real MCP server. 968 unit tests pass;
> both packages build; `pack:verify` and the npm publish dry-run pass with the
> first real dependency. See §13.

**Goal:** connect to real external tools using the standard.

- Add the official `@modelcontextprotocol/sdk` — codali's first third-party runtime dependency. Re-run `pnpm --filter mcoda run pack:verify` and the npm publish dry-run in this phase; **pin the SDK/protocol version** and add compatibility tests rather than hand-implementing protocol lifecycle.
- Implement **`tools/list` and `tools/call` only.** Resources and prompts are deferred — no stated example needs them.
- Transports: the SDK's **stdio** and **Streamable HTTP**. Do not build a separate legacy HTTP+SSE transport; current MCP carries SSE within Streamable HTTP where needed.
- Adapt discovered tools into the existing `ToolRegistry` (namespaced `mcp:<server>:<tool>`), preserving `inputSchema` and `outputSchema`. **MCP tool annotations are hints from the server and are not trusted for security decisions** — read-only status is decided by codali policy, not by the server's self-description.
- One real connection: the **official GitHub MCP server** (hosted remote, or the official local Docker server). The old npm `@modelcontextprotocol/server-github` package is unsupported and must not be used.
- Timeout, one retry, global concurrency limit. All external connector operations **read-only** in this phase.
- Apply the §4.7 trust boundary: repo config cannot introduce MCP servers.
- Secret redaction ships **with** the first connector, not in a later phase — extend `ContextRedactor` and `CodaliDatasetPrivacyEngine` here.

**Acceptance:** `codali tools list` shows discovered GitHub tools with descriptions; `codali ask "What are the open issues on <repo>?"` answers with citations; no configured secret appears in trace, evidence, or logs.

---

### Phase 3 — Bounded multi-source research ✅ **COMPLETE** (2026-08-04)

> See §14.

**Goal:** the hard examples, without unbounded work.

- Parallel execution of independent read-only tasks in the executor.
- Evidence normalization and source references across sources (reuse `EvidenceNormalizer`).
- **Maximum three orchestration rounds**, then `complete` / `partial` / `needs_clarification`.
- Relative dates ("last two weeks") resolved to absolute ranges at plan time and recorded in the trace.
- Hand-declared HTTP tools for APIs without a good MCP server:
  ```ts
  { id, description, method, urlTemplate, inputSchema, responseSelector, readOnly }
  ```
  Enough for a Jira, CRM, or Microsoft Graph operation. **No generic OpenAPI compiler** — see §8.
- Entity resolution ("Bekir" → "Bekir Dağ") and project-context expansion emerge as **tasks the orchestrator creates**, not new permanent pipeline stages. Ambiguity returns `needs_clarification`, never a guess.

**Acceptance:** Examples #4, #5, #6 from `codali_workflow.txt` answered against real GitHub + Jira, every claim traceable to an evidence item, within budget.

---

### Phase 4 — Media and product integration ✅ **COMPLETE** (2026-08-04)

> See §14.

- Image generation as a **normal tool** returning an `ArtifactRef`, backed by an OpenAI-compatible `/v1/images/generations` provider (works with `packages/mswarm/scripts/stable-diffusion-cpp-openai-server.py`). Bound via the `media` role.
- Freeze and document the canonical `CodaliRequest` / `CodaliResult` API as the product contract.
- A thin adapter matching the current AI-chat interface, **without changing AI chat**.
- Service mode (`codali serve`) **only after CLI behaviour is stable**, exposing the same result contract. Tenant identity bound to the authenticated caller (§4.7), never taken from a body field.

**Acceptance:** `codali ask "Generate an image of a puppy"` writes a PNG and returns an `ArtifactRef`; okacam AI chat gets the same result contract through the adapter as the CLI does.

---

## 6. Acceptance criteria — what we test

Tests assert outcomes, not internal choreography. Specifically we **do not** require an exact stage path, an exact tool-call count, a minimum number of iterations, or byte-identical CLI and service answers. A correct answer may need one round; requiring two teaches the system to waste calls.

Every scenario asserts:

- the question was actually answered
- claims carry source references
- no unauthorized tool ran
- the response respected `responseSchema` when one was supplied
- the run stayed within `maxRounds` / `maxToolCalls` / `deadlineMs`
- missing evidence produced `partial`, not fabricated certainty
- CLI and service expose the **same result contract** (not the same bytes)

---

## 7. Files touched

**New:**
```
packages/codali/src/cli/AskCommand.ts
packages/codali/src/cli/ToolsCommand.ts
packages/codali/src/runcontext/RunContextResolver.ts        # interface + local-config impl
packages/codali/src/gateway/Finalizer.ts                    # formatter | synthesizer | artifact
packages/codali/src/gateway/LocalGatewayProvider.ts         # lifted from mswarm
packages/codali/src/gateway/LocalGatewayTaskRunner.ts       # single-batch, non-iterating
packages/codali/src/agents/AgentInventory.ts                # loaded once at startup
packages/codali/src/connectors/mcp/{McpClient,McpToolAdapter}.ts
packages/codali/src/connectors/http/HttpToolDefinition.ts   # hand-declared tools
packages/codali/src/providers/ImageGenerationProvider.ts
```

**Modified:**
```
packages/codali/src/cli.ts                          # register ask/tools
packages/codali/src/tools/ToolRegistry.ts           # description, outputSchema, capability
packages/codali/src/gateway/CodaliGateway.ts        # toolDescriptions; rounds; finalizer; artifacts
packages/codali/src/gateway/GatewayPlanner.ts       # Plan shape; two-level tool exposure
packages/codali/src/gateway/CodaliGatewayTypes.ts   # artifacts on result
packages/codali/src/config/{Config,ConfigLoader}.ts # 3 roles; repo-config trust boundary
packages/codali/src/cognitive/ContextRedactor.ts    # connector secret patterns (Phase 2)
packages/codali/src/index.ts                        # public exports
packages/mswarm/src/codali-executor.ts              # shared factories; task runner stops looping
```

---

## 8. Deferred until demonstrated need

Each of these was in v1 and is removed. None is forbidden — each returns when a real integration proves it necessary.

| Deferred | Why | Trigger to revisit |
|---|---|---|
| Generic OpenAPI compiler | Imports hundreds of irrelevant operations, complex auth, pagination differences, huge schemas, unsafe writes | Hand-declared HTTP tools become burdensome across several connectors |
| Remote provisioning callback | Circular dependency `product → codali → product`; host already holds the data | A host genuinely cannot supply context at request time |
| Credential broker | Follows the callback | Same |
| Per-tenant connection pools, circuit breakers, cache invalidation endpoint | Only meaningful once one process serves many tenants concurrently | Service mode with real concurrent multi-tenant load |
| Vector/BM25 retrieval over tool descriptions | Hierarchical capability→tool selection should suffice | Measured failure of hierarchical selection |
| Automatic docdex memory writeback | Bad automatic writes permanently pollute future results | Explicit, reviewed writeback path |
| Full trace replay + dataset generation | Machinery exists; not needed to prove the loop works | After Phase 3 |
| MCP resources / prompts | No stated example needs them | A connector requires them |
| 12 configurable agent roles | Defaults are fine; configuring 12 is a burden | Tuning evidence shows a role needs its own model |

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Nested loops make runs unbounded and undiagnosable** (highest risk, G13) | Fixed first, in Phase 1: gateway owns rounds, executor returns after one batch, hard caps enforced |
| Planner and executor disagree on a tool's schema | One `ToolRegistry`; the catalog is a derived view with no state of its own |
| MCP spec churn breaks codali internals | Neutral internal contract; MCP is an adapter. Pinned SDK version + compatibility tests |
| MCP server annotations used for security decisions | Read-only status decided by codali policy, never by server self-description |
| Malicious repo config executes commands | §4.7 trust boundary: repo config may only narrow; executable keys rejected with a warning |
| Spoofed tenant ID in service mode | Tenant bound to the authenticated caller, never read from a body field |
| Secrets leaking into traces/datasets | Redaction ships with the first connector in Phase 2, not a later gate |
| Third-party payloads blow the evidence budget | `responseSelector` projection and size caps at the connector boundary |
| Scope creep back into a platform | §8 is the contract; each deferred item needs a stated trigger before it returns |

---

## 10. Changes from v1

| # | Review finding | Resolution |
|---|---|---|
| 1 | 12 configurable agent roles | **Adopted.** Three configurable roles (§4.1); a fourth, `worker`, was added later on measured evidence (§15). Existing roles keep defaults; the code is not deleted, the *configuration surface* is. |
| 2 | Multiple iterative loops | **Adopted, and it is worse than described.** Confirmed in code: `createGatewayTaskRunner` (`codali-executor.ts:2080`) runs each gateway worker task through the full `CodaliRuntime` tool loop. Fixed first, in Phase 1. |
| 3 | `ToolCatalog` duplicates `ToolRegistry` | **Adopted.** One registry; catalog is a derived view (§4.2). |
| 4 | Internal contract shouldn't be MCP-shaped; `outputSchema` not `outputContract` | **Adopted.** Reverses v1's design rule 2. |
| 5 | Don't send every full schema to the router | **Adopted.** Hierarchical capability→tool exposure (§4.3); BM25/embeddings deferred. |
| 6 | Route enum mixes concepts | **Adopted.** `Plan { outputType, tasks, canAnswerNow }` (§4.4). Image generation becomes a tool, not a pipeline. |
| 7 | Don't print raw tool output | **Adopted.** Finalizer with three modes (§4). |
| 8 | Caller-defined response schema missing | **Adopted with correction.** Not missing — `CodaliGatewayResponsePolicy` has `format`/`schema`/`finalAnswerRequired` and `CodaliGatewayResult` already carries status/answer/sources/confidence/evidence/trace. But only `format === "json"` is read (`CodaliGateway.ts:331,736`); **`schema` is accepted and never validated**, and there is **no `artifacts` field**. Work is enforcement + artifacts. |
| 9 | Tenant provisioning premature | **Adopted.** One `RunContextResolver` seam; host supplies context. Callback, broker, and pools deferred (§8). Note this changes what was agreed last turn — see below. |
| 10 | Repo config command-execution risk | **Adopted.** Explicit trust boundary (§4.7). A real vulnerability in v1. |
| 11 | Outdated MCP details | **Adopted.** `tools/list` + `tools/call` only; stdio + Streamable HTTP; pinned SDK; the unsupported npm GitHub server example removed. |
| 12 | Generic OpenAPI overkill | **Adopted.** Hand-declared HTTP tools (§Phase 3). |
| 13 | Docdex appears twice | **Adopted.** Native client only. Web fallback stays inside the search tool, not router logic. Memory writeback deferred. |
| 14 | Observability must be in Phase 0 | **Adopted.** Minimal tracing is Phase 1 acceptance, not deferred. |
| 15 | Tests reward complexity; three internal contradictions | **Adopted.** §6 rewritten. All three contradictions fixed: redaction now ships with the first connector; the early milestone no longer claims image generation; docdex is native-only. |

**One thing to confirm:** finding 9 walks back the dynamic tenant provisioning you asked for last turn. The requirement is still met — okacam resolves each tenant's MCP servers, connector configs, and credentials from its own database and passes them on the request, so nothing is read from a config file on the codali host. What is gone is codali *calling back* into okacam to fetch them, plus the broker, pools, and cache-invalidation machinery. If okacam cannot supply context at request time, say so and the callback source returns.

---

## 11. Immediate next step

Phase 1, as a complete vertical slice: one direct answer, one docdex search, one external web research request — with the loop bounded and tracing visible. No new platform abstractions before that works.

---

## 12. Phase 1 outcome (2026-08-04)

Delivered. 911 unit tests pass; `@mcoda/codali` and `@mcoda/mswarm` both build clean.

### What shipped

| Gap | Fix |
|---|---|
| G1 no CLI | `codali ask` runs the gateway in-process. `cli/AskCommand.ts` |
| G4 planner blind to tools | `CodaliGateway.plan()` now passes `toolDescriptors`; two-level capability→tool exposure in `gateway/ToolExposure.ts`. Docdex tool descriptions rewritten from "Search docdex index." to something a model can act on |
| G13 nested loops | `gateway/LocalGatewayTaskRunner.ts` — a task is one bounded pass (select tools → execute batch → summarize). Hard ceiling: 2 model calls, 8 tool calls per task. mswarm's runner capped to match, so cloud and local cannot drift |
| G12 result contract | `artifacts` and `warnings` added to `CodaliGatewayResult`; `response.schema` is now validated with one repair attempt, then `partial` |
| — no finisher | `gateway/Finalizer.ts` — deterministic / synthesizer / artifact modes. No path returns raw tool output |
| G11 tenant config | `runcontext/RunContextResolver.ts` — one seam, local-config and host-provided implementations, with the repo-config trust boundary enforced |
| G5 agent inventory | `agents/AgentInventory.ts` loads once per process; `agents/RoleResolution.ts` exposes the configurable roles (three at Phase 1; a fourth, `worker`, added in §15) |
| — no observability | `gateway/GatewayTracer.ts`, `codali ask --trace` |

### Findings that changed the design

1. **`supportsTools` is not `supportsToolCalls`.** mcoda reports `supportsTools: true` for CLI-backed agents because the CLI has tools — but `CodexCliProvider` and `ClaudeCliProvider` never emit `toolCalls`. Selecting one as a worker produced a correct 4-task plan and then zero tool calls, with nothing explaining why. `Provider.supportsToolCalls` is now the authority, and when nothing can call a tool the run withholds tools entirely and records `tools_unavailable:` rather than planning work that cannot execute.
2. **Deterministic finalization needs a router signal, not a heuristic.** Gating it on "one high-confidence fact" was wrong — "why is X failing?" can rest on one solid fact and still need reasoning. It now requires the classifier's `directAnswerCandidate`.
3. **Worker failures were invisible.** `executePlannedWorkerTasks` + `synthesizeFinalAnswer` called directly bypassed `run()`'s failure check, so every task could fail and the synthesizer would simply report it could not answer. Failures now surface in the trace.
4. **The state machine's 30s per-task default is wrong for CLI agents**, which take 30–90s per call; every task timed out before calling a tool. Now derived from the run deadline.
5. **mswarm self-hosted agents are not locally drivable.** Their model IDs are meaningful only to mswarm's relay; called directly they 400 at OpenRouter. The local CLI filters them out (`isLocallyDrivable`).
6. **The local→web waterfall belongs in the search tool**, per the review, and now lives there — including the detail that docdex reports web findings under `webDiscovery`, not `hits`, so judging by `hits` alone discarded everything it found.

### Known limitations

- **Web fallback depends on the planner choosing it.** The waterfall works (verified: 10.5 KB of digested web content for a query with no local match). But when the local index has *textually* matching but irrelevant hits, the tool cannot tell, and the small orchestrator model does not always reach for `docdex_web_research`. Relevance-aware fallback is a Phase 3 planning-quality matter.
- **No live multi-tenant verification.** Phase 1 built the `RunContextResolver` seam only; the tenant runtime is Phase 4.
- **Environment**: mswarm cloud (`api.mswarm.org/v1/swarm/openai/`) returned 502 throughout, and the self-hosted relay mis-routes model IDs to OpenRouter. Neither is caused by this work. Verification used `codex55` (codex-cli) as synthesizer and a locally registered `local-qwen3b` (ollama, qwen2.5:3b) as the tool-capable worker.

### To reproduce

```sh
# ~/.codali/config.json binds the three configurable roles
{ "agents": { "orchestrator": "local-qwen3b", "synthesizer": "codex55" } }

codali ask "Which file defines the CodaliGatewayPlanner class?" --trace
codali ask "Write a simple html/js pingpong game" --no-tools
codali ask "..." --response-schema ./schema.json --json
```

Note: a `local-qwen3b` mcoda agent (ollama `qwen2.5:3b`) was registered during
verification because no other reachable agent could emit tool calls. Remove it
with `mcoda agent delete local-qwen3b` if it is not wanted.

---

## 13. Phase 2 outcome (2026-08-04)

Delivered. 968 unit tests pass (+57 over Phase 1); `@mcoda/codali` and `@mcoda/mswarm` build clean; `pnpm --filter mcoda run pack:verify` and `release:publish:npm:dry-run` both pass with the new dependency.

### What shipped

| Item | Detail |
|---|---|
| Pinned SDK | `@modelcontextprotocol/sdk@1.30.0` — exact, no caret. Codali's first third-party runtime dependency |
| Protocol guard | `CODALI_MCP_PROTOCOL_VERSION` asserted against the SDK's `LATEST_PROTOCOL_VERSION` in a test, so an SDK bump that changes the wire format fails in CI, not against a live server |
| `McpClient` | `tools/list` + `tools/call` only. stdio and Streamable HTTP via the SDK. No legacy HTTP+SSE transport, no resources, no prompts |
| `McpToolAdapter` | MCP adapts *into* the neutral `ToolDefinition`; `mcp:<server>:<tool>` namespacing; server `annotations` kept for display but never trusted for security |
| `McpServerRegistry` | Lazy connect, per-server health, one retry on transport failure, global concurrency semaphore, guaranteed shutdown |
| Trust boundary | Repo config cannot introduce a server under `mcp_servers` **or** `mcpServers` — both spellings forbidden, since both readers accept them |
| Redaction | Connector secret patterns added to the dataset privacy engine *and* the tracer, with value-level (not just key-name) matching |
| `codali tools` | `list` / `describe` / `call` / `health` |

### Findings that changed the design

1. **The capability compiler silently dropped every MCP tool.** `ToolCapabilityCompiler` only recognizes built-ins, app contracts, and manifest entries; anything else is `not_declared` and discarded. The run planned with docdex only and nothing explained why — the classifier was never even offered the `fs` capability. Discovery *is* the declaration, so discovered tools are now passed to the compiler as `actualTools`. This was the single blocking bug and is covered by a regression test.
2. **Blanket `readOnly: true` on connector tools was wrong.** Labelling `edit_file` and `move_file` read-only is worse than admitting ignorance. `readOnly` now defaults to **false** and is an *operator declaration* (`readOnly: true` on the server, or an explicit `allowTools` list). Write tools stay registered and visible to `codali tools list` but are withheld from the model, with `mcp_write_tools_withheld:` in the trace. This is what "connectors are read-only in Phase 2" should have meant all along.
3. **`--json --trace` produced unparseable stdout**, because the rendered trace was appended after the JSON document. The trace now goes to stderr when `--json` is set.

### Acceptance, verified live

```
$ codali tools health
ok   fs  5 tool(s), 1682ms

$ codali ask "Use mcp:fs:list_directory with path …/connectors/mcp and list the files."
Files listed in …/connectors/mcp:
- McpClient.ts
- McpServerRegistry.ts
- McpToolAdapter.ts
- McpToolSource.ts
[ev-…]                    # 1 tool call, answered through MCP, cited
```

Secret hygiene: with a `ghp_…` token in the server's `env`, the token appears **zero** times in the JSON result and zero times in the stderr trace.

### Known limitations

- ~~Verified against `@modelcontextprotocol/server-filesystem`, not GitHub.~~ **Superseded 2026-08-05:** the official GitHub MCP server is connected over Streamable HTTP and serving 23 read-only tools against `bekirdag/mcoda`. See §15.
- **Small orchestrators pass relative paths.** The 3B local model repeatedly called `list_directory` with `connectors/mcp` where the server requires an absolute path inside its allowed root. Failures were reported correctly; this is planning quality, addressed in Phase 3.
- **Resources and prompts are not implemented.** Deferred by design; no stated requirement needs them.

### To reproduce

```jsonc
// ~/.codali/config.json
{
  "agents": { "orchestrator": "local-qwen3b", "synthesizer": "codex55" },
  "mcpServers": [{
    "name": "fs",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/path"],
    "readOnly": true,                       // operator declaration
    "allowTools": ["list_directory", "read_text_file"]
  }]
}
```

```sh
codali tools health
codali tools list
codali tools call mcp:fs:list_directory --args-json '{"path":"/abs/path"}'
codali ask "…" --trace
```

---

## 14. Phases 3 and 4 outcome (2026-08-04)

Both delivered. **1022 unit tests pass** (+54 over Phase 2); `@mcoda/codali` and `@mcoda/mswarm` build clean; `pack:verify` passes.

### Phase 3 — what shipped

| Item | Detail |
|---|---|
| Parallel execution | `maxParallelWorkers: 3` wired from the CLI and API. The state machine supported waves but defaulted to **1**, so a four-source question ran four sequential model round trips |
| Bounded rounds | `maxRounds: 3` with `complete` / `partial` / `needs_clarification` as definite outcomes |
| `needs_clarification` | Was a declared status nothing produced. The classifier now emits a clarifying question, and the **planner stage is skipped entirely** — no plan is built on a guessed identity, and a model call is saved |
| Temporal grounding | `TemporalContext.ts` resolves "last two weeks" → an absolute ISO range at plan time, hands it to every worker, and stamps it on the run so a report re-run tomorrow asks the same question |
| HTTP connectors | Hand-declared `{ id, description, method, urlTemplate, inputSchema, responseSelector }`. GET/HEAD only, enforced at declaration time. No OpenAPI compiler |
| Cross-source correlation | Evidence carries `usedTool`, `taskId` and `sourceTimestamp`, plus a `sourceBreakdown` per source type, so the synthesizer can join a ticket and a commit — and can tell a genuinely multi-source claim from one dressed up as several |

### Phase 4 — what shipped

| Item | Detail |
|---|---|
| Image generation | An **ordinary tool** (`media_generate_image`), not a separate pipeline. Returns an `ArtifactRef`; bytes go to `.codali/artifacts/<run>/`, never into evidence or the trace |
| Canonical API | `runCodali(request) → CodaliResult` in `src/api/CodaliApi.ts`. Same code path the CLI uses, so a product and the terminal cannot drift |
| AI-chat adapter | OpenAI-compatible `/v1/chat/completions`. okacam points its existing client at a new base URL — **no change to AI chat**. Provenance rides along under `codali.{status,sources,artifacts,traceId}`; a partial answer never reports `finish_reason: "stop"` |
| `codali serve` | Same result contract as the CLI. **Tenant is derived from the authenticated caller**, never from a body field — `applyPrincipalScope` discards caller-supplied context rather than merging it |

### Design decisions worth recording

1. **Media is a tool, not a route.** The original plan gave media its own orchestration path, which forced an up-front "media or not" classification and duplicated planning. As a tool, "generate an image of a puppy" is a one-task plan like any other, and a request needing *both* research and an image needs no special case.
2. **`needs_clarification` skips the planner, not just the workers.** Stopping after planning would still have built a plan around a guessed identity.
3. **`tools list` had to learn about HTTP connectors.** It only attached MCP, so the catalog disagreed with what a run could actually reach — exactly the confusion the command exists to prevent.

### Full functionality test, verified live

| # | Test | Result |
|---|---|---|
| T1 | HTTP connector direct call | ✅ Jira issues returned, projected by `responseSelector` |
| T2 | Example #1 — code generation, no tools | ✅ `succeeded`, 0 tool calls |
| T3 | Repo question via docdex | ✅ `GatewayPlanner.ts`, cited, 3 tool calls |
| T4 | Example #5 — blockers via connector | ✅ Correctly identified the one `Blocked` issue, cited, and stated what was missing |
| T5 | Example #3 — image generation | ✅ PNG written, returned as `ArtifactRef` |
| T6 | `codali serve` auth | ✅ healthz open; unauthenticated and wrong-key both 401 |
| T7 | AI-chat path over HTTP | ✅ OpenAI shape, `finish_reason: stop`, provenance carried |
| T8 | Tenant spoofing via body | ✅ Rejected (also unit-tested across two tenants) |
| T9 | Temporal grounding | ✅ "last two weeks" → 14-day absolute range |
| T10 | Secret hygiene, HTTP bearer auth | ✅ Token appears 0 times in stdout and 0 times in the trace |
| T11 | Budget exhaustion | ✅ Answered from what it had, cited; no fabrication |
| T12 | Response schema enforcement | ✅ Output conformed exactly; no invented content |

Four connector types coexist in one catalog: `docdex (26)`, `fs (3, MCP)`, `jira (1, HTTP)`, `web (1)`.

### Known limitations

- ~~Examples #4 and #6 were exercised against a local stand-in Jira.~~ **Superseded 2026-08-05:** GitHub, Jira (`wodonetwork.atlassian.net`) and Microsoft Graph are all connected against live accounts. See §15.
- **Entity resolution is not a pipeline stage**, by design: it emerges as an orchestrator-created task. With a 3B local orchestrator it does not reliably emerge. Larger orchestrators handle it; this is planning quality, not missing capability.
- **`codali serve` is single-tenant.** Multi-tenant hosting means a product calling `createCodaliServer` with its own `authenticate`, since only the product can map a caller to a tenant. The per-tenant connection pooling and credential brokering from §8 remain deferred.
- **No streaming.** `/v1/chat/completions` ignores `stream: true` and returns a complete response.

---

## 15. Live connector integration and model tiering (2026-08-05)

Everything below happened after Phase 4 and is not covered by §12–§14.

**1043 unit tests pass.** Both packages build.

### Credentials

Connectors need real secrets, and config files reference them indirectly so a
config can be read and diffed without leaking anything. That indirection is only
useful if the values live somewhere convenient, so:

- `runcontext/CredentialFile.ts` — reads `~/.codali/.creds`, dotenv format
  (`KEY=value`, `#` comments, `export` accepted). Process environment wins over
  the file, so a one-off `GITHUB_TOKEN=… codali ask …` overrides without editing.
- **Home directory only.** A workspace `.creds` is deliberately not read: a
  checked-out repository could otherwise substitute the token for a connector
  the operator configured. Same reasoning as `scrubRepoConfig`.
- `env:NAME` references are substituted **anywhere in a string**, not only at
  the start. `"Bearer env:GITHUB_TOKEN"` is what anyone writes, and requiring
  the reference to lead the value silently transmitted the literal text as a
  credential — GitHub rejected it as `invalid token`, which reads like a bad
  token rather than a missing one. An unresolvable reference now drops the whole
  value rather than sending it half-substituted.

### OAuth for Microsoft Graph

Graph needs a user context (`Mail.Read` on *my* mail), so app-only credentials
are the wrong shape — they would read the whole tenant.

- `connectors/oauth/DeviceCodeAuth.ts` — device authorization grant (RFC 8628).
  Correct `authorization_pending` polling, `slow_down` backoff, and expiry.
  Chosen because a CLI has no redirect URI to offer.
- `cli/AuthCommand.ts` — `codali auth microsoft`. Writes the refresh token into
  `~/.codali/.creds` in place rather than appending, so re-authenticating cannot
  leave a stale token above the new one.
- `oauth2_refresh` auth type on the HTTP connector — trades the refresh token
  for an access token, cached until 60s before expiry. Rotated refresh tokens
  are stored; Microsoft rotates them, and ignoring that strands the session.

### Connectors now live

| Name | Type | Tools | Verified against |
|---|---|---|---|
| docdex | built in | 26 | local index |
| github | MCP (Streamable HTTP) | 23, read only | `bekirdag/mcoda` |
| jira | HTTP + basic | 4 | `wodonetwork.atlassian.net`, 19 projects |
| graph | HTTP + oauth2_refresh | 5 | `bekir.dag@wodonetwork.com` |
| web | via docdex | 1 | SearXNG → live fetch |

Reusing okacam's existing Graph app registration rather than a new one, per an
explicit decision — its delegated scopes already matched what Example #6 needs.

### Model tiering

Local models are slow, so which model runs which stage matters more than it
would with hosted APIs. Measured on one identical question:

| orchestrator | worker | synthesizer | Time | Outcome |
|---|---|---|---|---|
| qwen3.6 | qwen3.6 | codex55 | 138s | no tool calls |
| local-qwen3b | qwen3.6 | qwen3.6 | 112s | **fabricated a file path** |
| **local-qwen3b** | **local-qwen3b** | **qwen3.6** | **47s** | correct, cited |

Small model plans and calls tools; the large model writes the final answer only.
Putting the large model on tool calls was worse on both axes — it answered from
memory instead of calling anything.

This is what motivated the `worker` role in §4.1.

### Fabricated provenance — fixed

The middle row above is the important finding. qwen3.6 made **zero tool calls**,
invented `src/planner/CodaliGatewayPlanner.py` (a file that does not exist, in
the wrong language), emitted a `sourceId` for it, and the synthesizer cited it
with confidence.

`EvidenceNormalizer` already downgraded unprovenanced claims — but the model
supplied its own provenance, so the check passed. Now: **a task that made no
successful tool call cannot claim a source at all.** Its output is forced to
`model_observation` with confidence capped at 0.25, regardless of what it
asserts. Two regression tests cover it.

Confidently wrong is worse than slow, and this was the only place the system
could be confidently wrong.

### mswarm gateway fix (external)

Self-hosted models were unreachable: `/v1/swarm/self-hosted/openai/models`
advertised them, but `/chat/completions` on the same path forwarded the ids to
OpenRouter, which rejected them. Reported in `mswarm_bug_report.md`; fixed in
gateway runtime `0e9e877` — the route is self-hosted-only, serves the exact ids
from `/models`, and returns 404/503 instead of falling through to a cloud
provider.

Codali's `isLocallyDrivable` filter, which had excluded `mswarm-self-hosted-*`
agents for exactly this reason, was removed.

### Other fixes

- **Explicit agent bindings were silently ignored.** mcoda's inventory carries
  no `tier` field — the resolver infers one — so binding a large agent to
  `orchestrator` failed a nominal "medium" requirement and fell back. A binding
  now overrides tier matching outright; an unknown slug warns rather than
  quietly substituting.
- **CLI adapters excluded from tool-worker selection.** `codex-cli`,
  `claude-cli` and `gemini-cli` advertise `supportsTools: true` because the CLI
  has tools, but Codali's provider drives them through text and cannot surface a
  structured call.
- **Temporal grounding reaches the worker.** The resolved window was given to
  the classifier and planner but not to the component that actually forms tool
  arguments, so models invented 2023 and 2024 date ranges for "the last two
  weeks" in 2026.
- **Tool output cap raised** 8k → 24k, with a truncation notice the model must
  acknowledge. A fortnight of commits previously became one, reported honestly
  but incompletely.
- **`--json --trace` no longer corrupts stdout** — the trace goes to stderr.

### Open

- **Web fallback is presence-based, not relevance-based.** It goes to the web
  only when the local index returns nothing; a weak but non-empty match stops it.
- **Entity resolution** still does not reliably emerge as an orchestrator task
  with a small model.
- `codali serve` remains single-tenant; no streaming.
- Day-to-day guidance now lives in `codali_finetuning_plan.md`.
