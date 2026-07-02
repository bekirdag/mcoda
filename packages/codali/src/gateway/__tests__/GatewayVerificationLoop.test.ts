import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryCodaliGatewayStore } from "../CodaliGatewayStore.js";
import {
  CodaliGatewayStateMachine,
  type CodaliGatewayVerifierRunInput,
  type CodaliGatewayVerifierRunner,
  type CodaliGatewayWorkerTaskRunInput,
  type CodaliGatewayWorkerTaskRunResult,
  type CodaliGatewayWorkerTaskRunner,
} from "../GatewayStateMachine.js";
import type {
  CodaliEvidenceItem,
  CodaliGatewayPlannerOutput,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
  CodaliGatewayVerifierOutput,
  CodaliGatewayWorkerTask,
} from "../CodaliGatewayTypes.js";

class StubTaskRunner implements CodaliGatewayWorkerTaskRunner {
  inputs: CodaliGatewayWorkerTaskRunInput[] = [];

  constructor(
    private readonly handler: (
      input: CodaliGatewayWorkerTaskRunInput,
    ) => Promise<CodaliGatewayWorkerTaskRunResult> | CodaliGatewayWorkerTaskRunResult,
  ) {}

  async run(input: CodaliGatewayWorkerTaskRunInput): Promise<CodaliGatewayWorkerTaskRunResult> {
    this.inputs.push(input);
    return this.handler(input);
  }
}

class StubVerifierRunner implements CodaliGatewayVerifierRunner {
  inputs: CodaliGatewayVerifierRunInput[] = [];

  constructor(
    private readonly handler: (
      input: CodaliGatewayVerifierRunInput,
    ) => Promise<unknown> | unknown,
  ) {}

  async verify(input: CodaliGatewayVerifierRunInput): Promise<unknown> {
    this.inputs.push(input);
    return this.handler(input);
  }
}

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: [],
  deniedTools: [],
  maxIterations: 3,
  maxRuntimeMs: 60_000,
  maxToolCalls: 8,
  maxModelCalls: 4,
  maxEvidenceItems: 20,
  maxContextPackTokens: 12_000,
  allowWrites: false,
  allowShell: false,
  allowDestructiveOperations: false,
  allowOutsideWorkspace: false,
  requireFinalLargeModel: true,
  ...overrides,
});

const baseRequest = (
  overrides: Partial<CodaliGatewayRequest> = {},
): CodaliGatewayRequest => ({
  id: "verification-loop-run",
  query: "Find tenant policy evidence",
  mode: "balanced",
  policy: basePolicy(),
  ...overrides,
});

const docdexRequest = (
  overrides: Partial<CodaliGatewayRequest> = {},
): CodaliGatewayRequest => baseRequest({
  docdex: {
    enabled: true,
    required: true,
    repoId: "repo-1",
    allowedOperations: ["search"],
  },
  tools: {
    actualTools: [{ name: "docdex_search" }],
  },
  policy: basePolicy({
    allowedTools: ["docdex_search"],
  }),
  ...overrides,
});

const workerTask = (
  id: string,
  overrides: Partial<CodaliGatewayWorkerTask> = {},
): CodaliGatewayWorkerTask => ({
  id,
  workerRole: "rag_worker",
  objective: `Collect evidence for ${id}`,
  toolsAllowed: [],
  outputFormat: "json_evidence",
  ...overrides,
});

const plannerOutput = (
  workerTasks: CodaliGatewayWorkerTask[],
): CodaliGatewayPlannerOutput => ({
  queryType: "repo_research",
  subquestions: [],
  workerTasks,
  maxIterations: 1,
  requiresFinalLargeModel: true,
});

const verifierOutput = (
  overrides: Partial<CodaliGatewayVerifierOutput> = {},
): CodaliGatewayVerifierOutput => ({
  passed: false,
  confidence: 0.42,
  verifiedEvidenceIds: [],
  rejectedEvidenceIds: [],
  issues: [],
  contradictions: [],
  missingInformation: [],
  followUpTasks: [],
  ...overrides,
});

const evidenceFor = (
  runId: string,
  taskId: string,
  claim = `Evidence gathered by ${taskId}.`,
): CodaliEvidenceItem => ({
  id: `ev-${taskId}`,
  runId,
  taskId,
  claim,
  sourceType: "docdex",
  sourceId: `doc-${taskId}`,
  sourceTitle: `${taskId}.md`,
  rawExcerpt: claim,
  confidence: 0.72,
  relevance: 0.81,
  usedTool: "docdex_search",
  tenantScoped: true,
});

const createMachine = async (
  request: CodaliGatewayRequest,
  taskRunner: CodaliGatewayWorkerTaskRunner,
  verifierRunner: CodaliGatewayVerifierRunner,
): Promise<CodaliGatewayStateMachine> => {
  const store = createInMemoryCodaliGatewayStore();
  await store.createRun({
    runId: request.id ?? "verification-loop-run",
    request,
    status: "running",
  });
  return new CodaliGatewayStateMachine({
    store,
    taskRunner,
    verifierRunner,
    maxParallelWorkers: 1,
  });
};

test("verification loop stops early when verifier passes", async () => {
  const request = baseRequest({ id: "verify-pass-run" });
  const taskRunner = new StubTaskRunner((input) => ({
    status: "succeeded",
    evidence: [evidenceFor(input.runId, input.task.id)],
  }));
  const verifier = new StubVerifierRunner((input) => {
    assert.equal(input.iteration, 1);
    assert.equal(input.evidence.length, 1);
    return verifierOutput({
      passed: true,
      confidence: 0.93,
      verifiedEvidenceIds: ["ev-initial"],
    });
  });
  const machine = await createMachine(request, taskRunner, verifier);

  const result = await machine.execute({
    runId: "verify-pass-run",
    request,
    planner: plannerOutput([workerTask("initial")]),
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.verification?.stopReason, "verifier_passed");
  assert.equal(result.verification?.iterations.length, 1);
  assert.equal(verifier.inputs.length, 1);
  assert.deepEqual(taskRunner.inputs.map((input) => input.task.id), ["initial"]);
  assert.equal(result.trace?.modelCalls.filter((call) => call.role === "verifier").length, 1);
});

test("verifier can add a second Docdex query when evidence is weak", async () => {
  const request = docdexRequest({
    id: "verify-follow-up-run",
    policy: basePolicy({
      allowedTools: ["docdex_search"],
      maxToolCalls: 2,
      maxIterations: 3,
    }),
  });
  const taskRunner = new StubTaskRunner((input) => ({
    status: "succeeded",
    evidence: [evidenceFor(input.runId, input.task.id)],
    toolCalls: [
      {
        tool: "docdex_search",
        status: "success",
        args: { query: input.task.query ?? input.request.query },
        result: { count: 1 },
      },
    ],
  }));
  const verifier = new StubVerifierRunner((input) => {
    if (input.iteration === 1) {
      assert.equal(input.remainingToolCalls, 1);
      return verifierOutput({
        confidence: 0.38,
        issues: [
          {
            code: "weak_evidence",
            message: "Initial search evidence is too thin.",
            severity: "warning",
          },
        ],
        missingInformation: ["Need a second repository source."],
        followUpTasks: [
          workerTask("docdex-second", {
            query: "second source for tenant policy evidence",
            toolsAllowed: ["docdex_search"],
          }),
        ],
      });
    }
    return verifierOutput({
      passed: true,
      confidence: 0.9,
      verifiedEvidenceIds: ["ev-docdex-initial", "ev-docdex-second"],
    });
  });
  const machine = await createMachine(request, taskRunner, verifier);

  const result = await machine.execute({
    runId: "verify-follow-up-run",
    request,
    planner: plannerOutput([
      workerTask("docdex-initial", {
        toolsAllowed: ["docdex_search"],
      }),
    ]),
  });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(taskRunner.inputs.map((input) => input.task.id), [
    "docdex-initial",
    "docdex-second",
  ]);
  assert.equal(verifier.inputs.length, 2);
  assert.equal(verifier.inputs[1]?.evidence.length, 2);
  assert.equal(result.toolCallCount, 2);
  assert.equal(result.verification?.followUpTaskCount, 1);
  assert.deepEqual(result.verification?.iterations[0]?.acceptedFollowUpTaskIds, [
    "docdex-second",
  ]);
  assert.equal(result.verification?.stopReason, "verifier_passed");
});

test("verification loop rejects follow-ups when tool budget is exhausted", async () => {
  const request = docdexRequest({
    id: "verify-budget-stop-run",
    policy: basePolicy({
      allowedTools: ["docdex_search"],
      maxToolCalls: 1,
      maxIterations: 3,
    }),
  });
  const taskRunner = new StubTaskRunner((input) => ({
    status: "succeeded",
    evidence: [evidenceFor(input.runId, input.task.id)],
    toolCalls: [
      {
        tool: "docdex_search",
        status: "success",
      },
    ],
  }));
  const verifier = new StubVerifierRunner(() => verifierOutput({
    confidence: 0.35,
    missingInformation: ["Need another source."],
    followUpTasks: [
      workerTask("budget-follow-up", {
        toolsAllowed: ["docdex_search"],
      }),
    ],
  }));
  const machine = await createMachine(request, taskRunner, verifier);

  const result = await machine.execute({
    runId: "verify-budget-stop-run",
    request,
    planner: plannerOutput([
      workerTask("budget-initial", {
        toolsAllowed: ["docdex_search"],
      }),
    ]),
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(taskRunner.inputs.map((input) => input.task.id), ["budget-initial"]);
  assert.equal(result.verification?.stopReason, "tool_budget_exhausted");
  assert.equal(result.verification?.rejectedFollowUpTasks[0]?.reason, "tool_budget_exhausted");
  assert.match(result.warnings.join("\n"), /verification_stop:tool_budget_exhausted/);
});

test("verification loop rejects unavailable follow-up tools", async () => {
  const request = docdexRequest({
    id: "verify-unavailable-tool-run",
    tools: {
      actualTools: [{ name: "docdex_search" }],
    },
    policy: basePolicy({
      allowedTools: ["docdex_search"],
      deniedTools: ["github_search"],
      maxToolCalls: 3,
      maxIterations: 3,
    }),
  });
  const taskRunner = new StubTaskRunner((input) => ({
    status: "succeeded",
    evidence: [evidenceFor(input.runId, input.task.id)],
  }));
  const verifier = new StubVerifierRunner(() => verifierOutput({
    confidence: 0.4,
    missingInformation: ["Need GitHub evidence, but GitHub is unavailable."],
    followUpTasks: [
      workerTask("github-follow-up", {
        toolsAllowed: ["github_search"],
      }),
    ],
  }));
  const machine = await createMachine(request, taskRunner, verifier);

  const result = await machine.execute({
    runId: "verify-unavailable-tool-run",
    request,
    planner: plannerOutput([workerTask("unavailable-initial")]),
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(taskRunner.inputs.map((input) => input.task.id), ["unavailable-initial"]);
  assert.equal(result.verification?.stopReason, "required_tool_unavailable");
  assert.equal(result.verification?.rejectedFollowUpTasks[0]?.reason, "required_tool_unavailable");
  assert.deepEqual(result.verification?.rejectedFollowUpTasks[0]?.tools, ["github_search"]);
});

test("verification loop stops at maxIterations even if verifier keeps suggesting work", async () => {
  const request = baseRequest({
    id: "verify-max-iterations-run",
    policy: basePolicy({
      maxIterations: 2,
      maxToolCalls: 3,
      maxModelCalls: 6,
    }),
  });
  const taskRunner = new StubTaskRunner((input) => ({
    status: "succeeded",
    evidence: [evidenceFor(input.runId, input.task.id)],
  }));
  const verifier = new StubVerifierRunner((input) => verifierOutput({
    confidence: 0.3,
    missingInformation: [`Need follow-up ${input.iteration}.`],
    followUpTasks: [
      workerTask(`loop-follow-up-${input.iteration}`),
    ],
  }));
  const machine = await createMachine(request, taskRunner, verifier);

  const result = await machine.execute({
    runId: "verify-max-iterations-run",
    request,
    planner: plannerOutput([workerTask("loop-initial")]),
  });

  assert.equal(result.status, "partial");
  assert.equal(verifier.inputs.length, 2);
  assert.deepEqual(taskRunner.inputs.map((input) => input.task.id), [
    "loop-initial",
    "loop-follow-up-1",
    "loop-follow-up-2",
  ]);
  assert.equal(result.verification?.iterations.length, 2);
  assert.equal(result.verification?.stopReason, "max_iterations_reached");
});

test("verification contradictions are preserved in run metadata", async () => {
  const request = baseRequest({ id: "verify-contradictions-run" });
  const taskRunner = new StubTaskRunner((input) => ({
    status: "succeeded",
    evidence: [evidenceFor(input.runId, input.task.id)],
  }));
  const verifier = new StubVerifierRunner(() => verifierOutput({
    confidence: 0.28,
    issues: [
      {
        code: "contradiction",
        message: "Evidence claims conflict.",
        severity: "error",
        evidenceIds: ["ev-contradiction-initial", "ev-conflicting"],
      },
    ],
    contradictions: [
      {
        summary: "One source says enabled while another says disabled.",
        evidenceIds: ["ev-contradiction-initial", "ev-conflicting"],
      },
    ],
  }));
  const machine = await createMachine(request, taskRunner, verifier);

  const result = await machine.execute({
    runId: "verify-contradictions-run",
    request,
    planner: plannerOutput([workerTask("contradiction-initial")]),
  });

  assert.equal(result.status, "partial");
  assert.equal(result.verification?.stopReason, "no_useful_followups");
  assert.equal(
    result.verification?.contradictions[0]?.summary,
    "One source says enabled while another says disabled.",
  );
  assert.notEqual(result.trace?.run.metadata?.verification, undefined);
});
