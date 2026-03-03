import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../ToolRegistry.js";
import { ToolExecutionError } from "../ToolTypes.js";

const context = { workspaceRoot: "/tmp" };

test("ToolRegistry executes registered tools", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "echo args",
    handler: async (args) => ({
      output: JSON.stringify(args ?? null),
    }),
  });

  const result = await registry.execute("echo", { ok: true }, context);
  assert.equal(result.ok, true);
  assert.equal(result.output, "{\"ok\":true}");
});

test("ToolRegistry reports unknown tools", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  const result = await registry.execute("missing", {}, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "tool_unknown");
  assert.match(result.error?.message ?? "", /Unknown tool/);
  assert.equal(result.error?.retryable, false);
});

test("ToolRegistry validates required args", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "needs_args",
    description: "requires args",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
    },
    handler: async () => ({
      output: "ok",
    }),
  });

  const result = await registry.execute("needs_args", {}, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "tool_invalid_args");
  assert.match(result.error?.message ?? "", /Missing required argument/);
  assert.equal(result.error?.details?.path, "$.path");
});

test("ToolRegistry validates argument types and unknown fields strictly", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "strict_args",
    description: "strict args",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" },
        retries: { type: "integer" },
      },
    },
    handler: async () => ({ output: "ok" }),
  });

  const wrongType = await registry.execute("strict_args", { path: 42 }, context);
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.error?.code, "tool_invalid_args");
  assert.equal(wrongType.error?.details?.path, "$.path");

  const unknownArg = await registry.execute(
    "strict_args",
    { path: "src/a.ts", extra: "unexpected" },
    context,
  );
  assert.equal(unknownArg.ok, false);
  assert.equal(unknownArg.error?.code, "tool_invalid_args");
  assert.equal(unknownArg.error?.details?.path, "$.extra");
  assert.match(unknownArg.error?.message ?? "", /Unknown argument/);
});

test("ToolRegistry supports additionalProperties when explicitly enabled", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "extended_args",
    description: "extended args",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      additionalProperties: true,
    },
    handler: async (args) => ({ output: JSON.stringify(args) }),
  });

  const result = await registry.execute(
    "extended_args",
    { path: "a.ts", extra: "allowed" },
    context,
  );
  assert.equal(result.ok, true);
});

test("ToolRegistry reports schema-invalid tools separately", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "broken_schema",
    description: "broken",
    inputSchema: {
      // @ts-expect-error intentional invalid type for runtime validation coverage
      type: "banana",
      properties: {},
    },
    handler: async () => ({ output: "ok" }),
  });

  const result = await registry.execute("broken_schema", {}, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "tool_schema_invalid");
  assert.match(result.error?.message ?? "", /Invalid schema/);
  assert.equal(result.error?.retryable, false);
});

test("ToolRegistry preserves explicit tool execution error metadata", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "permission_error",
    description: "permission",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new ToolExecutionError("tool_permission_denied", "blocked");
    },
  });

  const result = await registry.execute("permission_error", {}, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "tool_permission_denied");
  assert.equal(result.error?.category, "permission");
  assert.equal(result.error?.retryable, false);
});

test("ToolRegistry normalizes generic timeout errors", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "generic_timeout",
    description: "timeout",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      throw new Error("operation timed out");
    },
  });

  const result = await registry.execute("generic_timeout", {}, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "tool_timeout");
  assert.equal(result.error?.retryable, true);
});
