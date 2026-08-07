import assert from "node:assert/strict";
import test from "node:test";
import { resolveToolNameAgainst } from "../GatewayPlanner.js";

const available = [
  "docdex_search",
  "docdex_open",
  "http:logmira_tenant_records:okacam_daily_logs_search",
  "mcp:github:list_issues",
];

test("an exact name is returned unchanged", () => {
  assert.equal(resolveToolNameAgainst("docdex_search", available), "docdex_search");
});

test("the bare last segment resolves to its namespaced tool", () => {
  // What a model writes when asked to repeat
  // `http:logmira_tenant_records:okacam_daily_logs_search`. Compared exactly it
  // matched nothing, and the task carrying it was rejected whole — so the run
  // called no tools and reported an empty context pack.
  assert.equal(
    resolveToolNameAgainst("okacam_daily_logs_search", available),
    "http:logmira_tenant_records:okacam_daily_logs_search",
  );
  assert.equal(resolveToolNameAgainst("list_issues", available), "mcp:github:list_issues");
});

test("dropping only the transport prefix resolves too", () => {
  assert.equal(
    resolveToolNameAgainst("logmira_tenant_records:okacam_daily_logs_search", available),
    "http:logmira_tenant_records:okacam_daily_logs_search",
  );
});

test("case differences resolve", () => {
  assert.equal(resolveToolNameAgainst("DocDex_Search", available), "docdex_search");
});

test("an ambiguous segment resolves to nothing", () => {
  // Guessing between two systems would call the wrong one, which is worse than
  // reporting the tool unavailable.
  const ambiguous = ["http:a:search", "http:b:search"];
  assert.equal(resolveToolNameAgainst("search", ambiguous), undefined);
});

test("an unknown tool stays unknown", () => {
  assert.equal(resolveToolNameAgainst("not_a_tool", available), undefined);
  assert.equal(resolveToolNameAgainst("", available), undefined);
});

test("the planner's short tool name survives sanitisation as the real tool", async () => {
  // The integration failure end to end: the planner names the connector by its
  // last segment, sanitisation compared it exactly, dropped it, and the state
  // machine then rejected the whole task as `required_tool_unavailable`. The
  // run called nothing and reported an empty context pack.
  const { sanitizePlannerOutput } = await import("../GatewayPlanner.js");
  const connector = "http:logmira_tenant_records:okacam_daily_logs_search";

  const result = sanitizePlannerOutput(
    {
      queryType: "lookup",
      subquestions: [],
      workerTasks: [
        {
          id: "t1",
          workerRole: "tool_worker",
          objective: "list logs",
          toolsAllowed: ["okacam_daily_logs_search"],
          outputFormat: "text",
        },
      ],
    } as never,
    {
      request: {
        query: "which employee logged the most hours",
        policy: { allowedTools: [connector, "docdex_search"] },
        tools: { actualTools: [connector, "docdex_search"] },
      },
    } as never,
  );

  assert.deepEqual(result.planner.workerTasks[0]?.toolsAllowed, [connector]);
  assert.ok(
    result.warnings.some((warning) => warning.startsWith("planner_task_tools_resolved:t1:")),
    `expected a resolution warning, got ${JSON.stringify(result.warnings)}`,
  );
});
