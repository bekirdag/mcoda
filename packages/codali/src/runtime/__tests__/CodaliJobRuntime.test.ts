import assert from "node:assert/strict";
import test from "node:test";
import {
  runCodaliJob,
  type CodaliJobStageDefinition,
} from "../CodaliJobRuntime.js";
import type {
  CodaliRuntimeInput,
  CodaliRuntimeResult,
  CodaliRuntimeTelemetry,
} from "../CodaliRuntime.js";

const baseRuntime = (): CodaliRuntimeInput => ({
  task: "placeholder",
  workspace: { root: process.cwd(), readOnly: true },
  provider: { name: "stub", model: "stub-model" },
  policy: {
    allowWrites: false,
    allowShell: false,
    allowDestructiveOperations: false,
    allowOutsideWorkspace: false,
    allowedTools: ["docdex_search"],
    maxSteps: 4,
    maxToolCalls: 4,
    timeoutMs: 30_000,
    mode: "tool_loop",
  },
  docdex: {
    enabled: true,
    repoRoot: process.cwd(),
    toolManifest: {
      actualTools: ["docdex_search"],
      virtualTools: ["tenant_daily_logs"],
    },
  },
});

const stageIdFromTask = (input: CodaliRuntimeInput): string => {
  const match = input.task.match(/^Stage id: ([^\n]+)$/m);
  assert.ok(match, `missing stage id in task: ${input.task}`);
  return match[1]!;
};

const telemetryFor = (
  stageId: string,
  input: CodaliRuntimeInput,
  toolCallsExecuted: number,
): CodaliRuntimeTelemetry => ({
  runId: input.metadata?.requestId ?? stageId,
  runtime: "codali",
  mode: input.policy.mode,
  toolCallCount: toolCallsExecuted,
  calledTools: toolCallsExecuted > 0 ? ["docdex_search"] : [],
  consideredTools: ["docdex_search", "tenant_daily_logs"],
  registeredDynamicTools: ["tenant_daily_logs"],
  skippedDynamicTools: [],
  dynamicToolCalls: [],
  warnings: [],
});

const runtimeResult = (
  stageId: string,
  input: CodaliRuntimeInput,
  output: string,
  toolCallsExecuted = 0,
): CodaliRuntimeResult => ({
  finalMessage: output,
  messages: [{ role: "assistant", content: output }],
  toolCallsExecuted,
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  touchedFiles: [],
  warnings: [],
  events: [],
  runId: input.metadata?.requestId ?? stageId,
  telemetry: telemetryFor(stageId, input, toolCallsExecuted),
});

test("runCodaliJob executes a stage DAG and returns synthesizer output with telemetry", async () => {
  const calls: Array<{ stageId: string; input: CodaliRuntimeInput }> = [];
  const stages: CodaliJobStageDefinition[] = [
    { id: "router", kind: "router", maxToolCalls: 0 },
    { id: "planner", kind: "planner", dependsOn: ["router"], maxToolCalls: 0 },
    { id: "worker", kind: "worker", role: "evidence_collector", dependsOn: ["planner"], maxToolCalls: 2 },
    { id: "adjudicator", kind: "adjudicator", dependsOn: ["planner"], maxToolCalls: 1 },
    { id: "synthesizer", kind: "synthesizer", dependsOn: ["worker", "adjudicator"], maxToolCalls: 0 },
    { id: "verifier", kind: "verifier", dependsOn: ["synthesizer"], maxToolCalls: 0 },
  ];

  const result = await runCodaliJob({
    request: {
      id: "job-1",
      jobType: "tenant_chat",
      input: "What changed in the daily logs?",
      toolManifest: { actualTools: ["docdex_search"], virtualTools: ["tenant_daily_logs"] },
      stages,
      budgets: { maxToolCalls: 3, maxParallelStages: 2 },
      response: { requireEvidence: true },
      agentPolicy: {
        stageAgents: {
          evidence_collector: { slug: "worker-agent", adapter: "openai-compatible-local", model: "worker-model" },
        },
      },
    },
    runtime: baseRuntime(),
    runTask: async (input) => {
      const stageId = stageIdFromTask(input);
      calls.push({ stageId, input });
      if (stageId === "worker") {
        return runtimeResult(
          stageId,
          input,
          JSON.stringify({
            answer: "Worker found log evidence.",
            evidence: [{ source: "daily-log.md", summary: "Daily log changed." }],
          }),
          2,
        );
      }
      if (stageId === "adjudicator") {
        return runtimeResult(stageId, input, "Adjudicator OK", 1);
      }
      if (stageId === "synthesizer") {
        return runtimeResult(stageId, input, "Final tenant answer", 0);
      }
      if (stageId === "verifier") {
        return runtimeResult(stageId, input, JSON.stringify({ passed: true, summary: "Verified" }), 0);
      }
      return runtimeResult(stageId, input, `${stageId} ok`, 0);
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.output, "Final tenant answer");
  assert.equal(result.toolCallsExecuted, 3);
  assert.equal(result.evidence[0]?.source, "daily-log.md");
  assert.equal(result.verifier?.passed, true);
  assert.deepEqual(result.telemetry.calledTools, ["docdex_search"]);
  assert.equal(result.telemetry.stageCount, 6);
  assert.equal(calls.find((call) => call.stageId === "worker")?.input.agent?.slug, "worker-agent");
  assert.equal(calls.find((call) => call.stageId === "worker")?.input.policy.maxToolCalls, 2);
  assert.ok(calls.find((call) => call.stageId === "worker")?.input.task.includes("Stage role: evidence_collector"));
  assert.ok(
    calls.find((call) => call.stageId === "synthesizer")?.input.task.includes("Worker found log evidence."),
  );
  assert.ok(result.events.some((event) => event.type === "stage_start" && event.stageId === "worker"));
  assert.ok(result.events.some((event) => event.type === "job_result"));
});

test("runCodaliJob stops required stages when the total tool budget is exhausted", async () => {
  const calls: string[] = [];

  const result = await runCodaliJob({
    request: {
      id: "job-budget",
      jobType: "tenant_chat",
      input: "Use a bounded tool budget.",
      stages: [
        { id: "first", kind: "worker", maxToolCalls: 1 },
        { id: "second", kind: "synthesizer", dependsOn: ["first"], maxToolCalls: 1 },
      ],
      budgets: { maxToolCalls: 1 },
    },
    runtime: baseRuntime(),
    runTask: async (input) => {
      const stageId = stageIdFromTask(input);
      calls.push(stageId);
      return runtimeResult(stageId, input, "used one tool", 1);
    },
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(calls, ["first"]);
  assert.equal(result.errors[0]?.code, "tool_budget_exhausted");
  assert.equal(result.stages.find((stage) => stage.id === "second")?.status, "failed");
});

test("runCodaliJob continues after optional stage failure and marks the result partial", async () => {
  const result = await runCodaliJob({
    request: {
      id: "job-optional",
      jobType: "tenant_chat",
      input: "Continue when optional adjudication fails.",
      stages: [
        { id: "worker", kind: "worker", maxToolCalls: 0 },
        { id: "optional-check", kind: "adjudicator", dependsOn: ["worker"], optional: true, maxToolCalls: 0 },
        { id: "synthesizer", kind: "synthesizer", dependsOn: ["optional-check"], maxToolCalls: 0 },
      ],
      budgets: { maxToolCalls: 0 },
    },
    runtime: baseRuntime(),
    runTask: async (input) => {
      const stageId = stageIdFromTask(input);
      if (stageId === "optional-check") {
        throw new Error("optional check unavailable");
      }
      return runtimeResult(stageId, input, stageId === "synthesizer" ? "Recovered final" : "worker ok", 0);
    },
  });

  assert.equal(result.status, "partial");
  assert.equal(result.output, "Recovered final");
  assert.equal(result.errors[0]?.stageId, "optional-check");
});

test("runCodaliJob rejects cyclic stage dependencies", async () => {
  await assert.rejects(
    runCodaliJob({
      request: {
        id: "job-cycle",
        jobType: "tenant_chat",
        input: "Invalid graph",
        stages: [
          { id: "a", kind: "worker", dependsOn: ["b"] },
          { id: "b", kind: "synthesizer", dependsOn: ["a"] },
        ],
      },
      runtime: baseRuntime(),
      runTask: async (input) => runtimeResult(stageIdFromTask(input), input, "unused", 0),
    }),
    /cycle/,
  );
});
