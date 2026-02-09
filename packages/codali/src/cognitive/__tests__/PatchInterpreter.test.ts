import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { PatchInterpreter } from "../PatchInterpreter.js";

class StubProvider implements Provider {
  name = "stub";
  private responses: ProviderResponse[];
  requests: ProviderRequest[] = [];

  constructor(responses: ProviderResponse[]) {
    this.responses = responses;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) {
      return { message: { role: "assistant", content: "" } };
    }
    return next;
  }
}

class MemoryLogger {
  events: Array<{ type: string; data: Record<string, unknown> }> = [];
  async log(type: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ type, data });
  }
}

test("PatchInterpreter returns parsed patch payload", async () => {
  const provider = new StubProvider([
    {
      message: {
        role: "assistant",
        content: '{"patches":[{"action":"delete","file":"a.txt"}]}',
      },
    },
  ]);
  const interpreter = new PatchInterpreter({
    provider,
    patchFormat: "search_replace",
  });

  const result = await interpreter.interpret("freeform output");
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].action, "delete");
});

test("PatchInterpreter parses raw builder payload without provider call when already valid", async () => {
  const provider = new StubProvider([
    { message: { role: "assistant", content: '{"patches":[{"action":"delete","file":"ignored.txt"}]}' } },
  ]);
  const interpreter = new PatchInterpreter({
    provider,
    patchFormat: "search_replace",
  });

  const result = await interpreter.interpret('{"patches":[{"action":"delete","file":"a.txt"}]}');
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].action, "delete");
  assert.equal(provider.requests.length, 0);
});

test("PatchInterpreter retries once on invalid JSON", async () => {
  const provider = new StubProvider([
    { message: { role: "assistant", content: "not json" } },
    {
      message: {
        role: "assistant",
        content: '{"patches":[{"action":"delete","file":"a.txt"}]}',
      },
    },
  ]);
  const interpreter = new PatchInterpreter({
    provider,
    patchFormat: "search_replace",
    maxRetries: 1,
  });

  const result = await interpreter.interpret("freeform output");
  assert.equal(result.patches.length, 1);
  assert.equal(provider.requests.length, 2);
});

test("PatchInterpreter throws after retry failure", async () => {
  const provider = new StubProvider([
    { message: { role: "assistant", content: "not json" } },
    { message: { role: "assistant", content: "still bad" } },
  ]);
  const interpreter = new PatchInterpreter({
    provider,
    patchFormat: "search_replace",
    maxRetries: 1,
  });

  await assert.rejects(
    () => interpreter.interpret("freeform output"),
    /Patch output is not valid JSON/,
  );
});

test("PatchInterpreter logs request/response and retry events", async () => {
  const provider = new StubProvider([
    { message: { role: "assistant", content: "not json" } },
    {
      message: {
        role: "assistant",
        content: '{"patches":[{"action":"delete","file":"a.txt"}]}',
      },
    },
  ]);
  const logger = new MemoryLogger();
  const interpreter = new PatchInterpreter({
    provider,
    patchFormat: "search_replace",
    maxRetries: 1,
    logger,
  });

  await interpreter.interpret("freeform output");
  const types = logger.events.map((event) => event.type);
  assert.ok(types.includes("interpreter_request"));
  assert.ok(types.includes("interpreter_response"));
  assert.ok(types.includes("interpreter_retry"));
});
