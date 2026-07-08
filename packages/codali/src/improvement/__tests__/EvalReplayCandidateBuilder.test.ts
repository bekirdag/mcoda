import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  CodaliStorageDatasetKind,
  CodaliStorageDatasetRecord,
} from "../../storage/CodaliStorageContracts.js";
import {
  DatasetExportManifestReader,
} from "../DatasetExportManifestReader.js";
import {
  buildCodaliEvalReplayCandidateBundle,
} from "../EvalReplayCandidateBuilder.js";

const fixedNow = () => new Date("2026-07-08T10:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-24",
  productId: "product-neutral",
  deploymentId: "phase-24",
  runId: "dataset-export-phase-24",
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
    kind: input.part === "evidence" ? "evidence" : "dataset",
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

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  artifactType: string;
  datasetKind?: CodaliStorageDatasetKind;
  evalStage?: string;
  labels?: string[];
}): Promise<CodaliStorageDatasetRecord> => {
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    payload: {
      prompt: `Prompt for ${input.recordId}`,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    payload: {
      answer: `Answer for ${input.recordId}`,
    },
  });
  const evidenceRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "evidence",
    payload: {
      excerpt: `Evidence for ${input.recordId}`,
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: input.datasetKind ?? "gateway_answer",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    evidenceRefs: [evidenceRef],
    quality: {
      score: 0.94,
      labels: input.labels ?? ["human_reviewed"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: false,
      policyTags: ["local_only"],
    }),
    metadata: {
      artifactType: input.artifactType,
      evalStage: input.evalStage ?? "final_answer",
      exampleType: input.evalStage === "tool_router" ? "tool_decision" : "final_answer",
      taskHash: `task-hash-${input.recordId}`,
      promptHash: `prompt-hash-${input.recordId}`,
      expectedTargetHash: `target-hash-${input.recordId}`,
    },
  };
};

const buildExportFixture = async (directory: string) => {
  const objectDirectory = path.join(directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const accepted = await buildRecord({
    objectStore,
    recordId: "phase-24-accepted-eval",
    artifactType: "eval",
    evalStage: "final_answer",
  });
  const rejected = await buildRecord({
    objectStore,
    recordId: "phase-24-rejected-telemetry",
    artifactType: "telemetry",
    evalStage: "policy_event",
    labels: ["failure:tool_policy"],
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: "eval-replay",
    records: [accepted, rejected],
    objectStore,
    scope: scope(),
    generatedBy: "phase-24-candidate-builder-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.jsonlRef);
  assert.ok(result.replayFixtureRef);
  return {
    objectDirectory,
    manifest: result.manifest,
    jsonlRef: result.jsonlRef,
    replayFixtureRef: result.replayFixtureRef,
    accepted,
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

test("EvalReplayCandidateBuilder creates stable ref-only eval and replay fixture candidates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-24-builder-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifest.manifestId,
      directory: fixture.objectDirectory,
      allowedExampleArtifactTypes: ["eval", "eval_replay", "replay"],
    });

    const proposal = buildCodaliEvalReplayCandidateBundle({ inspection, artifact: "eval" });
    const repeated = buildCodaliEvalReplayCandidateBundle({ inspection, artifact: "eval" });

    assert.deepEqual(proposal.fixtureIds, repeated.fixtureIds);
    assert.equal(proposal.candidates[0]?.candidateId, repeated.candidates[0]?.candidateId);
    assert.equal(proposal.generationPolicy.modifiesRuntimePrompts, false);
    assert.equal(proposal.generationPolicy.modifiesRuntimeCode, false);
    assert.equal(proposal.expectedShape.replayFixture.bodyPolicy, "object_refs_only");
    assert.equal(proposal.candidates[0]?.status, "proposed");
    assert.equal(proposal.acceptedEvidence.length, 1);
    assert.equal(proposal.rejectedEvidence.length, 1);
    assert.ok(proposal.failureLabels.includes("artifact_type_not_allowed"));
    assert.equal(proposal.replayFixture.bodyStorage, "object_ref");
    assert.equal(proposal.replayFixture.bodyRef?.refId, fixture.replayFixtureRef.refId);
    assert.equal(proposal.replayFixture.records.length, 1);
    assert.equal(proposal.replayFixture.records[0]?.inputRef?.refId, fixture.accepted.inputRef.refId);
    assert.equal(
      Object.prototype.hasOwnProperty.call(proposal.replayFixture.records[0], "payload"),
      false,
    );
    assert.equal(proposal.evalFixture.cases.length, 1);
    assert.equal(proposal.evalFixture.cases[0]?.objectRefs.inputRef?.refId, fixture.accepted.inputRef.refId);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codali improve propose emits deterministic eval proposal JSON without storage writes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-24-cli-"));
  try {
    const fixture = await buildExportFixture(directory);
    const directOutput = await captureLog(() =>
      ImprovementCommand.run([
        "propose",
        "--artifact",
        "eval",
        "--export-id",
        fixture.manifest.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--dry-run",
        "--output",
        "json",
      ]));
    const directParsed = JSON.parse(directOutput) as Record<string, unknown>;
    assert.equal(directParsed.outputType, "improvement.propose");
    assert.equal(directParsed.status, "ok");
    const directData = directParsed.data as Record<string, unknown>;
    assert.equal(directData.dryRun, true);
    assert.equal(directData.artifact, "eval");
    const directProposal = directData.proposal as {
      candidates?: Array<{ status?: string }>;
      replayFixture?: { bodyRef?: { refId?: string } };
      acceptedEvidence?: unknown[];
      rejectedEvidence?: unknown[];
    };
    assert.equal(directProposal.candidates?.[0]?.status, "proposed");
    assert.equal(directProposal.replayFixture?.bodyRef?.refId, fixture.replayFixtureRef.refId);
    assert.equal(directProposal.acceptedEvidence?.length, 1);
    assert.equal(directProposal.rejectedEvidence?.length, 1);

    const aliasOutput = await captureLog(() =>
      runCli([
        "improve",
        "propose",
        "--artifact",
        "eval",
        "--export-id",
        fixture.manifest.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--dry-run",
        "--output",
        "json",
      ]));
    const aliasParsed = JSON.parse(aliasOutput) as Record<string, unknown>;
    assert.equal(aliasParsed.outputType, "improvement.propose");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
