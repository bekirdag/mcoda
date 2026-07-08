import { createHash } from "node:crypto";
import type {
  CodaliGatewayModelComparisonRecord,
} from "../eval/CodaliGatewayLiveHarness.js";
import type {
  CodaliStorageExportKind,
  CodaliStorageObjectPrivacyFlags,
  CodaliStorageObjectRef,
} from "../storage/CodaliStorageContracts.js";
import type {
  DatasetEligibilityGateAcceptedExample,
} from "./DatasetEligibilityGate.js";
import type { DatasetExportManifestReaderResult } from "./DatasetExportManifestReader.js";

export const CODALI_MODEL_ROUTER_CANDIDATE_SCHEMA_VERSION =
  "codali.improvement.model_router_candidate.v1" as const;

export const CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT = "model-router" as const;

export const CODALI_MODEL_ROUTER_SOURCE_ARTIFACT_TYPES = [
  "model_router",
  "model-router",
  "router",
  "tool_router",
  "tool-router",
] as const;

export const CODALI_MODEL_ROUTER_SUPPORTED_EXPORT_KINDS = [
  "model-router",
] as const satisfies readonly CodaliStorageExportKind[];

export type CodaliModelRouterProposalArtifact =
  typeof CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT;

export type CodaliModelRouterCandidateKind = "model_router";

export type CodaliModelRouterPlanAction =
  | "propose_shadow_route"
  | "no_change";

export interface CodaliModelRouterObjectRefSummary {
  refId: string;
  kind: string;
  contentHash: string;
  byteSize: number;
  mimeType: string;
  deletionGroupId: string;
  privacyFlags: CodaliStorageObjectPrivacyFlags;
  uri?: string;
  mediaType?: string;
  metadataKeys: string[];
}

export interface CodaliModelRouterSourceExample {
  recordId: string;
  sourceGatewayRecordId?: string;
  artifactTypes: string[];
  preferenceSignals: DatasetEligibilityGateAcceptedExample["preferenceSignals"];
  priorityScore: number;
  comparisonRecordCount: number;
  shadowRecordCount: number;
  objectRefs: {
    inputRef?: CodaliModelRouterObjectRefSummary;
    outputRef?: CodaliModelRouterObjectRefSummary;
    evidenceRefs: CodaliModelRouterObjectRefSummary[];
  };
  metadataShape: {
    keys: string[];
    comparisonKeys: string[];
  };
}

export interface CodaliModelRouterCandidateIdentity {
  identityKey: string;
  comparisonRole: "primary" | "shadow" | "mixed";
  agentSlug?: string;
  tier?: string;
  model?: string;
  adapter?: string;
  source?: string;
  healthStatus?: string;
  capabilities: string[];
}

export interface CodaliModelRouterInferenceMetricSummary {
  averageInputTokens?: number;
  averageOutputTokens?: number;
  averageTotalTokens?: number;
  averageQueueWaitMs?: number;
  averageQueueDepth?: number;
  averageThroughputTokensPerSecond?: number;
  averageRequestsPerMinute?: number;
  localInferenceSampleCount: number;
}

export interface CodaliModelRouterMetricScorecard {
  quality: number;
  toolAccuracy: number;
  schemaSuccess: number;
  latency: number;
  cost: number;
  availability: number;
  confidence: number;
  fallbackReliability: number;
  finalScore: number;
  sampleCount: number;
  shadowSampleCount: number;
  selectedByPolicyCount: number;
  averageLatencyMs?: number;
  averageCostUsd?: number;
  inference: CodaliModelRouterInferenceMetricSummary;
  failureRate: number;
  fallbackRate: number;
}

export interface CodaliModelRouterRouteCandidate {
  routeId: string;
  role: string;
  resolverRole: string;
  action: "propose_shadow_route" | "preserve_current" | "no_change";
  status: "proposed" | "blocked" | "no_change";
  current?: CodaliModelRouterCandidateIdentity;
  proposed?: CodaliModelRouterCandidateIdentity;
  scoreDelta?: number;
  primaryScorecard?: CodaliModelRouterMetricScorecard;
  proposedScorecard?: CodaliModelRouterMetricScorecard;
  blockedReasons: string[];
  evidence: {
    sourceRecordIds: string[];
    sourceGatewayRecordIds: string[];
    comparisonRecordIds: string[];
    primarySampleCount: number;
    shadowSampleCount: number;
    scorecardSampleCount: number;
    shadowEvidenceRequired: true;
    shadowEvidencePresent: boolean;
  };
  rollbackPlan: {
    reversible: true;
    restoreIdentity?: CodaliModelRouterCandidateIdentity;
    removeCandidateIdentity?: CodaliModelRouterCandidateIdentity;
    steps: string[];
  };
}

export interface CodaliModelRouterPlan {
  planId: string;
  action: CodaliModelRouterPlanAction;
  status: "proposed" | "blocked";
  reasons: string[];
  routeCount: number;
  proposedRouteCount: number;
  preservedRouteCount: number;
  noChangeRouteCount: number;
  reversible: true;
  requiresShadowEvidence: true;
  productionRouterChangeAllowed: false;
}

export interface CodaliModelRouterImprovementCandidateSummary {
  candidateId: string;
  candidateKind: CodaliModelRouterCandidateKind;
  status: "proposed" | "blocked" | "no_change";
  sourceExportIds: string[];
  sourceRecordIds: string[];
  artifactIds: string[];
  exampleCount: number;
  objectBytes: number;
  routeCount: number;
  proposedRouteCount: number;
  blockedReasons: string[];
}

export interface CodaliModelRouterCandidateBundle {
  schemaVersion: typeof CODALI_MODEL_ROUTER_CANDIDATE_SCHEMA_VERSION;
  artifact: CodaliModelRouterProposalArtifact;
  source: {
    exportId: string;
    manifestId: string;
    manifestPath: string;
    exportKind: CodaliStorageExportKind;
    checksum: string;
    recordCount: number;
    primaryArtifactRef?: CodaliModelRouterObjectRefSummary;
  };
  generationPolicy: {
    deterministic: true;
    dryRunOnly: true;
    modifiesRuntimePrompts: false;
    modifiesRuntimeCode: false;
    modifiesRuntimeRouter: false;
    productionRouterChangeAllowed: false;
    requiresShadowEvidence: true;
    reversible: true;
    uploadEnabled: false;
    preservesFinalSynthesisRoute: true;
    finalSynthesizerFineTuning: false;
  };
  expectedShape: {
    schemaVersion: typeof CODALI_MODEL_ROUTER_CANDIDATE_SCHEMA_VERSION;
    artifact: CodaliModelRouterProposalArtifact;
    requiredFields: string[];
    routeCandidateRequiredFields: string[];
    scorecardFields: string[];
  };
  sourceExamples: CodaliModelRouterSourceExample[];
  evidenceSummary: {
    comparisonRecordCount: number;
    primaryRecordCount: number;
    shadowRecordCount: number;
    roleCount: number;
    roles: string[];
    metricInputs: Array<
      | "quality"
      | "tool_accuracy"
      | "schema_success"
      | "latency"
      | "cost"
      | "availability"
      | "confidence"
      | "fallback_rate"
    >;
  };
  routerPlan: CodaliModelRouterPlan;
  routeCandidates: CodaliModelRouterRouteCandidate[];
  candidates: CodaliModelRouterImprovementCandidateSummary[];
}

export interface BuildCodaliModelRouterCandidateBundleInput {
  inspection: DatasetExportManifestReaderResult;
  artifact?: CodaliModelRouterProposalArtifact;
}

interface AcceptedRow {
  row: Record<string, unknown>;
  accepted: DatasetEligibilityGateAcceptedExample;
}

interface EvidenceRecord {
  rowRecordId: string;
  sourceGatewayRecordId?: string;
  record: CodaliGatewayModelComparisonRecord;
}

interface Aggregate {
  routeKey: string;
  role: string;
  resolverRole: string;
  identity: CodaliModelRouterCandidateIdentity;
  records: EvidenceRecord[];
  scorecard: CodaliModelRouterMetricScorecard;
}

const SCORE_DELTA_THRESHOLD = 0.05;
const LOCAL_PREFERENCE_SCORE_DELTA_THRESHOLD = 0.03;
const MIN_SHADOW_CONFIDENCE = 0.7;
const MIN_SHADOW_SCHEMA_SUCCESS = 0.85;
const MIN_SHADOW_AVAILABILITY = 0.7;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};

const sha256Hex = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

const stableId = (prefix: string, value: unknown): string =>
  `${prefix}-${sha256Hex(value).slice(0, 16)}`;

const normalizeToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s-]+/g, "_");

const uniqueSorted = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))))
    .sort();

const clamp01 = (value: number | undefined, fallback = 0): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
};

const readString = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const readBoolean = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
};

const readNumber = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
};

const stringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return uniqueSorted(value.map((entry) =>
      typeof entry === "string" ? entry : undefined));
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
};

const recordList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const numberObject = (
  entries: Array<[string, number | undefined]>,
): Record<string, number> | undefined => {
  const result: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (value !== undefined && Number.isFinite(value)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
};

const nestedRecord = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  for (const key of keys) {
    const value = record?.[key];
    if (isRecord(value)) return value;
  }
  return undefined;
};

const nestedRecords = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown>[] => {
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
};

const objectRefSummary = (
  ref: CodaliStorageObjectRef | undefined,
): CodaliModelRouterObjectRefSummary | undefined => {
  if (!ref) return undefined;
  return {
    refId: ref.refId,
    kind: ref.kind,
    contentHash: ref.contentHash,
    byteSize: ref.byteSize,
    mimeType: ref.mimeType,
    deletionGroupId: ref.deletionGroupId,
    privacyFlags: ref.privacyFlags,
    ...(ref.uri ? { uri: ref.uri } : {}),
    ...(ref.mediaType ? { mediaType: ref.mediaType } : {}),
    metadataKeys: isRecord(ref.metadata) ? Object.keys(ref.metadata).sort() : [],
  };
};

const metadataForRow = (row: Record<string, unknown>): Record<string, unknown> =>
  isRecord(row.metadata) ? row.metadata : {};

const comparisonRecordLooksValid = (value: Record<string, unknown>): boolean =>
  isRecord(value.metrics) &&
  Boolean(readString(value, ["role"]) || readString(value, ["resolverRole", "resolver_role"]));

const normalizeComparisonRole = (
  value: string | undefined,
  primary: boolean | undefined,
): "primary" | "shadow" => {
  const normalized = normalizeToken(value ?? "");
  if (normalized === "shadow") return "shadow";
  if (normalized === "primary") return "primary";
  return primary === false ? "shadow" : "primary";
};

const normalizeScenarioStatus = (
  value: string | undefined,
): CodaliGatewayModelComparisonRecord["resultStatus"] => {
  const normalized = normalizeToken(value ?? "");
  if (
    normalized === "passed" ||
    normalized === "failed" ||
    normalized === "degraded" ||
    normalized === "skipped"
  ) {
    return normalized;
  }
  return "skipped";
};

const normalizeComparisonRecord = (
  raw: Record<string, unknown>,
): CodaliGatewayModelComparisonRecord => {
  const rawMetrics = isRecord(raw.metrics) ? raw.metrics : {};
  const rawQuality = isRecord(rawMetrics.quality) ? rawMetrics.quality : {};
  const rawFailure = isRecord(rawMetrics.failure) ? rawMetrics.failure : {};
  const rawTokenUse = nestedRecord(rawMetrics, ["tokenUse", "token_use"]);
  const rawQueue = nestedRecord(rawMetrics, ["queue"]);
  const rawThroughput = nestedRecord(rawMetrics, ["throughput"]);
  const queueStatus = rawQueue ? readString(rawQueue, ["status"]) : undefined;
  const tokenUse = rawTokenUse
    ? numberObject([
        ["inputTokens", readNumber(rawTokenUse, ["inputTokens", "input_tokens"])],
        ["outputTokens", readNumber(rawTokenUse, ["outputTokens", "output_tokens"])],
        ["totalTokens", readNumber(rawTokenUse, ["totalTokens", "total_tokens"])],
      ]) as CodaliGatewayModelComparisonRecord["metrics"]["tokenUse"] | undefined
    : undefined;
  const queue = rawQueue
    ? {
        ...numberObject([
          ["waitMs", readNumber(rawQueue, ["waitMs", "wait_ms"])],
          ["depth", readNumber(rawQueue, ["depth"])],
        ]),
        ...(queueStatus ? { status: queueStatus } : {}),
      } as CodaliGatewayModelComparisonRecord["metrics"]["queue"]
    : undefined;
  const throughput = rawThroughput
    ? numberObject([
        [
          "tokensPerSecond",
          readNumber(rawThroughput, ["tokensPerSecond", "tokens_per_second"]),
        ],
        [
          "requestsPerMinute",
          readNumber(rawThroughput, ["requestsPerMinute", "requests_per_minute"]),
        ],
      ]) as CodaliGatewayModelComparisonRecord["metrics"]["throughput"] | undefined
    : undefined;
  const comparisonRole = normalizeComparisonRole(
    readString(raw, ["comparisonRole", "comparison_role"]),
    readBoolean(raw, ["primary"]),
  );
  const role = readString(raw, ["role"]) ?? "small_json";
  const resolverRole = readString(raw, ["resolverRole", "resolver_role"]) ?? role;
  const qualityStatus = normalizeScenarioStatus(
    readString(rawQuality, ["status"]) ?? readString(raw, ["resultStatus", "result_status"]),
  );
  return {
    id: readString(raw, ["id"]) ?? stableId("comparison", raw),
    scenarioId: (
      readString(raw, ["scenarioId", "scenario_id"]) ?? "generic_question"
    ) as CodaliGatewayModelComparisonRecord["scenarioId"],
    role: role as CodaliGatewayModelComparisonRecord["role"],
    resolverRole,
    comparisonRole,
    primary: readBoolean(raw, ["primary"]) ?? comparisonRole === "primary",
    ...(readNumber(raw, ["candidateRank", "candidate_rank"]) !== undefined
      ? { candidateRank: readNumber(raw, ["candidateRank", "candidate_rank"]) }
      : {}),
    ...(readString(raw, ["agentSlug", "agent_slug", "slug"])
      ? { agentSlug: readString(raw, ["agentSlug", "agent_slug", "slug"]) }
      : {}),
    ...(readString(raw, ["tier"])
      ? { tier: readString(raw, ["tier"]) as CodaliGatewayModelComparisonRecord["tier"] }
      : {}),
    ...(readString(raw, ["model"]) ? { model: readString(raw, ["model"]) } : {}),
    ...(readString(raw, ["adapter"]) ? { adapter: readString(raw, ["adapter"]) } : {}),
    ...(readString(raw, ["source"])
      ? { source: readString(raw, ["source"]) as CodaliGatewayModelComparisonRecord["source"] }
      : {}),
    ...(readString(raw, ["healthStatus", "health_status", "health"])
      ? {
          healthStatus: readString(raw, [
            "healthStatus",
            "health_status",
            "health",
          ]) as CodaliGatewayModelComparisonRecord["healthStatus"],
        }
      : {}),
    capabilities: stringList(raw.capabilities),
    resultStatus: normalizeScenarioStatus(readString(raw, ["resultStatus", "result_status"])),
    selectedByPolicy: readBoolean(raw, ["selectedByPolicy", "selected_by_policy"]) ??
      comparisonRole === "primary",
    metrics: {
      quality: {
        status: qualityStatus,
        score: clamp01(readNumber(rawQuality, ["score"]), 0),
        ...(readBoolean(rawQuality, ["jsonValid", "json_valid"]) !== undefined
          ? { jsonValid: readBoolean(rawQuality, ["jsonValid", "json_valid"]) }
          : {}),
        ...(readNumber(rawQuality, ["toolCallCount", "tool_call_count"]) !== undefined
          ? { toolCallCount: readNumber(rawQuality, ["toolCallCount", "tool_call_count"]) }
          : {}),
        ...(readBoolean(rawQuality, ["artifactPresent", "artifact_present"]) !== undefined
          ? {
              artifactPresent: readBoolean(rawQuality, [
                "artifactPresent",
                "artifact_present",
              ]),
            }
          : {}),
        ...(readBoolean(rawQuality, [
          "finalAnswerSucceeded",
          "final_answer_succeeded",
        ]) !== undefined
          ? {
              finalAnswerSucceeded: readBoolean(rawQuality, [
                "finalAnswerSucceeded",
                "final_answer_succeeded",
              ]),
            }
          : {}),
      },
      ...(readNumber(rawMetrics, ["latencyMs", "latency_ms"]) !== undefined
        ? { latencyMs: readNumber(rawMetrics, ["latencyMs", "latency_ms"]) }
        : {}),
      ...(readNumber(rawMetrics, ["costUsd", "cost_usd"]) !== undefined
        ? { costUsd: readNumber(rawMetrics, ["costUsd", "cost_usd"]) }
        : {}),
      ...(tokenUse ? { tokenUse } : {}),
      ...(queue && Object.keys(queue).length > 0 ? { queue } : {}),
      ...(throughput ? { throughput } : {}),
      failure: {
        status: (
          readString(rawFailure, ["status"]) === "failed" ||
          readString(rawFailure, ["status"]) === "degraded" ||
          readString(rawFailure, ["status"]) === "skipped"
        )
          ? readString(rawFailure, ["status"]) as "failed" | "degraded" | "skipped"
          : "none",
        reasons: stringList(rawFailure.reasons),
      },
      ...(isRecord(rawMetrics.localInference)
        ? { localInference: rawMetrics.localInference }
        : {}),
    },
    warnings: stringList(raw.warnings),
    errors: stringList(raw.errors),
    ...(isRecord(raw.metadata) ? { metadata: raw.metadata } : {}),
  };
};

const extractComparisonRecordsFromRecord = (
  record: Record<string, unknown> | undefined,
): Record<string, unknown>[] => {
  if (!record) return [];
  const shadowComparison = nestedRecord(record, ["shadowComparison", "shadow_comparison"]);
  const modelComparison = nestedRecord(record, ["modelComparison", "model_comparison"]);
  return [
    ...nestedRecords(record, ["modelComparisonRecords", "model_comparison_records"]),
    ...nestedRecords(record, ["comparisonRecords", "comparison_records"]),
    ...nestedRecords(record, ["records"]),
    ...nestedRecords(shadowComparison, ["records"]),
    ...nestedRecords(modelComparison, ["records"]),
    ...(comparisonRecordLooksValid(record) ? [record] : []),
    ...(modelComparison && comparisonRecordLooksValid(modelComparison) ? [modelComparison] : []),
  ];
};

const comparisonRecordsForRow = (row: Record<string, unknown>): CodaliGatewayModelComparisonRecord[] => {
  const metadata = metadataForRow(row);
  const records = [
    ...extractComparisonRecordsFromRecord(row),
    ...extractComparisonRecordsFromRecord(metadata),
  ];
  const byId = new Map<string, CodaliGatewayModelComparisonRecord>();
  for (const record of records) {
    if (!comparisonRecordLooksValid(record)) continue;
    const normalized = normalizeComparisonRecord(record);
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
};

const recordIdForRow = (row: Record<string, unknown>): string | undefined =>
  readString(row, ["recordId", "record_id"]);

const acceptedRows = (
  inspection: DatasetExportManifestReaderResult,
): AcceptedRow[] => {
  const acceptedByRecordId = new Map(
    inspection.curationReport.accepted.map((accepted) => [accepted.recordId, accepted]),
  );
  return inspection.primaryArtifactRows
    .filter(isRecord)
    .flatMap((row) => {
      const recordId = recordIdForRow(row);
      const accepted = recordId ? acceptedByRecordId.get(recordId) : undefined;
      return accepted ? [{ row, accepted }] : [];
    });
};

const sourceExampleForRow = (
  input: AcceptedRow,
): CodaliModelRouterSourceExample => {
  const metadata = metadataForRow(input.row);
  const comparisonRecords = comparisonRecordsForRow(input.row);
  const comparisonKeys = Object.keys(metadata).filter((key) =>
    normalizeToken(key).includes("comparison") ||
    normalizeToken(key).includes("model_router") ||
    normalizeToken(key).includes("router"));
  const inputRef = objectRefSummary(input.row.inputRef as CodaliStorageObjectRef | undefined);
  const outputRef = objectRefSummary(input.row.outputRef as CodaliStorageObjectRef | undefined);
  const evidenceRefs = recordList(input.row.evidenceRefs)
    .map((ref) => objectRefSummary(ref as unknown as CodaliStorageObjectRef))
    .filter((ref): ref is CodaliModelRouterObjectRefSummary => Boolean(ref));
  return {
    recordId: input.accepted.recordId,
    ...(input.accepted.sourceGatewayRecordId
      ? { sourceGatewayRecordId: input.accepted.sourceGatewayRecordId }
      : {}),
    artifactTypes: input.accepted.artifactTypes,
    preferenceSignals: input.accepted.preferenceSignals,
    priorityScore: input.accepted.priorityScore,
    comparisonRecordCount: comparisonRecords.length,
    shadowRecordCount: comparisonRecords.filter((record) =>
      record.comparisonRole === "shadow").length,
    objectRefs: {
      ...(inputRef ? { inputRef } : {}),
      ...(outputRef ? { outputRef } : {}),
      evidenceRefs,
    },
    metadataShape: {
      keys: Object.keys(metadata).sort(),
      comparisonKeys: comparisonKeys.sort(),
    },
  };
};

const routeKeyForRecord = (record: CodaliGatewayModelComparisonRecord): string =>
  `${normalizeToken(record.role)}::${normalizeToken(record.resolverRole)}`;

const identityForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): CodaliModelRouterCandidateIdentity => {
  const identityInput = {
    agentSlug: record.agentSlug,
    tier: record.tier,
    model: record.model,
    adapter: record.adapter,
    source: record.source,
    healthStatus: record.healthStatus,
    capabilities: record.capabilities ?? [],
  };
  return {
    identityKey: stableId("identity", identityInput),
    comparisonRole: record.comparisonRole,
    ...(record.agentSlug ? { agentSlug: record.agentSlug } : {}),
    ...(record.tier ? { tier: record.tier } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.adapter ? { adapter: record.adapter } : {}),
    ...(record.source ? { source: record.source } : {}),
    ...(record.healthStatus ? { healthStatus: record.healthStatus } : {}),
    capabilities: [...(record.capabilities ?? [])].sort(),
  };
};

const aggregateKeyForRecord = (record: CodaliGatewayModelComparisonRecord): string =>
  `${routeKeyForRecord(record)}::${identityForRecord(record).identityKey}`;

const average = (values: number[]): number | undefined =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

const failurePenalty = (record: CodaliGatewayModelComparisonRecord): number => {
  if (record.metrics.failure.status === "failed") return 1;
  if (record.metrics.failure.status === "skipped") return 0.8;
  if (record.metrics.failure.status === "degraded") return 0.5;
  if (record.resultStatus === "failed") return 1;
  if (record.resultStatus === "degraded") return 0.5;
  return 0;
};

const explicitScore = (
  record: CodaliGatewayModelComparisonRecord,
  keys: readonly string[],
): number | undefined => {
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const scorecard = nestedRecord(metadata, ["scorecard", "scores", "metrics"]);
  const rawMetrics = record.metrics as unknown as Record<string, unknown>;
  return readNumber(scorecard, keys) ?? readNumber(metadata, keys) ?? readNumber(rawMetrics, keys);
};

const toolAccuracyForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): number => {
  const explicit = explicitScore(record, [
    "toolAccuracy",
    "tool_accuracy",
    "toolSuccess",
    "tool_success",
    "toolSuccessRate",
    "tool_success_rate",
  ]);
  if (explicit !== undefined) return clamp01(explicit);
  const toolCallCount = record.metrics.quality.toolCallCount;
  if (toolCallCount === undefined) return 1;
  if (toolCallCount > 0 && failurePenalty(record) === 0) return 1;
  if (toolCallCount > 0) return 0.5;
  return 0;
};

const schemaSuccessForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): number => {
  const explicit = explicitScore(record, [
    "schemaSuccess",
    "schema_success",
    "jsonSuccess",
    "json_success",
    "schemaSuccessRate",
    "schema_success_rate",
  ]);
  if (explicit !== undefined) return clamp01(explicit);
  if (record.metrics.quality.jsonValid === true) return 1;
  if (record.metrics.quality.jsonValid === false) return 0;
  return (record.capabilities ?? []).some((capability) =>
    normalizeToken(capability).includes("json") ||
    normalizeToken(capability).includes("schema"))
    ? 0.85
    : 0.75;
};

const availabilityForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): number => {
  const health = normalizeToken(record.healthStatus ?? "");
  if (health === "healthy") return 1;
  if (health === "degraded") return 0.65;
  if (health === "limited") return 0.55;
  if (health === "unreachable") return 0;
  return record.resultStatus === "passed" ? 0.8 : 0.4;
};

const confidenceForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): number => {
  const explicit = explicitScore(record, [
    "confidence",
    "confidenceScore",
    "confidence_score",
  ]);
  if (explicit !== undefined) return clamp01(explicit);
  return clamp01(record.metrics.quality.score, 0);
};

const fallbackUsedForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): boolean => {
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const rawMetrics = record.metrics as unknown as Record<string, unknown>;
  return readBoolean(metadata, ["fallbackUsed", "fallback_used"]) ??
    readBoolean(rawMetrics, ["fallbackUsed", "fallback_used"]) ??
    record.metrics.failure.reasons.some((reason) => normalizeToken(reason).includes("fallback"));
};

const fallbackRateForRecord = (
  record: CodaliGatewayModelComparisonRecord,
): number => {
  const explicit = explicitScore(record, [
    "fallbackRate",
    "fallback_rate",
    "fallbackUseRate",
    "fallback_use_rate",
  ]);
  if (explicit !== undefined) return clamp01(explicit);
  return fallbackUsedForRecord(record) ? 1 : 0;
};

const inferenceSummaryForRecords = (
  records: readonly CodaliGatewayModelComparisonRecord[],
): CodaliModelRouterInferenceMetricSummary => {
  const averageNumber = (values: Array<number | undefined>): number | undefined =>
    average(values.filter((value): value is number =>
      typeof value === "number" && Number.isFinite(value)));
  const averageInputTokens = averageNumber(
    records.map((record) => record.metrics.tokenUse?.inputTokens),
  );
  const averageOutputTokens = averageNumber(
    records.map((record) => record.metrics.tokenUse?.outputTokens),
  );
  const averageTotalTokens = averageNumber(
    records.map((record) => record.metrics.tokenUse?.totalTokens),
  );
  const averageQueueWaitMs = averageNumber(
    records.map((record) => record.metrics.queue?.waitMs),
  );
  const averageQueueDepth = averageNumber(
    records.map((record) => record.metrics.queue?.depth),
  );
  const averageThroughputTokensPerSecond = averageNumber(
    records.map((record) => record.metrics.throughput?.tokensPerSecond),
  );
  const averageRequestsPerMinute = averageNumber(
    records.map((record) => record.metrics.throughput?.requestsPerMinute),
  );
  return {
    ...(averageInputTokens !== undefined
      ? { averageInputTokens }
      : {}),
    ...(averageOutputTokens !== undefined
      ? { averageOutputTokens }
      : {}),
    ...(averageTotalTokens !== undefined
      ? { averageTotalTokens }
      : {}),
    ...(averageQueueWaitMs !== undefined
      ? { averageQueueWaitMs }
      : {}),
    ...(averageQueueDepth !== undefined
      ? { averageQueueDepth }
      : {}),
    ...(averageThroughputTokensPerSecond !== undefined
      ? { averageThroughputTokensPerSecond }
      : {}),
    ...(averageRequestsPerMinute !== undefined
      ? { averageRequestsPerMinute }
      : {}),
    localInferenceSampleCount: records.filter((record) =>
      isRecord(record.metrics.localInference) &&
      Object.keys(record.metrics.localInference).length > 0).length,
  };
};

const metricScorecardForRecords = (
  records: readonly EvidenceRecord[],
): CodaliModelRouterMetricScorecard => {
  const rawRecords = records.map((entry) => entry.record);
  const sampleCount = rawRecords.length;
  const quality = average(rawRecords.map((record) => record.metrics.quality.score)) ?? 0;
  const toolAccuracy = average(rawRecords.map(toolAccuracyForRecord)) ?? 0;
  const schemaSuccess = average(rawRecords.map(schemaSuccessForRecord)) ?? 0;
  const latencyMs = average(rawRecords
    .map((record) => record.metrics.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  const costUsd = average(rawRecords
    .map((record) => record.metrics.costUsd)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  const inference = inferenceSummaryForRecords(rawRecords);
  const effectiveLatencyMs =
    latencyMs !== undefined && inference.averageQueueWaitMs !== undefined
      ? latencyMs + inference.averageQueueWaitMs
      : latencyMs ?? inference.averageQueueWaitMs;
  const latency = effectiveLatencyMs === undefined ? 0.75 : 1 / (1 + effectiveLatencyMs / 3_000);
  const cost = costUsd !== undefined
    ? 1 / (1 + costUsd * 100)
    : inference.averageTotalTokens !== undefined
      ? 1 / (1 + inference.averageTotalTokens / 10_000)
      : 0.75;
  const availability = average(rawRecords.map(availabilityForRecord)) ?? 0;
  const confidence = average(rawRecords.map(confidenceForRecord)) ?? 0;
  const failureRate = average(rawRecords.map(failurePenalty)) ?? 0;
  const fallbackRate = average(rawRecords.map(fallbackRateForRecord)) ?? 0;
  const fallbackReliability = 1 - fallbackRate;
  const finalScore =
    quality * 0.24 +
    toolAccuracy * 0.16 +
    schemaSuccess * 0.16 +
    latency * 0.12 +
    cost * 0.10 +
    availability * 0.12 +
    confidence * 0.08 +
    fallbackReliability * 0.02;
  return {
    quality: clamp01(quality),
    toolAccuracy: clamp01(toolAccuracy),
    schemaSuccess: clamp01(schemaSuccess),
    latency: clamp01(latency),
    cost: clamp01(cost),
    availability: clamp01(availability),
    confidence: clamp01(confidence),
    fallbackReliability: clamp01(fallbackReliability),
    finalScore: clamp01(finalScore),
    sampleCount,
    shadowSampleCount: rawRecords.filter((record) => record.comparisonRole === "shadow").length,
    selectedByPolicyCount: rawRecords.filter((record) => record.selectedByPolicy).length,
    ...(latencyMs !== undefined ? { averageLatencyMs: latencyMs } : {}),
    ...(costUsd !== undefined ? { averageCostUsd: costUsd } : {}),
    inference,
    failureRate: clamp01(failureRate),
    fallbackRate: clamp01(fallbackRate),
  };
};

const aggregateEvidence = (records: readonly EvidenceRecord[]): Aggregate[] => {
  const groups = new Map<string, EvidenceRecord[]>();
  for (const entry of records) {
    const key = aggregateKeyForRecord(entry.record);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.entries()].map(([key, group]) => {
    const first = group[0]?.record;
    if (!first) {
      throw new Error(`Empty model-router aggregate ${key}.`);
    }
    const comparisonRole: CodaliModelRouterCandidateIdentity["comparisonRole"] =
      group.every((entry) => entry.record.comparisonRole === "primary")
        ? "primary"
        : group.every((entry) => entry.record.comparisonRole === "shadow")
          ? "shadow"
          : "mixed";
    return {
      routeKey: routeKeyForRecord(first),
      role: first.role,
      resolverRole: first.resolverRole,
      identity: {
        ...identityForRecord(first),
        comparisonRole,
      },
      records: group,
      scorecard: metricScorecardForRecords(group),
    };
  }).sort((left, right) => left.routeKey.localeCompare(right.routeKey) ||
    right.scorecard.finalScore - left.scorecard.finalScore);
};

const sourceRecordIdsForAggregate = (
  aggregate: Aggregate | undefined,
): string[] => uniqueSorted(aggregate?.records.map((entry) => entry.rowRecordId) ?? []);

const gatewayRecordIdsForAggregate = (
  aggregate: Aggregate | undefined,
): string[] => uniqueSorted(aggregate?.records.map((entry) => entry.sourceGatewayRecordId) ?? []);

const comparisonRecordIdsForAggregate = (
  aggregate: Aggregate | undefined,
): string[] => uniqueSorted(aggregate?.records.map((entry) => entry.record.id) ?? []);

const finalSynthesisRouteSignal = (value: string): boolean =>
  value.includes("large_final") ||
  value.includes("final_synth") ||
  value.includes("final_answer_large_model") ||
  value === "final";

const isFinalSynthesisRoute = (route: readonly Aggregate[]): boolean =>
  route.some((aggregate) => {
    const routeSignals = [
      aggregate.role,
      aggregate.resolverRole,
      ...aggregate.records.map((entry) => entry.record.scenarioId),
    ]
      .filter((value): value is string => typeof value === "string")
      .map(normalizeToken);
    const tier = normalizeToken(aggregate.identity.tier ?? "");
    return routeSignals.some(finalSynthesisRouteSignal) ||
      (tier === "large" && routeSignals.some((value) => value.includes("final")));
  });

const isConstrainedWorkerRoute = (route: readonly Aggregate[]): boolean =>
  route.some((aggregate) =>
    [aggregate.role, aggregate.resolverRole]
      .map(normalizeToken)
      .some((value) =>
        value.includes("small_json") ||
        value.includes("extract") ||
        value.includes("repair") ||
        value.includes("router") ||
        value.includes("tool") ||
        value.includes("schema") ||
        value.includes("json") ||
        value.includes("constrained") ||
        value.includes("verifier")));

const isLocalOrSelfHosted = (aggregate: Aggregate): boolean => {
  const source = normalizeToken(aggregate.identity.source ?? "");
  const adapter = normalizeToken(aggregate.identity.adapter ?? "");
  return source === "local" ||
    source === "self_hosted" ||
    adapter.includes("ollama") ||
    adapter.includes("llama_cpp") ||
    adapter.includes("local");
};

const choosePrimaryAggregate = (aggregates: readonly Aggregate[]): Aggregate | undefined =>
  aggregates
    .filter((aggregate) =>
      aggregate.records.some((entry) =>
        entry.record.comparisonRole === "primary" ||
        entry.record.primary ||
        entry.record.selectedByPolicy))
    .sort((left, right) =>
      right.scorecard.selectedByPolicyCount - left.scorecard.selectedByPolicyCount ||
      right.scorecard.sampleCount - left.scorecard.sampleCount ||
      right.scorecard.finalScore - left.scorecard.finalScore)[0];

const chooseShadowAggregate = (
  aggregates: readonly Aggregate[],
  primary: Aggregate | undefined,
  constrainedWorker: boolean,
): Aggregate | undefined => {
  const shadows = aggregates
    .filter((aggregate) => aggregate.scorecard.shadowSampleCount > 0)
    .sort((left, right) => right.scorecard.finalScore - left.scorecard.finalScore);
  if (!constrainedWorker || !primary) return shadows[0];
  const local = shadows
    .filter(isLocalOrSelfHosted)
    .filter((aggregate) =>
      aggregate.scorecard.finalScore >=
        primary.scorecard.finalScore + LOCAL_PREFERENCE_SCORE_DELTA_THRESHOLD)
    .sort((left, right) => right.scorecard.finalScore - left.scorecard.finalScore)[0];
  return local ?? shadows[0];
};

const routeCandidateForAggregates = (
  routeKey: string,
  aggregates: readonly Aggregate[],
): CodaliModelRouterRouteCandidate => {
  const primary = choosePrimaryAggregate(aggregates);
  const constrainedWorker = isConstrainedWorkerRoute(aggregates);
  const shadow = chooseShadowAggregate(aggregates, primary, constrainedWorker);
  const finalRoute = isFinalSynthesisRoute(aggregates);
  const blockedReasons: string[] = [];
  if (!primary) blockedReasons.push("primary_evidence_missing");
  if (!shadow) blockedReasons.push("shadow_evidence_required");
  if (finalRoute) blockedReasons.push("final_synthesis_large_model_preserved");
  if (shadow && shadow.scorecard.confidence < MIN_SHADOW_CONFIDENCE) {
    blockedReasons.push("shadow_confidence_below_threshold");
  }
  if (shadow && shadow.scorecard.schemaSuccess < MIN_SHADOW_SCHEMA_SUCCESS) {
    blockedReasons.push("shadow_schema_success_below_threshold");
  }
  if (shadow && shadow.scorecard.availability < MIN_SHADOW_AVAILABILITY) {
    blockedReasons.push("shadow_availability_below_threshold");
  }
  const scoreDelta = primary && shadow
    ? shadow.scorecard.finalScore - primary.scorecard.finalScore
    : undefined;
  if (scoreDelta !== undefined && scoreDelta < SCORE_DELTA_THRESHOLD && !finalRoute) {
    blockedReasons.push("shadow_score_delta_insufficient");
  }
  const canPropose = Boolean(primary && shadow && !finalRoute && blockedReasons.length === 0);
  const action = canPropose
    ? "propose_shadow_route"
    : finalRoute
      ? "preserve_current"
      : "no_change";
  const status = canPropose ? "proposed" : finalRoute ? "no_change" : "blocked";
  const evidenceAggregates = [primary, shadow].filter((value): value is Aggregate => Boolean(value));
  return {
    routeId: stableId("router-route", {
      routeKey,
      primary: primary?.identity.identityKey,
      shadow: shadow?.identity.identityKey,
    }),
    role: primary?.role ?? shadow?.role ?? aggregates[0]?.role ?? routeKey.split("::")[0] ?? "unknown",
    resolverRole: primary?.resolverRole ??
      shadow?.resolverRole ??
      aggregates[0]?.resolverRole ??
      routeKey.split("::")[1] ??
      "unknown",
    action,
    status,
    ...(primary ? { current: primary.identity } : {}),
    ...(canPropose && shadow ? { proposed: shadow.identity } : {}),
    ...(scoreDelta !== undefined ? { scoreDelta } : {}),
    ...(primary ? { primaryScorecard: primary.scorecard } : {}),
    ...(shadow ? { proposedScorecard: shadow.scorecard } : {}),
    blockedReasons: uniqueSorted(blockedReasons),
    evidence: {
      sourceRecordIds: uniqueSorted(evidenceAggregates.flatMap(sourceRecordIdsForAggregate)),
      sourceGatewayRecordIds: uniqueSorted(evidenceAggregates.flatMap(gatewayRecordIdsForAggregate)),
      comparisonRecordIds: uniqueSorted(evidenceAggregates.flatMap(comparisonRecordIdsForAggregate)),
      primarySampleCount: primary?.scorecard.sampleCount ?? 0,
      shadowSampleCount: shadow?.scorecard.shadowSampleCount ?? 0,
      scorecardSampleCount: evidenceAggregates.reduce(
        (total, aggregate) => total + aggregate.scorecard.sampleCount,
        0,
      ),
      shadowEvidenceRequired: true,
      shadowEvidencePresent: Boolean(shadow),
    },
    rollbackPlan: {
      reversible: true,
      ...(primary ? { restoreIdentity: primary.identity } : {}),
      ...(canPropose && shadow ? { removeCandidateIdentity: shadow.identity } : {}),
      steps: canPropose
        ? [
            "Apply candidate behind an explicit router policy flag.",
            "Restore the captured current identity if scorecards regress.",
            "Remove the candidate identity from the router policy to roll back.",
          ]
        : [
            "No runtime router mutation was produced.",
            "Keep current router policy unchanged.",
          ],
    },
  };
};

const buildEvidenceRecords = (rows: readonly AcceptedRow[]): EvidenceRecord[] =>
  rows.flatMap((input) => comparisonRecordsForRow(input.row).map((record) => ({
    rowRecordId: input.accepted.recordId,
    ...(input.accepted.sourceGatewayRecordId
      ? { sourceGatewayRecordId: input.accepted.sourceGatewayRecordId }
      : {}),
    record,
  })));

const buildRouteCandidates = (
  records: readonly EvidenceRecord[],
): CodaliModelRouterRouteCandidate[] => {
  const aggregates = aggregateEvidence(records);
  const byRoute = new Map<string, Aggregate[]>();
  for (const aggregate of aggregates) {
    byRoute.set(aggregate.routeKey, [...(byRoute.get(aggregate.routeKey) ?? []), aggregate]);
  }
  return [...byRoute.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([routeKey, routeAggregates]) =>
      routeCandidateForAggregates(routeKey, routeAggregates));
};

const planForRoutes = (
  inspection: DatasetExportManifestReaderResult,
  routeCandidates: readonly CodaliModelRouterRouteCandidate[],
  comparisonRecordCount: number,
): CodaliModelRouterPlan => {
  const proposedRouteCount = routeCandidates.filter((route) =>
    route.status === "proposed").length;
  const preservedRouteCount = routeCandidates.filter((route) =>
    route.action === "preserve_current").length;
  const reasons = uniqueSorted([
    ...(comparisonRecordCount === 0 ? ["comparison_evidence_missing"] : []),
    ...(inspection.curationReport.acceptedCount === 0 ? ["accepted_examples_missing"] : []),
    ...routeCandidates.flatMap((route) => route.blockedReasons),
  ]);
  return {
    planId: stableId("model-router-plan", {
      exportId: inspection.exportId,
      checksum: inspection.provenance.checksum,
      routeIds: routeCandidates.map((route) => route.routeId),
    }),
    action: proposedRouteCount > 0 ? "propose_shadow_route" : "no_change",
    status: proposedRouteCount > 0 ? "proposed" : "blocked",
    reasons,
    routeCount: routeCandidates.length,
    proposedRouteCount,
    preservedRouteCount,
    noChangeRouteCount: routeCandidates.filter((route) =>
      route.status !== "proposed").length,
    reversible: true,
    requiresShadowEvidence: true,
    productionRouterChangeAllowed: false,
  };
};

const candidateSummary = (
  inspection: DatasetExportManifestReaderResult,
  routerPlan: CodaliModelRouterPlan,
  sourceExamples: readonly CodaliModelRouterSourceExample[],
): CodaliModelRouterImprovementCandidateSummary => {
  const status = routerPlan.action === "propose_shadow_route"
    ? "proposed"
    : "no_change";
  return {
    candidateId: stableId("model-router-candidate", {
      planId: routerPlan.planId,
      exportId: inspection.exportId,
      checksum: inspection.provenance.checksum,
    }),
    candidateKind: "model_router",
    status,
    sourceExportIds: [inspection.exportId],
    sourceRecordIds: inspection.provenance.sourceRecordIds,
    artifactIds: inspection.provenance.artifactRefs.map((ref) => ref.refId),
    exampleCount: sourceExamples.length,
    objectBytes: inspection.provenance.artifactRefs.reduce(
      (total, ref) => total + ref.byteSize,
      0,
    ),
    routeCount: routerPlan.routeCount,
    proposedRouteCount: routerPlan.proposedRouteCount,
    blockedReasons: routerPlan.action === "no_change" ? routerPlan.reasons : [],
  };
};

export const buildCodaliModelRouterCandidateBundle = (
  input: BuildCodaliModelRouterCandidateBundleInput,
): CodaliModelRouterCandidateBundle => {
  const artifact = input.artifact ?? CODALI_MODEL_ROUTER_PROPOSAL_ARTIFACT;
  const rows = acceptedRows(input.inspection);
  const sourceExamples = rows.map(sourceExampleForRow);
  const evidenceRecords = buildEvidenceRecords(rows);
  const routeCandidates = buildRouteCandidates(evidenceRecords);
  const routerPlan = planForRoutes(
    input.inspection,
    routeCandidates,
    evidenceRecords.length,
  );
  const roles = uniqueSorted(evidenceRecords.map((entry) => entry.record.resolverRole));
  return {
    schemaVersion: CODALI_MODEL_ROUTER_CANDIDATE_SCHEMA_VERSION,
    artifact,
    source: {
      exportId: input.inspection.exportId,
      manifestId: input.inspection.provenance.manifestId,
      manifestPath: input.inspection.manifestPath,
      exportKind: input.inspection.provenance.exportKind,
      checksum: input.inspection.provenance.checksum,
      recordCount: input.inspection.provenance.recordCount,
      ...(input.inspection.primaryArtifact
        ? { primaryArtifactRef: objectRefSummary(input.inspection.primaryArtifact.ref) }
        : {}),
    },
    generationPolicy: {
      deterministic: true,
      dryRunOnly: true,
      modifiesRuntimePrompts: false,
      modifiesRuntimeCode: false,
      modifiesRuntimeRouter: false,
      productionRouterChangeAllowed: false,
      requiresShadowEvidence: true,
      reversible: true,
      uploadEnabled: false,
      preservesFinalSynthesisRoute: true,
      finalSynthesizerFineTuning: false,
    },
    expectedShape: {
      schemaVersion: CODALI_MODEL_ROUTER_CANDIDATE_SCHEMA_VERSION,
      artifact,
      requiredFields: [
        "schemaVersion",
        "artifact",
        "generationPolicy",
        "evidenceSummary",
        "routerPlan",
        "routeCandidates",
        "candidates",
      ],
      routeCandidateRequiredFields: [
        "routeId",
        "role",
        "resolverRole",
        "action",
        "evidence",
        "rollbackPlan",
      ],
      scorecardFields: [
        "quality",
        "toolAccuracy",
        "schemaSuccess",
        "latency",
        "cost",
        "availability",
        "confidence",
        "fallbackReliability",
        "fallbackRate",
        "inference",
        "finalScore",
      ],
    },
    sourceExamples,
    evidenceSummary: {
      comparisonRecordCount: evidenceRecords.length,
      primaryRecordCount: evidenceRecords.filter((entry) =>
        entry.record.comparisonRole === "primary").length,
      shadowRecordCount: evidenceRecords.filter((entry) =>
        entry.record.comparisonRole === "shadow").length,
      roleCount: roles.length,
      roles,
      metricInputs: [
        "quality",
        "tool_accuracy",
        "schema_success",
        "latency",
        "cost",
        "availability",
        "confidence",
        "fallback_rate",
      ],
    },
    routerPlan,
    routeCandidates,
    candidates: [candidateSummary(input.inspection, routerPlan, sourceExamples)],
  };
};
