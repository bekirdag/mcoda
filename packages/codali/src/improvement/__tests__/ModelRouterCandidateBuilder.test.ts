import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../../cli.js";
import { DatasetCommand } from "../../cli/DatasetCommand.js";
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
  buildCodaliModelRouterCandidateBundle,
} from "../ModelRouterCandidateBuilder.js";

const fixedNow = () => new Date("2026-07-08T16:00:00.000Z");

const scope = (): GatewayDatasetStorageScope => ({
  tenantId: "tenant-phase-28",
  productId: "product-neutral",
  deploymentId: "phase-28",
  runId: "dataset-export-phase-28",
});

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
      replayAllowed: false,
    }),
    metadata: {
      part: input.part,
    },
  });

const primaryOnlyComparisonRecords = (): Record<string, unknown>[] => [
  {
    id: "phase-28-primary-only",
    scenarioId: "generic_question",
    role: "small_json",
    resolverRole: "repair",
    comparisonRole: "primary",
    primary: true,
    agentSlug: "current-repair-worker",
    tier: "small",
    model: "current-repair-model",
    adapter: "openai-compatible",
    source: "cloud",
    healthStatus: "healthy",
    capabilities: ["json_schema"],
    resultStatus: "passed",
    selectedByPolicy: true,
    metrics: {
      quality: {
        status: "passed",
        score: 0.88,
        jsonValid: true,
        toolCallCount: 1,
      },
      latencyMs: 1_100,
      costUsd: 0.0002,
      failure: {
        status: "none",
        reasons: [],
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        toolAccuracy: 0.91,
        schemaSuccess: 0.95,
        confidence: 0.88,
        fallbackRate: 0,
      },
    },
  },
];

const largeTierWorkerComparisonRecords = (): Record<string, unknown>[] => [
  {
    id: "phase-28-large-worker-primary",
    scenarioId: "generic_question",
    role: "small_json",
    resolverRole: "repair",
    comparisonRole: "primary",
    primary: true,
    agentSlug: "current-large-worker",
    tier: "large",
    model: "current-large-worker-model",
    adapter: "openai-compatible",
    source: "cloud",
    healthStatus: "healthy",
    capabilities: ["json_schema"],
    resultStatus: "passed",
    selectedByPolicy: true,
    metrics: {
      quality: {
        status: "passed",
        score: 0.7,
        jsonValid: true,
        toolCallCount: 1,
      },
      latencyMs: 3_000,
      costUsd: 0.001,
      failure: {
        status: "none",
        reasons: [],
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        toolAccuracy: 0.86,
        schemaSuccess: 0.9,
        confidence: 0.7,
        fallbackRate: 0,
      },
    },
  },
  {
    id: "phase-28-large-worker-shadow",
    scenarioId: "generic_question",
    role: "small_json",
    resolverRole: "repair",
    comparisonRole: "shadow",
    primary: false,
    candidateRank: 1,
    agentSlug: "shadow-local-worker",
    tier: "small",
    model: "shadow-local-worker-model",
    adapter: "ollama-remote",
    source: "local",
    healthStatus: "healthy",
    capabilities: ["json_schema"],
    resultStatus: "passed",
    selectedByPolicy: false,
    metrics: {
      quality: {
        status: "passed",
        score: 0.92,
        jsonValid: true,
        toolCallCount: 1,
      },
      latencyMs: 800,
      costUsd: 0.0001,
      failure: {
        status: "none",
        reasons: [],
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        toolAccuracy: 0.95,
        schemaSuccess: 0.97,
        confidence: 0.92,
        fallbackRate: 0,
      },
    },
  },
];

const buildModelRouterRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  recordId: string;
  modelComparisonRecords: Record<string, unknown>[];
}): Promise<CodaliStorageDatasetRecord> => {
  const inputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "input",
    payload: {
      task: `Route product-neutral worker role for ${input.recordId}.`,
    },
  });
  const outputRef = await putRef(input.objectStore, {
    ownerId: input.recordId,
    part: "output",
    payload: {
      decision: "Keep current route unless shadow evidence clears policy gates.",
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
      score: 0.96,
      labels: ["human_reviewed", "accepted_correction", "high_confidence"],
      reviewed: true,
    },
    privacy: createGatewayDatasetLocalOnlyPrivacy({
      containsPersonalData: false,
      exportAllowed: true,
      trainingAllowed: false,
      policyTags: ["local_only", "phase_28"],
    }),
    metadata: {
      artifactType: "model_router",
      exampleType: "model_router_shadow_evidence",
      reviewDecision: "accepted",
      confidenceBucket: "high",
      taskHash: `${input.recordId}-task`,
      promptHash: `${input.recordId}-prompt`,
      expectedTargetHash: `${input.recordId}-target`,
      modelComparisonRecords: input.modelComparisonRecords,
    },
  };
};

const buildExportFixture = async (input: {
  directory: string;
  record: CodaliStorageDatasetRecord;
}) => {
  const objectDirectory = path.join(input.directory, "objects");
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: objectDirectory,
    now: fixedNow,
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: "model-router",
    records: [input.record],
    objectStore,
    scope: scope(),
    generatedBy: "phase-28-model-router-candidate-builder-test",
    now: fixedNow,
  });
  assert.ok(result.accepted);
  assert.ok(result.manifest);
  assert.ok(result.jsonlRef);
  const inspection = await new DatasetExportManifestReader().inspect({
    exportId: result.manifest.manifestId,
    directory: objectDirectory,
    allowedExampleArtifactTypes: ["model_router", "model-router", "router"],
  });
  return {
    objectDirectory,
    inspection,
  };
};

test("model-router smoke fixture powers documented proposal flow", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-28-smoke-fixture-"));
  try {
    const exportOutput = await captureLog(() =>
      DatasetCommand.run([
        "export",
        "JSONL",
        "smoke",
        "--kind",
        "model-router",
        "--directory",
        directory,
        "--output",
        "json",
      ]));
    const exportParsed = JSON.parse(exportOutput) as {
      result?: {
        accepted?: boolean;
        manifest?: {
          manifestId?: string;
          exportKind?: string;
          recordCount?: number;
        };
      };
    };
    assert.equal(exportParsed.result?.accepted, true);
    assert.equal(exportParsed.result?.manifest?.exportKind, "model-router");
    assert.equal(exportParsed.result?.manifest?.recordCount, 1);

    const proposalOutput = await captureLog(() =>
      runCli([
        "improve",
        "propose",
        "--artifact",
        "model-router",
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
          generationPolicy?: {
            productionRouterChangeAllowed?: boolean;
            preservesFinalSynthesisRoute?: boolean;
            uploadEnabled?: boolean;
          };
          routerPlan?: {
            action?: string;
            proposedRouteCount?: number;
            preservedRouteCount?: number;
            productionRouterChangeAllowed?: boolean;
          };
          expectedShape?: {
            scorecardFields?: string[];
          };
          routeCandidates?: Array<{
            resolverRole?: string;
            action?: string;
            status?: string;
            proposed?: {
              source?: string;
              adapter?: string;
            };
            scoreDelta?: number;
            blockedReasons?: string[];
            proposedScorecard?: {
              fallbackRate?: number;
              inference?: {
                averageTotalTokens?: number;
                averageQueueWaitMs?: number;
                averageThroughputTokensPerSecond?: number;
                localInferenceSampleCount?: number;
              };
            };
            rollbackPlan?: {
              reversible?: boolean;
            };
          }>;
          candidates?: Array<{
            sourceExportIds?: string[];
            status?: string;
          }>;
        };
      };
    };
    const proposal = proposalParsed.data?.proposal;
    assert.equal(proposal?.generationPolicy?.productionRouterChangeAllowed, false);
    assert.equal(proposal?.generationPolicy?.preservesFinalSynthesisRoute, true);
    assert.equal(proposal?.generationPolicy?.uploadEnabled, false);
    assert.equal(proposal?.routerPlan?.action, "propose_shadow_route");
    assert.equal(proposal?.routerPlan?.proposedRouteCount, 1);
    assert.equal(proposal?.routerPlan?.preservedRouteCount, 1);
    assert.equal(proposal?.routerPlan?.productionRouterChangeAllowed, false);
    assert.equal(proposal?.expectedShape?.scorecardFields?.includes("fallbackRate"), true);

    const proposedRoute = proposal?.routeCandidates?.find((route) =>
      route.resolverRole === "extractor");
    assert.equal(proposedRoute?.status, "proposed");
    assert.equal(proposedRoute?.action, "propose_shadow_route");
    assert.equal(proposedRoute?.proposed?.source, "local");
    assert.equal(proposedRoute?.proposed?.adapter, "ollama-remote");
    assert.equal((proposedRoute?.scoreDelta ?? 0) > 0.05, true);
    assert.equal(proposedRoute?.rollbackPlan?.reversible, true);
    assert.equal(proposedRoute?.proposedScorecard?.fallbackRate, 0);
    assert.equal(proposedRoute?.proposedScorecard?.inference?.averageTotalTokens, 880);
    assert.equal(proposedRoute?.proposedScorecard?.inference?.averageQueueWaitMs, 20);
    assert.equal(
      proposal?.routeCandidates?.some((route) =>
        route.action === "preserve_current" &&
        route.blockedReasons?.includes("final_synthesis_large_model_preserved")),
      true,
    );
    assert.deepEqual(
      proposal?.candidates?.[0]?.sourceExportIds,
      [exportParsed.result?.manifest?.manifestId],
    );
    assert.equal(proposal?.candidates?.[0]?.status, "proposed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ModelRouterCandidateBuilder returns no-change without shadow evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-28-no-shadow-"));
  try {
    const seedObjectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "seed-objects"),
      now: fixedNow,
    });
    const record = await buildModelRouterRecord({
      objectStore: seedObjectStore,
      recordId: "phase-28-primary-only",
      modelComparisonRecords: primaryOnlyComparisonRecords(),
    });
    const fixture = await buildExportFixture({ directory, record });

    const proposal = buildCodaliModelRouterCandidateBundle({
      inspection: fixture.inspection,
    });

    assert.equal(proposal.routerPlan.action, "no_change");
    assert.equal(proposal.routerPlan.proposedRouteCount, 0);
    assert.equal(proposal.routeCandidates[0]?.status, "blocked");
    assert.equal(
      proposal.routeCandidates[0]?.blockedReasons.includes("shadow_evidence_required"),
      true,
    );
    assert.equal(proposal.candidates[0]?.status, "no_change");
    assert.equal(proposal.generationPolicy.productionRouterChangeAllowed, false);
    assert.equal(proposal.generationPolicy.dryRunOnly, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ModelRouterCandidateBuilder optimizes non-final large-tier workers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase-28-large-worker-"));
  try {
    const seedObjectStore = createLocalJsonlGatewayDatasetObjectStore({
      directory: path.join(directory, "seed-objects"),
      now: fixedNow,
    });
    const record = await buildModelRouterRecord({
      objectStore: seedObjectStore,
      recordId: "phase-28-large-worker",
      modelComparisonRecords: largeTierWorkerComparisonRecords(),
    });
    const fixture = await buildExportFixture({ directory, record });

    const proposal = buildCodaliModelRouterCandidateBundle({
      inspection: fixture.inspection,
    });
    const route = proposal.routeCandidates[0];

    assert.equal(proposal.routerPlan.action, "propose_shadow_route");
    assert.equal(route?.resolverRole, "repair");
    assert.equal(route?.status, "proposed");
    assert.equal(route?.action, "propose_shadow_route");
    assert.equal(route?.current?.tier, "large");
    assert.equal(route?.proposed?.source, "local");
    assert.equal(route?.blockedReasons.includes("final_synthesis_large_model_preserved"), false);
    assert.equal((route?.scoreDelta ?? 0) > 0.05, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
