import assert from "node:assert/strict";
import test from "node:test";
import { attachHttpTools } from "../HttpToolSource.js";
import { ToolRegistry } from "../../../tools/ToolRegistry.js";

const attach = (tool: Record<string, unknown>) => {
  const registry = new ToolRegistry();
  const result = attachHttpTools({
    context: {
      httpConnectors: [
        { name: "records", baseUrl: "http://127.0.0.1:1", tools: [tool] },
      ],
      warnings: [],
    } as never,
    toolRegistry: registry,
  });
  return { registry, result };
};

test("a tool declared with no arguments is reported to the host", () => {
  // An under-declared tool does not fail loudly. It produces a worker that
  // reads `properties: {}` as "takes no parameters" and declines to call it —
  // verbatim: "the tool does not accept parameters for specifying a time range".
  const { result } = attach({
    id: "daily_logs_search",
    description: "Search daily logs",
    method: "GET",
    urlTemplate: "/logs",
  });
  assert.ok(
    result.warnings.some((warning) =>
      warning.startsWith("http_tool_has_no_declared_arguments:http:records:daily_logs_search"),
    ),
    `expected a warning, got ${JSON.stringify(result.warnings)}`,
  );
});

test("and is described as callable rather than argumentless", () => {
  const { registry } = attach({
    id: "daily_logs_search",
    description: "Search daily logs",
    method: "GET",
    urlTemplate: "/logs",
  });
  const descriptor = registry.catalog(["http:records:daily_logs_search"])[0];
  assert.match(String(descriptor?.description), /calling it with no arguments is valid/);
});

test("a properly declared tool is left alone", () => {
  const { registry, result } = attach({
    id: "daily_logs_search",
    description: "Search daily logs",
    method: "GET",
    urlTemplate: "/logs",
    inputSchema: { type: "object", properties: { from: { type: "string" } } },
  });
  assert.equal(
    result.warnings.some((w) => w.startsWith("http_tool_has_no_declared_arguments")),
    false,
  );
  const descriptor = registry.catalog(["http:records:daily_logs_search"])[0];
  assert.equal(descriptor?.description, "Search daily logs");
});
