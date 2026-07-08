import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../../cli.js";
import { ImprovementCommand } from "../../cli/ImprovementCommand.js";
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
  CodaliStorageExportKind,
} from "../../storage/CodaliStorageContracts.js";
import {
  DatasetExportManifestReader,
  DatasetExportManifestReaderError,
} from "../DatasetExportManifestReader.js";

const fixedNow = () => new Date("2026-07-07T12:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-22",
  productId: "product-neutral",
  deploymentId: "phase-22",
  runId: "dataset-export-phase-22",
});

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
    exportAllowed: boolean;
    trainingAllowed: boolean;
  },
) =>
  objectStore.putObject({
    scope: scope(),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: createGatewayDatasetLocalOnlyObjectPrivacyFlags({
      containsTenantPrivateData: false,
      containsCustomerData: false,
      exportAllowed: input.exportAllowed,
      trainingAllowed: input.trainingAllowed,
      evalAllowed: true,
      replayAllowed: true,
    }),
    metadata: {
      part: input.part,
    },
  });

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  exportAllowed?: boolean;
  trainingAllowed?: boolean;
}): Promise<CodaliStorageDatasetRecord> => {
  const exportAllowed = input.exportAllowed ?? true;
  const trainingAllowed = input.trainingAllowed ?? false;
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    exportAllowed,
    trainingAllowed,
    payload: {
      prompt: `Prompt for ${input.recordId}`,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    exportAllowed,
    trainingAllowed,
    payload: {
      answer: `Answer for ${input.recordId}`,
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: trainingAllowed ? "model_call" : "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    quality: {
      score: 0.92,
      labels: ["phase_22_fixture"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed,
      trainingAllowed,
      policyTags: ["local_only"],
    }),
    metadata: {
      phase: 22,
    },
  };
};

const buildExportFixture = async (input: {
  directory: string;
  exportKind?: CodaliStorageExportKind;
  trainingAllowed?: boolean;
}) => {
  const objectDirectory = path.join(input.directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const record = await buildRecord({
    objectStore,
    recordId: "reader-row-1",
    trainingAllowed: input.trainingAllowed ?? false,
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: input.exportKind ?? "prompt-regression",
    records: [record],
    objectStore,
    scope: scope(),
    generatedBy: "phase-22-reader-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.manifestRef?.uri);
  assert.ok(result.jsonlRef?.uri);
  return {
    objectDirectory,
    manifest: result.manifest,
    manifestId: result.manifest.manifestId,
    manifestPath: fileURLToPath(result.manifestRef.uri),
    jsonlRef: result.jsonlRef,
    jsonlPath: fileURLToPath(result.jsonlRef.uri),
  };
};

const captureLog = async (run: () => Promise<void>): Promise<string> => {
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => {
    output += `${String(value ?? "")}\n`;
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return output;
};

test("DatasetExportManifestReader verifies checksum and normalizes candidate provenance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-22-reader-"));
  try {
    const fixture = await buildExportFixture({ directory });
    const result = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifestId,
      directory: fixture.objectDirectory,
      allowedExampleArtifactTypes: ["prompt"],
    });

    assert.equal(result.manifest.manifestId, fixture.manifestId);
    assert.ok(result.primaryArtifact);
    assert.equal(result.primaryArtifact.payloadSummary.payloadKind, "jsonl");
    assert.equal(result.primaryArtifact.payloadSummary.rowCount, 1);
    assert.equal(result.curationReport.acceptedCount, 1);
    assert.equal(result.curationReport.rejectedCount, 0);
    assert.ok(result.curationReport.accepted[0]?.artifactTypes.includes("prompt"));
    assert.ok(result.curationReport.accepted[0]?.artifactTypes.includes("prompt_regression"));
    assert.equal(result.provenance.sourceRecordIds[0], "reader-row-1");
    assert.equal(result.provenance.sourceGatewayRecordIds[0], "gateway-reader-row-1");
    assert.equal(result.provenance.primaryArtifactContentHash, result.manifest.checksum);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]?.candidateKind, "prompt");
    assert.equal(result.candidates[0]?.exampleCount, 1);
    assert.deepEqual(result.warnings, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DatasetExportManifestReader blocks artifact payload reads before parsing when privacy disallows export", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-23-reader-privacy-"));
  try {
    const fixture = await buildExportFixture({ directory });
    await writeFile(fixture.jsonlPath, "{not-valid-jsonl", "utf8");
    await writeFile(
      fixture.manifestPath,
      JSON.stringify({
        ...fixture.manifest,
        privacy: {
          ...fixture.manifest.privacy,
          exportAllowed: false,
        },
      }, null, 2),
      "utf8",
    );

    const result = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifestId,
      directory: fixture.objectDirectory,
    });

    assert.equal(result.primaryArtifact, undefined);
    assert.equal(result.curationReport.artifactReadAllowed, false);
    assert.equal(result.curationReport.acceptedCount, 0);
    assert.equal(result.curationReport.reasonCounts.artifact_privacy_read_disallowed, 1);
    assert.equal(result.curationReport.rejected[0]?.targetType, "artifact");
    assert.deepEqual(result.candidates, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DatasetExportManifestReader invalidates candidates when deletion group lineage is revoked", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-23-reader-revoked-"));
  try {
    const fixture = await buildExportFixture({ directory });
    const revokedDeletionGroupId = fixture.manifest.deletionGroupSnapshot.deletionGroupIds[0];
    assert.ok(revokedDeletionGroupId);
    const result = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifestId,
      directory: fixture.objectDirectory,
      revokedDeletionGroupIds: [revokedDeletionGroupId],
    });

    assert.equal(result.curationReport.lineageValid, false);
    assert.equal(result.curationReport.acceptedCount, 0);
    assert.equal(result.curationReport.reasonCounts.deletion_group_revoked, 1);
    assert.deepEqual(result.candidates, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DatasetExportManifestReader rejects invalid manifests before candidate generation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-22-invalid-"));
  try {
    const manifestPath = path.join(directory, "invalid.json");
    await writeFile(manifestPath, JSON.stringify({ manifestId: "invalid" }), "utf8");
    await assert.rejects(
      () => new DatasetExportManifestReader().inspect({ manifestPath }),
      (error) => {
        assert.ok(error instanceof DatasetExportManifestReaderError);
        assert.equal(error.code, "CODALI_DATASET_EXPORT_MANIFEST_INVALID");
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DatasetExportManifestReader verifies artifact checksums before payload use", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-22-checksum-"));
  try {
    const fixture = await buildExportFixture({ directory });
    await writeFile(fixture.jsonlPath, "{\"tampered\":true}\n", "utf8");
    await assert.rejects(
      () => new DatasetExportManifestReader().inspect({
        exportId: fixture.manifestId,
        directory: fixture.objectDirectory,
      }),
      (error) => {
        assert.ok(error instanceof DatasetExportManifestReaderError);
        assert.equal(error.code, "CODALI_DATASET_EXPORT_ARTIFACT_CHECKSUM_MISMATCH");
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DatasetExportManifestReader warns on unsupported export kinds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-22-unsupported-"));
  try {
    const fixture = await buildExportFixture({
      directory,
      exportKind: "repair-sft",
      trainingAllowed: true,
    });
    const result = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifestId,
      directory: fixture.objectDirectory,
    });

    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "unsupported_export_kind");
    assert.equal(result.warnings[0]?.exportKind, "repair-sft");
    assert.deepEqual(result.candidates, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DatasetExportManifestReader powers codali improve inspect dry-run JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-22-cli-"));
  try {
    const fixture = await buildExportFixture({ directory });
    const commandOutput = await captureLog(() =>
      ImprovementCommand.run([
        "inspect",
        "--export-id",
        fixture.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--dry-run",
        "--example-artifact-type",
        "prompt",
        "--output",
        "json",
      ]));
    const parsed = JSON.parse(commandOutput) as Record<string, unknown>;
    assert.equal(parsed.outputType, "improvement.inspect");
    const data = parsed.data as Record<string, unknown>;
    assert.equal(data.dryRun, true);
    assert.equal((data.candidates as unknown[]).length, 1);
    assert.equal((data.warnings as unknown[]).length, 0);
    assert.equal((data.curationReport as { acceptedCount?: number }).acceptedCount, 1);

    const aliasOutput = await captureLog(() =>
      runCli([
        "improve",
        "inspect",
        "--export-id",
        fixture.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--dry-run",
        "--example-artifact-type",
        "prompt",
        "--output",
        "json",
      ]));
    const aliasParsed = JSON.parse(aliasOutput) as Record<string, unknown>;
    assert.equal(aliasParsed.outputType, "improvement.inspect");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
