import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MODEL_CALLS_PER_TASK,
  MAX_TOOL_CALLS_PER_TASK,
  createLocalGatewayTaskRunner,
} from "../LocalGatewayTaskRunner.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";
import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "../../providers/ProviderTypes.js";
import type { CodaliGatewayWorkerTaskRunInput } from "../GatewayStateMachine.js";

class StubProvider implements Provider {
  readonly name = "stub";
  readonly requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("StubProvider ran out of responses");
    }
    return response;
  }
}

const textResponse = (content: string): ProviderResponse => ({
  message: { role: "assistant", content },
});

const toolCallResponse = (
  calls: Array<{ name: string; args: unknown }>,
): ProviderResponse => ({
  message: { role: "assistant", content: "" },
  toolCalls: calls.map((call, index) => ({
    id: `call-${index}`,
    name: call.name,
    args: call.args,
  })),
});

const registryWith = (
  handlers: Record<string, (args: unknown) => Promise<{ output: string }>>,
): ToolRegistry => {
  const registry = new ToolRegistry();
  for (const [name, handler] of Object.entries(handlers)) {
    registry.register({
      name,
      description: `${name} tool`,
      readOnly: true,
      capability: "test",
      inputSchema: { type: "object", additionalProperties: true, properties: {} },
      handler: async (args) => handler(args),
    });
  }
  return registry;
};

const taskInput = (
  overrides: Partial<CodaliGatewayWorkerTaskRunInput> = {},
): CodaliGatewayWorkerTaskRunInput =>
  ({
    runId: "run-1",
    task: {
      id: "task-1",
      workerRole: "tool_worker",
      objective: "Find the thing",
      toolsAllowed: ["alpha"],
      outputFormat: "text",
    },
    prompt: "Find the thing.",
    allowedTools: ["alpha"],
    remainingToolCalls: 8,
    remainingModelCalls: 4,
    timeoutMs: 30_000,
    request: {} as CodaliGatewayWorkerTaskRunInput["request"],
    policyCompilation: {} as CodaliGatewayWorkerTaskRunInput["policyCompilation"],
    ...overrides,
  }) as CodaliGatewayWorkerTaskRunInput;

const baseOptions = (provider: Provider, registry: ToolRegistry) => ({
  provider,
  registry,
  toolContext: { workspaceRoot: "/tmp" },
});

test("a task never exceeds two model calls, even when tools are used", async () => {
  const provider = new StubProvider([
    toolCallResponse([{ name: "alpha", args: {} }]),
    textResponse("Alpha reported 42."),
  ]);
  const registry = registryWith({ alpha: async () => ({ output: "42" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput());

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Alpha reported 42.");
  assert.equal(provider.requests.length, MAX_MODEL_CALLS_PER_TASK);
  assert.equal(result.modelCalls?.length, 2);
  assert.equal(result.toolCalls?.length, 1);
});

test("a task with no requested tools returns after one model call", async () => {
  const provider = new StubProvider([textResponse("No tools needed; the answer is 7.")]);
  const registry = registryWith({ alpha: async () => ({ output: "42" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput());

  assert.equal(result.status, "succeeded");
  assert.equal(provider.requests.length, 1);
  assert.equal(result.toolCalls?.length, 0);
});

test("the runner does not loop: a second tool request is never honoured", async () => {
  // The summarize pass is issued with toolChoice "none". Even if the model
  // tries to call more tools, execution has already ended.
  const provider = new StubProvider([
    toolCallResponse([{ name: "alpha", args: {} }]),
    toolCallResponse([{ name: "alpha", args: { again: true } }]),
  ]);
  const registry = registryWith({ alpha: async () => ({ output: "42" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput());

  assert.equal(result.toolCalls?.length, 1, "only the first batch executes");
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1]?.toolChoice, "none");
});

test("tool calls are capped by the per-task ceiling", async () => {
  const requested = Array.from({ length: MAX_TOOL_CALLS_PER_TASK + 5 }, () => ({
    name: "alpha",
    args: {},
  }));
  const provider = new StubProvider([
    toolCallResponse(requested),
    textResponse("Summarized."),
  ]);
  const registry = registryWith({ alpha: async () => ({ output: "ok" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput({ remainingToolCalls: 100 }));

  assert.equal(result.toolCalls?.length, MAX_TOOL_CALLS_PER_TASK);
});

test("tool calls are capped by the run's remaining budget", async () => {
  const provider = new StubProvider([
    toolCallResponse([
      { name: "alpha", args: {} },
      { name: "alpha", args: {} },
      { name: "alpha", args: {} },
    ]),
    textResponse("Summarized."),
  ]);
  const registry = registryWith({ alpha: async () => ({ output: "ok" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput({ remainingToolCalls: 2 }));

  assert.equal(result.toolCalls?.length, 2);
});

test("a tool outside the allowed list is refused, not executed", async () => {
  let forbiddenRan = false;
  const provider = new StubProvider([
    toolCallResponse([{ name: "forbidden", args: {} }, { name: "alpha", args: {} }]),
    textResponse("Summarized."),
  ]);
  const registry = registryWith({
    alpha: async () => ({ output: "ok" }),
    forbidden: async () => {
      forbiddenRan = true;
      return { output: "should not happen" };
    },
  });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput({ allowedTools: ["alpha"] }));

  assert.equal(forbiddenRan, false);
  const refused = result.toolCalls?.find((call) => call.tool === "forbidden");
  assert.equal(refused?.status, "failed");
  assert.equal(refused?.errorCode, "tool_permission_denied");
});

test("when every tool fails the task fails rather than narrating an empty result", async () => {
  const provider = new StubProvider([toolCallResponse([{ name: "alpha", args: {} }])]);
  const registry = registryWith({
    alpha: async () => {
      throw new Error("upstream exploded");
    },
  });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput());

  assert.equal(result.status, "failed");
  // The summarize pass must not run: no model call should be spent asking a
  // model to describe results that do not exist.
  assert.equal(provider.requests.length, 1);
});

test("an exhausted model budget still returns the tool evidence it gathered", async () => {
  const provider = new StubProvider([toolCallResponse([{ name: "alpha", args: {} }])]);
  const registry = registryWith({ alpha: async () => ({ output: "raw evidence" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput({ remainingModelCalls: 1 }));

  assert.equal(result.status, "succeeded");
  assert.match(String(result.output), /raw evidence/);
  assert.equal(provider.requests.length, 1);
});

test("no model budget fails closed", async () => {
  const provider = new StubProvider([]);
  const registry = registryWith({ alpha: async () => ({ output: "ok" }) });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  const result = await runner.run(taskInput({ remainingModelCalls: 0 }));

  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "GATEWAY_MODEL_BUDGET_EXCEEDED");
  assert.equal(provider.requests.length, 0);
});

test("the model is only offered tools the planner allowed", async () => {
  const provider = new StubProvider([textResponse("done")]);
  const registry = registryWith({
    alpha: async () => ({ output: "ok" }),
    beta: async () => ({ output: "ok" }),
  });
  const runner = createLocalGatewayTaskRunner(baseOptions(provider, registry));

  await runner.run(taskInput({ allowedTools: ["alpha"] }));

  const offered = provider.requests[0]?.tools?.map((tool) => tool.name);
  assert.deepEqual(offered, ["alpha"]);
});
