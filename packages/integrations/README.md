# @mcoda/integrations

External integrations for mcoda (docdex, telemetry, VCS, QA runners, update checks).

## Install
- Requires Node.js >= 20.
- Install: `npm i @mcoda/integrations`

## What it provides
- DocdexClient for local or remote docdex queries.
- TelemetryClient for token usage reporting.
- VcsClient for Git operations.
- SystemClient for update checks.
- QA adapters (Chromium, Maestro, CLI) and types.

## Example
```ts
import { DocdexClient } from "@mcoda/integrations";

const client = new DocdexClient({
  workspaceRoot: process.cwd(),
  baseUrl: process.env.MCODA_DOCDEX_URL,
});

const docs = await client.search({ docType: "rfp", query: "payments" });
```

## Notes
- Some integrations call external services; configure base URLs and tokens as needed.
- Primarily used by the mcoda CLI; APIs may evolve.

## License
MIT - see `LICENSE`.
