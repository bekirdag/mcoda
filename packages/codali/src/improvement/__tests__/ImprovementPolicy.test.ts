import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
  CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS,
  buildCodaliImprovementCliJsonOutput,
  createCodaliImprovementPolicy,
  evaluateCodaliImprovementPolicy,
  validateCodaliImprovementArtifact,
  validateCodaliImprovementCandidate,
  validateCodaliImprovementCliJsonOutput,
  validateCodaliImprovementGate,
  validateCodaliImprovementOutcome,
  validateCodaliImprovementPolicy,
  validateCodaliImprovementRelease,
  validateCodaliImprovementRun,
  validateCodaliImprovementScorecard,
  type CodaliImprovementPolicy,
  type CodaliImprovementValidationResult,
} from "../ImprovementPolicy.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, "..", "..", "cli.js");
const createdAt = "2026-07-07T12:00:00.000Z";
const scope = {
  tenantHash: "tenant_hash_fixture",
  productId: "product_fixture",
};

const expectOk = <T>(result: CodaliImprovementValidationResult<T>): T => {
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  if (!result.ok) throw new Error("Expected validation to pass");
  return result.value;
};

const expectIssue = <T>(
  result: CodaliImprovementValidationResult<T>,
  code: string,
): void => {
  assert.equal(result.ok, false, "Expected validation to fail");
  if (result.ok) throw new Error("Expected validation failure");
  assert.ok(
    result.issues.some((issue) => issue.code === code),
    JSON.stringify(result.issues, null, 2),
  );
};

const level4Policy = (overrides: Partial<CodaliImprovementPolicy> = {}) =>
  createCodaliImprovementPolicy({
    policyId: "policy-phase-21",
    releaseLevel: 4,
    scope,
    allowedArtifactTypes: [
      ...CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[4].allowedArtifactTypes,
    ],
    maxExamples: 10,
    maxObjectBytes: 4096,
    storageMode: "local_only",
    exportEnabled: false,
    trainingEnabled: false,
    autoTagEnabled: false,
    autoPublishEnabled: false,
    ...overrides,
  });

test("ImprovementPolicy exposes explicit release level contracts", () => {
  assert.equal(CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[0].description, "analysis only");
  assert.equal(
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[1].description,
    "eval/replay additions",
  );
  assert.equal(
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[2].description,
    "prompt/schema/tool metadata branch",
  );
  assert.equal(
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[3].description,
    "prerelease/canary tag",
  );
  assert.equal(
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[4].description,
    "stable npm release",
  );
  assert.deepEqual(CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[0].allowedActions, [
    "analyze",
  ]);
  assert.ok(
    CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[4].allowedActions.includes(
      "auto_publish",
    ),
  );
});

test("ImprovementPolicy blocks export, training, auto-tag, and publish when disabled", () => {
  const policy = level4Policy();

  const exportDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "export",
    scope,
    releaseLevel: 4,
    artifactType: "stable_npm_release",
  });
  const trainingDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "training",
    scope,
    releaseLevel: 4,
    exampleCount: 1,
  });
  const tagDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "auto_tag",
    scope,
    releaseLevel: 4,
    artifactType: "canary_tag",
  });
  const publishDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "auto_publish",
    scope,
    releaseLevel: 4,
    artifactType: "stable_npm_release",
  });
  const stablePublishDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "publish_stable",
    scope,
    releaseLevel: 4,
    artifactType: "stable_npm_release",
  });

  assert.equal(exportDecision.allowed, false);
  assert.ok(exportDecision.reasons.includes("export_disabled"));
  assert.equal(trainingDecision.allowed, false);
  assert.ok(trainingDecision.reasons.includes("training_disabled"));
  assert.equal(tagDecision.allowed, false);
  assert.ok(tagDecision.reasons.includes("auto_tag_disabled"));
  assert.equal(publishDecision.allowed, false);
  assert.ok(publishDecision.reasons.includes("auto_publish_disabled"));
  assert.equal(stablePublishDecision.allowed, false);
  assert.ok(stablePublishDecision.reasons.includes("publish_disabled"));
});

test("ImprovementPolicy enforces release level, scope, examples, bytes, and artifact limits", () => {
  const policy = level4Policy({
    releaseLevel: 2,
    allowedArtifactTypes: [
      ...CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[2].allowedArtifactTypes,
    ],
    exportEnabled: true,
    trainingEnabled: true,
  });
  expectOk(validateCodaliImprovementPolicy(policy));

  const publishDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "auto_publish",
    scope,
    releaseLevel: 2,
    artifactType: "stable_npm_release",
  });
  assert.equal(publishDecision.allowed, false);
  assert.ok(publishDecision.reasons.includes("release_level_too_low"));

  const scopeDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "export",
    scope: { tenantHash: "other_tenant", productId: "product_fixture" },
    releaseLevel: 2,
    artifactType: "eval_suite",
  });
  assert.equal(scopeDecision.allowed, false);
  assert.ok(scopeDecision.reasons.includes("scope_not_allowed"));

  const bytesDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "export",
    scope,
    releaseLevel: 2,
    artifactType: "eval_suite",
    objectBytes: 4097,
  });
  assert.equal(bytesDecision.allowed, false);
  assert.ok(bytesDecision.reasons.includes("max_object_bytes_exceeded"));

  const examplesDecision = evaluateCodaliImprovementPolicy(policy, {
    action: "training",
    scope,
    releaseLevel: 2,
    artifactType: "eval_suite",
    exampleCount: 11,
  });
  assert.equal(examplesDecision.allowed, false);
  assert.ok(examplesDecision.reasons.includes("max_examples_exceeded"));
});

test("ImprovementPolicy validators reject loose policy payloads", () => {
  expectIssue(
    validateCodaliImprovementPolicy({
      ...level4Policy({
        releaseLevel: 3,
        allowedArtifactTypes: [
          ...CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[3].allowedArtifactTypes,
        ],
        autoPublishEnabled: true,
      }),
    }),
    "auto_publish_requires_level_4",
  );

  expectIssue(
    validateCodaliImprovementPolicy({
      ...level4Policy(),
      unexpected: true,
    }),
    "unknown_field",
  );

  expectIssue(
    validateCodaliImprovementPolicy({
      ...level4Policy({
        releaseLevel: 1,
        allowedArtifactTypes: ["stable_npm_release"],
      }),
    }),
    "artifact_type_exceeds_release_level",
  );
});

test("ImprovementPolicy validates run, candidate, artifact, gate, scorecard, release, and outcome contracts", () => {
  const run = expectOk(validateCodaliImprovementRun({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    runId: "run-001",
    policyId: "policy-phase-21",
    scope,
    releaseLevel: 2,
    status: "completed",
    createdAt,
    sourceExportIds: ["export-001"],
    maxExamples: 10,
  }));

  const artifact = expectOk(validateCodaliImprovementArtifact({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    artifactId: "artifact-001",
    artifactType: "prompt_patch",
    scope,
    storageMode: "local_only",
    byteSize: 512,
    contentHash: "sha256:artifact001",
    exportAllowed: false,
    trainingAllowed: false,
    createdAt,
  }));

  const candidate = expectOk(validateCodaliImprovementCandidate({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    candidateId: "candidate-001",
    runId: run.runId,
    scope,
    candidateKind: "prompt",
    status: "accepted",
    artifactIds: [artifact.artifactId],
    sourceExportIds: ["export-001"],
    exampleCount: 4,
    objectBytes: 512,
    createdAt,
  }));

  const gate = expectOk(validateCodaliImprovementGate({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    gateId: "gate-001",
    candidateId: candidate.candidateId,
    gateType: "policy",
    status: "passed",
    required: true,
    passed: true,
    createdAt,
    score: 1,
  }));

  const scorecard = expectOk(validateCodaliImprovementScorecard({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    scorecardId: "scorecard-001",
    candidateId: candidate.candidateId,
    status: "passed",
    gates: [gate],
    scores: { policy: 1, eval: 0.97 },
    createdAt,
    summary: "All required gates passed.",
  }));

  const release = expectOk(validateCodaliImprovementRelease({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    releaseId: "release-001",
    candidateId: candidate.candidateId,
    scope,
    releaseLevel: 4,
    status: "published",
    artifactIds: [artifact.artifactId],
    tagName: "v0.0.0-canary",
    packageName: "@mcoda/codali",
    version: "0.0.0",
    createdAt,
  }));

  const outcome = expectOk(validateCodaliImprovementOutcome({
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    outcomeId: "outcome-001",
    releaseId: release.releaseId,
    scope,
    status: "succeeded",
    published: true,
    tagged: true,
    trainingUsed: false,
    exportUsed: false,
    createdAt,
    telemetry: { install_success_rate: 1 },
  }));

  assert.equal(scorecard.gates[0]?.gateId, gate.gateId);
  assert.equal(outcome.published, true);

  expectIssue(
    validateCodaliImprovementRelease({
      ...release,
      packageName: undefined,
      version: undefined,
    }),
    "undefined_field",
  );
});

test("ImprovementPolicy requires exact reasons for skipped gates", () => {
  const skippedGate = {
    schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
    gateId: "gate-skipped",
    candidateId: "candidate-skipped",
    gateType: "policy",
    status: "skipped",
    required: true,
    passed: false,
    createdAt,
    score: 0,
  };

  expectIssue(
    validateCodaliImprovementGate(skippedGate),
    "skipped_gate_reasons_required",
  );
  expectIssue(
    validateCodaliImprovementGate({ ...skippedGate, reasons: [] }),
    "skipped_gate_reasons_required",
  );
  expectIssue(
    validateCodaliImprovementGate({ ...skippedGate, reasons: [""] }),
    "invalid_string",
  );
  expectIssue(
    validateCodaliImprovementScorecard({
      schemaVersion: CODALI_IMPROVEMENT_CONTRACT_SCHEMA_VERSION,
      scorecardId: "scorecard-skipped",
      candidateId: "candidate-skipped",
      status: "blocked",
      gates: [skippedGate],
      scores: { policy: 0 },
      createdAt,
    }),
    "skipped_gate_reasons_required",
  );
  expectOk(validateCodaliImprovementGate({
    ...skippedGate,
    reasons: ["policy_check_not_available"],
  }));
});

test("ImprovementPolicy validates CLI JSON output contracts", () => {
  const policy = level4Policy();
  const decision = evaluateCodaliImprovementPolicy(policy, {
    action: "auto_publish",
    scope,
    releaseLevel: 4,
    artifactType: "stable_npm_release",
  });
  const output = buildCodaliImprovementCliJsonOutput({
    outputType: "improvement.policy_decision",
    status: "blocked",
    generatedAt: createdAt,
    policy,
    decision,
  });
  const validated = expectOk(validateCodaliImprovementCliJsonOutput(output));

  assert.equal(validated.command, "improvement");
  assert.equal(validated.status, "blocked");
  assert.equal(validated.decision?.allowed, false);
  assert.ok(validated.decision?.reasons.includes("auto_publish_disabled"));

  expectOk(validateCodaliImprovementCliJsonOutput(
    buildCodaliImprovementCliJsonOutput({
      outputType: "improvement.release_levels",
      status: "ok",
      generatedAt: createdAt,
      data: Object.values(CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS),
    }),
  ));

  expectIssue(
    validateCodaliImprovementCliJsonOutput(
      buildCodaliImprovementCliJsonOutput({
        outputType: "improvement.run",
        status: "ok",
        generatedAt: createdAt,
        data: { runId: "missing-required-fields" },
      }),
    ),
    "invalid_const",
  );

  expectIssue(
    validateCodaliImprovementCliJsonOutput(
      buildCodaliImprovementCliJsonOutput({
        outputType: "improvement.release_levels",
        status: "ok",
        generatedAt: createdAt,
        data: [
          {
            ...CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS[0],
            description: "loose level",
          },
          ...Object.values(CODALI_IMPROVEMENT_RELEASE_LEVEL_CONTRACTS).slice(1),
        ],
      }),
    ),
    "release_level_contract_mismatch",
  );
});

test("codali improvement policy emits strict JSON contract", { concurrency: false }, () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "improvement",
    "policy",
    "--output",
    "json",
    "--level",
    "4",
    "--tenant-hash",
    scope.tenantHash,
    "--product-id",
    scope.productId,
    "--check-action",
    "auto_publish",
    "--check-artifact-type",
    "stable_npm_release",
  ], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as unknown;
  const output = expectOk(validateCodaliImprovementCliJsonOutput(parsed));
  assert.equal(output.outputType, "improvement.policy_decision");
  assert.equal(output.status, "blocked");
  assert.ok(output.decision?.reasons.includes("auto_publish_disabled"));
});
