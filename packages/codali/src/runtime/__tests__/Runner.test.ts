import test from "node:test";
import assert from "node:assert/strict";
import { Runner } from "../Runner.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";

class StubProvider implements Provider {
  name = "stub";
  private calls = 0;

  constructor(private responses: ProviderResponse[]) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    const response = this.responses[this.calls];
    this.calls += 1;
    if (!response) {
      return { message: { role: "assistant", content: "" } };
    }
    return response;
  }
}

test("Runner executes tool calls", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    inputSchema: { type: "object" },
    handler: async (args) => ({ output: JSON.stringify(args) }),
  });

  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "call_1", name: "echo", args: { ok: true } }],
    },
    {
      message: { role: "assistant", content: "done" },
    },
  ]);

  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 3,
    maxToolCalls: 3,
  });

  const result = await runner.run([{ role: "user", content: "hi" }]);
  assert.equal(result.finalMessage.content, "done");
  assert.equal(result.toolCallsExecuted, 1);
});

test("Runner enforces step limit", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "noop",
    description: "noop",
    inputSchema: { type: "object" },
    handler: async () => ({ output: "ok" }),
  });

  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "call_1", name: "noop", args: {} }],
    },
  ]);

  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 1,
    maxToolCalls: 1,
  });

  await assert.rejects(async () => {
    await runner.run([{ role: "user", content: "hi" }]);
  }, /Runner step limit exceeded/);
});

test("Runner aggregates usage", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echo",
    inputSchema: { type: "object" },
    handler: async (args) => ({ output: JSON.stringify(args) }),
  });

  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "call_1", name: "echo", args: { ok: true } }],
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    },
    {
      message: { role: "assistant", content: "done" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]);

  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 3,
    maxToolCalls: 3,
  });

  const result = await runner.run([{ role: "user", content: "hi" }]);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 4, totalTokens: 7 });
});

test("Runner passes maxTokens to provider", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  let received: ProviderRequest | undefined;
  const provider: Provider = {
    name: "capture",
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      received = request;
      return { message: { role: "assistant", content: "done" } };
    },
  };

  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 1,
    maxToolCalls: 1,
    maxTokens: 128,
  });

  await runner.run([{ role: "user", content: "hi" }]);
  assert.equal(received?.maxTokens, 128);
});

test("Runner passes toolChoice override", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  let received: ProviderRequest | undefined;
  const provider: Provider = {
    name: "capture",
    async generate(request: ProviderRequest): Promise<ProviderResponse> {
      received = request;
      return { message: { role: "assistant", content: "done" } };
    },
  };

  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 1,
    maxToolCalls: 0,
    toolChoice: "none",
  });

  await runner.run([{ role: "user", content: "hi" }]);
  assert.equal(received?.toolChoice, "none");
});

test("Runner enforces timeout", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  const provider: Provider = {
    name: "slow",
    async generate(_request: ProviderRequest): Promise<ProviderResponse> {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { message: { role: "assistant", content: "late" } };
    },
  };

  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 1,
    maxToolCalls: 1,
    timeoutMs: 10,
  });

  await assert.rejects(async () => {
    await runner.run([{ role: "user", content: "hi" }]);
  }, /Runner timeout exceeded/);
});
