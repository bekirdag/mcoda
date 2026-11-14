import test from "node:test";
import assert from "node:assert/strict";
import { runCodaliTask, type CodaliRuntimeInput } from "../CodaliRuntime.js";
import { runCodaliJob } from "../CodaliJobRuntime.js";
import { ConfiguredModelScope } from "../../providers/ConfiguredModelScope.js";
import { orchestrationHash, type OrchestrationConfig } from "../../config/OrchestrationConfig.js";
import { ToolRegistry } from "../../tools/ToolRegistry.js";

const configuration = (maxModelCalls = 8, maxToolCalls = 8) => {
  const config: OrchestrationConfig = { schemaVersion: 1, profile: "embedded-fixture",
    providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" } },
    models: { small: { provider: "local", catalogId: "small", revision: "v1", supportsTools: true, operations: ["chat.completions"], contextWindow: 8192, maxOutputTokens: 100 },
      large: { provider: "local", catalogId: "large", revision: "v1", supportsTools: true, operations: ["chat.completions"], contextWindow: 8192, maxOutputTokens: 100 } },
    bindings: { lead: { candidates: ["large"] }, planner: { candidates: ["small"] }, worker: { useBinding: "lead" } },
    effort: { low: { maxModelCalls, maxToolCalls, maxTotalTokens: 10000, maxOutputTokens: 100 } },
  };
  return { config, hash: orchestrationHash(config), source: "fixture" };
};
const runtime = (resolved = configuration()): CodaliRuntimeInput => ({
  orchestration: { resolved, effort: "low" }, task: "Explain the evidence", workspace: { root: process.cwd(), readOnly: true },
  provider: { name: "must-not-run", model: "legacy-model" }, docdex: { enabled: false },
  policy: { mode: "tool_loop", allowWrites: false, allowShell: false, allowOutsideWorkspace: false,
    allowDestructiveOperations: false, maxSteps: 6, maxToolCalls: 5, timeoutMs: 30000 },
});
const success = () => Response.json({ choices: [{ message: { role: "assistant", content: "Verified answer" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const catalog = () => Response.json({ data: [{ id: "small", supports_tools: true }, { id: "large", supports_tools: true }] });

test("required retrieval uses authorized tools and the parent budget without model dispatch", async () => {
  const original = globalThis.fetch; let requests = 0; let calls = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected model dispatch"); };
  const resolved = configuration(8, 1); const scope = new ConfiguredModelScope(resolved, { effort: "low" });
  const input = runtime(resolved); input.orchestration!.scope = scope;
  input.policy.mode = "protocol_loop"; input.policy.allowedTools = ["docdex_search"];
  input.docdex = {};
  input.requiredRetrieval = [{ type: "docdex.search", query: "evidence", limit: 2 }];
  input.tools = [{ name: "docdex_search", description: "Search evidence", readOnly: true, handler: async () => { calls++; return { output: "evidence", data: { results: [{ rel_path: "source.ts" }] } }; } }];
  try {
    const result = await runCodaliTask(input);
    assert.equal(calls, 1); assert.equal(requests, 0); assert.equal(result.toolCallsExecuted, 1);
    assert.match(result.finalMessage, /source.ts/); assert.equal(scope.snapshot().modelCalls, 0); assert.equal(scope.toolsUsed, 1);
    await assert.rejects(runCodaliTask(input), /tool budget exhausted/);
    assert.equal(calls, 1);
  } finally { scope.close(); globalThis.fetch = original; }
});

test("required retrieval does not expand tool authorization", async () => {
  let calls = 0; const input = runtime(); input.policy.mode = "protocol_loop";
  input.docdex = {};
  input.policy.allowedTools = []; input.requiredRetrieval = [{ type: "docdex.search", query: "evidence", limit: 2 }];
  input.tools = [{ name: "docdex_search", description: "Search evidence", readOnly: true, handler: async () => { calls++; return { output: "secret" }; } }];
  const result = await runCodaliTask(input);
  assert.equal(calls, 0); assert.doesNotMatch(result.finalMessage, /secret/);
  await assert.rejects(runCodaliTask({ ...input, policy: { ...input.policy, mode: "tool_loop" } }), /protocol_loop/);
  await assert.rejects(runCodaliTask({ ...input, requiredRetrieval: [{ type: "docdex.search", query: "", limit: 2 }] }), /Invalid required/);
});

test("parallel embedded stages share one model budget and report the selected model", async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async url => { if (String(url).endsWith("/models")) return catalog(); requests++; return success(); };
  try {
    const result = await runCodaliJob({ runtime: runtime(configuration(1)), request: { jobType: "budget-test",
      stages: [{ id: "a", kind: "planner", maxToolCalls: 0 }, { id: "b", kind: "worker", maxToolCalls: 0 }], budgets: { maxParallelStages: 2 } } });
    assert.equal(result.status, "failed"); assert.equal(requests, 1);
    assert.equal(result.orchestration?.usage.modelCalls, 1); assert.equal(result.orchestration?.usage.totalTokens, 15);
    const completed = result.stages.filter(stage => stage.status === "completed");
    assert.equal(completed.length, 1); assert.ok(["small", "large"].includes(completed[0]!.model!));
    assert.match(result.errors[0]!.message, /budget exhausted/);
  } finally { globalThis.fetch = original; }
});

test("embedded preflight rejects undeclared roles and legacy overrides before dispatch", async () => {
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("Unexpected request"); };
  try {
    const request = { jobType: "test", stages: [{ id: "a", kind: "worker", maxToolCalls: 0 }] };
    await assert.rejects(runCodaliJob({ runtime: runtime(), request: { ...request, stages: [{ id: "a", kind: "undeclared" }] } }), /binding/i);
    await assert.rejects(runCodaliJob({ runtime: runtime(), request, runTask: runCodaliTask }), /task-runner override/);
    await assert.rejects(runCodaliJob({ runtime: runtime(), request: { ...request, agentPolicy: { defaultProvider: { name: "legacy", model: "legacy" } } } }), /provider overrides/);
    await assert.rejects(runCodaliTask({ ...runtime(), providerInstance: { name: "legacy", generate: async () => { throw new Error("bypassed"); } } }), /provider override/);
    assert.equal(requests, 0);
  } finally { globalThis.fetch = original; }
});

test("borrowed scopes survive successful calls but reject config and effort substitution", async () => {
  const original = globalThis.fetch; const resolved = configuration();
  const scope = new ConfiguredModelScope(resolved, { effort: "low" });
  globalThis.fetch = async url => String(url).endsWith("/models") ? catalog() : success();
  try {
    const input = runtime(resolved); input.orchestration!.scope = scope;
    for (let index = 0; index < 2; index++) {
      const result = await runCodaliTask(input);
      assert.equal(result.orchestration?.routes[0]?.catalogId, "large");
      assert.equal(result.orchestration?.cumulativeUsage.modelCalls, index + 1);
      assert.equal(scope.signal.aborted, false);
    }
    await assert.rejects(runCodaliTask({ ...input, orchestration: { ...input.orchestration!, effort: "high" } }), /does not match/);
    const other = configuration(9);
    await assert.rejects(runCodaliTask({ ...input, orchestration: { ...input.orchestration!, resolved: other } }), /does not match/);
    assert.equal(scope.snapshot().modelCalls, 2);
  } finally { scope.close(); globalThis.fetch = original; }
});

test("nested tools cannot evade the configured job tool budget", async () => {
  const original = globalThis.fetch; let innerCalls = 0;
  globalThis.fetch = async url => String(url).endsWith("/models") ? catalog() : Response.json({ choices: [{ message: {
    role: "assistant", content: "", tool_calls: [{ id: "outer-1", type: "function", function: { name: "outer", arguments: "{}" } }],
  } }] });
  const registry = new ToolRegistry();
  registry.register({ name: "inner", description: "Inner read", readOnly: true, handler: async () => { innerCalls++; return { output: "read" }; } });
  registry.register({ name: "outer", description: "Outer read", readOnly: true, handler: async (_, context) => registry.execute("inner", {}, context) });
  const input = runtime(configuration(8, 1)); input.toolRegistry = registry;
  try {
    await assert.rejects(runCodaliTask(input), /tool budget exhausted/);
    assert.equal(innerCalls, 0);
  } finally { globalThis.fetch = original; }
});

test("cancellation interrupts all active configured stages without dispatch replay", async () => {
  const original = globalThis.fetch; const abort = new AbortController(); let requests = 0;
  let started!: () => void; const dispatched = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return catalog();
    requests++; if (requests === 2) started();
    return new Promise<Response>((_, reject) => {
      const stop = () => reject(init?.signal?.reason);
      init?.signal?.addEventListener("abort", stop, { once: true }); if (init?.signal?.aborted) stop();
    });
  };
  try {
    const pending = runCodaliJob({ runtime: { ...runtime(), signal: abort.signal }, request: { jobType: "cancel-test",
      stages: [{ id: "a", kind: "planner", maxToolCalls: 0 }, { id: "b", kind: "worker", maxToolCalls: 0 }], budgets: { maxParallelStages: 2 } } });
    await Promise.race([dispatched, pending.then(() => { throw new Error("Job ended before both dispatches"); })]);
    abort.abort(new Error("Host cancelled"));
    const result = await pending;
    assert.equal(result.status, "failed"); assert.equal(requests, 2);
    assert.equal(result.orchestration?.usage.pendingCalls, 2); assert.equal(result.orchestration?.usage.estimated, true);
    assert.ok(result.errors.every(error => /Host cancelled/.test(error.message)));
  } finally { abort.abort(); globalThis.fetch = original; }
});
