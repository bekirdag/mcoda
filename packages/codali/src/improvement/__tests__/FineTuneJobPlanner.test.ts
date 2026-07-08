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
  CodaliStorageDatasetRecord,
  CodaliStorageExportKind,
} from "../../storage/CodaliStorageContracts.js";
import {
  DatasetExportManifestReader,
  type DatasetExportManifestReaderResult,
} from "../DatasetExportManifestReader.js";
import {
  CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE,
  buildCodaliFineTuneJobPlannerBundle,
  normalizeCodaliFineTuneWorkerRole,
} from "../FineTuneJobPlanner.js";

const fixedNow = () => new Date("2026-07-08T15:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-27",
  productId: "product-neutral",
  deploymentId: "phase-27",
  runId: "dataset-export-phase-27",
});

const localExtractorInventory = () => [
  {
    id: "local-extractor-worker",
    slug: "local-extractor-worker",
    adapter: "ollama-remote",
    model: "local-extractor:latest",
    health: {
      status: "healthy",
      latencyMs: 42,
    },
    capabilities: ["json_schema", "structured_output"],
    supportsJsonSchema: true,
    contextWindow: 12_000,
    rating: 8,
    reasoningRating: 5,
    costPerMillion: 0.12,
    maxComplexity: 4,
    bestUsage: "extractor",
  },
  {
    id: "unreachable-extractor-worker",
    slug: "unreachable-extractor-worker",
    adapter: "ollama-remote",
    model: "unreachable-extractor:latest",
    health: {
      status: "unreachable",
    },
    capabilities: ["json_schema"],
    supportsJsonSchema: true,
    contextWindow: 12_000,
    rating: 9,
    reasoningRating: 5,
    costPerMillion: 0.01,
    maxComplexity: 4,
    bestUsage: "extractor",
  },
];

const putRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
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
      exportAllowed: true,
      trainingAllowed: input.trainingAllowed,
      evalAllowed: true,
      replayAllowed: false,
    }),
    metadata: {
      part: input.part,
    },
  });

const buildRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  artifactType?: string;
  trainingAllowed?: boolean;
  scorecard?: boolean;
  qualityScore?: number;
}): Promise<CodaliStorageDatasetRecord> => {
  const trainingAllowed = input.trainingAllowed ?? true;
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    trainingAllowed,
    payload: {
      instruction: `Extract structured fields for ${input.recordId}.`,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    trainingAllowed,
    payload: {
      fields: {
        summary: `Structured output for ${input.recordId}`,
      },
    },
  });
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: "model_call",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    quality: {
      score: input.qualityScore ?? 0.96,
      labels: ["human_reviewed", "accepted_correction", "high_confidence"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed,
      policyTags: ["local_only", "phase_27"],
    }),
    metadata: {
      artifactType: input.artifactType ?? "extractor_sft",
      exampleType: "model_stage",
      reviewDecision: "accepted",
      confidenceBucket: "high",
      taskHash: `${input.recordId}-task`,
      promptHash: `${input.recordId}-prompt`,
      expectedTargetHash: `${input.recordId}-target`,
      ...(input.scorecard === false ? {} : {
        scorecard: {
          accuracyBefore: 0.62,
          accuracyAfter: 0.83,
          passRateBefore: 0.58,
          passRateAfter: 0.87,
        },
      }),
    },
  };
};

const buildExportFixture = async (input: {
  directory: string;
  records: CodaliStorageDatasetRecord[];
  exportKind?: CodaliStorageExportKind;
  allowedExampleArtifactTypes?: string[];
}): Promise<{
  objectDirectory: string;
  inspection: DatasetExportManifestReaderResult;
}> => {
  const objectDirectory = path.join(input.directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const records = [];
  for (const record of input.records) {
    records.push(record);
  }
  const result = await runCodaliDatasetExportJob({
    exportKind: input.exportKind ?? "extractor-sft",
    records,
    objectStore,
    scope: scope(),
    generatedBy: "phase-27-fine-tune-job-planner-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.jsonlRef);
  const inspection = await new DatasetExportManifestReader().inspect({
    exportId: result.manifest.manifestId,
    directory: objectDirectory,
    allowedExampleArtifactTypes: input.allowedExampleArtifactTypes ?? [
      "extractor",
      "extractor_sft",
    ],
  });
  return {
    objectDirectory,
    inspection,
  };
};

const buildFixtureFromSpecs = async (input: {
  directory: string;
  recordSpecs: Array<{
    recordId: string;
    trainingAllowed?: boolean;
    scorecard?: boolean;
    qualityScore?: number;
  }>;
}) => {
  const objectDirectory = path.join(input.directory, "seed-objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const records = [];
  for (const spec of input.recordSpecs) {
    records.push(await buildRecord({ objectStore, ...spec }));
  }
  return buildExportFixture({
    directory: input.directory,
    records,
  });
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

test("FineTuneJobPlanner builds reproducible extractor SFT job specs from export policy", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-27-planner-"));
  try {
    const fixture = await buildFixtureFromSpecs({
      directory,
      recordSpecs: [{ recordId: "phase-27-extractor-accepted" }],
    });

    const proposal = buildCodaliFineTuneJobPlannerBundle({
      inspection: fixture.inspection,
      role: "extractor",
      inventory: localExtractorInventory(),
    });
    const repeated = buildCodaliFineTuneJobPlannerBundle({
      inspection: fixture.inspection,
      role: "extractor",
      inventory: localExtractorInventory(),
    });

    assert.equal(proposal.schemaVersion, "codali.improvement.fine_tune_job_planner.v1");
    assert.equal(proposal.generationPolicy.deterministic, true);
    assert.equal(proposal.generationPolicy.uploadEnabled, false);
    assert.equal(proposal.generationPolicy.providerSubmissionEnabled, false);
    assert.equal(proposal.generationPolicy.finalSynthesizerFineTuning, false);
    assert.equal(proposal.trainingManifest.manifestId, repeated.trainingManifest.manifestId);
    assert.equal(proposal.trainingManifest.reproducibleFrom.exportId, fixture.inspection.exportId);
    assert.equal(proposal.trainingManifest.reproducibleFrom.role, "extractor");
    assert.equal(proposal.trainingManifest.rowCount, 1);
    assert.equal(proposal.trainingManifest.records[0]?.recordId, "phase-27-extractor-accepted");
    assert.equal(proposal.trainingManifest.excludedTrainingBlockedRecordIds.length, 0);
    assert.equal(proposal.scorecardSummary.required, true);
    assert.equal(proposal.scorecardSummary.bypassAllowed, false);
    assert.equal(proposal.scorecardSummary.examplesWithScorecards, 1);
    assert.equal(proposal.jobSpecs.length, 1);
    assert.equal(proposal.jobSpecs[0]?.status, "draft");
    assert.equal(proposal.jobSpecs[0]?.jobKind, "sft");
    assert.equal(proposal.jobSpecs[0]?.targetResolution.status, "resolved");
    assert.equal(
      proposal.jobSpecs[0]?.targetResolution.assignment?.agentSlug,
      "local-extractor-worker",
    );
    assert.equal(proposal.jobSpecs[0]?.providerSubmission.automaticSubmission, false);
    assert.equal(proposal.jobSpecs[0]?.providerSubmission.runnerStatus, "not_approved");
    assert.equal(proposal.costEstimate.costPerMillionTokens, 0.12);
    assert.equal((proposal.costEstimate.estimatedProviderCostUsd ?? 0) > 0, true);
    assert.equal(proposal.candidates[0]?.status, "proposed");
    assert.deepEqual(proposal.candidates[0]?.blockedReasons, []);
    assert.ok(proposal.evalPlan.commands.some((command) =>
      command.args.includes(
        "packages/codali/src/improvement/__tests__/FineTuneJobPlanner.test.ts",
      )));
    assert.equal(proposal.sourceExamples.every((example) =>
      example.privacy.trainingAllowed === true &&
      example.objectRefs.inputRef?.privacyFlags.trainingAllowed === true &&
      example.objectRefs.outputRef?.privacyFlags.trainingAllowed === true), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FineTuneJobPlanner builds preference job specs for worker roles", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-27-preference-"));
  try {
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "preference-seed-objects"),
      now: fixedNow,
    });
    const record = await buildRecord({
      objectStore,
      recordId: "phase-27-router-preference",
      artifactType: "model_router",
    });
    const fixture = await buildExportFixture({
      directory,
      records: [record],
      exportKind: "model-router",
      allowedExampleArtifactTypes: ["model_router", "model-router", "router"],
    });

    const proposal = buildCodaliFineTuneJobPlannerBundle({
      inspection: fixture.inspection,
      role: "tool_router",
      inventory: localExtractorInventory(),
    });

    assert.equal(proposal.rolePolicy.role, "tool_router");
    assert.equal(proposal.trainingManifest.jobKind, "preference");
    assert.equal(proposal.trainingManifest.rowCount, 1);
    assert.equal(
      proposal.trainingManifest.reproducibleFrom.exportId,
      fixture.inspection.exportId,
    );
    assert.equal(proposal.jobSpecs.length, 1);
    assert.equal(proposal.jobSpecs[0]?.jobKind, "preference");
    assert.equal(proposal.jobSpecs[0]?.status, "draft");
    assert.equal(proposal.jobSpecs[0]?.targetResolution.status, "resolved");
    assert.equal(proposal.jobSpecs[0]?.providerSubmission.automaticSubmission, false);
    assert.equal(proposal.candidates[0]?.status, "proposed");
    assert.deepEqual(proposal.candidates[0]?.blockedReasons, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FineTuneJobPlanner keeps training disallowed rows out of manifests", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-27-training-filter-"));
  try {
    const mixedObjectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "mixed-objects"),
      now: fixedNow,
    });
    const allowed = await buildRecord({
      objectStore: mixedObjectStore,
      recordId: "phase-27-training-allowed",
      trainingAllowed: true,
    });
    const denied = await buildRecord({
      objectStore: mixedObjectStore,
      recordId: "phase-27-training-denied",
      trainingAllowed: false,
    });
    const dryRun = await runCodaliDatasetExportJob({
      exportKind: "extractor-sft",
      records: [allowed, denied],
      objectStore: mixedObjectStore,
      scope: scope(),
      generatedBy: "phase-27-fine-tune-training-filter-test",
      now: fixedNow,
      dryRun: true,
    });
    assert.equal(dryRun.status, "dry_run");
    assert.equal(dryRun.dryRun.eligibleCount, 1);
    assert.equal(dryRun.dryRun.excludedCount, 1);
    assert.ok(dryRun.exclusionReasons.some((reason) =>
      reason.recordId === "phase-27-training-denied" && reason.purpose === "training"));

    const blocked = await runCodaliDatasetExportJob({
      exportKind: "extractor-sft",
      records: [allowed, denied],
      objectStore: mixedObjectStore,
      scope: scope(),
      generatedBy: "phase-27-fine-tune-training-filter-test",
      now: fixedNow,
    });
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.manifest, undefined);

    const fixture = await buildFixtureFromSpecs({
      directory,
      recordSpecs: [
        { recordId: "phase-27-training-allowed", trainingAllowed: true },
      ],
    });

    assert.equal(fixture.inspection.manifest.recordCount, 1);
    assert.deepEqual(fixture.inspection.manifest.lineage.sourceRecordIds, [
      "phase-27-training-allowed",
    ]);

    const proposal = buildCodaliFineTuneJobPlannerBundle({
      inspection: fixture.inspection,
      role: "extractor",
      inventory: localExtractorInventory(),
    });

    assert.equal(proposal.trainingManifest.rowCount, 1);
    assert.deepEqual(
      proposal.trainingManifest.records.map((record) => record.recordId),
      ["phase-27-training-allowed"],
    );
    assert.equal(
      proposal.trainingManifest.records.some((record) =>
        record.recordId === "phase-27-training-denied"),
      false,
    );
    assert.equal(JSON.stringify(proposal.trainingManifest).includes("training-denied"), false);
    assert.equal(proposal.candidates[0]?.status, "proposed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FineTuneJobPlanner blocks missing scorecards and final synthesizer fine tuning", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-27-blocks-"));
  try {
    const fixture = await buildFixtureFromSpecs({
      directory,
      recordSpecs: [{ recordId: "phase-27-no-scorecard", scorecard: false }],
    });

    const missingScorecard = buildCodaliFineTuneJobPlannerBundle({
      inspection: fixture.inspection,
      role: "extractor",
      inventory: localExtractorInventory(),
    });

    assert.equal(missingScorecard.scorecardSummary.bypassAllowed, false);
    assert.deepEqual(missingScorecard.scorecardSummary.missingRecordIds, [
      "phase-27-no-scorecard",
    ]);
    assert.equal(missingScorecard.candidates[0]?.status, "blocked");
    assert.ok(missingScorecard.candidates[0]?.blockedReasons.includes("scorecard_required"));
    assert.equal(missingScorecard.jobSpecs[0]?.status, "blocked");
    assert.equal(
      missingScorecard.evalPlan.gates.find((gate) => gate.type === "scorecard")?.passed,
      false,
    );

    const finalSynthesizer = buildCodaliFineTuneJobPlannerBundle({
      inspection: fixture.inspection,
      role: CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE,
      inventory: localExtractorInventory(),
    });

    assert.equal(normalizeCodaliFineTuneWorkerRole("final"), "final_synthesizer");
    assert.equal(finalSynthesizer.rolePolicy.allowedWorkerRole, false);
    assert.equal(finalSynthesizer.rolePolicy.finalSynthesizerAllowed, false);
    assert.equal(finalSynthesizer.jobSpecs.length, 0);
    assert.equal(finalSynthesizer.candidates[0]?.status, "blocked");
    assert.ok(
      finalSynthesizer.candidates[0]?.blockedReasons.includes(
        "final_synthesizer_fine_tune_disabled_by_default",
      ),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codali improve propose emits fine-tune dry-run JSON without provider submission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-27-cli-"));
  try {
    const fixture = await buildFixtureFromSpecs({
      directory,
      recordSpecs: [{ recordId: "phase-27-cli-extractor" }],
    });
    const inventoryJson = JSON.stringify(localExtractorInventory());

    const output = await captureLog(() =>
      ImprovementCommand.run([
        "propose",
        "--artifact",
        "fine-tune",
        "--role",
        "extractor",
        "--export-id",
        fixture.inspection.manifest.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--inventory-json",
        inventoryJson,
        "--dry-run",
        "--output",
        "json",
      ]));
    const parsed = JSON.parse(output) as {
      outputType?: string;
      status?: string;
      data?: {
        dryRun?: boolean;
        artifact?: string;
        proposal?: {
          generationPolicy?: {
            providerSubmissionEnabled?: boolean;
            finalSynthesizerFineTuning?: boolean;
          };
          candidates?: Array<{ status?: string; blockedReasons?: string[] }>;
          jobSpecs?: Array<{
            status?: string;
            targetResolution?: {
              status?: string;
              assignment?: { agentSlug?: string };
            };
            providerSubmission?: { automaticSubmission?: boolean };
          }>;
          trainingManifest?: {
            rowCount?: number;
            reproducibleFrom?: { exportId?: string; role?: string };
          };
        };
      };
    };
    assert.equal(parsed.outputType, "improvement.propose");
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.data?.dryRun, true);
    assert.equal(parsed.data?.artifact, "fine-tune");
    assert.equal(parsed.data?.proposal?.candidates?.[0]?.status, "proposed");
    assert.deepEqual(parsed.data?.proposal?.candidates?.[0]?.blockedReasons, []);
    assert.equal(parsed.data?.proposal?.jobSpecs?.[0]?.status, "draft");
    assert.equal(parsed.data?.proposal?.jobSpecs?.[0]?.targetResolution?.status, "resolved");
    assert.equal(
      parsed.data?.proposal?.jobSpecs?.[0]?.targetResolution?.assignment?.agentSlug,
      "local-extractor-worker",
    );
    assert.equal(
      parsed.data?.proposal?.jobSpecs?.[0]?.providerSubmission?.automaticSubmission,
      false,
    );
    assert.equal(parsed.data?.proposal?.generationPolicy?.providerSubmissionEnabled, false);
    assert.equal(parsed.data?.proposal?.generationPolicy?.finalSynthesizerFineTuning, false);
    assert.equal(parsed.data?.proposal?.trainingManifest?.rowCount, 1);
    assert.equal(
      parsed.data?.proposal?.trainingManifest?.reproducibleFrom?.exportId,
      fixture.inspection.exportId,
    );
    assert.equal(parsed.data?.proposal?.trainingManifest?.reproducibleFrom?.role, "extractor");

    const aliasOutput = await captureLog(() =>
      runCli([
        "improve",
        "propose",
        "--artifact",
        "fine-tune",
        "--role",
        "extractor",
        "--export-id",
        fixture.inspection.manifest.manifestId,
        "--directory",
        fixture.objectDirectory,
        "--inventory-json",
        inventoryJson,
        "--dry-run",
        "--output",
        "json",
      ]));
    const aliasParsed = JSON.parse(aliasOutput) as { outputType?: string };
    assert.equal(aliasParsed.outputType, "improvement.propose");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
