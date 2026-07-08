import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatasetCommand } from "../../cli/DatasetCommand.js";
import { ImprovementCommand } from "../../cli/ImprovementCommand.js";
import type {
  CodaliStorageDatasetRecord,
  CodaliStorageExportManifest,
} from "../../storage/CodaliStorageContracts.js";
import { runCodaliDatasetExportJob } from "../../storage/DatasetExportJob.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import {
  inspectCodaliDatasetRunForOperators,
  inspectCodaliReleaseForOperators,
} from "../OperatorInspector.js";
import { runCodaliReleaseOutcomeReporter } from "../ReleaseOutcomeReporter.js";

const fixedNow = () => new Date("2026-07-08T12:00:00.000Z");

const storageScope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-34",
  productId: "product-neutral",
  deploymentId: "phase-34",
  runId: "phase-34-run",
});

const improvementScope = () => ({
  tenantHash: "tenant-phase-34",
  productId: "product-neutral",
  deploymentId: "phase-34",
});

const captureLog = async (run: () => Promise<void>): Promise<string> => {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
};

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
    containsSecrets?: boolean;
    containsCustomerData?: boolean;
  },
) =>
  objectStore.putObject({
    scope: storageScope(),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsSecrets: input.containsSecrets ?? false,
      containsCustomerData: input.containsCustomerData ?? false,
      containsTenantPrivateData: false,
      exportAllowed: true,
      trainingAllowed: false,
      evalAllowed: true,
      replayAllowed: true,
    }),
    metadata: {
      part: input.part,
    },
  });

const buildDatasetRecord = async (
  objectStore: GatewayDatasetObjectStore,
  options: { sensitive?: boolean } = {},
): Promise<CodaliStorageDatasetRecord> => {
  const sensitive = options.sensitive ?? true;
  const inputRef = await putRef(objectStore, {
    ownerId: "phase-34-row",
    part: "input",
    containsSecrets: sensitive,
    containsCustomerData: sensitive,
    payload: {
      prompt: "Operator inspection prompt",
      apiToken: "service-token-that-must-not-leak",
      customerData: "raw customer text that must not leak",
    },
  });
  const outputRef = await putRef(objectStore, {
    ownerId: "phase-34-row",
    part: "output",
    payload: {
      answer: "Operator inspection answer",
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: "phase-34-record",
    datasetKind: "evaluation",
    createdAt: fixedNow().toISOString(),
    inputRef,
    outputRef,
    quality: {
      score: 0.91,
      labels: ["phase-34", "operator-inspection"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      classification: "internal",
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: false,
      policyTags: ["local_only"],
    }),
    metadata: {
      exampleType: "operator_inspection",
      failureCluster: "none",
      integration: "generic_gateway",
      confidenceBucket: "high",
      businessValueBucket: "high",
      apiToken: "metadata-secret-that-must-not-leak",
      customerData: "metadata customer text that must not leak",
    },
  };
};

const writeLocalCollection = async (
  directory: string,
  record: CodaliStorageDatasetRecord,
): Promise<void> => {
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "records.jsonl"),
    `${JSON.stringify({
      scope: storageScope(),
      collectedAt: fixedNow().toISOString(),
      records: [record],
      metadata: {
        batchToken: "batch-secret-that-must-not-leak",
      },
    })}\n`,
    "utf8",
  );
};

const writeReleaseArtifacts = async (input: {
  directory: string;
  manifest: CodaliStorageExportManifest;
  releaseId: string;
  candidateId: string;
}): Promise<void> => {
  const release = {
    schemaVersion: "codali.improvement.v1",
    releaseId: input.releaseId,
    candidateId: input.candidateId,
    scope: improvementScope(),
    releaseLevel: 2,
    status: "planned",
    artifactIds: ["phase-34-artifact"],
    createdAt: fixedNow().toISOString(),
    metadata: {
      sourceExportIds: [input.manifest.manifestId],
      apiToken: "release-secret-that-must-not-leak",
    },
  };
  const candidate = {
    schemaVersion: "codali.improvement.v1",
    candidateId: input.candidateId,
    runId: "phase-34-improvement-run",
    scope: improvementScope(),
    candidateKind: "release",
    status: "blocked",
    artifactIds: ["phase-34-artifact"],
    sourceExportIds: [input.manifest.manifestId],
    exampleCount: 1,
    objectBytes: 512,
    createdAt: fixedNow().toISOString(),
    blockedReasons: [
      "deterministic_tests:unit_regression",
      "privacy_metadata:missing_redaction",
    ],
  };
  const scorecard = {
    schemaVersion: "codali.improvement.v1",
    scorecardId: "phase-34-scorecard",
    candidateId: input.candidateId,
    status: "blocked",
    gates: [{
      schemaVersion: "codali.improvement.v1",
      gateId: "phase-34-deterministic-tests",
      candidateId: input.candidateId,
      gateType: "eval",
      status: "failed",
      required: true,
      passed: false,
      createdAt: fixedNow().toISOString(),
      reasons: ["deterministic_tests:unit_regression"],
    }],
    scores: {
      deterministicTests: 0,
    },
    createdAt: fixedNow().toISOString(),
    metadata: {
      manifestId: input.manifest.manifestId,
      customerData: "scorecard customer text that must not leak",
    },
  };
  const report = runCodaliReleaseOutcomeReporter({
    releaseId: input.releaseId,
    scope: improvementScope(),
    metrics: {
      schemaFailures: 1,
    },
    rollbackApplied: true,
    now: fixedNow,
  });

  await writeFile(
    path.join(input.directory, "manifest.json"),
    JSON.stringify(input.manifest, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(input.directory, "release.json"),
    JSON.stringify({ outputType: "improvement.release", data: { release } }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(input.directory, "candidate.json"),
    JSON.stringify(candidate, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(input.directory, "scorecard.json"),
    JSON.stringify({ outputType: "improvement.scorecard", data: { scorecard } }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(input.directory, "monitor.json"),
    JSON.stringify({ outputType: "improvement.monitor", data: report }, null, 2),
    "utf8",
  );
};

test("OperatorInspector emits dashboard-ready dataset run JSON without leaking sensitive fields", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-34-dataset-"));
  try {
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "objects"),
      now: fixedNow,
    });
    const record = await buildDatasetRecord(objectStore);
    await writeLocalCollection(directory, record);

    const inspection = await inspectCodaliDatasetRunForOperators({
      directory,
      runId: storageScope().runId,
      now: fixedNow,
    });

    assert.equal(inspection.dashboardReady, true);
    assert.equal(inspection.inspectionType, "dataset_run");
    assert.equal(inspection.runs.length, 1);
    assert.equal(inspection.runs[0]?.recordCount, 1);
    assert.equal(inspection.runs[0]?.privacy.containsSecretsCount, 1);
    assert.equal(inspection.audit.noSecretsOrUnredactedCustomerData, true);
    const serialized = JSON.stringify(inspection);
    assert.equal(serialized.includes("service-token-that-must-not-leak"), false);
    assert.equal(serialized.includes("metadata-secret-that-must-not-leak"), false);
    assert.equal(serialized.includes("raw customer text that must not leak"), false);

    const cliOutput = await captureLog(() => DatasetCommand.run([
      "inspect",
      "--run-id",
      storageScope().runId,
      "--directory",
      directory,
      "--output",
      "json",
    ]));
    const parsed = JSON.parse(cliOutput) as {
      dashboardReady?: boolean;
      runs?: Array<{ runId?: string; recordCount?: number }>;
    };
    assert.equal(parsed.dashboardReady, true);
    assert.equal(parsed.runs?.[0]?.runId, storageScope().runId);
    assert.equal(parsed.runs?.[0]?.recordCount, 1);

    const allRunsOutput = await captureLog(() => DatasetCommand.run([
      "inspect",
      "--directory",
      directory,
      "--output",
      "json",
    ]));
    const allRuns = JSON.parse(allRunsOutput) as {
      dashboardReady?: boolean;
      filters?: { runId?: string };
      runs?: Array<{ runId?: string; recordCount?: number }>;
    };
    assert.equal(allRuns.dashboardReady, true);
    assert.equal(allRuns.filters?.runId, undefined);
    assert.equal(allRuns.runs?.[0]?.runId, storageScope().runId);
    assert.equal(allRuns.runs?.[0]?.recordCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OperatorInspector traces releases to exports, eval gates, blocked reasons, and rollbacks", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-34-release-"));
  try {
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "objects"),
      now: fixedNow,
    });
    const exportObjectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "exports", "objects"),
      now: fixedNow,
    });
    const record = await buildDatasetRecord(objectStore, { sensitive: false });
    await writeLocalCollection(directory, record);
    const exportResult = await runCodaliDatasetExportJob({
      exportKind: "eval-replay",
      records: [record],
      objectStore: exportObjectStore,
      scope: storageScope(),
      dryRun: false,
      generatedBy: "phase-34-operator-inspector-test",
      now: fixedNow,
    });
    assert.equal(exportResult.accepted, true);
    assert.ok(exportResult.manifest);
    const manifest = exportResult.manifest;
    await writeReleaseArtifacts({
      directory,
      manifest,
      releaseId: "phase-34-release",
      candidateId: "phase-34-candidate",
    });

    const inspection = await inspectCodaliReleaseForOperators({
      releaseId: "phase-34-release",
      directory,
      now: fixedNow,
    });

    assert.equal(inspection.dashboardReady, true);
    assert.equal(inspection.releaseLineage.traceability.traceableToExports, true);
    assert.deepEqual(
      inspection.releaseLineage.traceability.exportIds,
      [manifest.manifestId],
    );
    assert.equal(inspection.releaseLineage.traceability.traceableToEvalGates, true);
    assert.deepEqual(inspection.releaseLineage.traceability.gateIds, [
      "phase-34-deterministic-tests",
    ]);
    assert.equal(inspection.blockedCandidates.length, 1);
    assert.deepEqual(inspection.blockedCandidates[0]?.reasons, [
      "deterministic_tests:unit_regression",
      "privacy_metadata:missing_redaction",
    ]);
    assert.equal(inspection.releaseLineage.rollbacks.length, 1);
    assert.equal(inspection.productQualitySummary.blockedCandidateCount, 1);
    assert.equal(
      inspection.storageServiceQueryEndpoints.releaseLineage,
      "/v1/improvement/releases/phase-34-release/lineage",
    );
    const serialized = JSON.stringify(inspection);
    assert.equal(serialized.includes("release-secret-that-must-not-leak"), false);
    assert.equal(serialized.includes("scorecard customer text that must not leak"), false);

    const cliOutput = await captureLog(() => ImprovementCommand.run([
      "inspect",
      "--release",
      "phase-34-release",
      "--directory",
      directory,
      "--output",
      "json",
    ]));
    const parsed = JSON.parse(cliOutput) as {
      outputType?: string;
      data?: {
        dashboardReady?: boolean;
        releaseLineage?: {
          traceability?: {
            traceableToExports?: boolean;
            traceableToEvalGates?: boolean;
          };
        };
      };
    };
    assert.equal(parsed.outputType, "improvement.inspect");
    assert.equal(parsed.data?.dashboardReady, true);
    assert.equal(parsed.data?.releaseLineage?.traceability?.traceableToExports, true);
    assert.equal(parsed.data?.releaseLineage?.traceability?.traceableToEvalGates, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OperatorInspector tolerates sparse release artifacts from older local JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-34-sparse-release-"));
  try {
    await mkdir(directory, { recursive: true });
    const manifestId = "phase-34-sparse-export";
    await writeFile(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: "codali.dataset.export.job.v1",
        recordType: "export_manifest",
        manifestId,
        exportKind: "eval-replay",
        artifactRefs: [],
        lineage: { sourceRunIds: [storageScope().runId] },
        createdAt: fixedNow().toISOString(),
      }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(directory, "release.json"),
      JSON.stringify({
        releaseId: "phase-34-sparse-release",
        candidateId: "phase-34-sparse-candidate",
        scope: improvementScope(),
        releaseLevel: 1,
        status: "planned",
        artifactIds: ["phase-34-sparse-artifact"],
        createdAt: fixedNow().toISOString(),
      }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(directory, "candidate.json"),
      JSON.stringify({
        candidateId: "phase-34-sparse-candidate",
        candidateKind: "release",
        status: "blocked",
        artifactIds: ["phase-34-sparse-artifact"],
        blockedReasons: ["candidate_policy:missing_required_eval"],
        metadata: { sourceExportIds: [manifestId] },
      }, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(directory, "scorecard.json"),
      JSON.stringify({
        scorecardId: "phase-34-sparse-scorecard",
        candidateId: "phase-34-sparse-candidate",
        status: "blocked",
        gates: [{
          gateId: "phase-34-sparse-eval",
          candidateId: "phase-34-sparse-candidate",
          gateType: "eval",
          status: "failed",
          required: true,
          passed: false,
          reasons: ["candidate_policy:missing_required_eval"],
        }],
      }, null, 2),
      "utf8",
    );

    const inspection = await inspectCodaliReleaseForOperators({
      releaseId: "phase-34-sparse-release",
      directory,
      now: fixedNow,
    });

    assert.equal(inspection.dashboardReady, true);
    assert.equal(inspection.releaseLineage.traceability.traceableToExports, true);
    assert.deepEqual(inspection.releaseLineage.traceability.exportIds, [manifestId]);
    assert.equal(inspection.releaseLineage.traceability.traceableToEvalGates, true);
    assert.deepEqual(inspection.blockedCandidates[0]?.reasons, [
      "candidate_policy:missing_required_eval",
    ]);
    assert.equal(inspection.productQualitySummary.privacy.containsSecretsExportCount, 0);
    assert.equal(inspection.productQualitySummary.privacy.containsCustomerDataExportCount, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
