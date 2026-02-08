import test from "node:test";
import assert from "node:assert/strict";
import { CodexCliProvider } from "../CodexCliProvider.js";
import type { AgentEvent, ProviderRequest } from "../ProviderTypes.js";

test("CodexCliProvider returns stub output when MCODA_CLI_STUB=1", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const provider = new CodexCliProvider({ model: "test-model" });
    const request: ProviderRequest = { messages: [{ role: "user", content: "hi" }] };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "codex-stub:hi");
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodexCliProvider emits token event when stream requested", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const provider = new CodexCliProvider({ model: "test-model" });
    const events: AgentEvent[] = [];
    const request: ProviderRequest = {
      messages: [{ role: "user", content: "stream" }],
      stream: true,
      onEvent: (event) => events.push(event),
    };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "codex-stub:stream");
    assert.deepEqual(events, [{ type: "token", content: "codex-stub:stream" }]);
  } finally {
    if (originalStub === undefined) {
      delete process.env.MCODA_CLI_STUB;
    } else {
      process.env.MCODA_CLI_STUB = originalStub;
    }
  }
});

test("CodexCliProvider throws when model is missing", async () => {
  const provider = new CodexCliProvider({ model: "" });
  const request: ProviderRequest = { messages: [{ role: "user", content: "hi" }] };
  await assert.rejects(
    provider.generate(request),
    /requires model from selected mcoda agent\/config/i,
  );
});
