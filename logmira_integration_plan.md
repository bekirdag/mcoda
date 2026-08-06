# Codali → logmira integration plan

Everything that has to be true before logmira (formerly okacam) can run Codali
for real tenants on the suku hardware.

Written 2026-08-06 against codali 0.1.112, mswarm `1d8f902`, suku node
`sukunahikona` (2× RTX 3090).

Each item below states what is wrong now, with the evidence for it, what "done"
looks like, and how it gets verified. Nothing here is speculative: every claim
was checked against running code or a live box before it was written down.

---

## A. Tenant isolation — the run must not borrow the operator's identity

**Status: DONE (0.1.113).** Operator-config fallback is now opt-in via
`allowOperatorConfigFallback`. A run with neither a context nor a resolver
fails with `run_context_required` and says what the host must supply. The CLI
resolves its own context and is unaffected. Four tests cover it.

`runCodali()` resolves its context as `request.runContext` →
`deps.resolveRunContext` → `LocalConfigRunContextResolver`
(`api/CodaliApi.ts:153`). That last fallback reads `~/.codali/config.json` and
`~/.codali/.creds` — the operator's GitHub token, Jira token and Microsoft
Graph refresh token.

A tenant request that omits `runContext` therefore gets answered using the
server operator's connectors. It does not error. It returns a plausible answer
sourced from the wrong account, and it will look perfectly correct in
development, where the operator and the tenant are the same person.

The same shape exists for models: `createProviderForAssignment` falls back to
`resolveMswarmApiKey()` (reads `~/.docdex/config.toml`) and, since 0.1.112, to
`CODALI_AGENT_API_KEY_*` / `CODALI_API_KEY` from the server environment.

**Done when:** a tenant-scoped request with no host-supplied context fails
closed with a named error instead of silently using operator credentials, and
local CLI use is unaffected.

**Verify:** a test that calls `runCodali` with a tenant and no `runContext` and
asserts the refusal; a second that asserts the CLI path still resolves locally.

---

## B. mswarm tenant access to self-hosted nodes

**Status: codali side DONE (0.1.113); one operator action outstanding.**

Codali now attaches `x-mswarm-client-identity` / `x-mswarm-client` to model
calls, derived from `runContext.tenant.slug` (falling back to the id), and only
for mswarm endpoints. An identity the agent already declares wins. mswarm's
proxy already reads those headers (`readProxySelfHostedClientIdentity`,
`openai-proxy/src/server.ts:2495`), so no mswarm change was needed.

**Outstanding, and it is a console action, not code:** both nodes currently
have an empty `client_allowlist`, and an empty allowlist means *nobody*, not
*everybody*. Until `wodo` is added to the suku node's allowlist at
`app.mswarm.org/.../mcoda-self-hosted/setup`, no tenant but the owner can
reach it however correct the headers are.

Also observed while checking: the suku node reports `status: degraded` with
`unreachable_reason: heartbeat_timeout` from 00:14, while `last_seen_at` is
current. Heartbeats restore `online` only when the node reports healthy and has
no failures in the degrade window, and every model on a degraded node is
reported `degraded` rather than `healthy` (`modelHealthFromNode`). The stale
`unreachable_at` / `heartbeat_timed_out_at` metadata is never cleared on
recovery either, which is what made it look dead. Worth fixing in mswarm:
clear the recovery metadata, and find out what the node agent is reporting.

The intended flow — a logmira tenant adds their mswarm API key in settings and
gains access to the suku node's mcoda agents — cannot work today for model
calls.

mswarm authorises a self-hosted node two ways
(`services/openai-proxy/src/server.ts:1769`, `self-hosted-nodes.ts:4805`):

1. the caller's tenant, api key and owner match the node's, or
2. the caller presents a client identity that appears in the node's
   `client_allowlist` — a domain such as `wodo` or `heka`, an IP, or a UUID.

Route 2 is how another tenant reaches someone else's node, and it is the route
the console at `app.mswarm.org/.../mcoda-self-hosted/setup` configures. It
requires the caller to send `x-mswarm-client-identity` (or `x-mswarm-client`,
`x-okacam-tenant`, `x-tenant-slug`).

`DocdexClient` sends that header (`docdex/DocdexClient.ts:523`).
`LocalGatewayProvider`, which makes every model call, **sends no headers at
all**. So a tenant can reach an allowlisted docdex repo and never an
allowlisted model.

Note also `selfHostedNodeAllowsClient` returns `false` for an empty allowlist,
so "no allowlist" means "nobody", not "no restriction". That is a safe default
but it must be set deliberately per node.

**Done when:** codali attaches the tenant's client identity to model calls, the
identity comes from the run context rather than the environment, and a request
carrying tenant `wodo`'s mswarm key reaches a node allowlisted to `wodo`.

**Verify:** unit test on header construction; live call against the suku node
with a client identity that is and is not on the allowlist.

---

## C. Remote docdex repositories

**Status: partially supported, unverified end to end.**

`DocdexClient` already takes `baseUrl`, `repoId`, `apiKey`, `authToken` and
`clientIdentity`, and `RunContext` carries a `docdex` block, so a remote,
tenant-scoped docdex server is expressible. What has never been exercised is a
full run against a remote repo id with no local index and no repo root on disk.

The CLI path always passes `repoRoot`, and `DocdexClient` sends
`x-docdex-repo-root` unless the context is marked immutable — which would leak a
server-side path into a tenant request.

**Done when:** a run against a remote docdex `repoId` with no local checkout
returns cited answers, and no local filesystem path is sent in that mode.

**Verify:** behaviour-suite subset run with a remote docdex context.

---

## D. Tool discovery inside a host product

**Status: mechanism exists, needs a conformance test and documentation.**

Codali never calls back into the host: everything a run may touch arrives as
`runContext` (tools, credentials, agent bindings, limits). The failure mode
already seen twice in this project is that a tool is present but invisible —
`ToolCapabilityCompiler` silently drops tools that are not declared as
`actualTools`, and a capability the classifier never sees can never be chosen.

logmira will supply MCP servers and HTTP connectors per tenant. If it declares
them slightly wrong, the run does not fail; it quietly answers without them.

**Done when:** there is a single documented shape for "here are this tenant's
tools", a conformance check that reports which supplied tools survived
compilation, and `codali tools list --json` works against a host-supplied
context so the logmira dev can see what a tenant's run would actually get.

---

## E. Hardware — stop wasting a GPU

**Status: attempted, reverted, and the premise was wrong.**

The synthesizer really is the bottleneck — that part held up. Measured per-call
on two live runs: `final_synthesizer` took 14.3s of a 17.6s run and 42.1s of a
46.2s run. Tool execution was 272ms and 114ms. Workers were 1–3s. So 80–91% of
every answer is the one model.

But the GPU is not being wasted. The configuration is deliberate, in layered
drop-ins that `systemctl cat` shows in override order:

- `20-context.conf` — both GPUs, `--split-mode layer --tensor-split 1,1`
- `30-wan-capacity.conf` — **`CUDA_VISIBLE_DEVICES=0`** and `--cpu-moe`,
  confining the model to GPU0 so Wan 2.2 video keeps GPU1
- `40-okacam-latency.conf` — same confinement, relaxed to `--n-cpu-moe 22`

So GPU1 is a video reservation, and the CPU offload is what pays for it.

I tried using the ~4.7 GB idle on GPU0 by moving ten expert layers back onto it
(`--n-cpu-moe 12`). It went out of memory during load and crash-looped 51 times
before I reverted it. The idle memory is not spare: with `--batch-size 8192`,
`--ubatch-size 1024` and an mmproj worst case of 1134 MiB, llama.cpp needs that
headroom for compute buffers. Service restored to `--n-cpu-moe 22`, 59 tok/s,
all media services active, restart counter back to zero.

**What is actually worth trying**, in order of expected value:

1. **Send the synthesizer less.** Prefill runs at ~1300 tok/s, so a 16k context
   pack costs ~12s before a token is emitted. `maxContextPackTokens` is 16000.
   Cutting what goes in is free latency and needs no hardware change.
2. **Lower `--ctx-size`.** It is 131072 for a model whose prompts are capped at
   16k by codali. The KV cache reserved for 131k context is large, and freeing
   it is what would make room for experts. Check who else uses this endpoint at
   long context before touching it.
3. Only then revisit the GPU split, together with whoever set the Wan
   reservation.

**Verify:** per-call latency breakdown before and after, not just wall clock.

---

## F. Tenant onboarding automation

**Status: not designed. Largest unknown; do last.**

Today: a tenant is created in logmira, an mswarm account and API key are made
by hand, and the key is pasted into logmira's AI settings.

Wanted: creating a logmira tenant provisions the mswarm account, mints a
scoped API key, links it to that tenant's AI settings, and — implied by item B
— registers the tenant's identity on whichever nodes it is entitled to use.

This crosses three systems and touches credential handling, so it needs a
written design before code. It is listed last deliberately: items A–E make the
manual path correct, and automating a broken path only multiplies it.

---

## Order of work

A → B → E → C → D → F.

A is a safety gate. B unblocks the actual product story. E is the biggest
user-visible win and is independent of the rest. C and D are correctness for
the host integration. F needs the others working first.
