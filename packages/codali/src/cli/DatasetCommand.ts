import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CODALI_STORAGE_EXPORT_KINDS,
  type CodaliStorageDatasetRecord,
  type CodaliStorageExportKind,
  type CodaliStorageObjectPrivacyFlags,
  type CodaliStoragePrivacyMetadata,
  type CodaliStorageReviewDecision,
  type CodaliStorageReviewPromotionTarget,
} from "../storage/CodaliStorageContracts.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  createLocalJsonlGatewayDatasetObjectStore,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "../storage/GatewayDatasetStore.js";
import {
  CODALI_DATASET_SFT_EXPORT_KINDS,
  runCodaliDatasetExportJob,
} from "../storage/DatasetExportJob.js";
import {
  applyDatasetLabel,
  applyDatasetPromotionTarget,
  datasetRecordBusinessValue,
  datasetRecordConfidence,
  datasetRecordFailureCluster,
  datasetRecordIntegration,
  readLocalDatasetCollection,
  sampleDatasetRecordEntries,
  summarizeDatasetCollection,
  writeLocalDatasetCollection,
  type DatasetCollectionSummary,
  type DatasetRecordEntry,
  type DatasetSampleOptions,
} from "../storage/DatasetReviewQueue.js";
import {
  formatCodaliDatasetRunOperatorInspectionText,
  inspectCodaliDatasetRunForOperators,
} from "../improvement/OperatorInspector.js";
import {
  evaluateCodaliProductionGovernanceAction,
  resolveCodaliProductionGovernance,
  type CodaliProductionGovernanceState,
} from "../improvement/ProductionGovernance.js";

const DATASET_EXIT_CODES = {
  usage_error: 2,
  export_blocked: 3,
} as const;

type DatasetExitCode = (typeof DATASET_EXIT_CODES)[keyof typeof DATASET_EXIT_CODES];

type DatasetSubcommand = "inspect" | "review-queue" | "label" | "promote-target" | "export";

const DATASET_COMMANDS = new Set<DatasetSubcommand>([
  "inspect",
  "review-queue",
  "label",
  "promote-target",
  "export",
]);

const REVIEW_PROMOTION_TARGETS = new Set<CodaliStorageReviewPromotionTarget>([
  "gold",
  "silver",
  "reject",
]);

const REVIEW_DECISIONS = new Set<CodaliStorageReviewDecision>([
  "approved",
  "rejected",
  "needs_changes",
  "escalated",
]);

export class DatasetCommandError extends Error {
  readonly exitCode: DatasetExitCode;

  constructor(message: string, exitCode: DatasetExitCode) {
    super(message);
    this.name = "DatasetCommandError";
    this.exitCode = exitCode;
  }
}

export interface ParsedDatasetArgs extends DatasetSampleOptions {
  command?: DatasetSubcommand;
  dryRun: boolean;
  allTenants: boolean;
  output: "text" | "json";
  exportKind: CodaliStorageExportKind;
  format: "jsonl";
  directory?: string;
  smoke: boolean;
  help?: boolean;
  recordId?: string;
  labels: string[];
  reasons: string[];
  reviewerId?: string;
  promotionTarget?: CodaliStorageReviewPromotionTarget;
  decision?: CodaliStorageReviewDecision;
  productionGovernance: CodaliProductionGovernanceState;
  positionals: string[];
}

const HELP_TEXT =
  "Usage: codali dataset <inspect|review-queue|label|promote-target|export> [options]\n"
  + "\n"
  + "Commands:\n"
  + "  inspect          Inspect a local dataset collection or run for operator dashboards.\n"
  + "  review-queue     Print a deterministic tenant-scoped review queue.\n"
  + "  label            Add review labels to a local dataset record.\n"
  + "  promote-target   Mark a local dataset record as gold, silver, or reject.\n"
  + "  export           Run an explicit local-only dataset export job.\n"
  + "\n"
  + "Options:\n"
  + "  JSONL                  Select JSONL output format for smoke exports.\n"
  + "  smoke                  Generate a deterministic local smoke dataset for export.\n"
  + "  --dry-run              Count eligible rows and exclusion reasons without artifacts.\n"
  + "  --kind <kind>          Export kind (default: prompt-regression).\n"
  + "  --directory <path>     Local dataset directory (default: .codali/dataset).\n"
  + "  --seed <value>         Deterministic sampler seed.\n"
  + "  --limit <count>        Maximum sampled rows.\n"
  + "  --tenant <id>          Filter by tenant scope.\n"
  + "  --all-tenants          Allow review-queue to sample across tenants explicitly.\n"
  + "  --product <id>         Filter by product scope.\n"
  + "  --run, --run-id <id>   Filter by run scope; inspect emits run dashboard JSON.\n"
  + "  --failure-cluster <v>  Filter by failure cluster/status/error.\n"
  + "  --integration <v>      Filter by integration/tool/source/provider.\n"
  + "  --confidence <v>       Filter by confidence bucket or minimum score.\n"
  + "  --business-value <v>   Filter by business value bucket or minimum score.\n"
  + "  --record-id <id>       Record id for label/promote-target.\n"
  + "  --label <label>        Label to add; repeat or comma-separate.\n"
  + "  --target <target>      Promotion target: gold|silver|reject.\n"
  + "  --output <text|json>   Output mode (default: text).\n"
  + "  --help                 Show help.\n";

const expectValue = (argv: string[], index: number, flag: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new DatasetCommandError(
      `Missing value for ${flag}.`,
      DATASET_EXIT_CODES.usage_error,
    );
  }
  return value;
};

const parseExportKind = (value: string): CodaliStorageExportKind => {
  if ((CODALI_STORAGE_EXPORT_KINDS as readonly string[]).includes(value)) {
    return value as CodaliStorageExportKind;
  }
  throw new DatasetCommandError(
    `Invalid --kind value. Expected one of: ${CODALI_STORAGE_EXPORT_KINDS.join(", ")}.`,
    DATASET_EXIT_CODES.usage_error,
  );
};

const parsePromotionTarget = (value: string): CodaliStorageReviewPromotionTarget => {
  if (REVIEW_PROMOTION_TARGETS.has(value as CodaliStorageReviewPromotionTarget)) {
    return value as CodaliStorageReviewPromotionTarget;
  }
  throw new DatasetCommandError(
    "Invalid promotion target. Expected gold|silver|reject.",
    DATASET_EXIT_CODES.usage_error,
  );
};

const parseReviewDecision = (value: string): CodaliStorageReviewDecision => {
  if (REVIEW_DECISIONS.has(value as CodaliStorageReviewDecision)) {
    return value as CodaliStorageReviewDecision;
  }
  throw new DatasetCommandError(
    "Invalid review decision. Expected approved|rejected|needs_changes|escalated.",
    DATASET_EXIT_CODES.usage_error,
  );
};

const parseLimit = (value: string, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DatasetCommandError(
      `Invalid ${flag} value. Expected a positive integer.`,
      DATASET_EXIT_CODES.usage_error,
    );
  }
  return parsed;
};

const splitList = (value: string): string[] =>
  value.split(",").map((item) => item.trim()).filter(Boolean);

export const parseDatasetArgs = (argv: string[]): ParsedDatasetArgs => {
  const parsed: ParsedDatasetArgs = {
    dryRun: false,
    allTenants: false,
    output: "text",
    exportKind: "prompt-regression",
    format: "jsonl",
    smoke: false,
    labels: [],
    reasons: [],
    productionGovernance: resolveCodaliProductionGovernance(),
    positionals: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (index === 0 && DATASET_COMMANDS.has(arg as DatasetSubcommand)) {
      parsed.command = arg as DatasetSubcommand;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--all-tenants") {
      parsed.allTenants = true;
      continue;
    }
    if (arg === "--kind") {
      parsed.exportKind = parseExportKind(expectValue(argv, index, "--kind"));
      index += 1;
      continue;
    }
    if (arg === "--directory") {
      parsed.directory = expectValue(argv, index, "--directory");
      index += 1;
      continue;
    }
    if (arg === "--output") {
      const value = expectValue(argv, index, "--output").toLowerCase();
      if (value !== "text" && value !== "json") {
        throw new DatasetCommandError(
          "Invalid --output value. Expected text|json.",
          DATASET_EXIT_CODES.usage_error,
        );
      }
      parsed.output = value;
      index += 1;
      continue;
    }
    if (arg === "--seed") {
      parsed.seed = expectValue(argv, index, "--seed");
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      parsed.limit = parseLimit(expectValue(argv, index, "--limit"), "--limit");
      index += 1;
      continue;
    }
    if (arg === "--tenant" || arg === "--tenant-id") {
      parsed.tenantId = expectValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--product" || arg === "--product-id") {
      parsed.productId = expectValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--deployment" || arg === "--deployment-id") {
      parsed.deploymentId = expectValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--run" || arg === "--run-id") {
      parsed.runId = expectValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--failure-cluster") {
      parsed.failureCluster = expectValue(argv, index, "--failure-cluster");
      index += 1;
      continue;
    }
    if (arg === "--integration") {
      parsed.integration = expectValue(argv, index, "--integration");
      index += 1;
      continue;
    }
    if (arg === "--confidence") {
      parsed.confidence = expectValue(argv, index, "--confidence");
      index += 1;
      continue;
    }
    if (arg === "--business-value") {
      parsed.businessValue = expectValue(argv, index, "--business-value");
      index += 1;
      continue;
    }
    if (arg === "--record-id") {
      parsed.recordId = expectValue(argv, index, "--record-id");
      index += 1;
      continue;
    }
    if (arg === "--label" || arg === "--labels") {
      parsed.labels.push(...splitList(expectValue(argv, index, arg)));
      index += 1;
      continue;
    }
    if (arg === "--reason") {
      parsed.reasons.push(expectValue(argv, index, "--reason"));
      index += 1;
      continue;
    }
    if (arg === "--reviewer-id") {
      parsed.reviewerId = expectValue(argv, index, "--reviewer-id");
      index += 1;
      continue;
    }
    if (arg === "--target" || arg === "--promotion-target") {
      parsed.promotionTarget = parsePromotionTarget(expectValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--decision") {
      parsed.decision = parseReviewDecision(expectValue(argv, index, "--decision"));
      index += 1;
      continue;
    }
    if (arg?.toLowerCase() === "jsonl") {
      parsed.format = "jsonl";
      continue;
    }
    if (arg === "smoke") {
      parsed.smoke = true;
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new DatasetCommandError(
        `Unknown dataset option: ${arg}`,
        DATASET_EXIT_CODES.usage_error,
      );
    }
    parsed.positionals.push(arg);
  }

  if ((parsed.command === "label" || parsed.command === "promote-target") && !parsed.recordId) {
    parsed.recordId = parsed.positionals[0];
  }
  if (parsed.command === "label" && parsed.positionals.length > 1) {
    parsed.labels.push(...parsed.positionals.slice(1).flatMap(splitList));
  }
  if (parsed.command === "promote-target" && !parsed.promotionTarget && parsed.positionals[1]) {
    parsed.promotionTarget = parsePromotionTarget(parsed.positionals[1]);
  }
  if (parsed.allTenants && parsed.tenantId) {
    throw new DatasetCommandError(
      "Use either --tenant <id> or --all-tenants, not both.",
      DATASET_EXIT_CODES.usage_error,
    );
  }
  parsed.productionGovernance = resolveCodaliProductionGovernance();
  return parsed;
};

const fixedSmokeNow = () => new Date("2026-07-07T12:00:00.000Z");

const defaultDatasetDirectory = (): string =>
  path.join(process.cwd(), ".codali", "dataset");

const smokeScope = (): GatewayDatasetStorageScope => ({
  tenantId: "local",
  productId: "product-neutral",
  deploymentId: "smoke",
  runId: "dataset-export-smoke",
});

const isDocdexRetrievalSmokeExportKind = (
  exportKind: CodaliStorageExportKind,
): boolean => exportKind === "query-expander-sft" || exportKind === "rag-reranker";

const isModelRouterSmokeExportKind = (
  exportKind: CodaliStorageExportKind,
): boolean => exportKind === "model-router";

const putSmokeRef = (
  objectStore: GatewayDatasetObjectStore,
  input: {
    ownerId: string;
    part: string;
    payload: unknown;
    privacyFlags: CodaliStorageObjectPrivacyFlags;
  },
) =>
  objectStore.putObject({
    scope: smokeScope(),
    ownerType: "dataset_record",
    ownerId: input.ownerId,
    kind: input.part === "retrieval_evidence" ? "evidence" : "dataset",
    payload: input.payload,
    retentionClass: "dataset",
    privacyFlags: input.privacyFlags,
    metadata: {
      part: input.part,
      smoke: true,
    },
  });

const docdexRetrievalSmokeMetadata = (
  exportKind: CodaliStorageExportKind,
): Record<string, unknown> => ({
  artifactType: exportKind === "rag-reranker" ? "rag_reranker" : "query_expander",
  exampleType: "docdex_retrieval",
  smoke: true,
  reviewDecision: "accepted",
  confidenceBucket: "high",
  taskHash: "docdex-retrieval-smoke-task",
  promptHash: "docdex-retrieval-smoke-prompt",
  expectedTargetHash: "docdex-retrieval-smoke-target",
  retrieval: {
    query: "tenant-scoped retrieval freshness query",
    expandedQueries: [
      "fresh retrieval source policy",
      "duplicate retrieval evidence handling",
    ],
    selectedSources: [{
      sourceId: "tenant-scoped-repo/docs/retrieval-policy.md",
      sourceType: "repo_doc",
      freshness: "fresh",
    }],
    sourceTypes: ["repo_doc", "fresh"],
  },
  scorecard: {
    recallBefore: 0.45,
    recallAfter: 0.78,
    precisionBefore: 0.57,
    precisionAfter: 0.84,
    freshnessBefore: 0.39,
    freshnessAfter: 0.9,
  },
});

const modelRouterSmokeComparisonRecords = (): Record<string, unknown>[] => [
  {
    id: "model-router-smoke-extractor-primary",
    scenarioId: "generic_question",
    role: "small_json",
    resolverRole: "extractor",
    comparisonRole: "primary",
    primary: true,
    agentSlug: "current-extractor-worker",
    tier: "small",
    model: "current-extractor-model",
    adapter: "openai-compatible",
    source: "cloud",
    healthStatus: "healthy",
    capabilities: ["json_schema", "tool_calling"],
    resultStatus: "passed",
    selectedByPolicy: true,
    metrics: {
      quality: {
        status: "passed",
        score: 0.74,
        jsonValid: true,
        toolCallCount: 1,
      },
      latencyMs: 2_400,
      costUsd: 0.00018,
      tokenUse: {
        inputTokens: 950,
        outputTokens: 220,
        totalTokens: 1_170,
      },
      queue: {
        waitMs: 120,
        depth: 2,
        status: "ready",
      },
      throughput: {
        tokensPerSecond: 18,
        requestsPerMinute: 12,
      },
      failure: {
        status: "none",
        reasons: [],
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        toolAccuracy: 0.72,
        schemaSuccess: 0.9,
        confidence: 0.74,
        fallbackRate: 0.14,
      },
    },
  },
  {
    id: "model-router-smoke-extractor-shadow",
    scenarioId: "generic_question",
    role: "small_json",
    resolverRole: "extractor",
    comparisonRole: "shadow",
    primary: false,
    candidateRank: 1,
    agentSlug: "local-extractor-worker",
    tier: "small",
    model: "local-extractor-model",
    adapter: "ollama-remote",
    source: "local",
    healthStatus: "healthy",
    capabilities: ["json_schema", "structured_output", "tool_calling"],
    resultStatus: "passed",
    selectedByPolicy: false,
    metrics: {
      quality: {
        status: "passed",
        score: 0.93,
        jsonValid: true,
        toolCallCount: 1,
      },
      latencyMs: 900,
      costUsd: 0.00002,
      tokenUse: {
        inputTokens: 720,
        outputTokens: 160,
        totalTokens: 880,
      },
      queue: {
        waitMs: 20,
        depth: 0,
        status: "ready",
      },
      throughput: {
        tokensPerSecond: 44,
        requestsPerMinute: 22,
      },
      failure: {
        status: "none",
        reasons: [],
      },
      localInference: {
        backend: "local",
        quantized: true,
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        toolAccuracy: 0.97,
        schemaSuccess: 0.98,
        confidence: 0.92,
        fallbackRate: 0,
      },
    },
  },
  {
    id: "model-router-smoke-final-primary",
    scenarioId: "final_answer_large_model",
    role: "large_final",
    resolverRole: "final_synthesizer",
    comparisonRole: "primary",
    primary: true,
    agentSlug: "current-final-synthesizer",
    tier: "large",
    model: "current-final-model",
    adapter: "openai-compatible",
    source: "cloud",
    healthStatus: "healthy",
    capabilities: ["long_context"],
    resultStatus: "passed",
    selectedByPolicy: true,
    metrics: {
      quality: {
        status: "passed",
        score: 0.94,
        finalAnswerSucceeded: true,
      },
      latencyMs: 3_200,
      costUsd: 0.0009,
      tokenUse: {
        inputTokens: 3_000,
        outputTokens: 700,
        totalTokens: 3_700,
      },
      failure: {
        status: "none",
        reasons: [],
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        confidence: 0.94,
        fallbackRate: 0,
      },
    },
  },
  {
    id: "model-router-smoke-final-shadow",
    scenarioId: "final_answer_large_model",
    role: "large_final",
    resolverRole: "final_synthesizer",
    comparisonRole: "shadow",
    primary: false,
    candidateRank: 1,
    agentSlug: "shadow-final-synthesizer",
    tier: "large",
    model: "shadow-final-model",
    adapter: "openai-compatible",
    source: "cloud",
    healthStatus: "healthy",
    capabilities: ["long_context"],
    resultStatus: "passed",
    selectedByPolicy: false,
    metrics: {
      quality: {
        status: "passed",
        score: 0.96,
        finalAnswerSucceeded: true,
      },
      latencyMs: 2_800,
      costUsd: 0.0008,
      tokenUse: {
        inputTokens: 3_000,
        outputTokens: 650,
        totalTokens: 3_650,
      },
      failure: {
        status: "none",
        reasons: [],
      },
    },
    warnings: [],
    errors: [],
    metadata: {
      scorecard: {
        confidence: 0.95,
        fallbackRate: 0,
      },
    },
  },
];

const modelRouterSmokeMetadata = (): Record<string, unknown> => ({
  artifactType: "model_router",
  exampleType: "model_router_shadow_evidence",
  smoke: true,
  reviewDecision: "accepted",
  confidenceBucket: "high",
  taskHash: "model-router-smoke-task",
  promptHash: "model-router-smoke-prompt",
  expectedTargetHash: "model-router-smoke-target",
  modelComparisonRecords: modelRouterSmokeComparisonRecords(),
});

const fineTuneSmokeRoleForExportKind = (
  exportKind: CodaliStorageExportKind,
): string => exportKind.endsWith("-sft")
  ? exportKind.slice(0, -"-sft".length).replace(/-/g, "_")
  : exportKind.replace(/-/g, "_");

const fineTuneSmokeMetadata = (
  exportKind: CodaliStorageExportKind,
): Record<string, unknown> => {
  const role = fineTuneSmokeRoleForExportKind(exportKind);
  return {
    artifactType: `${role}_sft`,
    exampleType: "model_stage",
    smoke: true,
    role,
    reviewDecision: "accepted",
    confidenceBucket: "high",
    taskHash: `${role}-smoke-task`,
    promptHash: `${role}-smoke-prompt`,
    expectedTargetHash: `${role}-smoke-target`,
    scorecard: {
      accuracyBefore: 0.62,
      accuracyAfter: 0.81,
      passRateBefore: 0.58,
      passRateAfter: 0.86,
      latencyBefore: 1.2,
      latencyAfter: 1.1,
    },
  };
};

const buildSmokeRecord = async (input: {
  objectStore: GatewayDatasetObjectStore;
  exportKind: CodaliStorageExportKind;
  recordId?: string;
  qualityScore?: number;
}): Promise<CodaliStorageDatasetRecord> => {
  const trainingAllowed = CODALI_DATASET_SFT_EXPORT_KINDS.includes(
    input.exportKind as Extract<CodaliStorageExportKind, `${string}-sft`>,
  );
  const docdexRetrievalSmoke = isDocdexRetrievalSmokeExportKind(input.exportKind);
  const modelRouterSmoke = isModelRouterSmokeExportKind(input.exportKind);
  const privacy: CodaliStoragePrivacyMetadata = createGatewayDatasetLocalOnlyPrivacy({
    exportAllowed: true,
    trainingAllowed,
    containsPersonalData: false,
    policyTags: docdexRetrievalSmoke || modelRouterSmoke
      ? ["local_only", "smoke", "tenant_scoped"]
      : ["local_only", "smoke"],
    metadata: {
      source: "dataset_export_smoke",
    },
  });
  const privacyFlags = createGatewayDatasetLocalOnlyObjectPrivacyFlags({
    containsTenantPrivateData: docdexRetrievalSmoke || modelRouterSmoke,
    containsCustomerData: false,
    exportAllowed: true,
    trainingAllowed,
  });
  const evidencePrivacyFlags = createGatewayDatasetLocalOnlyObjectPrivacyFlags({
    containsTenantPrivateData: docdexRetrievalSmoke || modelRouterSmoke,
    containsCustomerData: false,
    containsSourceCode: docdexRetrievalSmoke,
    exportAllowed: true,
    trainingAllowed,
  });
  const recordId = input.recordId ?? "dataset-export-smoke-record";
  const inputRef = await putSmokeRef(input.objectStore, {
    ownerId: recordId,
    part: "smoke_input",
    privacyFlags,
    payload: docdexRetrievalSmoke
      ? {
          query: "tenant-scoped retrieval freshness query",
        }
      : modelRouterSmoke
        ? {
            task: "Choose a product-neutral constrained worker route.",
          }
      : {
          prompt: "Summarize the local-only dataset export policy.",
          context: ["local storage", "explicit export"],
        },
  });
  const outputRef = await putSmokeRef(input.objectStore, {
    ownerId: recordId,
    part: "smoke_output",
    privacyFlags,
    payload: docdexRetrievalSmoke
      ? {
          expandedQueries: [
            "fresh retrieval source policy",
            "duplicate retrieval evidence handling",
          ],
        }
      : modelRouterSmoke
        ? {
            decision: "Shadow route is eligible for dry-run proposal only.",
          }
      : {
          answer: "Exports are explicit, local-only, and manifest-backed.",
        },
  });
  const evidenceRefs = docdexRetrievalSmoke
    ? [await putSmokeRef(input.objectStore, {
        ownerId: recordId,
        part: "retrieval_evidence",
        privacyFlags: evidencePrivacyFlags,
        payload: {
          selectedSource: "tenant-scoped-repo/docs/retrieval-policy.md",
          freshness: "fresh",
        },
      })]
    : undefined;
  return {
    schemaVersion: "codali.storage.v1",
    recordType: "dataset_record",
    recordId,
    datasetKind: trainingAllowed ? "model_call" : "gateway_answer",
    createdAt: fixedSmokeNow().toISOString(),
    sourceGatewayRecordId: "gateway-export-smoke",
    inputRef,
    outputRef,
    ...(evidenceRefs ? { evidenceRefs } : {}),
    quality: {
      score: input.qualityScore ?? (docdexRetrievalSmoke ? 0.97 : 0.91),
      labels: docdexRetrievalSmoke
        ? ["smoke", input.exportKind, "human_reviewed", "accepted_correction", "high_confidence"]
        : ["smoke", input.exportKind],
      reviewed: true,
    },
    privacy,
    metadata: {
      ...(docdexRetrievalSmoke
        ? docdexRetrievalSmokeMetadata(input.exportKind)
        : modelRouterSmoke
          ? modelRouterSmokeMetadata()
        : trainingAllowed
          ? fineTuneSmokeMetadata(input.exportKind)
        : {
            artifactType: input.exportKind === "eval-replay" ? "eval" : input.exportKind,
            exampleType: trainingAllowed ? "model_stage" : "final_answer",
            smoke: true,
          }),
    },
  };
};

const buildSmokeRecords = async (input: {
  objectStore: GatewayDatasetObjectStore;
  exportKind: CodaliStorageExportKind;
}): Promise<CodaliStorageDatasetRecord[]> => {
  if (!isDocdexRetrievalSmokeExportKind(input.exportKind)) {
    return [await buildSmokeRecord(input)];
  }
  return [
    await buildSmokeRecord({
      ...input,
      recordId: "dataset-export-docdex-retrieval-smoke-record",
      qualityScore: 0.97,
    }),
    await buildSmokeRecord({
      ...input,
      recordId: "dataset-export-docdex-retrieval-smoke-duplicate",
      qualityScore: 0.91,
    }),
  ];
};

const formatCounts = (counts: Record<string, number>): string => {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([key, count]) => `${key}=${count}`).join(",") : "none";
};

const formatExportText = (input: {
  directory: string;
  result: Awaited<ReturnType<typeof runCodaliDatasetExportJob>>;
  smoke?: boolean;
  collectionTotal?: number;
  selectedCount?: number;
}): string => {
  const lines = [
    `dataset export${input.smoke ? " smoke" : ""}: ${input.result.status}`,
    `kind: ${input.result.exportKind}`,
    `format: ${input.result.exportFormat}`,
  ];
  if (input.collectionTotal !== undefined || input.selectedCount !== undefined) {
    lines.push(
      `collection_records: total=${input.collectionTotal ?? input.result.dryRun.totalCount} selected=${input.selectedCount ?? input.result.dryRun.totalCount}`,
    );
  }
  lines.push(
    `records: total=${input.result.dryRun.totalCount} eligible=${input.result.dryRun.eligibleCount} excluded=${input.result.dryRun.excludedCount}`,
    `directory: ${input.directory}`,
    `exclusion_reasons: ${formatCounts(input.result.dryRun.exclusionReasonCounts)}`,
  );
  if (input.result.jsonlRef?.uri) lines.push(`jsonl: ${input.result.jsonlRef.uri}`);
  if (input.result.replayFixtureRef?.uri) lines.push(`replay_fixture: ${input.result.replayFixtureRef.uri}`);
  if (input.result.manifestRef?.uri) lines.push(`manifest: ${input.result.manifestRef.uri}`);
  return lines.join("\n");
};

const formatInspectText = (summary: DatasetCollectionSummary): string => [
  "dataset inspect",
  `directory: ${summary.directory}`,
  `records_file: ${summary.recordsPath}`,
  `batches: ${summary.batchCount}`,
  `records: rows=${summary.totalRecordRows} unique=${summary.uniqueRecordCount} invalid_lines=${summary.invalidLineCount} invalid_records=${summary.invalidRecordCount}`,
  `review: reviewed=${summary.reviewedCount} unreviewed=${summary.unreviewedCount}`,
  `privacy: export_allowed=${summary.exportAllowedCount} training_allowed=${summary.trainingAllowedCount}`,
  `tenants: ${formatCounts(summary.byTenant)}`,
  `products: ${formatCounts(summary.byProduct)}`,
  `dataset_kinds: ${formatCounts(summary.byDatasetKind)}`,
  `example_types: ${formatCounts(summary.byExampleType)}`,
  `failure_clusters: ${formatCounts(summary.byFailureCluster)}`,
  `integrations: ${formatCounts(summary.byIntegration)}`,
  `confidence: ${formatCounts(summary.byConfidence)}`,
  `business_value: ${formatCounts(summary.byBusinessValue)}`,
].join("\n");

const formatRecordLine = (entry: DatasetRecordEntry): string => [
  entry.record.recordId,
  `tenant=${entry.scope.tenantId}`,
  `product=${entry.scope.productId}`,
  `kind=${entry.record.datasetKind}`,
  `score=${entry.record.quality?.score ?? "unknown"}`,
  `reviewed=${entry.record.quality?.reviewed === true ? "true" : "false"}`,
  `failure_cluster=${datasetRecordFailureCluster(entry.record)}`,
  `integration=${datasetRecordIntegration(entry.record)}`,
  `confidence=${datasetRecordConfidence(entry.record)}`,
  `business_value=${datasetRecordBusinessValue(entry.record)}`,
  `labels=${entry.record.quality?.labels?.join(",") ?? "none"}`,
].join("\t");

const formatReviewQueueText = (input: {
  directory: string;
  entries: DatasetRecordEntry[];
  parsed: ParsedDatasetArgs;
}): string => [
  "dataset review-queue",
  `directory: ${input.directory}`,
  `seed: ${input.parsed.seed ?? "review-queue"}`,
  `selected: ${input.entries.length}`,
  ...input.entries.map(formatRecordLine),
].join("\n");

const sampleOptionsFromParsed = (
  parsed: ParsedDatasetArgs,
  overrides: Partial<DatasetSampleOptions> = {},
): DatasetSampleOptions => ({
  seed: parsed.seed,
  limit: parsed.limit,
  tenantId: parsed.tenantId,
  productId: parsed.productId,
  deploymentId: parsed.deploymentId,
  runId: parsed.runId,
  failureCluster: parsed.failureCluster,
  integration: parsed.integration,
  confidence: parsed.confidence,
  businessValue: parsed.businessValue,
  ...overrides,
});

const exportScope = (
  entries: readonly DatasetRecordEntry[],
  parsed: ParsedDatasetArgs,
): GatewayDatasetStorageScope => {
  const first = entries[0]?.scope;
  return {
    tenantId: parsed.tenantId ?? first?.tenantId ?? "local",
    productId: parsed.productId ?? first?.productId ?? "product-neutral",
    deploymentId: parsed.deploymentId ?? first?.deploymentId ?? "local",
    runId: parsed.runId ?? first?.runId ?? "dataset-export",
  };
};

const assertSingleScopeForWriteExport = (entries: readonly DatasetRecordEntry[]): void => {
  const scopes = new Set(entries.map((entry) =>
    `${entry.scope.tenantId}:${entry.scope.productId}:${entry.scope.deploymentId}`));
  if (scopes.size > 1) {
    throw new DatasetCommandError(
      "Non-dry-run dataset export requires a single tenant/product/deployment scope.",
      DATASET_EXIT_CODES.export_blocked,
    );
  }
};

const assertProductionGovernanceAllowsDatasetExport = (
  parsed: ParsedDatasetArgs,
): void => {
  const decision = evaluateCodaliProductionGovernanceAction(
    parsed.productionGovernance,
    "dataset_export",
  );
  if (!decision.allowed) {
    throw new DatasetCommandError(
      `Dataset export disabled by production governance: ${decision.reasons.join(", ")}.`,
      DATASET_EXIT_CODES.export_blocked,
    );
  }
};

const runSmokeExport = async (parsed: ParsedDatasetArgs): Promise<void> => {
  assertProductionGovernanceAllowsDatasetExport(parsed);
  const directory = parsed.directory ??
    await mkdtemp(path.join(os.tmpdir(), "codali-dataset-export-"));
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: path.join(directory, "objects"),
    now: fixedSmokeNow,
  });
  const records = await buildSmokeRecords({
    objectStore,
    exportKind: parsed.exportKind,
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: parsed.exportKind,
    records,
    objectStore,
    scope: smokeScope(),
    dryRun: parsed.dryRun,
    generatedBy: "dataset export smoke",
    now: fixedSmokeNow,
    metadata: {
      smoke: true,
    },
  });
  if (!result.accepted && !parsed.dryRun) {
    throw new DatasetCommandError(
      `Dataset export blocked: ${result.exclusionReasons.map((reason) => reason.code).join(", ")}`,
      DATASET_EXIT_CODES.export_blocked,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify({
        directory,
        result,
        productionGovernance: parsed.productionGovernance,
      }, null, 2)
      : formatExportText({ directory, result, smoke: true }),
  );
};

const runDatasetExport = async (parsed: ParsedDatasetArgs): Promise<void> => {
  assertProductionGovernanceAllowsDatasetExport(parsed);
  if (parsed.smoke) {
    await runSmokeExport(parsed);
    return;
  }
  const directory = parsed.directory ?? defaultDatasetDirectory();
  const collection = await readLocalDatasetCollection({ directory });
  const summary = summarizeDatasetCollection(collection);
  const entries = sampleDatasetRecordEntries(collection, sampleOptionsFromParsed(parsed));
  if (!parsed.dryRun) assertSingleScopeForWriteExport(entries);
  const objectStore = createLocalJsonlGatewayDatasetObjectStore({
    directory: path.join(directory, "exports", "objects"),
  });
  const result = await runCodaliDatasetExportJob({
    exportKind: parsed.exportKind,
    records: entries.map((entry) => entry.record),
    objectStore,
    scope: exportScope(entries, parsed),
    dryRun: parsed.dryRun,
    generatedBy: "dataset export",
    metadata: {
      explicitExport: true,
      sampler: sampleOptionsFromParsed(parsed),
      sourceDirectory: directory,
    },
  });
  if (!result.accepted && !parsed.dryRun) {
    throw new DatasetCommandError(
      `Dataset export blocked: ${result.exclusionReasons.map((reason) => reason.code).join(", ")}`,
      DATASET_EXIT_CODES.export_blocked,
    );
  }
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify({
        directory,
        summary,
        selectedRecordIds: entries.map((entry) => entry.record.recordId),
        result,
        productionGovernance: parsed.productionGovernance,
      }, null, 2)
      : formatExportText({
          directory,
          result,
          collectionTotal: summary.uniqueRecordCount,
          selectedCount: entries.length,
        }),
  );
};

const runInspect = async (parsed: ParsedDatasetArgs): Promise<void> => {
  const directory = parsed.directory ?? defaultDatasetDirectory();
  if (parsed.runId || parsed.output === "json") {
    const inspection = await inspectCodaliDatasetRunForOperators({
      directory,
      ...(parsed.runId ? { runId: parsed.runId } : {}),
    });
    // eslint-disable-next-line no-console
    console.log(
      parsed.output === "json"
        ? JSON.stringify(inspection, null, 2)
        : formatCodaliDatasetRunOperatorInspectionText(inspection),
    );
    return;
  }
  const collection = await readLocalDatasetCollection({ directory });
  const summary = summarizeDatasetCollection(collection);
  // eslint-disable-next-line no-console
  console.log(formatInspectText(summary));
};

const runReviewQueue = async (parsed: ParsedDatasetArgs): Promise<void> => {
  if (!parsed.tenantId && !parsed.allTenants) {
    throw new DatasetCommandError(
      "dataset review-queue requires --tenant <id> or explicit --all-tenants.",
      DATASET_EXIT_CODES.usage_error,
    );
  }
  const directory = parsed.directory ?? defaultDatasetDirectory();
  const collection = await readLocalDatasetCollection({ directory });
  const entries = sampleDatasetRecordEntries(collection, sampleOptionsFromParsed(parsed, {
    seed: parsed.seed ?? "review-queue",
    unreviewedOnly: true,
  }));
  // eslint-disable-next-line no-console
  console.log(
    parsed.output === "json"
      ? JSON.stringify({ directory, seed: parsed.seed ?? "review-queue", records: entries }, null, 2)
      : formatReviewQueueText({ directory, entries, parsed: { ...parsed, seed: parsed.seed ?? "review-queue" } }),
  );
};

const runLabel = async (parsed: ParsedDatasetArgs): Promise<void> => {
  if (!parsed.recordId) {
    throw new DatasetCommandError("dataset label requires --record-id or a record id argument.", DATASET_EXIT_CODES.usage_error);
  }
  if (parsed.labels.length === 0) {
    throw new DatasetCommandError("dataset label requires at least one --label.", DATASET_EXIT_CODES.usage_error);
  }
  const directory = parsed.directory ?? defaultDatasetDirectory();
  const collection = await readLocalDatasetCollection({ directory });
  const result = applyDatasetLabel(collection, {
    ...sampleOptionsFromParsed(parsed),
    recordId: parsed.recordId,
    labels: parsed.labels,
    reviewerId: parsed.reviewerId,
    reason: parsed.reasons[0],
  });
  await writeLocalDatasetCollection(collection);
  // eslint-disable-next-line no-console
  console.log(parsed.output === "json" ? JSON.stringify(result, null, 2) : `dataset label: updated=${result.updatedCount} records=${result.recordIds.join(",")}`);
};

const runPromoteTarget = async (parsed: ParsedDatasetArgs): Promise<void> => {
  if (!parsed.recordId) {
    throw new DatasetCommandError("dataset promote-target requires --record-id or a record id argument.", DATASET_EXIT_CODES.usage_error);
  }
  if (!parsed.promotionTarget) {
    throw new DatasetCommandError("dataset promote-target requires --target gold|silver|reject.", DATASET_EXIT_CODES.usage_error);
  }
  const directory = parsed.directory ?? defaultDatasetDirectory();
  const collection = await readLocalDatasetCollection({ directory });
  const result = applyDatasetPromotionTarget(collection, {
    ...sampleOptionsFromParsed(parsed),
    recordId: parsed.recordId,
    promotionTarget: parsed.promotionTarget,
    decision: parsed.decision,
    labels: parsed.labels.length ? parsed.labels : undefined,
    reasons: parsed.reasons.length ? parsed.reasons : undefined,
    reviewerId: parsed.reviewerId,
  });
  await writeLocalDatasetCollection(collection);
  // eslint-disable-next-line no-console
  console.log(parsed.output === "json" ? JSON.stringify(result, null, 2) : `dataset promote-target: updated=${result.updatedCount} records=${result.recordIds.join(",")}`);
};

export class DatasetCommand {
  static async run(argv: string[]): Promise<void> {
    const parsed = parseDatasetArgs(argv);
    if (parsed.help) {
      // eslint-disable-next-line no-console
      console.log(HELP_TEXT);
      return;
    }
    switch (parsed.command) {
      case "inspect":
        await runInspect(parsed);
        return;
      case "review-queue":
        await runReviewQueue(parsed);
        return;
      case "label":
        await runLabel(parsed);
        return;
      case "promote-target":
        await runPromoteTarget(parsed);
        return;
      case "export":
        await runDatasetExport(parsed);
        return;
      default:
        throw new DatasetCommandError(HELP_TEXT, DATASET_EXIT_CODES.usage_error);
    }
  }
}
