import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MswarmCodaliExecutor, type MswarmCodaliInvocationInput } from "../codali-executor.js";

const fixture = async (t: { after(fn: () => Promise<void>): void }, maxModelCalls = 8) => {
  const root = await mkdtemp(join(tmpdir(), "mswarm-node-orchestration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "models.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1, profile: "node-test",
    providers: { local: { adapter: "openai-compatible", baseUrl: "http://127.0.0.1:11452/v1" } },
    models: { lead: { provider: "local", catalogId: "strata", revision: "test-artifact", operations: ["chat.completions"], contextWindow: 131072, maxOutputTokens: 1024 } },
    bindings: { lead: { candidates: ["lead"] }, planner: { useBinding: "lead" }, worker: { useBinding: "lead" }, synthesizer: { useBinding: "lead" } },
    effort: { high: { maxModelCalls, maxTotalTokens: 32000, maxOutputTokens: 1024 } },
  }));
  const input: MswarmCodaliInvocationInput = { jobId: "job-configured", requestId: "request-configured", model: "public-agent",
    messages: [{ role: "user", content: "Explain recursion" }], workspace: { root, readOnly: true }, docdex: { enabled: false }, policy: { allowTools: false },
    agent: { slug: "local-strata", adapter: "strata-local", runnerKind: "strata", model: "strata", baseUrl: "http://127.0.0.1:11452/v1", modelDigest: "test-artifact",
      contextWindow: 131072, maxOutputTokens: 1024, capabilities: ["final_answer_synthesis"], orchestrationConfigPath: file, apiKey: "test-node-runner-secret" },
  };
  return input;
};

const fakeRunner = (answers: string[]) => {
  const original = globalThis.fetch; const routes: string[] = []; const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, "http://127.0.0.1:11452");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-node-runner-secret");
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "strata" }] });
    const body = JSON.parse(String(init?.body)); routes.push(body.model); bodies.push(body);
    assert.equal(body.model, "strata");
    return Response.json({ choices: [{ message: { role: "assistant", content: answers.shift() ?? "Answer" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  };
  return { routes, bodies, restore: () => { globalThis.fetch = original; } };
};

test("configured node direct inference uses the admitted runner and reports shared usage", async t => {
  const input = await fixture(t); const mock = fakeRunner(["Local answer"]);
  input.nativeReasoning = { reasoning_effort: "high", reasoning_budget_tokens: 128 };
  try {
    const result = await new MswarmCodaliExecutor().invoke(input);
    assert.equal(result.output, "Local answer"); assert.deepEqual(mock.routes, ["strata"]);
    assert.equal(result.metadata.orchestration?.usage.modelCalls, 1); assert.equal(result.usage?.totalTokens, 15);
    assert.equal(mock.bodies[0].reasoning_effort, "high"); assert.equal(mock.bodies[0].reasoning_budget_tokens, 128);
    assert.notEqual(result.metadata.orchestration?.configHash, result.metadata.orchestration?.sourceConfigHash);
    assert.doesNotMatch(JSON.stringify(result.metadata), /test-node-runner-secret/);
    await assert.rejects(new MswarmCodaliExecutor().invoke({ ...input, runCodali: async () => { throw new Error("bypass"); } }), /legacy runtime overrides/);
    await assert.rejects(new MswarmCodaliExecutor().invoke({ ...input, agent: { ...input.agent, model: "unadmitted" } }), /admitted model/);
    assert.equal(mock.routes.length, 1);
  } finally { mock.restore(); }
});

test("configured node gateway shares planner and synthesizer accounting", async t => {
  const input = await fixture(t);
  input.nativeReasoning = { reasoning_effort: "none", reasoning_budget_tokens: 0 };
  input.codaliGateway = { query: "Explain recursion", mode: "balanced", policy: { requireFinalLargeModel: false } };
  const mock = fakeRunner([
    JSON.stringify({ queryType: "general", needsPrivateData: false, needsFreshData: false, needsDocdex: false, needsAppTools: false, needsImageWorker: false, confidence: "high" }),
    JSON.stringify({ queryType: "general", subquestions: [], workerTasks: [], requiresFinalLargeModel: false }), "Recursive answer",
  ]);
  try {
    const result = await new MswarmCodaliExecutor().invoke(input);
    assert.equal(result.output, "Recursive answer"); assert.equal(result.gatewayResult?.status, "succeeded");
    assert.equal(mock.routes.length, 3); assert.equal(result.metadata.orchestration?.usage.modelCalls, 3); assert.equal(result.usage?.totalTokens, 45);
    assert.ok(mock.bodies.every(body => body.reasoning_effort === "none" && body.reasoning_budget_tokens === 0));
  } finally { mock.restore(); }
});

test("configured node stages cannot create a new model budget per child", async t => {
  const input = await fixture(t, 1);
  input.codaliJob = { jobType: "budget-check", stages: [{ id: "a", kind: "worker", maxToolCalls: 0 }, { id: "b", kind: "worker", maxToolCalls: 0 }], budgets: { maxParallelStages: 2 } };
  const mock = fakeRunner(["One stage"]);
  try {
    await assert.rejects(new MswarmCodaliExecutor().invoke(input), /CODALI_JOB_FAILED:.*budget exhausted/);
    assert.equal(mock.routes.length, 1);
  } finally { mock.restore(); }
});
