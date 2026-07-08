import test from "node:test";
import assert from "node:assert/strict";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { createCodaliGateway } from "../CodaliGateway.js";
import {
  buildCodaliGatewayPlannerMessages,
  createCodaliGatewayPlanner,
} from "../GatewayPlanner.js";
import type { CodaliGatewayPolicy, CodaliGatewayRequest } from "../CodaliGatewayTypes.js";

class StubProvider implements Provider {
  name = "stub";
  requests: ProviderRequest[] = [];

  constructor(private readonly responses: ProviderResponse[]) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No stub response configured");
    }
    return response;
  }
}

const jsonResponse = (value: unknown): ProviderResponse => ({
  message: { role: "assistant", content: JSON.stringify(value) },
});

const basePolicy = (
  overrides: Partial<CodaliGatewayPolicy> = {},
): CodaliGatewayPolicy => ({
  allowedTools: [],
  deniedTools: [],
  maxIterations: 3,
  maxRuntimeMs: 60_000,
  maxToolCalls: 8,
  maxModelCalls: 5,
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
  id: "gateway-test-run",
  query: "What is Codali?",
  mode: "balanced",
  policy: basePolicy(),
  ...overrides,
});

test("planner supports a generic direct-answer path without worker tasks", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "general",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: false,
      directAnswerCandidate: "Codali is an orchestration runtime.",
      confidence: "high",
    }),
    jsonResponse({
      queryType: "general",
      subquestions: [],
      workerTasks: [],
      maxIterations: 1,
      requiresFinalLargeModel: true,
    }),
  ]);

  const planner = createCodaliGatewayPlanner(provider);
  const result = await planner.plan({ request: baseRequest() });

  assert.equal(result.classifier.queryType, "general");
  assert.equal(result.planner.workerTasks.length, 0);
  assert.equal(provider.requests[0]?.responseFormat?.type, "json_schema");
  assert.equal(provider.requests[1]?.responseFormat?.type, "json_schema");
  assert.match(provider.requests[1]?.messages[1]?.content ?? "", /Allowed tools:\n- none/);
});

test("planner can produce Docdex and app-tool worker tasks from effective policy tools", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "repo_research",
      needsPrivateData: true,
      needsFreshData: false,
      needsDocdex: true,
      needsAppTools: true,
      needsImageWorker: false,
      confidence: "medium",
    }),
    jsonResponse({
      queryType: "repo_research",
      subquestions: [{ id: "sq-1", question: "What policy applies?" }],
      workerTasks: [
        {
          id: "task-1",
          workerRole: "rag_worker",
          objective: "Find policy evidence.",
          toolsAllowed: ["docdex_search", "tenant_policy_search"],
          outputFormat: "evidence_items",
          expectedSources: ["docdex"],
        },
      ],
      expectedEvidenceCount: 2,
      maxIterations: 2,
      requiresFinalLargeModel: true,
    }),
  ]);

  const request = baseRequest({
    query: "Find the tenant policy in the repo",
    docdex: {
      enabled: true,
      required: true,
      repoId: "repo-1",
      allowedOperations: ["search"],
    },
    tools: {
      actualTools: [{ name: "docdex_search" }],
      virtualTools: [{ name: "tenant_policy_search" }],
    },
    policy: basePolicy({
      allowedTools: ["docdex_search", "tenant_policy_search"],
      appVirtualTools: ["tenant_policy_search"],
      appToolContracts: {
        tenant_policy_search: {
          readOnly: true,
          callSchema: { type: "object", properties: { query: { type: "string" } } },
          backingTools: ["docdex_search"],
        },
      },
    }),
  });

  const result = await createCodaliGatewayPlanner(provider).plan({ request });

  assert.deepEqual(result.planner.workerTasks[0]?.toolsAllowed, [
    "docdex_search",
    "tenant_policy_search",
  ]);
  const plannerPrompt = provider.requests[1]?.messages[1]?.content ?? "";
  assert.match(plannerPrompt, /docdex_search/);
  assert.match(plannerPrompt, /tenant_policy_search/);
});

test("planner removes disabled tools returned by the model", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "repo_research",
      needsPrivateData: true,
      needsFreshData: false,
      needsDocdex: true,
      needsAppTools: false,
      needsImageWorker: false,
    }),
    jsonResponse({
      queryType: "repo_research",
      subquestions: [],
      workerTasks: [
        {
          id: "task-1",
          workerRole: "rag_worker",
          objective: "Search allowed sources.",
          toolsAllowed: ["docdex_search", "github_search"],
          outputFormat: "evidence_items",
        },
      ],
    }),
  ]);

  const request = baseRequest({
    docdex: {
      enabled: true,
      required: true,
      repoId: "repo-1",
      allowedOperations: ["search"],
    },
    tools: {
      actualTools: [{ name: "docdex_search" }, { name: "github_search" }],
    },
    policy: basePolicy({
      allowedTools: ["docdex_search", "github_search"],
      deniedTools: ["github_search"],
    }),
  });

  const result = await createCodaliGatewayPlanner(provider).plan({ request });

  assert.deepEqual(result.planner.workerTasks[0]?.toolsAllowed, ["docdex_search"]);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("planner_task_tools_removed:task-1:github_search"),
    ),
  );
  assert.doesNotMatch(
    provider.requests[1]?.messages[1]?.content ?? "",
    /github_search/,
  );
});

test("image worker is exposed and retained only when policy allows it", async () => {
  const blockedProvider = new StubProvider([
    jsonResponse({
      queryType: "image",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: true,
    }),
    jsonResponse({
      queryType: "image",
      subquestions: [],
      workerTasks: [
        {
          id: "image-1",
          workerRole: "image_worker",
          objective: "Generate image.",
          toolsAllowed: [],
          outputFormat: "artifact",
        },
      ],
    }),
  ]);
  const blocked = await createCodaliGatewayPlanner(blockedProvider).plan({
    request: baseRequest({ mode: "image", policy: basePolicy({ allowImageWorker: false }) }),
  });
  assert.equal(blocked.classifier.needsImageWorker, false);
  assert.equal(blocked.planner.workerTasks.length, 0);
  assert.doesNotMatch(
    blockedProvider.requests[1]?.messages[1]?.content ?? "",
    /image_worker/,
  );

  const allowedProvider = new StubProvider([
    jsonResponse({
      queryType: "image",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: true,
    }),
    jsonResponse({
      queryType: "image",
      subquestions: [],
      workerTasks: [
        {
          id: "image-1",
          workerRole: "image_worker",
          objective: "Generate image.",
          toolsAllowed: [],
          outputFormat: "artifact",
        },
      ],
    }),
  ]);
  const allowed = await createCodaliGatewayPlanner(allowedProvider).plan({
    request: baseRequest({ mode: "image", policy: basePolicy({ allowImageWorker: true }) }),
  });
  assert.equal(allowed.classifier.needsImageWorker, true);
  assert.equal(allowed.planner.workerTasks[0]?.workerRole, "image_worker");
  assert.match(allowedProvider.requests[1]?.messages[1]?.content ?? "", /image_worker/);
});

test("planner performs one JSON repair attempt", async () => {
  const provider = new StubProvider([
    { message: { role: "assistant", content: "not json" } },
    jsonResponse({
      queryType: "general",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: false,
    }),
    jsonResponse({
      queryType: "general",
      subquestions: [],
      workerTasks: [],
    }),
  ]);

  const result = await createCodaliGatewayPlanner(provider, {
    maxRepairAttempts: 1,
  }).plan({ request: baseRequest() });

  assert.equal(result.classifierRepairAttempts, 1);
  assert.equal(result.planner.workerTasks.length, 0);
  assert.match(provider.requests[1]?.messages.at(-1)?.content ?? "", /Repair the classifier/);
});

test("planner normalizes schema-adjacent classifier output from local models", async () => {
  const provider = new StubProvider([
    jsonResponse({
      classification: {
        intent: "tenant_project_lookup",
        needs_private_data: "yes",
        needs_fresh_data: "true",
        needs_docdex: "1",
        needs_app_tools: 1,
      },
    }),
    jsonResponse({
      queryType: "tenant_project_lookup",
      subquestions: [{ id: "sq-1", question: "Which records are relevant?" }],
      workerTasks: [
        {
          id: "task-1",
          workerRole: "tool_worker",
          objective: "Gather tenant project records.",
          toolsAllowed: ["docdex_search", "tenant_project_search"],
          outputFormat: "evidence_items",
        },
      ],
    }),
  ]);

  const result = await createCodaliGatewayPlanner(provider).plan({
    request: baseRequest({
      docdex: {
        enabled: true,
        required: true,
        repoId: "repo-tenant",
        allowedOperations: ["search"],
      },
      policy: basePolicy({
        allowedTools: ["docdex_search", "tenant_project_search"],
        appVirtualTools: ["tenant_project_search"],
      }),
    }),
  });

  assert.equal(result.classifierRepairAttempts, 0);
  assert.equal(result.classifier.queryType, "tenant_project_lookup");
  assert.equal(result.classifier.needsPrivateData, true);
  assert.equal(result.classifier.needsFreshData, true);
  assert.equal(result.classifier.needsDocdex, true);
  assert.equal(result.classifier.needsAppTools, true);
  assert.equal(result.classifier.needsImageWorker, false);
  assert.equal(result.planner.workerTasks.length, 1);
});

test("planner normalizes schema-adjacent planner task output from local models", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "tenant_project_lookup",
      needsPrivateData: true,
      needsFreshData: true,
      needsDocdex: true,
      needsAppTools: true,
      needsImageWorker: false,
    }),
    jsonResponse({
      plan: {
        questions: ["Who is assigned to the project?"],
        tasks: [
          {
            task: "Search tenant records and integrations for project assignments.",
            tools: "docdex_search, tenant_project_search",
          },
        ],
      },
    }),
  ]);

  const result = await createCodaliGatewayPlanner(provider).plan({
    request: baseRequest({
      docdex: {
        enabled: true,
        required: true,
        repoId: "repo-tenant",
        allowedOperations: ["search"],
      },
      policy: basePolicy({
        allowedTools: ["docdex_search", "tenant_project_search"],
        appVirtualTools: ["tenant_project_search"],
      }),
    }),
  });

  assert.equal(result.plannerRepairAttempts, 0);
  assert.equal(result.planner.queryType, "tenant_project_lookup");
  assert.equal(result.planner.subquestions[0]?.id, "sq-1");
  assert.equal(result.planner.subquestions[0]?.question, "Who is assigned to the project?");
  assert.equal(result.planner.workerTasks[0]?.id, "task-1");
  assert.equal(result.planner.workerTasks[0]?.workerRole, "tool_worker");
  assert.equal(
    result.planner.workerTasks[0]?.objective,
    "Search tenant records and integrations for project assignments.",
  );
  assert.deepEqual(result.planner.workerTasks[0]?.toolsAllowed, [
    "docdex_search",
    "tenant_project_search",
  ]);
  assert.equal(result.planner.workerTasks[0]?.outputFormat, "evidence_items");
});

test("planning-only gateway persists planner trace in the store", async () => {
  const provider = new StubProvider([
    jsonResponse({
      queryType: "general",
      needsPrivateData: false,
      needsFreshData: false,
      needsDocdex: false,
      needsAppTools: false,
      needsImageWorker: false,
    }),
    jsonResponse({
      queryType: "general",
      subquestions: [],
      workerTasks: [],
    }),
  ]);

  const gateway = createCodaliGateway({ provider });
  const result = await gateway.plan(baseRequest({ id: "gateway-plan-run" }));

  assert.equal(result.trace?.run.status, "succeeded");
  assert.deepEqual(
    result.trace?.modelCalls.map((call) => call.role),
    ["classifier", "planner"],
  );
});

test("planner prompt helper includes only effective allowed tools", () => {
  const provider = new StubProvider([]);
  const request = baseRequest({
    docdex: {
      enabled: true,
      required: true,
      repoId: "repo-1",
      allowedOperations: ["search"],
    },
    tools: {
      actualTools: [{ name: "docdex_search" }, { name: "github_search" }],
    },
    policy: basePolicy({
      allowedTools: ["docdex_search", "github_search"],
      deniedTools: ["github_search"],
    }),
  });
  const planner = createCodaliGatewayPlanner(provider);
  assert.ok(planner);
  const messages = buildCodaliGatewayPlannerMessages(
    { request },
    {
      queryType: "repo_research",
      needsPrivateData: true,
      needsFreshData: false,
      needsDocdex: true,
      needsAppTools: false,
      needsImageWorker: false,
    },
  );
  assert.match(messages[1]?.content ?? "", /docdex_search/);
  assert.doesNotMatch(messages[1]?.content ?? "", /github_search/);
});
