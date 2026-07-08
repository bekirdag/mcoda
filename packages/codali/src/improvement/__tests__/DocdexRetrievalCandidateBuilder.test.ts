import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../../cli.js";
import { DatasetCommand } from "../../cli/DatasetCommand.js";
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
} from "../../storage/CodaliStorageContracts.js";
import {
  DatasetExportManifestReader,
} from "../DatasetExportManifestReader.js";
import {
  buildCodaliDocdexRetrievalCandidateBundle,
} from "../DocdexRetrievalCandidateBuilder.js";

const fixedNow = () => new Date("2026-07-08T14:00:00.000Z");

const privateQuery = "tenant private roadmap retrieval query";
const privateSourceId = "tenant-private-repo/docs/roadmap.md";

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-26",
  productId: "product-neutral",
  deploymentId: "phase-26",
  runId: "dataset-export-phase-26",
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
      containsTenantPrivateData: true,
      containsCustomerData: false,
      containsSourceCode: input.part === "evidence",
      exportAllowed: true,
      trainingAllowed: true,
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
  qualityScore: number;
  qualityLabels?: string[];
  reviewed?: boolean;
  reviewDecision?: string;
  confidenceBucket?: string;
  lineageSuffix?: string;
  nestedScorecard?: boolean;
  sourceTypes?: string[];
}): Promise<CodaliStorageDatasetRecord> => {
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    payload: {
      query: privateQuery,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    payload: {
      expandedQueries: [
        "roadmap freshness window",
        "source update policy",
      ],
    },
  });
  const evidenceRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "evidence",
    payload: {
      selectedSource: privateSourceId,
      freshness: "fresh",
    },
  });
  const scorecard = {
    recallBefore: 0.42,
    recallAfter: 0.76,
    precisionBefore: 0.58,
    precisionAfter: 0.82,
    freshnessBefore: 0.4,
    freshnessAfter: 0.91,
  };
  const retrieval = {
    query: privateQuery,
    expandedQueries: [
      "roadmap freshness window",
      "source update policy",
    ],
    selectedSources: [{
      sourceId: privateSourceId,
      sourceType: "repo_doc",
      freshness: "fresh",
    }],
    sourceTypes: input.sourceTypes ?? ["repo_doc"],
    ...(input.nestedScorecard ? { scorecard } : {}),
  };
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId: input.recordId,
    datasetKind: "curated_example",
    createdAt: fixedNow().toISOString(),
    sourceGatewayRecordId: `gateway-${input.recordId}`,
    inputRef,
    outputRef,
    evidenceRefs: [evidenceRef],
    quality: {
      score: input.qualityScore,
      labels: input.qualityLabels ?? [
        "human_reviewed",
        "accepted_correction",
        "high_confidence",
      ],
      reviewed: input.reviewed ?? true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: true,
      policyTags: ["local_only", "tenant_scoped"],
    }),
    metadata: {
      artifactType: "query_expander",
      reviewDecision: input.reviewDecision ?? "accepted",
      confidenceBucket: input.confidenceBucket ?? "high",
      taskHash: input.lineageSuffix
        ? `phase-26-retrieval-task-${input.lineageSuffix}`
        : "phase-26-retrieval-task",
      promptHash: input.lineageSuffix
        ? `phase-26-retrieval-prompt-${input.lineageSuffix}`
        : "phase-26-retrieval-prompt",
      expectedTargetHash: input.lineageSuffix
        ? `phase-26-retrieval-target-${input.lineageSuffix}`
        : "phase-26-retrieval-target",
      retrieval,
      ...(input.nestedScorecard ? {} : { scorecard }),
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
    recordId: "phase-26-accepted-retrieval",
    qualityScore: 0.97,
  });
  const duplicate = await buildRecord({
    objectStore,
    recordId: "phase-26-duplicate-retrieval",
    qualityScore: 0.97,
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: "query-expander-sft",
    records: [accepted, duplicate],
    objectStore,
    scope: scope(),
    generatedBy: "phase-26-docdex-retrieval-builder-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.jsonlRef);
  return {
    objectDirectory,
    manifest: result.manifest,
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

test("DocdexRetrievalCandidateBuilder builds private-safe retrieval eval proposals", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-26-builder-"));
  try {
    const fixture = await buildExportFixture(directory);
    const inspection = await new DatasetExportManifestReader().inspect({
      exportId: fixture.manifest.manifestId,
      directory: fixture.objectDirectory,
      allowedExampleArtifactTypes: [
        "query_expander",
        "docdex_retrieval",
        "rag_reranker",
        "rerank",
        "freshness",
        "duplicate_detection",
        "source_selection",
      ],
    });

    const proposal = buildCodaliDocdexRetrievalCandidateBundle({ inspection });
    const repeated = buildCodaliDocdexRetrievalCandidateBundle({ inspection });

    assert.equal(proposal.candidates[0]?.status, "proposed");
    assert.equal(proposal.candidates[0]?.candidateId, repeated.candidates[0]?.candidateId);
    assert.equal(proposal.generationPolicy.deterministic, true);
    assert.equal(proposal.generationPolicy.uploadEnabled, false);
    assert.equal(proposal.generationPolicy.finalSynthesizerFineTuning, false);
    assert.equal(proposal.sourceExamples.length, 1);
    assert.equal(proposal.queryExpanderEval.cases.length, 1);
    assert.equal(proposal.queryExpanderEval.cases[0]?.expectedExpansionCount, 2);
    assert.equal(
      proposal.queryExpanderEval.fineTuningPriority.orderedRecordIds[0],
      "phase-26-accepted-retrieval",
    );
    assert.equal(proposal.sourceExamples[0]?.privacyScope.tenantScoped, true);
    assert.equal(proposal.sourceExamples[0]?.privacyScope.rawTextAllowed, false);
    assert.ok(
      proposal.sourceExamples[0]?.privacyScope.reasons
        .includes("object_contains_tenant_private_data"),
    );
    assert.equal(proposal.sourceExamples[0]?.query.text, undefined);
    assert.equal(proposal.sourceExamples[0]?.query.storage, "object_ref_or_hash_only");
    assert.equal(proposal.rerankLabels.some((label) => label.label === "positive"), true);
    assert.equal(proposal.rerankLabels.some((label) => label.label === "negative"), true);
    assert.ok(proposal.rerankLabels.some((label) =>
      label.reasonCodes.includes("duplicate_lineage")));
    assert.ok(proposal.regressionCases.some((testCase) => testCase.kind === "freshness"));
    assert.ok(proposal.regressionCases.some((testCase) =>
      testCase.kind === "duplicate_detection"));
    assert.ok(proposal.regressionCases.some((testCase) =>
      testCase.kind === "source_selection"));
    assert.equal(proposal.docdexEvalCommands.length, 2);
    assert.equal(proposal.docdexEvalCommands[0]?.command, "docdexd");
    assert.equal(
      proposal.docdexEvalCommands.every((command) => command.dryRunSafe),
      true,
    );
    const commandArgs = proposal.docdexEvalCommands.map((command) => command.args);
    assert.equal(commandArgs.flat().includes("eval"), false);
    const runTestsCommand = proposal.docdexEvalCommands.find((command) =>
      command.args[0] === "run-tests");
    assert.ok(runTestsCommand);
    assert.deepEqual(runTestsCommand.expectedScorecards, [
      "recall",
      "precision",
      "freshness",
    ]);
    assert.equal(
      runTestsCommand.args.includes(
        "packages/codali/src/improvement/__tests__/DocdexRetrievalCandidateBuilder.test.ts",
      ),
      true,
    );
    assert.ok(proposal.docdexEvalCommands.some((command) =>
      command.args[0] === "hook" && command.args[1] === "pre-commit"));
    assert.equal(proposal.scorecardSummary.recallDelta > 0, true);
    assert.equal(proposal.scorecardSummary.precisionDelta > 0, true);
    assert.equal(proposal.scorecardSummary.freshnessDelta > 0, true);
    assert.equal(JSON.stringify(proposal).includes(privateQuery), false);
    assert.equal(JSON.stringify(proposal).includes(privateSourceId), false);
    assert.equal(JSON.stringify(proposal).includes("OKACAM"), false);
    assert.equal(JSON.stringify(proposal).includes("Suku"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("DocdexRetrievalCandidateBuilder orders query-expander data by fine-tuning signal priority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-26-priority-"));
  try {
    const objectDirectory = path.join(directory, "objects");
    const objectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: objectDirectory,
      now: fixedNow,
    });
    const records = [
      await buildRecord({
        objectStore,
        recordId: "phase-26-human-reviewed-priority",
        qualityScore: 0.71,
        qualityLabels: ["human_reviewed"],
        reviewed: true,
        reviewDecision: "candidate",
        confidenceBucket: "medium",
        lineageSuffix: "human-reviewed",
        nestedScorecard: true,
      }),
      await buildRecord({
        objectStore,
        recordId: "phase-26-accepted-correction-priority",
        qualityScore: 0.73,
        qualityLabels: ["accepted_correction"],
        reviewed: false,
        reviewDecision: "accepted",
        confidenceBucket: "medium",
        lineageSuffix: "accepted-correction",
      }),
      await buildRecord({
        objectStore,
        recordId: "phase-26-high-confidence-priority",
        qualityScore: 0.99,
        qualityLabels: ["high_confidence"],
        reviewed: false,
        reviewDecision: "candidate",
        confidenceBucket: "high",
        lineageSuffix: "high-confidence",
      }),
    ];
    const result = await runCodaliDatasetExportJob({
      exportKind: "query-expander-sft",
      records,
      objectStore,
      scope: scope(),
      generatedBy: "phase-26-docdex-retrieval-priority-test",
      now: fixedNow,
    });
    assert.ok(result.accepted);
    assert.ok(result.manifest);
    const inspection = await new DatasetExportManifestReader().inspect({
      exportId: result.manifest.manifestId,
      directory: objectDirectory,
      allowedExampleArtifactTypes: ["query_expander"],
    });

    const proposal = buildCodaliDocdexRetrievalCandidateBundle({ inspection });
    const expectedOrder = [
      "phase-26-human-reviewed-priority",
      "phase-26-accepted-correction-priority",
      "phase-26-high-confidence-priority",
    ];
    assert.deepEqual(
      proposal.queryExpanderEval.fineTuningPriority.orderedRecordIds,
      expectedOrder,
    );
    assert.deepEqual(
      proposal.queryExpanderEval.cases.map((entry) => entry.sourceRecordId),
      expectedOrder,
    );
    const humanReviewed = proposal.sourceExamples.find((example) =>
      example.recordId === "phase-26-human-reviewed-priority");
    assert.equal(humanReviewed?.fineTuningPriority, "high");
    assert.equal(humanReviewed?.scorecard.freshness?.after, 0.91);
    assert.equal(
      humanReviewed?.metadataShape.scorecardKeys.includes("freshnessAfter"),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("codali improve propose emits docdex retrieval dry-run JSON", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-26-cli-"));
  try {
    const fixture = await buildExportFixture(directory);
    const directOutput = await captureLog(() =>
      ImprovementCommand.run([
        "propose",
        "--artifact",
        "docdex-retrieval",
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
    const data = directParsed.data as {
      dryRun?: boolean;
      artifact?: string;
      proposal?: {
        candidates?: Array<{ status?: string }>;
        sourceExamples?: unknown[];
        queryExpanderEval?: { cases?: unknown[] };
        rerankLabels?: unknown[];
        regressionCases?: Array<{ kind?: string }>;
        docdexEvalCommands?: Array<{ command?: string; args?: string[] }>;
      };
    };
    assert.equal(data.dryRun, true);
    assert.equal(data.artifact, "docdex-retrieval");
    assert.equal(data.proposal?.candidates?.[0]?.status, "proposed");
    assert.equal(data.proposal?.sourceExamples?.length, 1);
    assert.equal(data.proposal?.queryExpanderEval?.cases?.length, 1);
    assert.ok((data.proposal?.rerankLabels?.length ?? 0) >= 2);
    assert.ok(data.proposal?.regressionCases?.some((testCase) =>
      testCase.kind === "duplicate_detection"));
    assert.equal(data.proposal?.docdexEvalCommands?.[0]?.command, "docdexd");
    assert.equal(
      data.proposal?.docdexEvalCommands?.some((command) =>
        command.args?.[0] === "run-tests" &&
          command.args.includes(
            "packages/codali/src/improvement/__tests__/DocdexRetrievalCandidateBuilder.test.ts",
          )),
      true,
    );
    assert.equal(
      data.proposal?.docdexEvalCommands?.flatMap((command) => command.args ?? [])
        .includes("eval"),
      false,
    );
    assert.equal(directOutput.includes(privateQuery), false);
    assert.equal(directOutput.includes(privateSourceId), false);

    const aliasOutput = await captureLog(() =>
      runCli([
        "improve",
        "propose",
        "--artifact",
        "docdex-retrieval",
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

test("codali dataset smoke fixture powers documented docdex retrieval proposal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-26-smoke-fixture-"));
  try {
    const exportOutput = await captureLog(() =>
      DatasetCommand.run([
        "export",
        "JSONL",
        "smoke",
        "--kind",
        "query-expander-sft",
        "--directory",
        directory,
        "--output",
        "json",
      ]));
    const exportParsed = JSON.parse(exportOutput) as {
      directory?: string;
      result?: {
        accepted?: boolean;
        manifest?: {
          manifestId?: string;
          exportKind?: string;
          recordCount?: number;
        };
      };
    };
    assert.equal(exportParsed.directory, directory);
    assert.equal(exportParsed.result?.accepted, true);
    assert.equal(exportParsed.result?.manifest?.exportKind, "query-expander-sft");
    assert.equal(exportParsed.result?.manifest?.recordCount, 2);
    assert.ok(exportParsed.result?.manifest?.manifestId);

    const proposalOutput = await captureLog(() =>
      runCli([
        "improve",
        "propose",
        "--artifact",
        "docdex-retrieval",
        "--export-id",
        String(exportParsed.result?.manifest?.manifestId),
        "--directory",
        directory,
        "--dry-run",
        "--output",
        "json",
      ]));
    const proposalParsed = JSON.parse(proposalOutput) as {
      data?: {
        proposal?: {
          candidates?: Array<{ status?: string; blockedReasons?: string[] }>;
          sourceExamples?: Array<{ privacyScope?: { tenantScoped?: boolean } }>;
          queryExpanderEval?: { fineTuningPriority?: { orderedRecordIds?: string[] } };
          rerankLabels?: Array<{ label?: string; reasonCodes?: string[] }>;
          regressionCases?: Array<{ kind?: string }>;
          docdexEvalCommands?: Array<{
            command?: string;
            args?: string[];
            expectedScorecards?: string[];
          }>;
        };
      };
    };
    const proposal = proposalParsed.data?.proposal;
    assert.equal(proposal?.candidates?.[0]?.status, "proposed");
    assert.deepEqual(proposal?.candidates?.[0]?.blockedReasons, []);
    assert.equal(proposal?.sourceExamples?.length, 1);
    assert.equal(proposal?.sourceExamples?.[0]?.privacyScope?.tenantScoped, true);
    assert.equal(
      proposal?.queryExpanderEval?.fineTuningPriority?.orderedRecordIds?.[0],
      "dataset-export-docdex-retrieval-smoke-record",
    );
    assert.equal(proposal?.rerankLabels?.some((label) => label.label === "positive"), true);
    assert.equal(proposal?.rerankLabels?.some((label) =>
      label.label === "negative" && label.reasonCodes?.includes("duplicate_lineage")),
      true,
    );
    assert.ok(proposal?.regressionCases?.some((testCase) => testCase.kind === "freshness"));
    assert.ok(proposal?.regressionCases?.some((testCase) =>
      testCase.kind === "duplicate_detection"));
    assert.ok(proposal?.regressionCases?.some((testCase) =>
      testCase.kind === "source_selection"));
    assert.equal(proposal?.docdexEvalCommands?.[0]?.command, "docdexd");
    const runTestsCommand = proposal?.docdexEvalCommands?.find((command) =>
      command.args?.[0] === "run-tests");
    assert.ok(runTestsCommand);
    assert.equal(
      runTestsCommand.args?.includes(
        "packages/codali/src/improvement/__tests__/DocdexRetrievalCandidateBuilder.test.ts",
      ),
      true,
    );
    assert.deepEqual(runTestsCommand.expectedScorecards, [
      "recall",
      "precision",
      "freshness",
    ]);
    assert.equal(
      proposal?.docdexEvalCommands?.flatMap((command) => command.args ?? [])
        .includes("eval"),
      false,
    );
    assert.equal(proposalOutput.includes("tenant-scoped retrieval freshness query"), false);
    assert.equal(proposalOutput.includes("tenant-scoped-repo/docs/retrieval-policy.md"), false);
    assert.equal(proposalOutput.includes("OKACAM"), false);
    assert.equal(proposalOutput.includes("Suku"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
