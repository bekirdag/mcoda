import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCliProvider } from "../ClaudeCliProvider.js";
import type { AgentEvent, ProviderRequest } from "../ProviderTypes.js";

test("ClaudeCliProvider returns stub output and emits a stream token", { concurrency: false }, async () => {
  const originalStub = process.env.MCODA_CLI_STUB;
  try {
    process.env.MCODA_CLI_STUB = "1";
    const provider = new ClaudeCliProvider({ model: "sonnet" });
    const events: AgentEvent[] = [];
    const request: ProviderRequest = {
      messages: [{ role: "user", content: "ping" }],
      stream: true,
      onEvent: (event) => events.push(event),
    };
    const result = await provider.generate(request);
    assert.equal(result.message.content, "claude-stub:ping");
    assert.deepEqual(events, [{ type: "token", content: "claude-stub:ping" }]);
  } finally {
    if (originalStub === undefined) delete process.env.MCODA_CLI_STUB;
    else process.env.MCODA_CLI_STUB = originalStub;
  }
});

test("ClaudeCliProvider rejects an empty selected model", async () => {
  const provider = new ClaudeCliProvider({ model: "" });
  await assert.rejects(
    provider.generate({ messages: [{ role: "user", content: "ping" }] }),
    /requires model from selected mcoda agent\/config/i,
  );
});
