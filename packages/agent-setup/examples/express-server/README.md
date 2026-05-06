# Express Server Example

```ts
import express from "express";
import {
  createInMemoryMcodaAgentSettingsStore,
  createMcodaAgentSetupHttpHandler,
  createMcodaAgentSetupService
} from "@mcoda/agent-setup/server";

const app = express();
app.use(express.json());

const service = createMcodaAgentSetupService({
  settingsStore: createInMemoryMcodaAgentSettingsStore(),
  authorize: async (request) => {
    // Check admin auth here.
  }
});

const handler = createMcodaAgentSetupHttpHandler(service);

app.all("/api/mcoda/*", async (req, res) => {
  const response = await handler({
    method: req.method,
    path: req.path,
    body: req.body,
    raw: req
  });
  res.status(response.status).json(response.body);
});

app.listen(3000);
```

This uses the real programmatic mcoda/mswarm runtime by default. After the
frontend posts a real mswarm API key to `/api/mcoda/mswarm-api-key`, cloud and
self-hosted agents are fetched and synced from the real mswarm server.
