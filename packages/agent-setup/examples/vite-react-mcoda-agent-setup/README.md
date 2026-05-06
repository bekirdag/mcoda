# Vite React mcoda Agent Setup Example

```tsx
import {
  McodaAgentSetupPage,
  createMcodaAgentSetupClient,
  defaultMcodaStageDefinitions
} from "@mcoda/agent-setup/react";
import "@mcoda/agent-setup/react/styles.css";

const client = createMcodaAgentSetupClient({
  baseUrl: "/api/mcoda"
});

export function App() {
  return (
    <McodaAgentSetupPage
      client={client}
      stages={defaultMcodaStageDefinitions}
      title="mcoda Agent Setup"
    />
  );
}
```

Use the server helpers from `@mcoda/agent-setup/server` behind the same
`/api/mcoda` base path in your API server, reverse proxy, or dev server.
