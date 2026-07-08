import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../../cli.js";
import { parseDatasetArgs } from "../../cli/DatasetCommand.js";
import { parseImprovementArgs } from "../../cli/ImprovementCommand.js";
import {
  CODALI_PRODUCTION_GOVERNANCE_ENV_FLAGS,
  evaluateCodaliProductionGovernanceAction,
  resolveCodaliProductionGovernance,
} from "../ProductionGovernance.js";

const withEnv = <T>(
  patch: Record<string, string | undefined>,
  run: () => T,
): T => {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

const withEnvAsync = async <T>(
  patch: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> => {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("ProductionGovernance defaults production to local-only storage with upload disabled", () => {
  const governance = resolveCodaliProductionGovernance({ env: {} });

  assert.equal(governance.schemaVersion, "codali.production_governance.v1");
  assert.deepEqual(
    governance.emergencyDisableFlags.map((flag) => flag.name),
    [...CODALI_PRODUCTION_GOVERNANCE_ENV_FLAGS],
  );
  assert.equal(governance.effective.datasetEnabled, true);
  assert.equal(governance.effective.storageMode, "local_only");
  assert.equal(governance.effective.storageUploadEnabled, false);
  assert.equal(governance.effective.improvementEnabled, true);
  assert.equal(governance.effective.trainingEnabled, false);
  assert.equal(governance.effective.autoTagEnabled, false);
  assert.equal(governance.effective.autoPublishEnabled, false);
  assert.equal(governance.effective.shadowOnly, false);

  const exportDecision = evaluateCodaliProductionGovernanceAction(
    governance,
    "dataset_export",
  );
  const serviceWriteDecision = evaluateCodaliProductionGovernanceAction(
    governance,
    "service_gateway_write",
  );

  assert.equal(exportDecision.allowed, true);
  assert.equal(serviceWriteDecision.allowed, false);
  assert.ok(serviceWriteDecision.reasons.includes("storage_service_not_enabled"));
  assert.ok(serviceWriteDecision.reasons.includes("storage_upload_disabled"));
});

test("ProductionGovernance explicitly enables service-local gateway writes only when upload is allowed", () => {
  const governance = resolveCodaliProductionGovernance({
    env: {
      CODALI_STORAGE_MODE: "storage_service",
      CODALI_STORAGE_UPLOAD_ENABLED: "true",
    },
  });
  const decision = evaluateCodaliProductionGovernanceAction(
    governance,
    "service_gateway_write",
  );

  assert.equal(decision.allowed, true);
  assert.equal(governance.effective.storageMode, "storage_service");
  assert.equal(governance.effective.storageUploadEnabled, true);
});

test("ProductionGovernance emergency flags disable dataset, storage, improvement, training, tag, publish, and writes", () => {
  const governance = resolveCodaliProductionGovernance({
    releaseLevel: 4,
    env: {
      CODALI_DATASET_ENABLED: "false",
      CODALI_STORAGE_MODE: "off",
      CODALI_STORAGE_UPLOAD_ENABLED: "false",
      CODALI_IMPROVEMENT_ENABLED: "false",
      CODALI_IMPROVEMENT_AUTO_TAG: "false",
      CODALI_IMPROVEMENT_AUTO_PUBLISH: "false",
      CODALI_IMPROVEMENT_TRAINING_ENABLED: "false",
      CODALI_IMPROVEMENT_SHADOW_ONLY: "true",
    },
  });

  assert.equal(governance.effective.datasetEnabled, false);
  assert.equal(governance.effective.storageMode, "off");
  assert.equal(governance.effective.improvementEnabled, false);
  assert.equal(governance.effective.trainingEnabled, false);
  assert.equal(governance.effective.autoTagEnabled, false);
  assert.equal(governance.effective.autoPublishEnabled, false);
  assert.equal(governance.effective.shadowOnly, true);
  assert.equal(
    governance.emergencyDisableFlags.every((flag) => flag.configured),
    true,
  );

  const datasetDecision = evaluateCodaliProductionGovernanceAction(
    governance,
    "dataset_export",
  );
  const improvementDecision = evaluateCodaliProductionGovernanceAction(
    governance,
    "improvement_analyze",
  );
  const trainingDecision = evaluateCodaliProductionGovernanceAction(
    governance,
    "training",
  );
  const publishDecision = evaluateCodaliProductionGovernanceAction(
    governance,
    "stable_publish",
  );

  assert.equal(datasetDecision.allowed, false);
  assert.ok(datasetDecision.reasons.includes("dataset_disabled"));
  assert.ok(datasetDecision.reasons.includes("storage_mode_off"));
  assert.equal(improvementDecision.allowed, false);
  assert.ok(improvementDecision.reasons.includes("improvement_disabled"));
  assert.equal(trainingDecision.allowed, false);
  assert.ok(trainingDecision.reasons.includes("training_disabled"));
  assert.equal(publishDecision.allowed, false);
  assert.ok(publishDecision.reasons.includes("auto_publish_disabled"));
  assert.ok(publishDecision.reasons.includes("shadow_only_mode"));
});

test("ProductionGovernance gates candidate, canary, and stable release levels", () => {
  const candidateBlocked = resolveCodaliProductionGovernance({
    env: {},
    releaseLevel: 2,
    privacyGatesStable: false,
  });
  const candidateAllowed = resolveCodaliProductionGovernance({
    env: {},
    releaseLevel: 2,
    privacyGatesStable: true,
  });
  assert.equal(
    evaluateCodaliProductionGovernanceAction(candidateBlocked, "candidate_branch")
      .allowed,
    false,
  );
  assert.equal(
    evaluateCodaliProductionGovernanceAction(candidateAllowed, "candidate_branch")
      .allowed,
    true,
  );

  const canaryBlocked = resolveCodaliProductionGovernance({
    env: {},
    releaseLevel: 3,
    internalDeployment: false,
  });
  const canaryAllowed = resolveCodaliProductionGovernance({
    env: {},
    releaseLevel: 3,
    internalDeployment: true,
  });
  assert.equal(
    evaluateCodaliProductionGovernanceAction(canaryBlocked, "prerelease_canary")
      .allowed,
    false,
  );
  assert.equal(
    evaluateCodaliProductionGovernanceAction(canaryAllowed, "prerelease_canary")
      .allowed,
    true,
  );

  const stableAllowed = resolveCodaliProductionGovernance({
    releaseLevel: 4,
    env: {
      CODALI_IMPROVEMENT_AUTO_TAG: "true",
      CODALI_IMPROVEMENT_AUTO_PUBLISH: "true",
    },
    policyActive: true,
    ciActive: true,
    npmProvenanceActive: true,
    storageAuditActive: true,
    rollbackMonitorActive: true,
    hardGatesActive: true,
  });
  assert.equal(
    evaluateCodaliProductionGovernanceAction(stableAllowed, "stable_publish")
      .allowed,
    true,
  );
});

test("ProductionGovernance emergency flags override improvement CLI write and release toggles", () => {
  withEnv({
    CODALI_STORAGE_MODE: "off",
    CODALI_STORAGE_UPLOAD_ENABLED: "false",
    CODALI_IMPROVEMENT_AUTO_TAG: "false",
    CODALI_IMPROVEMENT_AUTO_PUBLISH: "false",
    CODALI_IMPROVEMENT_TRAINING_ENABLED: "false",
    CODALI_IMPROVEMENT_SHADOW_ONLY: "true",
  }, () => {
    const parsed = parseImprovementArgs([
      "policy",
      "--level",
      "4",
      "--write",
      "--storage-mode",
      "storage_service",
      "--enable-training",
      "--auto-tag",
      "--auto-publish",
    ]);

    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.storageMode, "local_only");
    assert.equal(parsed.productionGovernance.effective.storageMode, "off");
    assert.equal(parsed.trainingEnabled, false);
    assert.equal(parsed.autoTagEnabled, false);
    assert.equal(parsed.autoPublishEnabled, false);
    assert.equal(parsed.productionGovernance.effective.shadowOnly, true);
  });
});

test("ProductionGovernance allows non-dry-run candidate and stable publish only when gates are explicit", () => {
  withEnv({
    CODALI_STORAGE_UPLOAD_ENABLED: "true",
    CODALI_PRIVACY_GATES_STABLE: "true",
  }, () => {
    const parsed = parseImprovementArgs([
      "build-release",
      "--level",
      "2",
      "--write",
      "--candidate",
      "candidate-phase-35",
    ]);
    const decision = evaluateCodaliProductionGovernanceAction(
      parsed.productionGovernance,
      "candidate_branch",
    );

    assert.equal(parsed.dryRun, false);
    assert.equal(decision.allowed, true);
  });

  withEnv({
    CODALI_STORAGE_UPLOAD_ENABLED: "true",
    CODALI_IMPROVEMENT_AUTO_TAG: "true",
    CODALI_IMPROVEMENT_AUTO_PUBLISH: "true",
    CODALI_IMPROVEMENT_POLICY_ACTIVE: "true",
    CODALI_IMPROVEMENT_CI_ACTIVE: "true",
    CODALI_IMPROVEMENT_NPM_PROVENANCE_ACTIVE: "true",
    CODALI_IMPROVEMENT_STORAGE_AUDIT_ACTIVE: "true",
    CODALI_IMPROVEMENT_ROLLBACK_MONITOR_ACTIVE: "true",
    CODALI_IMPROVEMENT_HARD_GATES_ACTIVE: "true",
  }, () => {
    const parsed = parseImprovementArgs([
      "publish",
      "--level",
      "4",
      "--write",
      "--mode",
      "auto_tag",
      "--candidate",
      "candidate-phase-35",
    ]);
    const decision = evaluateCodaliProductionGovernanceAction(
      parsed.productionGovernance,
      "stable_publish",
    );

    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.autoTagEnabled, true);
    assert.equal(parsed.autoPublishEnabled, true);
    assert.equal(decision.allowed, true);
  });
});

test("ProductionGovernance emergency flags are visible to dataset CLI parsing", () => {
  withEnv({
    CODALI_DATASET_ENABLED: "false",
    CODALI_STORAGE_MODE: "off",
  }, () => {
    const parsed = parseDatasetArgs(["export", "--kind", "planner-sft"]);
    const decision = evaluateCodaliProductionGovernanceAction(
      parsed.productionGovernance,
      "dataset_export",
    );

    assert.equal(parsed.productionGovernance.effective.datasetEnabled, false);
    assert.equal(parsed.productionGovernance.effective.storageMode, "off");
    assert.equal(decision.allowed, false);
    assert.ok(decision.reasons.includes("dataset_disabled"));
    assert.ok(decision.reasons.includes("storage_mode_off"));
  });
});

test("ProductionGovernance blocks non-dry-run storage write when upload is enabled without service storage mode", async () => {
  await withEnvAsync({
    CODALI_STORAGE_UPLOAD_ENABLED: "true",
    CODALI_STORAGE_MODE: undefined,
  }, async () => {
    await assert.rejects(
      () => runCli([
        "improve",
        "monitor",
        "--release",
        "phase-35-local-only-write-block",
        "--write",
        "--storage-service-url",
        "http://127.0.0.1:9",
        "--storage-service-token",
        "test-token",
      ]),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Production governance blocked service_gateway_write/);
        assert.match(error.message, /storage_service_not_enabled/);
        return true;
      },
    );
  });
});
