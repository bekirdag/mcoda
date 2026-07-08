import test from "node:test";
import assert from "node:assert/strict";
import {
  CODALI_GATEWAY_DATASET_EVAL_STAGES,
  createDefaultCodaliGatewayDatasetEvalImport,
  createDefaultCodaliGatewayDatasetReplayFixture,
  importCodaliGatewayDatasetReplayFixture,
} from "../GatewayDatasetEval.js";
import {
  CODALI_GATEWAY_EVAL_CASES,
  runCodaliGatewayEvalSuite,
} from "../GatewayEvalSuite.js";

test("dataset replay fixture importer converts one selected example per eval stage", async () => {
  const imported = await createDefaultCodaliGatewayDatasetEvalImport();
  const stages = imported.cases.map((evalCase) => evalCase.dataset?.stage);

  assert.deepEqual(stages, CODALI_GATEWAY_DATASET_EVAL_STAGES);
  assert.equal(imported.lineage.selectedRecordCount, CODALI_GATEWAY_DATASET_EVAL_STAGES.length);
  assert.equal(imported.lineage.skippedRecordCount, 0);
  assert.equal(imported.lineage.exportKind, "eval-replay");
  for (const evalCase of imported.cases) {
    assert.equal(evalCase.dataset?.source, "dataset_replay_fixture");
    assert.ok(evalCase.dataset?.sourceRecordId);
    assert.ok(evalCase.dataset?.sourceObjectHashes.length);
    assert.match(evalCase.dataset?.promptVersion ?? "", /^codali\.gateway\.dataset\..+\.prompt\.v1$/);
    assert.equal(evalCase.dataset?.schemaVersions.gatewayEval, 1);
    assert.equal(evalCase.dataset?.schemaVersions.datasetEval, 1);
    assert.equal(evalCase.dataset?.schemaVersions.datasetReplayFixture, "codali.dataset.replay.fixture.v1");
  }
});

test("gateway smoke report includes dataset lineage and prompt/schema versions", async () => {
  const report = await runCodaliGatewayEvalSuite({
    runId: "gateway-dataset-eval-run",
    reportId: "gateway-dataset-eval-report",
  });

  assert.equal(report.summary.status, "passed");
  assert.equal(report.summary.total, CODALI_GATEWAY_EVAL_CASES.length + CODALI_GATEWAY_DATASET_EVAL_STAGES.length);
  assert.equal(report.metrics.datasetCaseCount, CODALI_GATEWAY_DATASET_EVAL_STAGES.length);
  assert.equal(report.metrics.datasetStageCoverageRate.value, 1);
  assert.equal(report.metrics.datasetLineageCoverageRate.value, 1);
  assert.equal(report.metrics.promptSchemaVersionCoverageRate.value, 1);
  assert.equal(report.gates.passed, true);
  assert.equal(report.lineage.source, "mixed");
  assert.equal(report.lineage.dataset?.source, "dataset_replay_fixture");
  assert.deepEqual(
    Object.keys(report.lineage.datasetStageCounts),
    CODALI_GATEWAY_DATASET_EVAL_STAGES,
  );
  assert.equal(report.lineage.datasetSourceRecordIds.length, CODALI_GATEWAY_DATASET_EVAL_STAGES.length);
  assert.equal(report.versions.gatewayEval, 1);
  assert.equal(report.versions.datasetEval, 1);
  assert.equal(report.versions.schemaVersions.datasetReplayFixture, "codali.dataset.replay.fixture.v1");
  assert.equal(report.versions.promptVersions.classifier, "codali.gateway.dataset.classifier.prompt.v1");
});

test("dataset coverage regression gate fails when a replay fixture omits a required stage", async () => {
  const fixture = createDefaultCodaliGatewayDatasetReplayFixture();
  fixture.records = fixture.records.filter((record) => record.metadata?.evalStage !== "policy_event");
  const imported = await importCodaliGatewayDatasetReplayFixture({ fixture });

  const report = await runCodaliGatewayEvalSuite({
    cases: [...CODALI_GATEWAY_EVAL_CASES, ...imported.cases],
    datasetLineage: imported.lineage,
  });
  const failureCodes = new Set(report.gates.failures.map((failure) => failure.code));

  assert.equal(report.summary.status, "failed");
  assert.equal(report.metrics.datasetStageCoverageRate.value, 0.9);
  assert.equal(report.lineage.datasetStageCounts.policy_event, 0);
  assert.ok(failureCodes.has("gateway_dataset_stage_coverage_below_min"));
});

test("dataset replay importer skips records without eval and replay privacy allowance", async () => {
  const fixture = createDefaultCodaliGatewayDatasetReplayFixture();
  const first = fixture.records[0];
  assert.ok(first);
  first.inputRef = {
    ...first.inputRef,
    privacyFlags: {
      ...first.inputRef.privacyFlags,
      replayAllowed: false,
    },
  };

  const imported = await importCodaliGatewayDatasetReplayFixture({ fixture });

  assert.equal(imported.cases.length, CODALI_GATEWAY_DATASET_EVAL_STAGES.length - 1);
  assert.equal(imported.lineage.skippedRecordCount, 1);
  assert.deepEqual(imported.lineage.skippedRecords, [
    {
      recordId: "default-classifier",
      stage: "classifier",
      reason: "eval_or_replay_not_allowed",
    },
  ]);
});
