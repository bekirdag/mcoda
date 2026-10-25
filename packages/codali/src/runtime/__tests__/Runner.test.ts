import test from "node:test";
import assert from "node:assert/strict";
import { Runner, RunnerBudgetError } from "../Runner.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import { ToolExecutionError } from "../../tools/ToolTypes.js";
import { OpenAiCompatibleProvider } from "../../providers/OpenAiCompatibleProvider.js";
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

test("Runner preserves assistant tool calls through the OpenAI-compatible round trip", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests += 1;
    if (requests === 2) {
      const assistant = body.messages.find((message: { role: string }) => message.role === "assistant");
      assert.deepEqual(assistant.tool_calls, [{
        id: "call_echo", type: "function", function: { name: "echo", arguments: '{"ok":true}' },
      }]);
      const tool = body.messages.find((message: { role: string }) => message.role === "tool");
      assert.equal(tool.tool_call_id, "call_echo");
      assert.equal(tool.content, '{"ok":true}');
    }
    const message = requests === 1
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_echo", type: "function", function: { name: "echo", arguments: '{"ok":true}' } }] }
      : { role: "assistant", content: "Verified" };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const tools = new ToolRegistry();
    tools.register({ name: "echo", description: "Echo supplied arguments", handler: async (args) => ({ output: JSON.stringify(args) }) });
    const runner = new Runner({
      provider: new OpenAiCompatibleProvider({ model: "strata-test", baseUrl: "http://127.0.0.1:9999/v1/" }),
      tools, context: { workspaceRoot: process.cwd() }, maxSteps: 2, maxToolCalls: 1,
    });
    const result = await runner.run([{ role: "user", content: "Verify with echo." }]);
    assert.equal(result.finalMessage.content, "Verified");
    assert.equal(result.toolCallsExecuted, 1);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test("Runner reserves a bounded worker's final step for summary without more tools", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  tools.register({ name: "read_evidence", description: "Read evidence", handler: async () => ({ output: "verified evidence" }) });
  let calls = 0;
  const provider: Provider = {
    name: "bounded-worker",
    async generate(request) {
      calls += 1;
      if (calls === 1) {
        assert.equal(request.tools?.[0].name, "read_evidence");
        return { message: { role: "assistant", content: "" }, toolCalls: [{ id: "evidence", name: "read_evidence", args: {} }] };
      }
      assert.equal(request.tools, undefined);
      assert.equal(request.toolChoice, "none");
      assert.equal(request.messages.at(-1)?.content, "verified evidence");
      return { message: { role: "assistant", content: "Evidence summary" } };
    },
  };
  const runner = new Runner({ provider, tools, context: { workspaceRoot: process.cwd() }, maxSteps: 2, maxToolCalls: 8, finalStepWithoutTools: true });
  const result = await runner.run([{ role: "user", content: "Gather evidence and summarize it." }]);
  assert.equal(result.finalMessage.content, "Evidence summary");
  assert.equal(calls, 2);
  assert.equal(result.toolCallsExecuted, 1);
});

test("Runner bounds combined tool results while keeping whole items and coverage notices", { concurrency: false }, async () => {
  const tools = new ToolRegistry();
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: index, evidence: "evidence ".repeat(100) }));
  tools.register({ name: "search", description: "Search evidence", handler: async () => ({ output: JSON.stringify({ hits: rows }) }) });
  let calls = 0;
  const provider: Provider = { name: "bounded-evidence", async generate(request) {
    if (++calls === 1) return { message: { role: "assistant", content: "" }, toolCalls: [
      { id: "a", name: "search", args: {} }, { id: "b", name: "search", args: {} },
    ] };
    const results = request.messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 2);
    for (const result of results) {
      assert.match(result.content, /TRUNCATED.*INCOMPLETE/);
      const retained = JSON.parse(result.content.split("\n\n[TRUNCATED:")[0]);
      assert.ok(retained.hits.length > 0 && retained.hits.length < rows.length);
      assert.deepEqual(retained.hits[0], rows[0]);
    }
    assert.ok(results.reduce((sum, result) => sum + result.content.length, 0) < 5_000);
    return { message: { role: "assistant", content: "Partial evidence was retained." } };
  } };
  const runner = new Runner({ provider, tools, context: { workspaceRoot: process.cwd() }, maxSteps: 2, maxToolCalls: 2, maxToolResultChars: 4_000, finalStepWithoutTools: true });
  await runner.run([{ role: "user", content: "Search both sources." }]);
  assert.equal(rows.length, 100);
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
