# @mcoda/agent-setup

Turnkey mcoda/mswarm agent setup SDK for applications.

The package provides:

- headless catalog and assignment utilities
- a typed HTTP client
- framework-agnostic server service helpers
- a default programmatic mcoda runtime adapter
- an optional React setup page

The default server runtime uses mcoda package APIs directly and does not require
a preinstalled or configured `mcoda` CLI/client tool. When an admin submits a
real mswarm API key through `configureMswarmApiKey()`, subsequent cloud and
self-hosted catalog reads use the real mswarm API via `MswarmApi`.

React consumers can use the packaged default stylesheet:

```ts
import { McodaAgentSetupPage } from "@mcoda/agent-setup/react";
import "@mcoda/agent-setup/react/styles.css";
```
