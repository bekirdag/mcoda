import test from "node:test";
import assert from "node:assert/strict";
import {
  validateCodaliContextPack,
  validateCodaliEvidenceItem,
  validateCodaliGatewayPlannerOutput,
  validateCodaliGatewayRequest,
  validateCodaliGatewayVerifierOutput,
  validateCodaliGatewayWorkerTask,
} from "../CodaliGatewaySchemas.js";

const basePolicy = () => ({
  allowed_tools: ["docdex_search", "docdex_open"],
  denied_tools: ["shell"],
  max_iterations: 3,
  max_runtime_ms: 60_000,
  max_tool_calls: 8,
  max_model_calls: 5,
  max_evidence_items: 20,
  max_context_pack_tokens: 12_000,
  allow_writes: false,
  allow_shell: false,
  allow_destructive_operations: false,
  allow_outside_workspace: false,
  require_final_large_model: true,
});

test("validates and normalizes gateway requests with snake_case aliases", () => {
  const result = validateCodaliGatewayRequest({
    id: "run-1",
    query: "Find the current tenant support policy.",
    mode: "balanced",
    tenant: { id: "tenant-1", slug: "tenant-a" },
    docdex: { enabled: true, repoId: "repo-1" },
    tool_manifest: {
      actualTools: [{ name: "docdex_search" }],
      virtual_tools: [{ name: "tenant_policy_search" }],
    },
    policy: {
      ...basePolicy(),
      app_tool_contracts: {
        tenant_policy_search: {
          read_only: true,
          call_schema: { type: "object" },
          backing_tools: ["docdex_search"],
        },
      },
      app_virtual_tools: ["tenant_policy_search"],
    },
    agent_policy: {
      resolver: "mcoda_inventory",
      roles: {
        planner: { tier: "medium", requires_json_schema: true },
      },
    },
    response: { format: "json", final_answer_required: true },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.policy.allowedTools, ["docdex_search", "docdex_open"]);
  assert.deepEqual(result.value.policy.deniedTools, ["shell"]);
  assert.deepEqual(result.value.policy.appVirtualTools, ["tenant_policy_search"]);
  assert.equal(result.value.tools?.virtual_tools instanceof Array, true);
  assert.equal(result.value.agentPolicy?.roles?.planner?.requiresJsonSchema, true);
  assert.equal(result.value.response?.finalAnswerRequired, true);
});

test("rejects missing gateway query", () => {
  const result = validateCodaliGatewayRequest({ policy: basePolicy() });

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.path === "$.query"));
});

test("rejects unsafe tool permissions and invalid budgets", () => {
  const result = validateCodaliGatewayRequest({
    query: "Summarize repo state.",
    policy: {
      ...basePolicy(),
      allow_shell: true,
      allow_destructive_operations: true,
      max_tool_calls: 0,
      max_runtime_ms: -1,
      app_tool_gateway: { endpoint: "https://example.test/tools", readOnly: false },
      app_tool_contracts: [{ name: "write_crm", read_only: false }],
    },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.code === "read_only_policy_required"),
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "expected_positive_integer"),
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "read_only_gateway_required"),
  );
  assert.ok(
    result.issues.some((issue) => issue.code === "read_only_tool_contract_required"),
  );
});

test("validates planner output and worker task aliases", () => {
  const workerTask = {
    id: "task-1",
    worker_role: "rag_worker",
    objective: "Find source policies.",
    tools_allowed: ["docdex_search"],
    output_format: "evidence_items",
    expected_sources: ["docdex"],
  };

  const workerResult = validateCodaliGatewayWorkerTask(workerTask);
  assert.equal(workerResult.ok, true);
  assert.equal(workerResult.value.workerRole, "rag_worker");
  assert.deepEqual(workerResult.value.toolsAllowed, ["docdex_search"]);

  const plannerResult = validateCodaliGatewayPlannerOutput({
    query_type: "repo_research",
    subquestions: [{ id: "sq-1", question: "What source policy applies?" }],
    worker_tasks: [workerTask],
    expected_evidence_count: 3,
    max_iterations: 2,
  });

  assert.equal(plannerResult.ok, true);
  assert.equal(plannerResult.value.queryType, "repo_research");
  assert.equal(plannerResult.value.workerTasks[0]?.workerRole, "rag_worker");
});

test("rejects invalid evidence confidence and relevance", () => {
  const result = validateCodaliEvidenceItem({
    id: "ev-1",
    run_id: "run-1",
    claim: "The repo supports encrypted Docdex search.",
    source_type: "docdex",
    confidence: 1.2,
    relevance: -0.1,
    tenant_scoped: true,
  });

  assert.equal(result.ok, false);
  assert.equal(
    result.issues.filter((issue) => issue.code === "expected_unit_number").length,
    2,
  );
});

test("validates verifier output and context packs", () => {
  const evidence = {
    id: "ev-1",
    run_id: "run-1",
    claim: "Docdex is the primary encrypted search layer.",
    source_type: "docdex",
    confidence: 0.9,
    relevance: 0.95,
    tenant_scoped: true,
  };

  const verifier = validateCodaliGatewayVerifierOutput({
    passed: true,
    confidence: 0.8,
    verified_evidence_ids: ["ev-1"],
    rejected_evidence_ids: [],
    issues: [],
    contradictions: [],
    missing_information: [],
    follow_up_tasks: [],
  });
  assert.equal(verifier.ok, true);

  const contextPack = validateCodaliContextPack({
    id: "pack-1",
    run_id: "run-1",
    original_query: "How does the gateway use Docdex?",
    decision_facts: [evidence],
    contradictions: [],
    missing_information: [],
    selected_excerpts: [{ evidence_id: "ev-1", text: "Docdex encrypted search." }],
    tool_summary: [{ tool: "docdex_search", calls: 1, statuses: { success: 1 } }],
    token_estimate: 128,
  });

  assert.equal(contextPack.ok, true);
  assert.equal(contextPack.value.decisionFacts[0]?.runId, "run-1");
  assert.equal(contextPack.value.selectedExcerpts[0]?.evidenceId, "ev-1");
});
