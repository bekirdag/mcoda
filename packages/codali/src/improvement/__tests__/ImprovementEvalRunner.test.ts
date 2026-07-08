import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ImprovementCommand } from "../../cli/ImprovementCommand.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../../storage/GatewayDatasetStore.js";
import { runCodaliDatasetExportJob } from "../../storage/DatasetExportJob.js";
import type {
  CodaliStorageDatasetRecord,
  CodaliStorageExportManifest,
} from "../../storage/CodaliStorageContracts.js";
import {
  CODALI_IMPROVEMENT_EVAL_GATE_IDS,
  buildCodaliImprovementEvalScorecard,
} from "../ImprovementEvalRunner.js";

const fixedNow = () => new Date("2026-07-08T12:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-30",
  productId: "product-neutral",
  deploymentId: "phase-30",
  runId: "improvement-eval-phase-30",
});

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
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
      exportAllowed: true,
      trainingAllowed: false,
      evalAllowed: true,
      replayAllowed: true,
    }),
    metadata: {
      part: input.part,
    },
  });

const buildRecord = async (
  objectStore: GatewayDatasetObjectStore,
): Promise<CodaliStorageDatasetRecord> => {
  const inputRef = await putRef(objectStore, {
    ownerId: "phase-30-row",
    part: "input",
    payload: {
      prompt: "Prompt for Phase 30 release gates",
    },
  });
  const outputRef = await putRef(objectStore, {
    ownerId: "phase-30-row",
    part: "output",
    payload: {
      answer: "Answer for Phase 30 release gates",
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: "phase-30-row",
    datasetKind: "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: "gateway-phase-30-row",
    inputRef,
    outputRef,
    quality: {
      score: 0.94,
      labels: ["phase_30_release_gate"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: false,
      policyTags: ["local_only"],
    }),
    metadata: {
      phase: 30,
    },
  };
};

const buildExportFixture = async (
  directory: string,
): Promise<{ manifest: CodaliStorageExportManifest; manifestPath: string }> => {
  const objectDirectory = path.join(directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const record = await buildRecord(objectStore);
  const result = await runCodaliDatasetExportJob({
    exportKind: "prompt-regression",
    records: [record],
    objectStore,
    scope: scope(),
    generatedBy: "phase-30-eval-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.manifestRef?.uri);
  return {
    manifest: result.manifest,
    manifestPath: fileURLToPath(result.manifestRef.uri),
  };
};

const buildPassingCandidate = (manifest: CodaliStorageExportManifest) => {
  const ownerScope = manifest.artifactRefs[0]?.ownerScope;
  assert.ok(ownerScope);
  return {
    candidateId: "candidate-phase-30-pass",
    release: {
      schemaVersion: "codali.improvement.v1",
      releaseId: "release-phase-30-pass",
      candidateId: "candidate-phase-30-pass",
      scope: {
        tenantHash: ownerScope.tenantHash,
        productId: ownerScope.productId,
        ...(ownerScope.deploymentId ? { deploymentId: ownerScope.deploymentId } : {}),
      },
      releaseLevel: 4,
      status: "planned",
      artifactIds: manifest.artifactRefs.map((ref) => ref.refId),
      createdAt: fixedNow().toISOString(),
      tagName: "codali-improvement-phase-30-pass",
      packageName: "@mcoda/codali",
      version: "0.0.0-phase-30",
    },
    manifest,
    deterministicTests: [{ name: "unit", status: "passed" }],
    replayChecks: [{ name: "replay-fixture", status: "passed" }],
    privacyChecks: [{ name: "privacy", status: "passed" }],
    policyChecks: [{ name: "policy", status: "passed" }],
    toolPolicy: {
      allowedTools: ["retrieval.read", "evidence.view"],
      deniedTools: ["shell.exec", "filesystem.write"],
      destructiveToolsAllowed: false,
    },
    changedFilePaths: [".codali/improvement/candidates/candidate-release.json"],
    approvedPaths: [".codali/improvement/"],
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

test("ImprovementEvalRunner passes every release gate with manifest evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-30-eval-pass-"));
  try {
    const fixture = await buildExportFixture(directory);
    const result = await buildCodaliImprovementEvalScorecard({
      candidateId: "candidate-phase-30-pass",
      candidate: buildPassingCandidate(fixture.manifest),
      now: fixedNow,
    });

    assert.deepEqual(
      result.gates.map((gate) => gate.gateId),
      [...CODALI_IMPROVEMENT_EVAL_GATE_IDS],
    );
    assert.equal(result.scorecard.status, "passed");
    assert.equal(result.releaseApproval.tagAllowed, true);
    assert.equal(result.releaseApproval.publishAllowed, true);
    assert.deepEqual(result.blockedReasons, []);
    for (const gate of result.gates) {
      assert.match(gate.status, /^(passed|failed|skipped|warning)$/);
      assert.notEqual(gate.status, "skipped");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ImprovementEvalRunner blocks skipped hard gates with exact reasons", async () => {
  const result = await buildCodaliImprovementEvalScorecard({
    candidateId: "candidate-phase-30-missing",
    candidate: {
      candidateId: "candidate-phase-30-missing",
    },
    now: fixedNow,
  });

  assert.equal(result.scorecard.status, "blocked");
  assert.equal(result.releaseApproval.tagAllowed, false);
  assert.equal(result.releaseApproval.publishAllowed, false);
  assert.ok(result.releaseApproval.skippedHardGateIds.includes("deterministic_tests"));
  for (const gate of result.gates) {
    assert.match(gate.status, /^(passed|failed|skipped|warning)$/);
    if (gate.status === "skipped") {
      assert.ok(gate.reasons.length > 0, `${gate.gateId} skip reason missing`);
      assert.ok(gate.reasons.every((reason) => reason.trim().length > 0));
    }
  }
});

test("codali improve eval persists scorecards and blocked reasons when writes are enabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-30-eval-cli-"));
  const storageScope = scope();
  const candidatePath = path.join(directory, "candidate.json");
  await writeFile(
    candidatePath,
    JSON.stringify({
      candidateId: "candidate-phase-30-cli",
      deterministicTests: [{
        name: "unit",
        status: "failed",
        reason: "unit_regression",
      }],
    }, null, 2),
    "utf8",
  );
  const requests: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const originalFetch = globalThis.fetch;
  const originalStorageMode = process.env.CODALI_STORAGE_MODE;
  const originalStorageUploadEnabled = process.env.CODALI_STORAGE_UPLOAD_ENABLED;
  process.env.CODALI_STORAGE_MODE = "storage_service";
  process.env.CODALI_STORAGE_UPLOAD_ENABLED = "true";
  globalThis.fetch = (async (url, request) => {
    const body = JSON.parse(String(request?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      url: String(url),
      headers: request?.headers as Record<string, string>,
      body,
    });
    const isCandidate = String(url).endsWith("/v1/improvement/candidates");
    return {
      ok: true,
      status: 201,
      statusText: "Created",
      text: async () => JSON.stringify({
        accepted: true,
        scope: body.scope,
        ...(isCandidate
          ? { candidate: { candidateId: body.candidate_id } }
          : { run: { improvementRunId: body.improvement_run_id } }),
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const output = await captureLog(() => ImprovementCommand.run([
      "eval",
      "--candidate",
      candidatePath,
      "--no-dry-run",
      "--storage-service-url",
      "http://storage.local",
      "--storage-service-token",
      "service-token",
      "--tenant-id",
      storageScope.tenantId,
      "--product-id",
      storageScope.productId,
      "--deployment-id",
      storageScope.deploymentId,
      "--run-id",
      storageScope.runId,
      "--output",
      "json",
    ]));
    const parsed = JSON.parse(output) as {
      status: string;
      data: {
        candidateId: string;
        status: string;
        metadata?: Record<string, unknown>;
      };
    };
    assert.equal(parsed.status, "blocked");
    assert.equal(parsed.data.candidateId, "candidate-phase-30-cli");
    assert.equal(parsed.data.status, "blocked");
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.url, "http://storage.local/v1/improvement/runs");
    assert.equal(requests[1]?.url, "http://storage.local/v1/improvement/candidates");
    assert.equal(
      requests[1]?.headers["x-codali-storage-idempotency-key"]?.startsWith(
        "improvement-scorecard:",
      ),
      true,
    );
    const candidateBody = requests[1]?.body;
    const metadata = candidateBody?.metadata as Record<string, unknown> | undefined;
    assert.equal(candidateBody?.status, "blocked");
    assert.ok(metadata?.scorecard);
    assert.deepEqual(
      metadata?.blockedReasons,
      [
        "approved_file_paths:candidate_write_targets_not_available",
        "deletion_groups:deletion_group_snapshot_not_available",
        "deterministic_tests:unit_regression",
        "lineage_validity:lineage_not_available",
        "no_cross_tenant_replay:replay_fixture_not_available",
        "no_shell_write_destructive_tools:no_runtime_tool_list_present",
        "object_checksums:object_refs_not_available",
        "privacy_metadata:privacy_metadata_not_available",
        "replay_fixtures:replay_fixture_results_not_available",
        "tenant_scope:tenant_scope_refs_not_available",
      ],
    );
    assert.equal(Array.isArray(parsed.data.metadata?.storageWrites), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorageMode === undefined) {
      delete process.env.CODALI_STORAGE_MODE;
    } else {
      process.env.CODALI_STORAGE_MODE = originalStorageMode;
    }
    if (originalStorageUploadEnabled === undefined) {
      delete process.env.CODALI_STORAGE_UPLOAD_ENABLED;
    } else {
      process.env.CODALI_STORAGE_UPLOAD_ENABLED = originalStorageUploadEnabled;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
