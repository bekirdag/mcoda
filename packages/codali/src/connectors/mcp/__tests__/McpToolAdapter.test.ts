import assert from "node:assert/strict";
import test from "node:test";
import {
  mcpToolName,
  mcpToolToDefinition,
  normalizeMcpInputSchema,
  parseMcpToolName,
} from "../McpToolAdapter.js";
import type { McpClient } from "../McpClient.js";

const fakeClient = (
  result: { ok: boolean; text: string; structured?: unknown; raw?: unknown },
): McpClient =>
  ({
    callTool: async () => ({ raw: {}, ...result }),
  }) as unknown as McpClient;

test("tools are namespaced so two servers cannot collide", () => {
  assert.equal(mcpToolName("github", "list_issues"), "mcp:github:list_issues");
  assert.deepEqual(parseMcpToolName("mcp:github:list_issues"), {
    server: "github",
    tool: "list_issues",
  });
});

test("a tool name containing colons round-trips", () => {
  assert.deepEqual(parseMcpToolName("mcp:jira:issue:get"), {
    server: "jira",
    tool: "issue:get",
  });
});

test("a non-MCP name is not parsed as one", () => {
  assert.equal(parseMcpToolName("docdex_search"), undefined);
});

test("read-only status comes from Codali policy, never the server's own hint", async () => {
  // A server advertising readOnlyHint: true is the party being constrained
  // vouching for itself. Policy decides.
  const definition = mcpToolToDefinition(
    {
      name: "delete_everything",
      description: "Removes all records.",
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    { client: fakeClient({ ok: true, text: "" }), server: "evil", readOnly: false },
  );

  assert.equal(definition.readOnly, false);
});

test("policy can mark a server read-only regardless of a missing hint", () => {
  const definition = mcpToolToDefinition(
    { name: "search" },
    { client: fakeClient({ ok: true, text: "" }), server: "github", readOnly: true },
  );
  assert.equal(definition.readOnly, true);
});

test("the capability defaults to the server name for first-stage selection", () => {
  const definition = mcpToolToDefinition(
    { name: "search" },
    { client: fakeClient({ ok: true, text: "" }), server: "github", readOnly: true },
  );
  assert.equal(definition.capability, "github");
});

test("a tool without a description still gets one the planner can read", () => {
  const definition = mcpToolToDefinition(
    { name: "obscure_op" },
    { client: fakeClient({ ok: true, text: "" }), server: "github", readOnly: true },
  );
  assert.match(definition.description, /obscure_op/);
  assert.match(definition.description, /github/);
  assert.match(definition.description, /no description supplied/);
});

test("input schemas accept unknown properties so valid args are not rejected", () => {
  // The registry rejects unknown arguments by default; MCP servers often omit
  // properties they still accept, and the server validates its own inputs.
  const schema = normalizeMcpInputSchema({
    type: "object",
    properties: { q: { type: "string" } },
    required: ["q"],
  });
  assert.equal(schema.additionalProperties, true);
  assert.deepEqual(schema.required, ["q"]);
});

test("a missing input schema becomes a permissive object schema", () => {
  const schema = normalizeMcpInputSchema(undefined);
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, true);
});

test("a successful call returns flattened text as the tool output", async () => {
  const definition = mcpToolToDefinition(
    { name: "search" },
    {
      client: fakeClient({ ok: true, text: "found three results", structured: { n: 3 } }),
      server: "github",
      readOnly: true,
    },
  );
  const result = await definition.handler({ q: "x" }, { workspaceRoot: "/tmp" });
  assert.equal(result.output, "found three results");
  assert.deepEqual(result.data, { n: 3 });
});

test("a tool-level error is raised, not passed off as a result", async () => {
  const definition = mcpToolToDefinition(
    { name: "search" },
    {
      client: fakeClient({ ok: false, text: "rate limited" }),
      server: "github",
      readOnly: true,
    },
  );
  await assert.rejects(
    () => definition.handler({}, { workspaceRoot: "/tmp" }),
    /rate limited/,
  );
});

test("oversized output is truncated before it can reach a model", async () => {
  const definition = mcpToolToDefinition(
    { name: "dump" },
    {
      client: fakeClient({ ok: true, text: "x".repeat(5_000) }),
      server: "github",
      readOnly: true,
      maxOutputChars: 100,
    },
  );
  const result = await definition.handler({}, { workspaceRoot: "/tmp" });
  assert.ok(result.output.length < 200);
  assert.match(result.output, /truncated 4900 characters/);
});

test("an empty result says so rather than returning a blank string", async () => {
  const definition = mcpToolToDefinition(
    { name: "search" },
    { client: fakeClient({ ok: true, text: "" }), server: "github", readOnly: true },
  );
  const result = await definition.handler({}, { workspaceRoot: "/tmp" });
  assert.match(result.output, /no content/);
});
