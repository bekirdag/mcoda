import test from "node:test";
import assert from "node:assert/strict";
import {
  CODALI_GATEWAY_EVAL_CASES,
  compareCodaliGatewayEvalBaseline,
  createDefaultCodaliGatewayEvalRunner,
  runCodaliGatewayEvalSuite,
  type CodaliGatewayEvalRunner,
  type CodaliGatewayEvalTaskType,
} from "../GatewayEvalSuite.js";

const ALL_TASK_TYPES: CodaliGatewayEvalTaskType[] = [
  "generic_question",
  "code_repo_question",
  "encrypted_docdex_search_question",
  "product_tool_question",
  "disabled_integration_question",
  "image_generation_question",
  "missing_evidence_question",
];

test("gateway eval default cases cover every Phase 16 task type", () => {
  const taskTypes = CODALI_GATEWAY_EVAL_CASES.map((evalCase) => evalCase.type);
  assert.deepEqual(taskTypes, ALL_TASK_TYPES);
});

test("runCodaliGatewayEvalSuite passes the deterministic gateway smoke suite", async () => {
  const report = await runCodaliGatewayEvalSuite({
    runId: "gateway-eval-pass",
    reportId: "gateway-eval-report-pass",
  });

  assert.equal(report.summary.status, "passed");
  assert.equal(report.summary.total, 7);
  assert.equal(report.summary.passed, 7);
  assert.equal(report.metrics.taskCount, 7);
  assert.equal(report.metrics.plannerSchemaValidityRate.value, 1);
  assert.equal(report.metrics.disabledToolLeakageRate.value, 0);
  assert.equal(report.metrics.finalLargeModelRate.value, 1);
  assert.equal(report.gates.passed, true);
  assert.equal(report.regression.status, "baseline_missing");
  assert.equal(report.regression.deltas.some((delta) => delta.key === "latency_ms.p95"), true);
  assert.equal(report.regression.deltas.some((delta) => delta.key === "cost_usd.p95"), true);
});

test("gateway eval catches routing, disabled-tool leakage, and wrong final tier", async () => {
  const defaultRunner = createDefaultCodaliGatewayEvalRunner();
  const runner: CodaliGatewayEvalRunner = async (evalCase) => {
    const record = await defaultRunner(evalCase);
    if (evalCase.type === "code_repo_question") {
      return {
        ...record,
        taskType: "generic_question",
        selectedTaskType: "generic_question",
      };
    }
    if (evalCase.type === "disabled_integration_question") {
      return {
        ...record,
        calledTools: [...record.calledTools, "github_search"],
        toolCallCount: (record.toolCallCount ?? 0) + 1,
      };
    }
    if (evalCase.type === "product_tool_question") {
      return {
        ...record,
        finalModelTier: "small",
      };
    }
    return record;
  };

  const report = await runCodaliGatewayEvalSuite({ runner });
  const failureCodes = new Set(report.gates.failures.map((failure) => failure.code));

  assert.equal(report.summary.status, "failed");
  assert.equal(report.gates.passed, false);
  assert.ok(
    report.cases.find((result) => result.caseId === "gateway-code-repo-question")
      ?.failures.includes("gateway_planner_schema_or_task_type_invalid"),
  );
  assert.ok(
    report.cases.find((result) => result.caseId === "gateway-disabled-integration-question")
      ?.failures.includes("gateway_disabled_tool_leakage_detected"),
  );
  assert.ok(
    report.cases.find((result) => result.caseId === "gateway-product-tool-question")
      ?.failures.includes("gateway_final_large_model_missing"),
  );
  assert.ok(failureCodes.has("gateway_planner_schema_validity_below_min"));
  assert.ok(failureCodes.has("gateway_disabled_tool_leakage_exceeded"));
  assert.ok(failureCodes.has("gateway_final_large_model_rate_below_min"));
});

test("gateway eval records p95 latency and cost regressions", async () => {
  const baseline = await runCodaliGatewayEvalSuite({
    runId: "gateway-eval-baseline",
    reportId: "gateway-eval-report-baseline",
  });
  const defaultRunner = createDefaultCodaliGatewayEvalRunner();
  const runner: CodaliGatewayEvalRunner = async (evalCase) => {
    const record = await defaultRunner(evalCase);
    return {
      ...record,
      latencyMs: 1_500,
      costUsd: 0.02,
    };
  };

  const report = await runCodaliGatewayEvalSuite({
    baseline,
    runner,
    thresholds: {
      latencyRegressionRatioMax: 0.1,
      costRegressionRatioMax: 0.1,
    },
  });
  const comparison = compareCodaliGatewayEvalBaseline({
    current: report.metrics,
    baseline,
  });
  const failureCodes = new Set(report.gates.failures.map((failure) => failure.code));

  assert.equal(comparison.status, "compared");
  assert.equal(report.regression.status, "compared");
  assert.ok(report.regression.deltas.find((delta) => delta.key === "latency_ms.p95")?.regression);
  assert.ok(report.regression.deltas.find((delta) => delta.key === "cost_usd.p95")?.regression);
  assert.ok(failureCodes.has("gateway_latency_regression_exceeded"));
  assert.ok(failureCodes.has("gateway_cost_regression_exceeded"));
});
