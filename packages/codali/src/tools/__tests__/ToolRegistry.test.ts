import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../ToolRegistry.js";

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
  assert.match(result.error ?? "", /Unknown tool/);
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
  assert.match(result.error ?? "", /Missing required arguments/);
});
