import assert from "node:assert/strict";
import test from "node:test";
import { inspectToolSurface } from "../ToolSurface.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";

const registryWith = (...names: string[]): ToolRegistry => {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.register({
      name,
      description: `tool ${name}`,
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ output: "ok" }),
    });
  }
  return registry;
};

test("reports the tools a tenant's run will actually be offered", () => {
  const report = inspectToolSurface(
    { tenant: { slug: "wodo" }, warnings: [] } as never,
    registryWith("docdex_search", "mcp:github:list_issues"),
  );

  assert.deepEqual(report.registered, ["docdex_search", "mcp:github:list_issues"]);
  assert.ok(report.visible.includes("docdex_search"));
  assert.ok(report.visible.includes("mcp:github:list_issues"));
  assert.deepEqual(report.dropped, []);
});

test("an empty registry reports nothing rather than failing", () => {
  const report = inspectToolSurface({ warnings: [] } as never, registryWith());
  assert.deepEqual(report.registered, []);
  assert.deepEqual(report.dropped, []);
});

test("every registered tool is accounted for as visible or dropped", () => {
  // The property that matters: a host can never be left wondering where a tool
  // went. Silent loss is the failure this exists to catch.
  const registry = registryWith("docdex_search", "docdex_web_research", "http:jira:get_issue");
  const report = inspectToolSurface({ tenant: { slug: "wodo" }, warnings: [] } as never, registry);

  const accountedFor = new Set([...report.visible, ...report.dropped.map((entry) => entry.tool)]);
  for (const tool of report.registered) {
    assert.ok(accountedFor.has(tool), `${tool} was neither visible nor explained`);
  }
});

test("a dropped tool always carries a reason", () => {
  const report = inspectToolSurface(
    { warnings: [] } as never,
    registryWith("docdex_search", "some:unknown:tool"),
  );
  for (const entry of report.dropped) {
    assert.ok(entry.reason.length > 0, `${entry.tool} was dropped without a reason`);
  }
});
