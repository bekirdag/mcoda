import assert from "node:assert/strict";
import test from "node:test";
import { LocalGatewayTaskRunner } from "../LocalGatewayTaskRunner.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";

const TOOL = "http:records:daily_logs_search";

const build = (opts: { failForced?: boolean } = {}) => {
  const registry = new ToolRegistry();
  for (const name of [TOOL, "docdex_search"]) {
    registry.register({
      name,
      description: name,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      handler: async () => ({ output: "{}" }),
    });
  }
  const choices: unknown[] = [];
  const provider = {
    name: "stub",
    supportsToolCalls: true,
    generate: async (request: { toolChoice?: unknown }) => {
      choices.push(request.toolChoice);
      if (opts.failForced && request.toolChoice && typeof request.toolChoice === "object") {
        throw new Error("tool_choice not supported");
      }
      return { message: { role: "assistant", content: "nothing found" }, toolCalls: [] };
    },
  };
  const runner = new LocalGatewayTaskRunner({
    provider: provider as never,
    registry,
    toolContext: { workspaceRoot: process.cwd() },
  });
  return { runner, choices };
};

const run = (runner: LocalGatewayTaskRunner, workerRole: string, tools: string[]) =>
  runner.run({
    runId: "r1",
    task: { id: "t1", workerRole, objective: "gather", toolsAllowed: tools, outputFormat: "text" },
    prompt: "which employee logged the most hours",
    allowedTools: tools,
    remainingToolCalls: 8,
    remainingModelCalls: 4,
  } as never);

test("a retrieval task with one tool is told which tool to call", async () => {
  // Emission is intermittent at the model: one real call, then four runs that
  // narrated instead. The planner already chose the tool, so whether to call it
  // is not the model's question to answer.
  const { runner, choices } = build();
  await run(runner, "tool_worker", [TOOL]);
  assert.deepEqual(choices[0], { name: TOOL });
});

test("with several tools the choice stays the model's", async () => {
  const { runner, choices } = build();
  await run(runner, "tool_worker", [TOOL, "docdex_search"]);
  assert.equal(choices[0], "auto");
});

test("a worker that may answer from knowledge is not forced", async () => {
  const { runner, choices } = build();
  await run(runner, "direct_answer", [TOOL]);
  assert.equal(choices[0], "auto");
});

test("an endpoint that rejects a named tool still gets the task done", async () => {
  // Not every endpoint accepts one, and a run must not die because we asked.
  const { runner, choices } = build({ failForced: true });
  const result = await run(runner, "tool_worker", [TOOL]);
  assert.deepEqual(choices[0], { name: TOOL });
  assert.equal(choices[1], "auto");
  assert.equal(result.status, "succeeded");
});
