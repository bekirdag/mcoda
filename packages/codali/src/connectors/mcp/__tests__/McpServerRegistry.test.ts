import assert from "node:assert/strict";
import test from "node:test";
import { McpServerRegistry } from "../McpServerRegistry.js";
import { McpClient, McpClientError, type McpServerDefinition } from "../McpClient.js";
import { attachMcpTools } from "../McpToolSource.js";
import { ToolRegistry } from "../../../tools/ToolRegistry.js";

interface StubOptions {
  tools?: Array<{ name: string; description?: string }>;
  listError?: Error;
  callError?: Error;
  callDelayMs?: number;
}

const stubClient = (name: string, options: StubOptions = {}): McpClient => {
  const state = { callCount: 0, closed: false };
  const client = {
    name,
    state,
    async listTools() {
      if (options.listError) throw options.listError;
      return options.tools ?? [{ name: "alpha", description: "Alpha tool" }];
    },
    async callTool() {
      state.callCount += 1;
      if (options.callDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
      }
      if (options.callError) throw options.callError;
      return { ok: true, text: "result", raw: {} };
    },
    async close() {
      state.closed = true;
    },
  };
  return client as unknown as McpClient;
};

const definition = (name: string): McpServerDefinition => ({
  name,
  transport: "stdio",
  command: "noop",
});

test("tools from every configured server are discovered and namespaced", async () => {
  const registry = new McpServerRegistry({
    servers: [definition("github"), definition("jira")],
    createClient: (server) => stubClient(server.name),
  });

  const tools = await registry.discoverTools();

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["mcp:github:alpha", "mcp:jira:alpha"],
  );
});

test("a disabled server is skipped without being contacted", async () => {
  let created = 0;
  const registry = new McpServerRegistry({
    servers: [{ ...definition("github"), enabled: false }],
    createClient: (server) => {
      created += 1;
      return stubClient(server.name);
    },
  });

  const tools = await registry.discoverTools();

  assert.equal(tools.length, 0);
  assert.equal(created, 0);
  assert.equal(registry.healthReport()[0]?.status, "disabled");
});

test("one failing server does not prevent another from working", async () => {
  const registry = new McpServerRegistry({
    servers: [definition("broken"), definition("working")],
    createClient: (server) =>
      server.name === "broken"
        ? stubClient(server.name, { listError: new Error("connection refused") })
        : stubClient(server.name),
  });

  const tools = await registry.discoverTools();

  assert.deepEqual(tools.map((tool) => tool.name), ["mcp:working:alpha"]);
  const health = registry.healthReport();
  assert.equal(health.find((entry) => entry.name === "broken")?.status, "failed");
  assert.equal(health.find((entry) => entry.name === "working")?.status, "connected");
});

test("a failing server's error is recorded for diagnosis", async () => {
  const registry = new McpServerRegistry({
    servers: [definition("broken")],
    createClient: (server) =>
      stubClient(server.name, { listError: new Error("ENOENT: command not found") }),
  });
  await registry.discoverTools();
  assert.match(registry.healthReport()[0]?.error ?? "", /command not found/);
});

test("a retryable transport failure is retried exactly once", async () => {
  const client = stubClient("flaky", {
    callError: new McpClientError("mcp_call_tool_failed", "flaky", "socket hang up", {
      retryable: true,
    }),
  });
  const registry = new McpServerRegistry({
    servers: [definition("flaky")],
    createClient: () => client,
  });

  const tools = await registry.discoverTools();
  await assert.rejects(() => tools[0]!.handler({}, { workspaceRoot: "/tmp" }));

  // Two attempts total: the original plus one retry. Safe because Phase 2
  // connectors are read-only.
  assert.equal((client as unknown as { state: { callCount: number } }).state.callCount, 2);
});

test("a non-retryable failure is not retried", async () => {
  const client = stubClient("strict", {
    callError: new McpClientError("mcp_call_tool_failed", "strict", "bad request", {
      retryable: false,
    }),
  });
  const registry = new McpServerRegistry({
    servers: [definition("strict")],
    createClient: () => client,
  });

  const tools = await registry.discoverTools();
  await assert.rejects(() => tools[0]!.handler({}, { workspaceRoot: "/tmp" }));

  assert.equal((client as unknown as { state: { callCount: number } }).state.callCount, 1);
});

test("concurrent calls are capped so one server cannot monopolise a run", async () => {
  let active = 0;
  let peak = 0;
  const client = {
    async listTools() {
      return [{ name: "slow" }];
    },
    async callTool() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { ok: true, text: "done", raw: {} };
    },
    async close() {},
  } as unknown as McpClient;

  const registry = new McpServerRegistry({
    servers: [definition("slow")],
    createClient: () => client,
    maxConcurrentCalls: 2,
  });

  const tools = await registry.discoverTools();
  await Promise.all(
    Array.from({ length: 6 }, () => tools[0]!.handler({}, { workspaceRoot: "/tmp" })),
  );

  assert.ok(peak <= 2, `expected at most 2 concurrent calls, saw ${peak}`);
});

test("closing shuts down every connected server", async () => {
  const clients = new Map<string, McpClient>();
  const registry = new McpServerRegistry({
    servers: [definition("a"), definition("b")],
    createClient: (server) => {
      const client = stubClient(server.name);
      clients.set(server.name, client);
      return client;
    },
  });

  await registry.discoverTools();
  await registry.close();

  for (const client of clients.values()) {
    assert.equal((client as unknown as { state: { closed: boolean } }).state.closed, true);
  }
});

test("discovered tools land in the run's existing registry, not a parallel store", async () => {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register({
    name: "docdex_search",
    description: "Search the repo.",
    capability: "docdex",
    readOnly: true,
    handler: async () => ({ output: "" }),
  });

  const result = await attachMcpTools({
    context: { mcpServers: [definition("github")] },
    toolRegistry,
    createRegistry: (options) =>
      new McpServerRegistry({ ...options, createClient: (server) => stubClient(server.name) }),
  });

  assert.deepEqual(result.registered, ["mcp:github:alpha"]);
  // One registry: the planner and the executor cannot see different schemas.
  assert.deepEqual(
    toolRegistry.list().map((tool) => tool.name).sort(),
    ["docdex_search", "mcp:github:alpha"],
  );
  await result.registry?.close();
});

test("attaching with no configured servers is a no-op", async () => {
  const toolRegistry = new ToolRegistry();
  const result = await attachMcpTools({ context: {}, toolRegistry });
  assert.deepEqual(result.registered, []);
  assert.deepEqual(result.health, []);
  assert.equal(result.registry, undefined);
});

test("an unavailable server produces a warning rather than failing the run", async () => {
  const toolRegistry = new ToolRegistry();
  const result = await attachMcpTools({
    context: { mcpServers: [definition("broken")] },
    toolRegistry,
    createRegistry: (options) =>
      new McpServerRegistry({
        ...options,
        createClient: (server) =>
          stubClient(server.name, { listError: new Error("refused") }),
      }),
  });

  assert.deepEqual(result.registered, []);
  assert.ok(result.warnings.some((warning) => warning.startsWith("mcp_server_unavailable:broken")));
  await result.registry?.close();
});
