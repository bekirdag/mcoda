import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import {
  runCodaliDatasetExportJob,
} from "../../storage/DatasetExportJob.js";
import type {
  CodaliStorageDatasetRecord,
} from "../../storage/CodaliStorageContracts.js";
import {
  DatasetEligibilityGate,
} from "../DatasetEligibilityGate.js";

const fixedNow = () => new Date("2026-07-07T12:00:00.000Z");

const scope = (runId = "phase-23-shared-lineage"): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-23",
  productId: "product-neutral",
  deploymentId: "phase-23",
  runId,
});

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
    runId?: string;
    exportAllowed?: boolean;
    trainingAllowed?: boolean;
  },
) => {
  const exportAllowed = input.exportAllowed ?? true;
  return objectStore.putObject({
    scope: scope(input.runId),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsTenantPrivateData: false,
      containsCustomerData: false,
      exportAllowed,
      trainingAllowed: input.trainingAllowed ?? false,
      evalAllowed: true,
      replayAllowed: true,
    }),
    metadata: {
      part: input.part,
    },
  });
};

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  runId?: string;
  artifactType: string;
  taskHash: string;
  promptHash: string;
  toolContractHash: string;
  expectedTargetHash: string;
  exportAllowed?: boolean;
  reviewed?: boolean;
  score?: number;
  labels?: string[];
  metadata?: Record<string, unknown>;
}): Promise<CodaliStorageDatasetRecord> => {
  const exportAllowed = input.exportAllowed ?? true;
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    runId: input.runId,
    exportAllowed,
    payload: {
      prompt: `Prompt for ${input.recordId}`,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    runId: input.runId,
    exportAllowed,
    payload: {
      answer: `Answer for ${input.recordId}`,
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    quality: {
      score: input.score ?? 0.5,
      labels: input.labels ?? [],
      reviewed: input.reviewed ?? false,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed,
      trainingAllowed: false,
      policyTags: ["local_only"],
    }),
    metadata: {
      artifactType: input.artifactType,
      taskHash: input.taskHash,
      promptHash: input.promptHash,
      toolContractHash: input.toolContractHash,
      expectedTargetHash: input.expectedTargetHash,
      ...(input.metadata ?? {}),
    },
  };
};

test("DatasetEligibilityGate curates eligible examples with explicit rejection reasons", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-23-eligibility-"));
  try {
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "objects"),
      now: fixedNow,
    });
    const weakerDuplicate = await buildRecord({
      objectStore,
      recordId: "duplicate-low",
      artifactType: "prompt",
      taskHash: "task-hash-shared",
      promptHash: "prompt-hash-shared",
      toolContractHash: "tool-contract-hash-shared",
      expectedTargetHash: "expected-target-hash-shared",
      score: 0.2,
    });
    const reviewedDuplicate = await buildRecord({
      objectStore,
      recordId: "duplicate-reviewed",
      artifactType: "prompt",
      taskHash: "task-hash-shared",
      promptHash: "prompt-hash-shared",
      toolContractHash: "tool-contract-hash-shared",
      expectedTargetHash: "expected-target-hash-shared",
      reviewed: true,
      score: 0.97,
      labels: ["accepted_correction", "strong_negative"],
      metadata: {
        reviewDecision: "accepted",
        negativeExampleStrength: 0.95,
      },
    });
    const telemetryArtifact = await buildRecord({
      objectStore,
      recordId: "telemetry-artifact",
      runId: "phase-23-telemetry",
      artifactType: "telemetry",
      taskHash: "task-hash-telemetry",
      promptHash: "prompt-hash-telemetry",
      toolContractHash: "tool-contract-hash-telemetry",
      expectedTargetHash: "expected-target-hash-telemetry",
      score: 0.9,
    });
    const revokedLineage = await buildRecord({
      objectStore,
      recordId: "revoked-lineage",
      runId: "phase-23-revoked",
      artifactType: "prompt",
      taskHash: "task-hash-revoked",
      promptHash: "prompt-hash-revoked",
      toolContractHash: "tool-contract-hash-revoked",
      expectedTargetHash: "expected-target-hash-revoked",
      score: 0.9,
    });
    const privacyBlocked = await buildRecord({
      objectStore,
      recordId: "privacy-blocked",
      runId: "phase-23-privacy-blocked",
      artifactType: "prompt",
      taskHash: "task-hash-privacy",
      promptHash: "prompt-hash-privacy",
      toolContractHash: "tool-contract-hash-privacy",
      expectedTargetHash: "expected-target-hash-privacy",
      exportAllowed: false,
      score: 0.9,
    });
    const exportResult = await runCodaliDatasetExportJob({
      exportKind: "prompt-regression",
      records: [
        weakerDuplicate,
        reviewedDuplicate,
        telemetryArtifact,
        revokedLineage,
      ],
      objectStore,
      scope: scope("phase-23-export"),
      generatedBy: "phase-23-eligibility-test",
      now: fixedNow,
    });
    assert.ok(exportResult.manifest);
    assert.ok(exportResult.jsonlRef);

    const report = new DatasetEligibilityGate().curate({
      exportId: exportResult.manifest.manifestId,
      manifest: exportResult.manifest,
      primaryArtifactRef: exportResult.jsonlRef,
      rows: [
        weakerDuplicate,
        reviewedDuplicate,
        telemetryArtifact,
        revokedLineage,
        privacyBlocked,
      ],
      allowedArtifactTypes: ["prompt"],
      revokedDeletionGroupIds: [revokedLineage.inputRef.deletionGroupId],
    });

    assert.equal(report.artifactReadAllowed, true);
    assert.equal(report.totalExamples, 5);
    assert.equal(report.acceptedCount, 1);
    assert.deepEqual(report.acceptedRecordIds, ["duplicate-reviewed"]);
    assert.equal(report.lineageValid, false);
    assert.equal(report.reasonCounts.duplicate_lineage, 1);
    assert.equal(report.reasonCounts.artifact_type_not_allowed, 1);
    assert.equal(report.reasonCounts.deletion_group_revoked, 1);
    assert.ok((report.reasonCounts.row_privacy_read_disallowed ?? 0) > 0);
    assert.ok(report.rejected.every((item) => item.reasons.length > 0));
    assert.ok(report.rejected.every((item) =>
      item.reasons.every((reason) => typeof reason.code === "string" && reason.code.length > 0)));

    const accepted = report.accepted[0];
    assert.ok(accepted);
    assert.deepEqual(accepted.lineageKey.runIds, ["phase-23-shared-lineage"]);
    assert.deepEqual(accepted.lineageKey.deletionGroupIds, ["gateway-dataset-phase-23-shared-lineage"]);
    assert.equal(accepted.lineageKey.taskHash, "task-hash-shared");
    assert.equal(accepted.lineageKey.promptHash, "prompt-hash-shared");
    assert.equal(accepted.lineageKey.toolContractHash, "tool-contract-hash-shared");
    assert.equal(accepted.lineageKey.expectedTargetHash, "expected-target-hash-shared");
    assert.ok(accepted.artifactTypes.includes("prompt"));
    assert.ok(accepted.artifactTypes.includes("prompt_regression"));
    assert.deepEqual(accepted.preferenceSignals, [
      "human_reviewed",
      "accepted_correction",
      "high_confidence",
      "strong_negative",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
