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
