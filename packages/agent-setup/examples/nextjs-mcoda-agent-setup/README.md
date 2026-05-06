# Next.js mcoda Agent Setup Example

This example shows the intended app shape. The page imports the turnkey React
entrypoint, while the API route uses the framework-agnostic handler.

```tsx
// app/mcoda-agent-setup/page.tsx
"use client";

import {
  McodaAgentSetupPage,
  createMcodaAgentSetupClient,
  defaultMcodaStageDefinitions
} from "@mcoda/agent-setup/react";
import "@mcoda/agent-setup/react/styles.css";

const client = createMcodaAgentSetupClient({
  baseUrl: "/api/mcoda",
  getAuthHeaders: async () => ({ authorization: `Bearer ${await getToken()}` })
});

export default function Page() {
  return (
    <McodaAgentSetupPage
      client={client}
      stages={defaultMcodaStageDefinitions}
      title="mcoda Agent Setup"
    />
  );
}
```

```ts
// app/api/mcoda/[...path]/route.ts
import {
  createInMemoryMcodaAgentSettingsStore,
  createMcodaAgentSetupHttpHandler,
  createMcodaAgentSetupService
} from "@mcoda/agent-setup/server";

const service = createMcodaAgentSetupService({
  settingsStore: createInMemoryMcodaAgentSettingsStore(),
  authorize: async (request) => {
    // Verify admin session here.
  }
});

const handler = createMcodaAgentSetupHttpHandler(service);

async function route(request: Request) {
  const body = request.method === "GET" ? undefined : await request.json();
  const response = await handler({
    method: request.method,
    url: request.url,
    body,
    raw: request
  });
  return Response.json(response.body, { status: response.status });
}

export const GET = route;
export const POST = route;
export const PATCH = route;
```
