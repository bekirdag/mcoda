import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODALI_STORAGE_EXPORT_KINDS,
  validateCodaliStorageExportManifest,
  type CodaliStorageDatasetRecord,
  type CodaliStorageExportKind,
  type CodaliStorageObjectPrivacyFlags,
  type CodaliStoragePrivacyMetadata,
} from "../CodaliStorageContracts.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createInMemoryGatewayDatasetObjectStore,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../GatewayDatasetStore.js";
import {
  runCodaliDatasetExportJob,
} from "../DatasetExportJob.js";
import {
  readLocalDatasetCollection,
  sampleDatasetRecordEntries,
  summarizeDatasetCollection,
} from "../DatasetReviewQueue.js";
import {
  DatasetCommand,
  parseDatasetArgs,
} from "../../cli/DatasetCommand.js";

const fixedNow = () => new Date("2026-07-07T12:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-local",
  productId: "product-neutral",
  deploymentId: "test",
  runId: "dataset-export-test",
});

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
  },
) =>
  objectStore.putObject({
    scope: scope(),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: input.privacyFlags,
    metadata: {
      part: input.part,
    },
  });

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  exportAllowed: boolean;
  trainingAllowed: boolean;
  evalAllowed?: boolean;
  replayAllowed?: boolean;
  exportKind?: CodaliStorageExportKind;
}): Promise<CodaliStorageDatasetRecord> => {
  const privacy: CodaliStoragePrivacyMetadata = createGatewayDatasetLocalOnlyPrivacy({
    exportAllowed: input.exportAllowed,
    trainingAllowed: input.trainingAllowed,
    policyTags: ["local_only"],
  });
  const privacyFlags = createGatewayDatasetLocalOnlyObjectPrivacyFlags({
    containsTenantPrivateData: false,
    containsCustomerData: false,
    exportAllowed: input.exportAllowed,
    trainingAllowed: input.trainingAllowed,
    evalAllowed: input.evalAllowed ?? true,
    replayAllowed: input.replayAllowed ?? true,
  });
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    privacyFlags,
    payload: {
      prompt: `Prompt for ${input.recordId}`,
      exportKind: input.exportKind ?? "prompt-regression",
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    privacyFlags,
    payload: {
      answer: `Answer for ${input.recordId}`,
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: input.trainingAllowed ? "model_call" : "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    quality: {
      score: 0.9,
      labels: ["export_candidate"],
      reviewed: true,
    },
    privacy,
    metadata: {
      exampleType: input.trainingAllowed ? "model_stage" : "final_answer",
    },
  };
};

const writeDatasetCollection = async (
  directory: string,
  batches: Array<{
    scope: GatewayDatasetStorageScope;
    records: CodaliStorageDatasetRecord[];
  }>,
) => {
  await writeFile(
    path.join(directory, "records.jsonl"),
    batches.map((batch, index) => JSON.stringify({
      schemaVersion: "codali.storage.v1",
      collectedAt: fixedNow().toISOString(),
      scope: batch.scope,
      idempotencyKey: `dataset-test-${index + 1}`,
      records: batch.records,
      metadata: { test: true },
    })).join("\n") + "\n",
    "utf8",
  );
};

const withReviewMetadata = (
  record: CodaliStorageDatasetRecord,
  metadata: Record<string, unknown>,
  score = record.quality?.score ?? 0.9,
): CodaliStorageDatasetRecord => ({
  ...record,
  quality: {
    ...(record.quality ?? {}),
    score,
    labels: [
      ...(record.quality?.labels ?? []),
      `integration:${String(metadata.integration)}`,
      `business:${String(metadata.businessValue)}`,
    ],
    reviewed: false,
  },
  metadata: {
    ...(record.metadata ?? {}),
    ...metadata,
  },
});

const captureDatasetOutput = async (argv: string[]): Promise<string> => {
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => {
    output += `${String(value ?? "")}\n`;
  };
  try {
    await DatasetCommand.run(argv);
  } finally {
    console.log = originalLog;
  }
  return output;
};

test("dataset export exposes every required Phase 12 export kind", () => {
  assert.deepEqual(CODALI_STORAGE_EXPORT_KINDS, [
    "eval-replay",
    "prompt-regression",
    "extractor-sft",
    "tool-router-sft",
    "planner-sft",
    "verifier-sft",
    "query-expander-sft",
    "repair-sft",
    "context-refiner-sft",
    "rag-reranker",
    "model-router",
  ]);
});

test("dataset export dry-run reports counts and exclusion reasons without artifact writes", async () => {
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
  const eligible = await buildRecord({
    objectStore,
    recordId: "eligible-row",
    exportAllowed: true,
    trainingAllowed: false,
  });
  const excluded = await buildRecord({
    objectStore,
    recordId: "excluded-row",
    exportAllowed: false,
    trainingAllowed: false,
  });
  const beforeObjectCount = objectStore.listObjects().length;

  const result = await runCodaliDatasetExportJob({
    exportKind: "prompt-regression",
    records: [eligible, excluded],
    objectStore,
    scope: scope(),
    dryRun: true,
    now: fixedNow,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.status, "dry_run");
  assert.equal(result.dryRun.totalCount, 2);
  assert.equal(result.dryRun.eligibleCount, 1);
  assert.equal(result.dryRun.excludedCount, 1);
  assert.ok(result.exclusionReasons.some((reason) => reason.code === "privacy_export_not_allowed"));
  assert.equal(objectStore.listObjects().length, beforeObjectCount);
  assert.equal(result.jsonlRef, undefined);
});

test("dataset export blocks empty non-dry-run jobs", async () => {
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });

  const result = await runCodaliDatasetExportJob({
    exportKind: "prompt-regression",
    records: [],
    objectStore,
    scope: scope(),
    now: fixedNow,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.dryRun.totalCount, 0);
  assert.equal(result.dryRun.eligibleCount, 0);
  assert.equal(result.jsonlRef, undefined);
});

test("dataset export evaluates replay eligibility for eval-replay exports", async () => {
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
  const record = await buildRecord({
    objectStore,
    recordId: "replay-denied-row",
    exportAllowed: true,
    trainingAllowed: false,
    replayAllowed: false,
    exportKind: "eval-replay",
  });

  const result = await runCodaliDatasetExportJob({
    exportKind: "eval-replay",
    records: [record],
    objectStore,
    scope: scope(),
    now: fixedNow,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "blocked");
  assert.ok(result.exclusionReasons.some((reason) => reason.code === "object_replay_not_allowed"));
  assert.equal(result.jsonlRef, undefined);
});

test("dataset export writes JSONL, replay fixture, and audited manifest to object storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dataset-export-job-"));
  try {
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "objects"),
      now: fixedNow,
    });
    const record = await buildRecord({
      objectStore,
      recordId: "jsonl-row",
      exportAllowed: true,
      trainingAllowed: false,
    });

    const result = await runCodaliDatasetExportJob({
      exportKind: "prompt-regression",
      records: [record],
      objectStore,
      scope: scope(),
      generatedBy: "dataset-export-test",
      now: fixedNow,
    });

    assert.equal(result.accepted, true);
    assert.equal(result.status, "exported");
    assert.ok(result.manifest);
    assert.ok(result.jsonlRef);
    assert.ok(result.replayFixtureRef);
    assert.ok(result.manifestRef);
    assert.equal(result.manifest?.exportKind, "prompt-regression");
    assert.equal(result.manifest?.recordCount, 1);
    assert.equal(result.manifest?.checksum, result.jsonlRef?.contentHash);
    assert.equal(result.manifest?.artifactRefs?.length, 2);
    assert.equal(result.manifest?.privacySummary?.exportAllowedCount, 1);
    assert.deepEqual(result.manifest?.lineage?.sourceRecordIds, ["jsonl-row"]);
    assert.equal(result.jsonlRef?.privacyFlags.exportAllowed, true);
    assert.equal(result.replayFixtureRef?.privacyFlags.exportAllowed, true);
    assert.equal(result.manifestRef?.privacyFlags.exportAllowed, true);
    assert.equal(result.jsonlRef?.privacyFlags.trainingAllowed, false);
    assert.deepEqual(
      result.manifest?.deletionGroupSnapshot?.byRecordId["jsonl-row"],
      [record.inputRef.deletionGroupId],
    );

    assert.ok(result.jsonlRef?.uri);
    const jsonl = await readFile(fileURLToPath(result.jsonlRef.uri), "utf8");
    const row = JSON.parse(jsonl.trim()) as Record<string, unknown>;
    assert.equal(row.recordId, "jsonl-row");
    assert.match(jsonl, /\n$/);

    assert.ok(result.replayFixtureRef?.uri);
    const replay = JSON.parse(
      await readFile(fileURLToPath(result.replayFixtureRef.uri), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(replay.exportKind, "prompt-regression");
    assert.equal((replay.records as unknown[]).length, 1);

    assert.ok(result.manifestRef?.uri);
    const manifest = JSON.parse(
      await readFile(fileURLToPath(result.manifestRef.uri), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(manifest.recordType, "export_manifest");
    assert.equal(manifest.checksum, result.jsonlRef.contentHash);

    const invalidManifest = validateCodaliStorageExportManifest({
      ...result.manifest,
      privacySummary: {
        ...result.manifest?.privacySummary,
        recordCount: "not-a-count",
      },
    });
    assert.equal(invalidManifest.ok, false);
    assert.ok(
      invalidManifest.issues.some(
        (issue) =>
          issue.path === "$.privacySummary.recordCount" &&
          issue.code === "expected_non_negative_integer",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dataset export blocks SFT export when training is not allowed", async () => {
  const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
  const record = await buildRecord({
    objectStore,
    recordId: "training-denied-row",
    exportAllowed: true,
    trainingAllowed: false,
    exportKind: "repair-sft",
  });
  const beforeObjectCount = objectStore.listObjects().length;

  const result = await runCodaliDatasetExportJob({
    exportKind: "repair-sft",
    records: [record],
    objectStore,
    scope: scope(),
    now: fixedNow,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.status, "blocked");
  assert.equal(result.dryRun.eligibleCount, 0);
  assert.equal(result.jsonlRef, undefined);
  assert.ok(result.exclusionReasons.some((reason) => reason.code === "privacy_training_not_allowed"));
  assert.ok(result.exclusionReasons.some((reason) => reason.code === "object_training_not_allowed"));
  assert.equal(objectStore.listObjects().length, beforeObjectCount);
});

test("dataset export CLI smoke supports dry-run and JSONL smoke arguments", async () => {
  const parsed = parseDatasetArgs(["export", "JSONL", "smoke", "--dry-run", "--kind", "repair-sft"]);
  assert.equal(parsed.command, "export");
  assert.equal(parsed.format, "jsonl");
  assert.equal(parsed.smoke, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.exportKind, "repair-sft");

  const directory = await mkdtemp(path.join(os.tmpdir(), "dataset-export-command-"));
  const originalLog = console.log;
  let output = "";
  console.log = (value?: unknown) => {
    output += String(value ?? "");
  };
  try {
    await DatasetCommand.run(["export", "JSONL", "smoke", "--directory", directory]);
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }

  assert.match(output, /dataset export smoke: exported/);
  assert.match(output, /jsonl: file:/);
  assert.match(output, /manifest: file:/);
});

test("dataset review queue samples deterministically by seed and tenant-scoped filters", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dataset-review-queue-"));
  try {
    const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
    const plannerEligible = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "planner-eligible",
        exportAllowed: true,
        trainingAllowed: true,
        exportKind: "planner-sft",
      }),
      {
        exampleType: "model_stage",
        failureCluster: "schema",
        integration: "planner",
        confidence: "high",
        businessValue: "critical",
        businessValueScore: 0.95,
      },
      0.95,
    );
    const plannerDenied = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "planner-denied",
        exportAllowed: true,
        trainingAllowed: false,
        exportKind: "planner-sft",
      }),
      {
        exampleType: "model_stage",
        failureCluster: "schema",
        integration: "planner",
        confidence: "high",
        businessValue: "critical",
        businessValueScore: 0.9,
      },
      0.9,
    );
    const otherTenant = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "other-tenant",
        exportAllowed: true,
        trainingAllowed: true,
      }),
      {
        exampleType: "final_answer",
        failureCluster: "none",
        integration: "answer",
        confidence: "medium",
        businessValue: "standard",
        businessValueScore: 0.5,
      },
      0.55,
    );
    await writeDatasetCollection(directory, [
      {
        scope: {
          tenantId: "tenant-a",
          productId: "product-a",
          deploymentId: "test",
          runId: "run-a",
        },
        records: [plannerEligible, plannerDenied],
      },
      {
        scope: {
          tenantId: "tenant-b",
          productId: "product-a",
          deploymentId: "test",
          runId: "run-b",
        },
        records: [otherTenant],
      },
    ]);

    const collection = await readLocalDatasetCollection({ directory });
    const first = sampleDatasetRecordEntries(collection, {
      seed: "phase-16",
      limit: 1,
      tenantId: "tenant-a",
      failureCluster: "schema",
      integration: "planner",
      confidence: "high",
      businessValue: "critical",
      unreviewedOnly: true,
    }).map((entry) => entry.record.recordId);
    const second = sampleDatasetRecordEntries(collection, {
      seed: "phase-16",
      limit: 1,
      tenantId: "tenant-a",
      failureCluster: "schema",
      integration: "planner",
      confidence: "high",
      businessValue: "critical",
      unreviewedOnly: true,
    }).map((entry) => entry.record.recordId);
    const summary = summarizeDatasetCollection(collection);
    const cliOutput = await captureDatasetOutput([
      "review-queue",
      "--directory",
      directory,
      "--tenant",
      "tenant-a",
      "--seed",
      "phase-16",
      "--limit",
      "1",
      "--failure-cluster",
      "schema",
      "--integration",
      "planner",
      "--confidence",
      "high",
      "--business-value",
      "critical",
    ]);
    await assert.rejects(
      () => DatasetCommand.run([
        "review-queue",
        "--directory",
        directory,
        "--seed",
        "phase-16",
      ]),
      /dataset review-queue requires --tenant <id> or explicit --all-tenants\./,
    );
    const allTenantsOutput = await captureDatasetOutput([
      "review-queue",
      "--directory",
      directory,
      "--all-tenants",
      "--seed",
      "phase-16",
    ]);

    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.equal(summary.uniqueRecordCount, 3);
    assert.equal(summary.byTenant["tenant-a"], 2);
    assert.equal(summary.byTenant["tenant-b"], 1);
    assert.match(cliOutput, /dataset review-queue/);
    assert.match(cliOutput, /tenant=tenant-a/);
    assert.doesNotMatch(cliOutput, /tenant=tenant-b/);
    assert.match(allTenantsOutput, /tenant=tenant-a/);
    assert.match(allTenantsOutput, /tenant=tenant-b/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dataset review queue keeps duplicate record ids isolated by tenant scope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dataset-review-duplicate-id-"));
  try {
    const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
    const tenantARecord = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "shared-record",
        exportAllowed: true,
        trainingAllowed: true,
        exportKind: "planner-sft",
      }),
      {
        exampleType: "model_stage",
        failureCluster: "schema",
        integration: "planner",
        confidence: "high",
        businessValue: "critical",
        businessValueScore: 0.92,
      },
      0.92,
    );
    const tenantBRecord = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "shared-record",
        exportAllowed: true,
        trainingAllowed: true,
        exportKind: "planner-sft",
      }),
      {
        exampleType: "model_stage",
        failureCluster: "schema",
        integration: "planner",
        confidence: "high",
        businessValue: "critical",
        businessValueScore: 0.91,
      },
      0.91,
    );
    await writeDatasetCollection(directory, [
      {
        scope: {
          tenantId: "tenant-a",
          productId: "product-a",
          deploymentId: "test",
          runId: "run-a",
        },
        records: [tenantARecord],
      },
      {
        scope: {
          tenantId: "tenant-b",
          productId: "product-a",
          deploymentId: "test",
          runId: "run-b",
        },
        records: [tenantBRecord],
      },
    ]);

    const collection = await readLocalDatasetCollection({ directory });
    const tenantAEntries = sampleDatasetRecordEntries(collection, {
      tenantId: "tenant-a",
      seed: "phase-16",
      unreviewedOnly: true,
    });
    const tenantBEntries = sampleDatasetRecordEntries(collection, {
      tenantId: "tenant-b",
      seed: "phase-16",
      unreviewedOnly: true,
    });
    const summary = summarizeDatasetCollection(collection);
    const cliOutput = await captureDatasetOutput([
      "review-queue",
      "--directory",
      directory,
      "--tenant",
      "tenant-a",
      "--seed",
      "phase-16",
    ]);

    assert.equal(tenantAEntries.length, 1);
    assert.equal(tenantBEntries.length, 1);
    assert.equal(tenantAEntries[0]?.record.recordId, "shared-record");
    assert.equal(tenantBEntries[0]?.record.recordId, "shared-record");
    assert.equal(summary.uniqueRecordCount, 2);
    assert.equal(summary.byTenant["tenant-a"], 1);
    assert.equal(summary.byTenant["tenant-b"], 1);
    assert.match(cliOutput, /tenant=tenant-a/);
    assert.doesNotMatch(cliOutput, /tenant=tenant-b/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dataset label and promote-target persist reviewed metadata locally", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dataset-label-promote-"));
  try {
    const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
    const record = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "label-target",
        exportAllowed: true,
        trainingAllowed: true,
      }),
      {
        exampleType: "final_answer",
        failureCluster: "none",
        integration: "answer",
        confidence: "medium",
        businessValue: "standard",
      },
      0.62,
    );
    await writeDatasetCollection(directory, [
      {
        scope: {
          tenantId: "tenant-label",
          productId: "product-label",
          deploymentId: "test",
          runId: "run-label",
        },
        records: [record],
      },
    ]);

    const labelOutput = await captureDatasetOutput([
      "label",
      "label-target",
      "--directory",
      directory,
      "--tenant",
      "tenant-label",
      "--label",
      "needs-human-review",
      "--reason",
      "sampled for review",
    ]);
    const promoteOutput = await captureDatasetOutput([
      "promote-target",
      "label-target",
      "gold",
      "--directory",
      directory,
      "--tenant",
      "tenant-label",
      "--label",
      "accepted-target",
      "--reason",
      "matches expected answer",
    ]);
    const collection = await readLocalDatasetCollection({ directory });
    const [entry] = sampleDatasetRecordEntries(collection, { tenantId: "tenant-label" });
    assert.ok(entry);

    assert.match(labelOutput, /dataset label: updated=1/);
    assert.match(promoteOutput, /dataset promote-target: updated=1/);
    assert.equal(entry.record.quality?.reviewed, true);
    assert.equal(entry.record.quality?.score, 0.95);
    assert.ok(entry.record.quality?.labels?.includes("needs-human-review"));
    assert.ok(entry.record.quality?.labels?.includes("accepted-target"));
    assert.ok(entry.record.quality?.labels?.includes("review:gold"));
    assert.equal(entry.record.metadata?.rawTraceIncluded, false);
    assert.equal(entry.record.metadata?.reviewPromotionTarget, "gold");
    assert.equal(entry.record.metadata?.labelReason, "sampled for review");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dataset export CLI dry-run reports selected counts and exclusion reasons", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "dataset-export-dry-run-"));
  try {
    const objectStore = createInMemoryGatewayDatasetObjectStore({ now: fixedNow });
    const eligible = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "planner-export-eligible",
        exportAllowed: true,
        trainingAllowed: true,
        exportKind: "planner-sft",
      }),
      {
        exampleType: "model_stage",
        failureCluster: "schema",
        integration: "planner",
        confidence: "high",
        businessValue: "critical",
      },
      0.91,
    );
    const excluded = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "planner-export-excluded",
        exportAllowed: true,
        trainingAllowed: false,
        exportKind: "planner-sft",
      }),
      {
        exampleType: "model_stage",
        failureCluster: "schema",
        integration: "planner",
        confidence: "high",
        businessValue: "critical",
      },
      0.9,
    );
    const ignored = withReviewMetadata(
      await buildRecord({
        objectStore,
        recordId: "ignored-answer",
        exportAllowed: true,
        trainingAllowed: true,
      }),
      {
        exampleType: "final_answer",
        failureCluster: "none",
        integration: "answer",
        confidence: "low",
        businessValue: "standard",
      },
      0.3,
    );
    await writeDatasetCollection(directory, [
      {
        scope: {
          tenantId: "tenant-export",
          productId: "product-export",
          deploymentId: "test",
          runId: "run-export",
        },
        records: [eligible, excluded, ignored],
      },
    ]);

    const output = await captureDatasetOutput([
      "export",
      "--directory",
      directory,
      "--kind",
      "planner-sft",
      "--dry-run",
      "--tenant",
      "tenant-export",
      "--failure-cluster",
      "schema",
      "--integration",
      "planner",
    ]);

    assert.match(output, /dataset export: dry_run/);
    assert.match(output, /collection_records: total=3 selected=2/);
    assert.match(output, /records: total=2 eligible=1 excluded=1/);
    assert.match(output, /privacy_training_not_allowed=2/);
    assert.match(output, /object_training_not_allowed=2/);
    assert.doesNotMatch(output, /jsonl: file:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
