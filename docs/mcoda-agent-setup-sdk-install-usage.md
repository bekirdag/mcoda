# mcoda Agent Setup SDK Install And Usage

Last verified: 2026-05-06

This document explains how an application can install and use the public
`@mcoda/agent-setup` SDK to configure mcoda/mswarm agents from an app UI.

## Current Published Package

The npm registry currently reports:

```bash
npm view @mcoda/agent-setup version --registry https://registry.npmjs.org/
# 0.1.66
```

Published `@mcoda/agent-setup@0.1.66` exports:

- `@mcoda/agent-setup`
- `@mcoda/agent-setup/headless`
- `@mcoda/agent-setup/server`
- `@mcoda/agent-setup/react`

It depends on public `@mcoda/core@0.1.66`.

Important: the local repo has a newer React stylesheet export,
`@mcoda/agent-setup/react/styles.css`, but that export is not in the currently
published `0.1.66` package. It becomes available to npm consumers only after a
version bump and republish.

## What The SDK Does

The SDK provides:

- Headless catalog and stage-assignment helpers.
- A browser-safe typed HTTP client.
- Server-side service helpers and HTTP handler.
- A default programmatic mcoda runtime adapter.
- Optional React setup UI components.

The default programmatic server runtime uses mcoda package APIs directly. It
does not require the host app server to have the `mcoda` CLI/client tool
preinstalled or configured.

## Install

From the consuming app:

```bash
npm install @mcoda/agent-setup
```

For React UI usage:

```bash
npm install react react-dom @mcoda/agent-setup
```

Runtime requirement:

```text
Node.js >= 20
```

## Recommended Architecture

Use this split:

- Browser: renders setup UI and calls your own app backend.
- App backend: owns admin authorization and receives the mswarm API key.
- SDK server service: stores non-secret setup metadata, configures the runtime,
  fetches real cloud/self-hosted catalogs, syncs agents, and saves assignments.

Do not send the mswarm API key directly to a third-party browser-only client or
store it in frontend state beyond the submit request.

## Backend Setup

Example Express-style backend:

```ts
import express from "express";
import {
  createInMemoryMcodaAgentSettingsStore,
  createMcodaAgentSetupHttpHandler,
  createMcodaAgentSetupService,
  createProgrammaticMcodaRuntimeAdapter,
} from "@mcoda/agent-setup/server";

const app = express();
app.use(express.json());

const service = createMcodaAgentSetupService({
  settingsStore: createInMemoryMcodaAgentSettingsStore(),
  mcoda: createProgrammaticMcodaRuntimeAdapter(),
  authorize: async (request) => {
    // Check that the current user is allowed to administer mcoda/mswarm setup.
    // Throw an Error to reject unauthorized requests.
  },
  logger: console,
});

const handler = createMcodaAgentSetupHttpHandler(service, {
  basePath: "/api/mcoda",
});

app.all("/api/mcoda/*path", async (req, res) => {
  const result = await handler({
    method: req.method,
    url: req.originalUrl,
    body: req.body,
    raw: req,
  });

  res.status(result.status).set(result.headers).send(result.body);
});

app.listen(3000);
```

The in-memory settings store is useful for smoke tests and prototypes. A
production app should provide a persistent implementation of
`McodaAgentSettingsStore` so saved stage assignments and key metadata survive
process restarts.

## Backend Routes

With `basePath: "/api/mcoda"`, the handler exposes:

```text
GET    /api/mcoda/agent-settings
POST   /api/mcoda/mswarm-api-key
POST   /api/mcoda/agents/sync
PATCH  /api/mcoda/agent-settings
POST   /api/mcoda/agents/test
```

Route behavior:

- `GET /agent-settings`: returns current setup state, assignments, and catalog.
- `POST /mswarm-api-key`: configures the submitted mswarm API key server-side.
- `POST /agents/sync`: syncs cloud and self-hosted agents from the real mswarm
  server.
- `PATCH /agent-settings`: saves per-stage agent assignments.
- `POST /agents/test`: runs a small test request against a selected agent when
  the runtime supports testing.

## Frontend HTTP Client

Use the browser-safe client against your backend route:

```ts
import { createMcodaAgentSetupClient } from "@mcoda/agent-setup";

const client = createMcodaAgentSetupClient({
  baseUrl: "/api/mcoda",
  getAuthHeaders: () => ({
    authorization: `Bearer ${adminToken}`,
  }),
});

const snapshot = await client.fetchSnapshot();

await client.configureMswarmApiKey({
  apiKey: "mswarm-api-key-from-admin-form",
  reasonCode: "admin_setup",
});

await client.syncAgents({
  reasonCode: "admin_catalog_refresh",
});

await client.updateAssignments({
  assignments: {
    planner: "mswarm-cloud-openrouter-qwen-qwen3-6-plus",
    reviewer: "self-hosted-suku-qwen-35b",
  },
  reasonCode: "admin_assignment_update",
});
```

Do not hardcode real production agent slugs in product code. The UI should let
the admin choose from the catalog returned by `fetchSnapshot()` / `syncAgents()`.
The slugs above are examples only.

## React Setup Page

Basic React integration:

```tsx
import {
  McodaAgentSetupPage,
  createMcodaAgentSetupClient,
  defaultMcodaStageDefinitions,
} from "@mcoda/agent-setup/react";

const client = createMcodaAgentSetupClient({
  baseUrl: "/api/mcoda",
});

export function AgentSetupScreen() {
  return (
    <McodaAgentSetupPage
      client={client}
      stages={defaultMcodaStageDefinitions}
      title="mcoda / mswarm Agent Setup"
      labels={{
        saveKey: "Save key",
        syncAgents: "Sync agents",
        saveAssignments: "Save assignments",
        cloud: "Cloud",
        selfHosted: "Self-hosted",
      }}
    />
  );
}
```

For the currently published `0.1.66` package, provide your own app CSS around
the React component.

After the local stylesheet export is version-bumped and published, consumers can
also add:

```ts
import "@mcoda/agent-setup/react/styles.css";
```

## Headless Usage

If the app has its own UI, use the client and headless utilities instead of the
React page:

```ts
import { createMcodaAgentSetupClient } from "@mcoda/agent-setup";
import {
  buildCloudAgentOptions,
  buildSelfHostedServerOptions,
} from "@mcoda/agent-setup/headless";

const client = createMcodaAgentSetupClient({
  baseUrl: "/api/mcoda",
});

const snapshot = await client.fetchSnapshot();
const cloudOptions = buildCloudAgentOptions(
  snapshot.catalog.localAgents,
  snapshot.catalog.cloudAgents
);
const selfHostedServers = buildSelfHostedServerOptions(
  snapshot.catalog.localAgents,
  snapshot.catalog.selfHostedAgents
);
```

This is the preferred path for apps that already have a design system.

## Persistent Settings Store

A production settings store should implement:

```ts
import type {
  McodaAgentSettingsSnapshot,
  McodaAgentSettingsStore,
} from "@mcoda/agent-setup/server";

export function createDatabaseSettingsStore(): McodaAgentSettingsStore {
  return {
    async load(): Promise<McodaAgentSettingsSnapshot> {
      // Read assignments and key metadata from your database.
      return {
        assignments: {},
        mswarmApiKeyConfigured: false,
        mswarmApiKeyLast4: null,
        mswarmConfiguredAt: null,
        updatedAt: null,
      };
    },
    async saveMswarmKeyMetadata(input) {
      // Store only configured/last4/configuredAt metadata.
      // Do not store raw secrets here unless your product explicitly owns
      // encrypted secret storage in this same implementation.
    },
    async saveAssignments(input) {
      // Persist stage -> selected agent slug mappings.
    },
  };
}
```

The raw mswarm API key is passed to the runtime by
`configureMswarmApiKey()`. The settings store is for setup metadata and
assignments.

## Local Monorepo Development

When developing from the mcoda monorepo before publishing a new version:

```bash
npm install /Users/bekirdag/Documents/apps/mcoda/packages/agent-setup
```

or with a file dependency:

```json
{
  "dependencies": {
    "@mcoda/agent-setup": "file:../mcoda/packages/agent-setup"
  }
}
```

For published consumers, prefer the npm registry package:

```bash
npm install @mcoda/agent-setup
```

## Smoke Test Checklist

After wiring the SDK into an app:

1. Start the backend and frontend.
2. Open the setup page as an authorized admin.
3. Submit a real mswarm API key.
4. Confirm `GET /api/mcoda/agent-settings` reports the key as configured and
   shows only the last four characters.
5. Click or call `syncAgents()`.
6. Confirm cloud agents and self-hosted agents come from the real mswarm server.
7. Save assignments for each required stage.
8. Restart the app server and confirm assignments still load if using a
   persistent settings store.
