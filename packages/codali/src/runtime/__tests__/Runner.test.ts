import test from "node:test";
import assert from "node:assert/strict";
import { Runner, RunnerBudgetError } from "../Runner.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { ToolExecutionError } from "../../tools/ToolTypes.js";
import type { AgentEvent, Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";

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

test("Runner emits tool events", { concurrency: false }, async () => {
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

  const events: AgentEvent[] = [];
  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 3,
    maxToolCalls: 3,
    onEvent: (event) => events.push(event),
  });

  await runner.run([{ role: "user", content: "hi" }]);
  assert.ok(events.some((event) => event.type === "status" && event.phase === "thinking"));
  assert.ok(events.some((event) => event.type === "tool_call" && event.name === "echo"));
  assert.ok(events.some((event) => event.type === "tool_result" && event.name === "echo"));
});

test("Runner propagates normalized tool errors to events and logs", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "guarded",
    description: "guarded tool",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new ToolExecutionError("tool_permission_denied", "blocked by policy", {
        retryable: false,
      });
    },
  });

  const provider = new StubProvider([
    {
      message: { role: "assistant", content: "" },
      toolCalls: [{ id: "call_1", name: "guarded", args: {} }],
    },
    {
      message: { role: "assistant", content: "done" },
    },
  ]);

  const events: AgentEvent[] = [];
  const logs: Array<{ type: string; data: Record<string, unknown> }> = [];
  const runner = new Runner({
    provider,
    tools,
    context: { workspaceRoot: process.cwd() },
    maxSteps: 3,
    maxToolCalls: 3,
    onEvent: (event) => events.push(event),
    logger: {
      log: async (type: string, data: Record<string, unknown>) => {
        logs.push({ type, data });
      },
      logSafetyEvent: async (data: Record<string, unknown>) => {
        logs.push({ type: "safety_event", data });
      },
    } as unknown as import("../RunLogger.js").RunLogger,
  });

  const result = await runner.run([{ role: "user", content: "hi" }]);
  assert.equal(result.finalMessage.content, "done");
  const toolEvent = events.find(
    (event): event is Extract<AgentEvent, { type: "tool_result" }> =>
      event.type === "tool_result" && event.name === "guarded",
  );
  assert.ok(toolEvent);
  assert.equal(toolEvent.ok, false);
  assert.equal(toolEvent.errorCode, "tool_permission_denied");
  assert.equal(toolEvent.retryable, false);

  const toolLog = logs.find((entry) => entry.type === "tool_call" && entry.data.name === "guarded");
  assert.ok(toolLog);
  assert.equal(toolLog?.data.error_code, "tool_permission_denied");
  assert.equal(toolLog?.data.error_retryable, false);
  const safetyLog = logs.find((entry) => entry.type === "safety_event");
  assert.ok(safetyLog);
  assert.equal(safetyLog?.data.code, "tool_permission_denied");
  assert.equal(safetyLog?.data.phase, "act");
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

  await assert.rejects(
    async () => {
      await runner.run([{ role: "user", content: "hi" }]);
    },
    (error: unknown) => {
      assert.ok(error instanceof RunnerBudgetError);
      assert.equal(error.code, "runner_step_limit_exceeded");
      return true;
    },
  );
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

test("Runner omits tools when toolChoice is none", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: "read_file",
    description: "read file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async () => ({ output: "ok" }),
  });
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
  assert.equal(received?.tools, undefined);
  assert.equal(received?.toolChoice, undefined);
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

  await assert.rejects(
    async () => {
      await runner.run([{ role: "user", content: "hi" }]);
    },
    (error: unknown) => {
      assert.ok(error instanceof RunnerBudgetError);
      assert.equal(error.code, "runner_timeout_exceeded");
      return true;
    },
  );
});
