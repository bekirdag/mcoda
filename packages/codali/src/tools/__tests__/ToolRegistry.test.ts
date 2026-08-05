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

test("ToolRegistry rejects a wrong type and ignores an unknown field", { concurrency: false }, async () => {
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

  // An unknown field used to fail the call. A worker gets one batch of tool
  // calls, so that turned a nearly-right call into no call at all; the field is
  // dropped instead and the tool runs with its documented defaults.
  const unknownArg = await registry.execute(
    "strict_args",
    { path: "src/a.ts", extra: "unexpected" },
    context,
  );
  assert.equal(unknownArg.ok, true);
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

test("ToolRegistry preserves Docdex runtime error codes", { concurrency: false }, async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "docdex_policy_error",
    description: "docdex policy",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const error = new Error("Docdex operation is not allowed by this job: open");
      Object.assign(error, {
        code: "docdex_operation_not_allowed",
        retryable: false,
        details: { operation: "open" },
      });
      throw error;
    },
  });

  const result = await registry.execute("docdex_policy_error", {}, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "docdex_operation_not_allowed");
  assert.equal(result.error?.category, "permission");
  assert.equal(result.error?.retryable, false);
  assert.deepEqual(result.error?.details, { operation: "open" });
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

test("an unknown argument is dropped rather than failing the call", async () => {
  // A worker gets one batch of tool calls, so a rejected call is not retried —
  // it takes the sub-task down with it. Small models lost calls by naming a
  // field `depth` when the schema said `maxDepth`.
  const registry = new ToolRegistry();
  let received: unknown;
  registry.register({
    name: "listing",
    description: "list",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, maxDepth: { type: "number" } },
    },
    handler: async (args) => {
      received = args;
      return { output: "ok" };
    },
  });

  const result = await registry.execute(
    "listing",
    { path: "packages", depth: 2 },
    { workspaceRoot: "/tmp" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(received, { path: "packages" });
});

test("a scalar string is coerced to the declared type", async () => {
  const registry = new ToolRegistry();
  let received: Record<string, unknown> | undefined;
  registry.register({
    name: "listing",
    description: "list",
    inputSchema: {
      type: "object",
      properties: {
        maxDepth: { type: "number" },
        dirsOnly: { type: "boolean" },
        limit: { type: "integer" },
      },
    },
    handler: async (args) => {
      received = args as Record<string, unknown>;
      return { output: "ok" };
    },
  });

  const result = await registry.execute(
    "listing",
    { maxDepth: "2", dirsOnly: "true", limit: "5" },
    { workspaceRoot: "/tmp" },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(received, { maxDepth: 2, dirsOnly: true, limit: 5 });
});

test("tolerance does not extend to values that are actually wrong", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "listing",
    description: "list",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, maxDepth: { type: "number" } },
    },
    handler: async () => ({ output: "ok" }),
  });

  // "two" is not a number, and a missing required argument is still missing.
  const badType = await registry.execute(
    "listing",
    { path: "packages", maxDepth: "two" },
    { workspaceRoot: "/tmp" },
  );
  assert.equal(badType.ok, false);
  assert.equal(badType.error?.code, "tool_invalid_args");

  const missing = await registry.execute("listing", { depth: 2 }, { workspaceRoot: "/tmp" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "tool_invalid_args");
});

test("a tool that opts into extra properties still receives them", async () => {
  const registry = new ToolRegistry();
  let received: unknown;
  registry.register({
    name: "passthrough",
    description: "anything",
    inputSchema: { type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
    handler: async (args) => {
      received = args;
      return { output: "ok" };
    },
  });

  await registry.execute("passthrough", { a: "x", b: 1 }, { workspaceRoot: "/tmp" });
  assert.deepEqual(received, { a: "x", b: 1 });
});
