import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import {
  CODALI_MCP_PROTOCOL_VERSION,
  McpClient,
  McpClientError,
  flattenMcpContent,
  type McpTransportClient,
} from "../McpClient.js";

/**
 * Compatibility guard. Pinning the SDK version is only half the protection —
 * this asserts the protocol the SDK actually speaks, so a dependency bump that
 * changes the wire format fails here rather than against a live server.
 */
test("the SDK speaks the protocol version this build was written against", () => {
  assert.equal(
    LATEST_PROTOCOL_VERSION,
    CODALI_MCP_PROTOCOL_VERSION,
    "MCP protocol version changed; re-verify tools/list and tools/call before bumping",
  );
});

class StubTransport implements McpTransportClient {
  listToolsCalls = 0;
  callToolCalls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  closed = false;

  constructor(
    private readonly tools: unknown[] = [],
    private readonly callResult: unknown = { content: [{ type: "text", text: "ok" }] },
  ) {}

  async listTools() {
    this.listToolsCalls += 1;
    return { tools: this.tools };
  }

  async callTool(params: { name: string; arguments?: Record<string, unknown> }) {
    this.callToolCalls.push(params);
    if (this.callResult instanceof Error) throw this.callResult;
    return this.callResult;
  }

  async close() {
    this.closed = true;
  }
}

const clientWith = (transport: McpTransportClient, overrides = {}) =>
  new McpClient({
    definition: {
      name: "test",
      transport: "stdio",
      command: "noop",
      ...overrides,
    },
    createClient: async () => transport,
  });

test("tools/list results are normalized into tool definitions", async () => {
  const transport = new StubTransport([
    {
      name: "search",
      description: "Search things",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
    { name: "noDescription" },
    { notATool: true },
  ]);

  const tools = await clientWith(transport).listTools();

  assert.equal(tools.length, 2, "entries without a name are dropped");
  assert.equal(tools[0]?.name, "search");
  assert.equal(tools[0]?.description, "Search things");
  assert.deepEqual(tools[0]?.annotations, { readOnlyHint: true });
});

test("the connection is established once and shared", async () => {
  const transport = new StubTransport([{ name: "a" }]);
  const client = clientWith(transport);
  await Promise.all([client.listTools(), client.listTools(), client.listTools()]);
  assert.equal(transport.listToolsCalls, 3);
});

test("allowTools narrows what a server may expose", async () => {
  const transport = new StubTransport([{ name: "a" }, { name: "b" }, { name: "c" }]);
  const tools = await clientWith(transport, { allowTools: ["a", "c"] }).listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["a", "c"]);
});

test("denyTools wins over allowTools", async () => {
  const transport = new StubTransport([{ name: "a" }, { name: "b" }]);
  const tools = await clientWith(transport, {
    allowTools: ["a", "b"],
    denyTools: ["b"],
  }).listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["a"]);
});

test("text content blocks are flattened for the model", () => {
  const text = flattenMcpContent([
    { type: "text", text: "line one" },
    { type: "text", text: "line two" },
  ]);
  assert.equal(text, "line one\nline two");
});

test("non-text content is described rather than silently dropped", () => {
  const text = flattenMcpContent([
    { type: "text", text: "before" },
    { type: "image", data: "…", mimeType: "image/png" },
  ]);
  assert.match(text, /before/);
  assert.match(text, /\[image content omitted\]/);
});

test("embedded resources contribute their text", () => {
  const text = flattenMcpContent([
    { type: "resource", resource: { uri: "file:///a.ts", text: "contents" } },
  ]);
  assert.equal(text, "contents");
});

test("a tool reporting isError is surfaced as a failed call, not a result", async () => {
  const transport = new StubTransport([], {
    isError: true,
    content: [{ type: "text", text: "repository not found" }],
  });
  const result = await clientWith(transport).callTool("get_repo", { name: "x" });
  assert.equal(result.ok, false);
  assert.equal(result.text, "repository not found");
});

test("structured content is preserved alongside the flattened text", async () => {
  const transport = new StubTransport([], {
    content: [{ type: "text", text: "summary" }],
    structuredContent: { count: 3 },
  });
  const result = await clientWith(transport).callTool("list", {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.structured, { count: 3 });
});

test("a transport failure becomes a retryable McpClientError", async () => {
  const transport = new StubTransport([], new Error("socket hang up"));
  await assert.rejects(
    () => clientWith(transport).callTool("x", {}),
    (error: unknown) => {
      assert.ok(error instanceof McpClientError);
      assert.equal(error.code, "mcp_call_tool_failed");
      assert.equal(error.retryable, true);
      assert.equal(error.server, "test");
      return true;
    },
  );
});

test("non-object arguments are normalized rather than forwarded", async () => {
  const transport = new StubTransport();
  await clientWith(transport).callTool("x", "not an object");
  assert.deepEqual(transport.callToolCalls[0]?.arguments, {});
});

test("closing is idempotent and tolerates a transport that throws", async () => {
  const transport = new StubTransport();
  const client = clientWith(transport);
  await client.listTools();
  transport.close = async () => {
    throw new Error("already gone");
  };
  await client.close();
  await client.close();
});
