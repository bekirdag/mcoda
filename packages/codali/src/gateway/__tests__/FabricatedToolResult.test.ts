import assert from "node:assert/strict";
import test from "node:test";
import { LocalGatewayTaskRunner } from "../LocalGatewayTaskRunner.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";

/** The payload a worker actually produced against a connector it never called. */
const FABRICATED = JSON.stringify({
  evidence_items: [
    {
      tool_name: "http:logmira_tenant_records:okacam_daily_logs_search",
      tool_call_id: "call_001",
      status: "success",
      parameters: {},
      raw_data_excerpt: [
        { date: "2026-07-29", employee_id: "emp_101", hours_logged: 8.5 },
        { date: "2026-07-30", employee_id: "emp_101", hours_logged: 9.0 },
      ],
    },
  ],
});

const runnerWith = (content: string) => {
  const registry = new ToolRegistry();
  registry.register({
    name: "http:logmira_tenant_records:okacam_daily_logs_search",
    description: "Search daily logs",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ output: "{}" }),
  });
  return new LocalGatewayTaskRunner({
    provider: {
      name: "stub",
      supportsToolCalls: true,
      generate: async () => ({ message: { role: "assistant", content }, toolCalls: [] }),
    } as never,
    registry,
    toolContext: { workspaceRoot: process.cwd() },
  });
};

const runTask = (runner: LocalGatewayTaskRunner) =>
  runner.run({
    runId: "r1",
    task: {
      id: "t1",
      workerRole: "tool_worker",
      objective: "find hours logged",
      toolsAllowed: ["http:logmira_tenant_records:okacam_daily_logs_search"],
      outputFormat: "text",
    },
    prompt: "Which employee logged the most hours?",
    allowedTools: ["http:logmira_tenant_records:okacam_daily_logs_search"],
    remainingToolCalls: 8,
    remainingModelCalls: 4,
  } as never);

test("a worker that invents tool results fails instead of supplying evidence", async () => {
  // Real payload from a timesheet product: employee ids and hours that exist
  // nowhere, labelled `status: success` with a tool_call_id, against a
  // connector that received no request. The verifier happened to reject the
  // context pack; nothing guaranteed it would.
  const result = await runTask(runnerWith(FABRICATED));

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "GATEWAY_WORKER_FABRICATED_TOOL_RESULT");
  assert.ok(
    !JSON.stringify(result.output ?? "").includes("emp_101"),
    "invented rows must not survive as task output",
  );
});

test("an honest worker that called nothing still reports what it could not find", async () => {
  // Prose is not the problem, and a worker must stay free to say this.
  const result = await runTask(
    runnerWith("I could not determine the hours logged; the search returned nothing relevant."),
  );
  assert.equal(result.status, "succeeded");
  assert.match(String(result.output), /could not determine/);
});

test("a single passing mention of a tool is not treated as fabrication", async () => {
  const result = await runTask(
    runnerWith("The daily logs tool would answer this, but I have no results to report."),
  );
  assert.equal(result.status, "succeeded");
});

test("the run records that nothing was retrieved", async () => {
  const result = await runTask(runnerWith("Nothing found."));
  assert.equal((result.metadata as Record<string, unknown>).noToolsExecuted, true);
});
