# @mcoda/agent-setup

Turnkey mcoda/mswarm agent setup SDK for applications.

The package provides:

- headless catalog and assignment utilities
- a typed HTTP client
- framework-agnostic server service helpers
- a default programmatic mcoda runtime adapter
- an optional React setup page
- a trusted backend GPU/generic job client for owner-local mswarm nodes

The default server runtime uses mcoda package APIs directly and does not require
a preinstalled or configured `mcoda` CLI/client tool. When an admin submits a
real mswarm API key through `configureMswarmApiKey()`, subsequent cloud and
self-hosted catalog reads use the real mswarm API via `MswarmApi`.
Self-hosted catalog reads include mswarm load-balanced aliases by default in
the setup SDK, and those aliases are exposed as `Auto load-balanced` server
options with `managedKind: "self_hosted_load_balanced"`. The synced local agent
config keeps only gateway/group metadata and never needs self-hosted node tokens
or invocation signing secrets in browser-visible state.
Self-hosted entries also expose lifecycle diagnostics through `healthReason` and
`selfHostedLifecycle`, including relay gateway URL, lifecycle route templates,
runtime package version, and missing-route protocol mismatch details.
Tenant-scoped self-hosted node access is represented by optional
`clientIdentity`, `clientAllowlist`, and `clientAllowlistCount` catalog fields.
Set `clientIdentity` on the programmatic runtime or use
`MCODA_MSWARM_CLIENT_IDENTITY` so catalog reads and syncs only show nodes
allowlisted for that tenant/client.

## Self-Hosted Routing Modes

The setup SDK presents two self-hosted routing modes side by side:

- Direct self-hosted entries keep a fixed server/node target and use
  `managedKind: "self_hosted"` with `routingMode: "direct"`.
- Auto load-balanced entries are synthetic mswarm aliases and use
  `managedKind: "self_hosted_load_balanced"` with `routingMode: "auto"`.

Existing saved assignments are not rewritten when auto aliases appear. For a
safe migration, let an admin choose the `Auto load-balanced` option only after
the control plane preview shows an eligible upgraded node group. For rollback,
save a direct self-hosted slug again or hide auto aliases in the backend catalog
sync; direct server entries remain usable.

If the gateway/node lifecycle protocol is incompatible, catalog entries surface
`healthStatus: "degraded"`,
`healthReason: "self_hosted_protocol_mismatch"`, and
`selfHostedLifecycle.missingRoute` rather than showing the agent as healthy.
Host apps should display that reason and avoid selecting degraded self-hosted
entries automatically.

For user-scoped mswarm integrations, `configureMswarmApiKey()` can receive
non-secret connection metadata such as tenant ID, product slug, owner user ID,
feature key, and installation ID. The default runtime validates tenant,
product, and API-key identity against mswarm runtime usage limits when
available, then exposes the stored metadata as `snapshot.mswarmConnection`.

React consumers can use the packaged default stylesheet:

```ts
import { McodaAgentSetupPage } from "@mcoda/agent-setup/react";
import "@mcoda/agent-setup/react/styles.css";
```

Host applications can pass `gpuJobOps` and GPU job callbacks into
`McodaAgentSetupPage` to show an owner-local queue/usage/audit panel beside the
agent setup flow. Keep those callbacks backed by trusted backend routes; do not
send self-hosted node signing secrets to browser code.

Trusted backend code can use the GPU job client directly:

```ts
import { createMcodaGpuJobClient } from "@mcoda/agent-setup";

const gpuJobs = await createMcodaGpuJobClient({
  nodeBaseUrl: process.env.MCODA_MSWARM_NODE_BASE_URL,
  nodeId: process.env.MCODA_MSWARM_NODE_ID,
  signingSecret: process.env.MCODA_MSWARM_NODE_SIGNING_SECRET,
});

const capabilities = await gpuJobs.listGpus();
const ops = await gpuJobs.ops({ auditLimit: 25 });
```
