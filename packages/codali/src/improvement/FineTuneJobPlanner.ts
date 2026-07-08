import { createHash } from "node:crypto";
import {
  resolveCodaliGatewayAgentTiers,
  type AgentTierResolution,
  type CodaliGatewayAgentAssignment,
  type CodaliGatewayAgentCandidateDiagnostic,
  type CodaliGatewayAgentTierError,
} from "../gateway/AgentTierResolver.js";
import type {
  CodaliStorageExportKind,
  CodaliStorageExportLineage,
  CodaliStorageExportPrivacySummary,
  CodaliStorageObjectPrivacyFlags,
  CodaliStorageObjectRef,
  CodaliStoragePrivacyMetadata,
} from "../storage/CodaliStorageContracts.js";
import type {
  DatasetEligibilityGateAcceptedExample,
  DatasetEligibilityGateRejectedExample,
} from "./DatasetEligibilityGate.js";
import type { DatasetExportManifestReaderResult } from "./DatasetExportManifestReader.js";

export const CODALI_FINE_TUNE_JOB_PLANNER_SCHEMA_VERSION =
  "codali.improvement.fine_tune_job_planner.v1" as const;

export const CODALI_FINE_TUNE_PROPOSAL_ARTIFACT = "fine-tune" as const;

export const CODALI_FINE_TUNE_WORKER_ROLES = [
  "extractor",
  "tool_router",
  "planner",
  "verifier",
  "query_expander",
  "repair",
  "context_refiner",
] as const;

export const CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE = "final_synthesizer" as const;

export type CodaliFineTuneAllowedWorkerRole =
  (typeof CODALI_FINE_TUNE_WORKER_ROLES)[number];

export type CodaliFineTuneWorkerRole =
  | CodaliFineTuneAllowedWorkerRole
  | typeof CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE;

export type CodaliFineTuneProposalArtifact = typeof CODALI_FINE_TUNE_PROPOSAL_ARTIFACT;

export type CodaliFineTuneJobKind = "sft" | "preference";

export type CodaliFineTuneCandidateKind = "fine_tune_job_spec";

export interface CodaliFineTuneObjectRefSummary {
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

export interface CodaliFineTuneScorecardMetricDelta {
  metric: string;
  before?: number;
  after?: number;
  delta?: number;
}

export interface CodaliFineTuneSourceScorecard {
  scorecardId: string;
  present: boolean;
  metricKeys: string[];
  metricDeltas: CodaliFineTuneScorecardMetricDelta[];
}

export interface CodaliFineTuneSourceExample {
  recordId: string;
  sourceGatewayRecordId?: string;
  artifactTypes: string[];
  preferenceSignals: string[];
  priorityScore: number;
  lineageKey: DatasetEligibilityGateAcceptedExample["lineageKey"];
  privacy: {
    trainingAllowed: true;
    policyTags: string[];
    containsPersonalData: boolean;
    containsTenantPrivateData: boolean;
    containsCustomerData: boolean;
    containsSourceCode: boolean;
  };
  scorecard: CodaliFineTuneSourceScorecard;
  objectRefs: {
    inputRef?: CodaliFineTuneObjectRefSummary;
    outputRef?: CodaliFineTuneObjectRefSummary;
    evidenceRefs: CodaliFineTuneObjectRefSummary[];
  };
  tokenEstimate: number;
  metadataShape: {
    keys: string[];
    scorecardKeys: string[];
  };
}

export interface CodaliFineTuneTrainingManifestRecord {
  recordId: string;
  sourceGatewayRecordId?: string;
  lineageKey: DatasetEligibilityGateAcceptedExample["lineageKey"];
  scorecardId: string;
  objectRefHashes: string[];
  tokenEstimate: number;
  preferenceSignals: string[];
  priorityScore: number;
}

export interface CodaliFineTuneTrainingManifest {
  manifestId: string;
  jobKind: CodaliFineTuneJobKind;
  role: CodaliFineTuneWorkerRole;
  exportId: string;
  sourceManifestId: string;
  sourceChecksum: string;
  reproducibleFrom: {
    exportId: string;
    sourceManifestId: string;
    sourceChecksum: string;
    policyHash: string;
    role: CodaliFineTuneWorkerRole;
  };
  records: CodaliFineTuneTrainingManifestRecord[];
  rowCount: number;
  totalTokenEstimate: number;
  excludedTrainingBlockedRecordIds: string[];
}

export interface CodaliFineTuneInventoryWarning {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CodaliFineTuneInventorySource {
  source: "provided" | "command" | "not_provided";
  command?: string;
  args?: string[];
  status?: "succeeded" | "failed" | "not_run";
  latencyMs?: number;
  inventoryCount?: number;
  errors?: string[];
}

export interface CodaliFineTuneTargetAssignmentSummary {
  resolverRole: string;
  agentSlug: string;
  adapter: string;
  provider?: string;
  model: string;
  source: string;
  tier: string;
  runtimeHealth: {
    status: string;
    latencyMs?: number;
  };
  capabilities: string[];
  contextWindow?: number;
  costPerMillion?: number;
  score: number;
  reasons: string[];
}

export interface CodaliFineTuneTargetResolution {
  source: CodaliFineTuneInventorySource;
  status: "resolved" | "unresolved";
  resolverRole: string;
  inventorySnapshotHash?: string;
  inventoryCount: number;
  assignment?: CodaliFineTuneTargetAssignmentSummary;
  diagnostics: CodaliGatewayAgentCandidateDiagnostic[];
  warnings: CodaliGatewayAgentTierError[];
  errors: CodaliGatewayAgentTierError[];
  refreshWarnings: CodaliFineTuneInventoryWarning[];
}

export interface CodaliFineTuneScorecardSummary {
  required: true;
  bypassAllowed: false;
  examplesWithScorecards: number;
  missingRecordIds: string[];
  scorecardIds: string[];
  averageMetricDeltas: CodaliFineTuneScorecardMetricDelta[];
}

export interface CodaliFineTuneEvalCommandSpec {
  commandId: string;
  command: "docdexd";
  args: string[];
  dryRunSafe: true;
  expectedScorecards: string[];
  scorecardBypassAllowed: false;
}

export interface CodaliFineTuneEvalPlan {
  planId: string;
  scorecardRequired: true;
  bypassAllowed: false;
  scorecardIds: string[];
  gates: Array<{
    gateId: string;
    type: "scorecard" | "privacy" | "offline_eval" | "target_health";
    required: true;
    passed: boolean;
    reasons: string[];
  }>;
  commands: CodaliFineTuneEvalCommandSpec[];
}

export interface CodaliFineTuneCostEstimate {
  source: "mcoda_inventory" | "not_available";
  currency: "USD";
  estimatedTrainingTokens: number;
  costPerMillionTokens?: number;
  estimatedProviderCostUsd?: number;
  notes: string[];
}

export interface CodaliFineTuneRollbackPlan {
  planId: string;
  automaticProviderJobSubmitted: false;
  steps: string[];
  triggers: string[];
}

export interface CodaliFineTuneProviderSubmissionPolicy {
  automaticSubmission: false;
  approvalRequired: true;
  status: "not_submitted";
  runnerStatus: "not_approved";
  blocker: "provider_specific_runners_not_approved";
}

export interface CodaliFineTuneJobSpec {
  jobSpecId: string;
  jobPlanId: string;
  status: "draft" | "blocked";
  jobKind: CodaliFineTuneJobKind;
  role: CodaliFineTuneWorkerRole;
  targetResolution: CodaliFineTuneTargetResolution;
  trainingManifest: CodaliFineTuneTrainingManifest;
  datasetLineage: CodaliStorageExportLineage;
  privacySummary: CodaliStorageExportPrivacySummary;
  scorecardSummary: CodaliFineTuneScorecardSummary;
  evalPlan: CodaliFineTuneEvalPlan;
  costEstimate: CodaliFineTuneCostEstimate;
  rollbackPlan: CodaliFineTuneRollbackPlan;
  providerSubmission: CodaliFineTuneProviderSubmissionPolicy;
}

export interface CodaliFineTuneImprovementCandidateSummary {
  candidateId: string;
  candidateKind: CodaliFineTuneCandidateKind;
  status: "proposed" | "blocked";
  role: CodaliFineTuneWorkerRole;
  jobKind: CodaliFineTuneJobKind;
  sourceExportIds: string[];
  sourceRecordIds: string[];
  artifactIds: string[];
  exampleCount: number;
  objectBytes: number;
  jobSpecIds: string[];
  blockedReasons: string[];
  scorecardRequired: true;
  providerSubmissionEnabled: false;
}

export interface CodaliFineTuneJobPlannerBundle {
  schemaVersion: typeof CODALI_FINE_TUNE_JOB_PLANNER_SCHEMA_VERSION;
  artifact: CodaliFineTuneProposalArtifact;
  source: {
    exportId: string;
    manifestId: string;
    manifestPath: string;
    exportKind: CodaliStorageExportKind;
    checksum: string;
    recordCount: number;
    primaryArtifactRef: CodaliFineTuneObjectRefSummary;
  };
  generationPolicy: {
    deterministic: true;
    modifiesRuntimePrompts: false;
    modifiesRuntimeCode: false;
    bodyPolicy: "object_refs_and_hashes_only";
    uploadEnabled: false;
    providerSubmissionEnabled: false;
    scorecardRequired: true;
    scorecardBypassAllowed: false;
    finalSynthesizerFineTuning: false;
  };
  expectedShape: {
    schemaVersion: typeof CODALI_FINE_TUNE_JOB_PLANNER_SCHEMA_VERSION;
    artifact: CodaliFineTuneProposalArtifact;
    requiredFields: string[];
    jobSpecRequiredFields: string[];
  };
  rolePolicy: {
    role: CodaliFineTuneWorkerRole;
    resolverRole: string;
    allowedWorkerRole: boolean;
    supportedExportKinds: CodaliStorageExportKind[];
    finalSynthesizerAllowed: false;
    providerAutoSubmitAllowed: false;
  };
  sourceExamples: CodaliFineTuneSourceExample[];
  trainingManifest: CodaliFineTuneTrainingManifest;
  targetResolution: CodaliFineTuneTargetResolution;
  scorecardSummary: CodaliFineTuneScorecardSummary;
  evalPlan: CodaliFineTuneEvalPlan;
  costEstimate: CodaliFineTuneCostEstimate;
  rollbackPlan: CodaliFineTuneRollbackPlan;
  providerSubmission: CodaliFineTuneProviderSubmissionPolicy;
  jobSpecs: CodaliFineTuneJobSpec[];
  rejectedEvidence: DatasetEligibilityGateRejectedExample[];
  candidates: CodaliFineTuneImprovementCandidateSummary[];
}

export interface BuildCodaliFineTuneJobPlannerBundleInput {
  inspection: DatasetExportManifestReaderResult;
  role?: CodaliFineTuneWorkerRole;
  artifact?: CodaliFineTuneProposalArtifact;
  inventory?: unknown[];
  inventorySource?: CodaliFineTuneInventorySource;
  inventoryWarnings?: CodaliFineTuneInventoryWarning[];
}

interface FineTuneRoleSpec {
  resolverRole: string;
  sourceArtifactTypes: string[];
  supportedExportKinds: CodaliStorageExportKind[];
}

const DEFAULT_INVENTORY_COMMAND = {
  command: "mcoda",
  args: ["agent", "list", "--json", "--refresh-health"],
} as const;

const ROLE_SPECS: Record<CodaliFineTuneWorkerRole, FineTuneRoleSpec> = {
  extractor: {
    resolverRole: "extractor",
    sourceArtifactTypes: ["extractor", "extractor_sft"],
    supportedExportKinds: ["extractor-sft"],
  },
  tool_router: {
    resolverRole: "router",
    sourceArtifactTypes: [
      "router",
      "tool_router",
      "tool_router_sft",
      "model_router",
      "model-router",
    ],
    supportedExportKinds: ["tool-router-sft", "model-router"],
  },
  planner: {
    resolverRole: "planner",
    sourceArtifactTypes: ["planner", "planner_sft"],
    supportedExportKinds: ["planner-sft"],
  },
  verifier: {
    resolverRole: "verifier",
    sourceArtifactTypes: ["verifier", "verifier_sft"],
    supportedExportKinds: ["verifier-sft"],
  },
  query_expander: {
    resolverRole: "query_expander",
    sourceArtifactTypes: [
      "query_expander",
      "query_expander_sft",
      "rag_reranker",
      "rag-reranker",
    ],
    supportedExportKinds: ["query-expander-sft", "rag-reranker"],
  },
  repair: {
    resolverRole: "repair",
    sourceArtifactTypes: ["repair", "repair_sft"],
    supportedExportKinds: ["repair-sft"],
  },
  context_refiner: {
    resolverRole: "context_refiner",
    sourceArtifactTypes: ["context_refiner", "context_refiner_sft"],
    supportedExportKinds: ["context-refiner-sft"],
  },
  final_synthesizer: {
    resolverRole: "final_synthesizer",
    sourceArtifactTypes: ["final_synthesizer", "final_synthesizer_sft"],
    supportedExportKinds: [],
  },
};

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

const normalizedUniqueSorted = (values: Array<string | undefined>): string[] =>
  uniqueSorted(values.map((value) => value ? normalizeToken(value) : undefined));

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

const objectRefFromValue = (value: unknown): CodaliStorageObjectRef | undefined =>
  isRecord(value) &&
  typeof value.refId === "string" &&
  typeof value.contentHash === "string" &&
  typeof value.byteSize === "number" &&
  typeof value.mimeType === "string" &&
  typeof value.deletionGroupId === "string" &&
  isRecord(value.privacyFlags)
    ? value as unknown as CodaliStorageObjectRef
    : undefined;

const refsForRow = (row: Record<string, unknown> | undefined): {
  inputRef?: CodaliStorageObjectRef;
  outputRef?: CodaliStorageObjectRef;
  evidenceRefs: CodaliStorageObjectRef[];
} => {
  const evidenceRefs = Array.isArray(row?.evidenceRefs)
    ? row.evidenceRefs.map(objectRefFromValue)
      .filter((ref): ref is CodaliStorageObjectRef => Boolean(ref))
    : [];
  return {
    inputRef: objectRefFromValue(row?.inputRef),
    outputRef: objectRefFromValue(row?.outputRef),
    evidenceRefs,
  };
};

const allRefsForRow = (row: Record<string, unknown> | undefined): CodaliStorageObjectRef[] => {
  const refs = refsForRow(row);
  return [refs.inputRef, refs.outputRef, ...refs.evidenceRefs]
    .filter((ref): ref is CodaliStorageObjectRef => Boolean(ref));
};

const summarizeObjectRef = (
  ref: CodaliStorageObjectRef,
): CodaliFineTuneObjectRefSummary => ({
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
});

const recordIdForRow = (row: unknown): string | undefined =>
  isRecord(row) ? readString(row, ["recordId", "record_id"]) : undefined;

const rowsByRecordId = (
  rows: readonly unknown[],
): Map<string, Record<string, unknown>> => {
  const output = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const recordId = recordIdForRow(row);
    if (recordId) output.set(recordId, row);
  }
  return output;
};

const metadataForRow = (row: Record<string, unknown> | undefined): Record<string, unknown> =>
  isRecord(row?.metadata) ? row.metadata : {};

const privacyForRow = (
  row: Record<string, unknown> | undefined,
): CodaliStoragePrivacyMetadata | undefined =>
  isRecord(row?.privacy)
    ? row.privacy as unknown as CodaliStoragePrivacyMetadata
    : undefined;

const nestedRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return {};
};

const scorecardMetadataForRow = (
  row: Record<string, unknown> | undefined,
): Record<string, unknown> => {
  const metadata = metadataForRow(row);
  return nestedRecord(metadata, [
    "scorecard",
    "evalScorecard",
    "eval_scorecard",
    "qualityScorecard",
    "quality_scorecard",
  ]);
};

const roleSpecFor = (role: CodaliFineTuneWorkerRole): FineTuneRoleSpec =>
  ROLE_SPECS[role];

export const normalizeCodaliFineTuneWorkerRole = (
  value: string,
): CodaliFineTuneWorkerRole | undefined => {
  const normalized = normalizeToken(value);
  if (normalized === "final" || normalized === "synthesizer") {
    return CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE;
  }
  if (normalized === CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE) {
    return CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE;
  }
  return CODALI_FINE_TUNE_WORKER_ROLES.includes(
    normalized as CodaliFineTuneAllowedWorkerRole,
  )
    ? normalized as CodaliFineTuneAllowedWorkerRole
    : undefined;
};

export const fineTuneArtifactTypesForRole = (
  role: CodaliFineTuneWorkerRole,
): string[] => [...roleSpecFor(role).sourceArtifactTypes];

const jobKindForExportKind = (
  exportKind: CodaliStorageExportKind,
): CodaliFineTuneJobKind =>
  exportKind === "rag-reranker" || exportKind === "model-router"
    ? "preference"
    : "sft";

const supportedExportForRole = (
  role: CodaliFineTuneWorkerRole,
  exportKind: CodaliStorageExportKind,
): boolean => roleSpecFor(role).supportedExportKinds.includes(exportKind);

const policyHashFor = (
  role: CodaliFineTuneWorkerRole,
  exportKind: CodaliStorageExportKind,
): string => `sha256:${sha256Hex({
  role,
  exportKind,
  trainingAllowedRequired: true,
  scorecardRequired: true,
  scorecardBypassAllowed: false,
  finalSynthesizerAllowed: false,
  providerAutoSubmitAllowed: false,
}).slice(0, 24)}`;

const hasTrainingPermission = (
  row: Record<string, unknown> | undefined,
  refs: readonly CodaliStorageObjectRef[],
): boolean => {
  const privacy = privacyForRow(row);
  return privacy?.trainingAllowed === true &&
    refs.length > 0 &&
    refs.every((ref) => ref.privacyFlags.trainingAllowed === true);
};

const privacySummaryForRow = (
  row: Record<string, unknown> | undefined,
  refs: readonly CodaliStorageObjectRef[],
): CodaliFineTuneSourceExample["privacy"] => {
  const privacy = privacyForRow(row);
  return {
    trainingAllowed: true,
    policyTags: uniqueSorted(privacy?.policyTags ?? []),
    containsPersonalData:
      privacy?.containsPersonalData === true ||
      refs.some((ref) => ref.privacyFlags.containsPersonalData),
    containsTenantPrivateData:
      refs.some((ref) => ref.privacyFlags.containsTenantPrivateData),
    containsCustomerData:
      refs.some((ref) => ref.privacyFlags.containsCustomerData),
    containsSourceCode:
      refs.some((ref) => ref.privacyFlags.containsSourceCode),
  };
};

const scorecardMetricDeltas = (
  scorecard: Record<string, unknown>,
): CodaliFineTuneScorecardMetricDelta[] => {
  const metricNames = new Set<string>();
  for (const key of Object.keys(scorecard)) {
    const normalized = key.replace(/[_-]/g, "");
    const match = normalized.match(/^(.*?)(Before|After|Baseline|Candidate|Delta)$/i);
    if (match?.[1]) {
      metricNames.add(normalizeToken(match[1]));
    }
  }
  const deltas: CodaliFineTuneScorecardMetricDelta[] = [];
  for (const metric of [...metricNames].sort()) {
    const before = readNumber(scorecard, [
      `${metric}Before`,
      `${metric}_before`,
      `${metric}Baseline`,
      `${metric}_baseline`,
    ]);
    const after = readNumber(scorecard, [
      `${metric}After`,
      `${metric}_after`,
      `${metric}Candidate`,
      `${metric}_candidate`,
    ]);
    const explicitDelta = readNumber(scorecard, [`${metric}Delta`, `${metric}_delta`]);
    const delta = explicitDelta ?? (
      before !== undefined && after !== undefined ? after - before : undefined
    );
    if (before !== undefined || after !== undefined || delta !== undefined) {
      deltas.push({
        metric,
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(delta !== undefined ? { delta: Number(delta.toFixed(6)) } : {}),
      });
    }
  }
  return deltas;
};

const scorecardForRow = (
  accepted: DatasetEligibilityGateAcceptedExample,
  row: Record<string, unknown> | undefined,
): CodaliFineTuneSourceScorecard => {
  const scorecard = scorecardMetadataForRow(row);
  const metricKeys = Object.keys(scorecard).sort();
  return {
    scorecardId: stableId("fine-tune-scorecard", {
      recordId: accepted.recordId,
      metricKeys,
      lineageKey: accepted.lineageKey,
    }),
    present: metricKeys.length > 0,
    metricKeys,
    metricDeltas: scorecardMetricDeltas(scorecard),
  };
};

const tokenEstimateForRefs = (refs: readonly CodaliStorageObjectRef[]): number =>
  Math.max(1, Math.ceil(refs.reduce((sum, ref) => sum + ref.byteSize, 0) / 4));

const sourceExampleForAccepted = (
  accepted: DatasetEligibilityGateAcceptedExample,
  row: Record<string, unknown> | undefined,
): CodaliFineTuneSourceExample | undefined => {
  const refs = refsForRow(row);
  const allRefs = [refs.inputRef, refs.outputRef, ...refs.evidenceRefs]
    .filter((ref): ref is CodaliStorageObjectRef => Boolean(ref));
  if (!hasTrainingPermission(row, allRefs)) {
    return undefined;
  }
  const metadata = metadataForRow(row);
  const scorecard = scorecardForRow(accepted, row);
  return {
    recordId: accepted.recordId,
    ...(accepted.sourceGatewayRecordId ? {
      sourceGatewayRecordId: accepted.sourceGatewayRecordId,
    } : {}),
    artifactTypes: accepted.artifactTypes,
    preferenceSignals: accepted.preferenceSignals.map(String).sort(),
    priorityScore: accepted.priorityScore,
    lineageKey: accepted.lineageKey,
    privacy: privacySummaryForRow(row, allRefs),
    scorecard,
    objectRefs: {
      ...(refs.inputRef ? { inputRef: summarizeObjectRef(refs.inputRef) } : {}),
      ...(refs.outputRef ? { outputRef: summarizeObjectRef(refs.outputRef) } : {}),
      evidenceRefs: refs.evidenceRefs.map(summarizeObjectRef),
    },
    tokenEstimate: tokenEstimateForRefs(allRefs),
    metadataShape: {
      keys: Object.keys(metadata).sort(),
      scorecardKeys: scorecard.metricKeys,
    },
  };
};

const buildSourceExampleSet = (
  inspection: DatasetExportManifestReaderResult,
): {
  sourceExamples: CodaliFineTuneSourceExample[];
  excludedTrainingBlockedRecordIds: string[];
} => {
  const rowMap = rowsByRecordId(inspection.primaryArtifactRows);
  const sourceExamples: CodaliFineTuneSourceExample[] = [];
  const excludedTrainingBlockedRecordIds: string[] = [];
  for (const accepted of inspection.curationReport.accepted) {
    const row = rowMap.get(accepted.recordId);
    const refs = allRefsForRow(row);
    if (!hasTrainingPermission(row, refs)) {
      excludedTrainingBlockedRecordIds.push(accepted.recordId);
      continue;
    }
    const sourceExample = sourceExampleForAccepted(accepted, row);
    if (sourceExample) sourceExamples.push(sourceExample);
  }
  return {
    sourceExamples: sourceExamples.sort((left, right) =>
      right.priorityScore - left.priorityScore || left.recordId.localeCompare(right.recordId)),
    excludedTrainingBlockedRecordIds: excludedTrainingBlockedRecordIds.sort(),
  };
};

const buildTrainingManifest = (
  inspection: DatasetExportManifestReaderResult,
  role: CodaliFineTuneWorkerRole,
  jobKind: CodaliFineTuneJobKind,
  sourceExamples: readonly CodaliFineTuneSourceExample[],
  excludedTrainingBlockedRecordIds: readonly string[],
): CodaliFineTuneTrainingManifest => {
  const policyHash = policyHashFor(role, inspection.manifest.exportKind);
  const manifestId = stableId("fine-tune-manifest", {
    exportId: inspection.exportId,
    sourceManifestId: inspection.manifest.manifestId,
    checksum: inspection.manifest.checksum,
    role,
    jobKind,
    policyHash,
    recordIds: sourceExamples.map((example) => example.recordId),
  });
  const records = sourceExamples.map((example) => {
    const objectRefHashes = uniqueSorted([
      example.objectRefs.inputRef?.contentHash,
      example.objectRefs.outputRef?.contentHash,
      ...example.objectRefs.evidenceRefs.map((ref) => ref.contentHash),
    ]).map((hash) => `sha256:${hash.replace(/^sha256:/, "")}`);
    return {
      recordId: example.recordId,
      ...(example.sourceGatewayRecordId ? {
        sourceGatewayRecordId: example.sourceGatewayRecordId,
      } : {}),
      lineageKey: example.lineageKey,
      scorecardId: example.scorecard.scorecardId,
      objectRefHashes,
      tokenEstimate: example.tokenEstimate,
      preferenceSignals: example.preferenceSignals,
      priorityScore: example.priorityScore,
    };
  });
  return {
    manifestId,
    jobKind,
    role,
    exportId: inspection.exportId,
    sourceManifestId: inspection.manifest.manifestId,
    sourceChecksum: inspection.manifest.checksum,
    reproducibleFrom: {
      exportId: inspection.exportId,
      sourceManifestId: inspection.manifest.manifestId,
      sourceChecksum: inspection.manifest.checksum,
      policyHash,
      role,
    },
    records,
    rowCount: records.length,
    totalTokenEstimate: records.reduce((sum, record) => sum + record.tokenEstimate, 0),
    excludedTrainingBlockedRecordIds: [...excludedTrainingBlockedRecordIds],
  };
};

const averageMetricDeltas = (
  sourceExamples: readonly CodaliFineTuneSourceExample[],
): CodaliFineTuneScorecardMetricDelta[] => {
  const byMetric = new Map<string, number[]>();
  for (const example of sourceExamples) {
    for (const delta of example.scorecard.metricDeltas) {
      if (delta.delta === undefined) continue;
      const values = byMetric.get(delta.metric) ?? [];
      values.push(delta.delta);
      byMetric.set(delta.metric, values);
    }
  }
  return [...byMetric.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([metric, values]) => ({
      metric,
      delta: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)),
    }));
};

const buildScorecardSummary = (
  sourceExamples: readonly CodaliFineTuneSourceExample[],
): CodaliFineTuneScorecardSummary => {
  const missingRecordIds = sourceExamples
    .filter((example) => !example.scorecard.present)
    .map((example) => example.recordId)
    .sort();
  const scorecardIds = sourceExamples
    .filter((example) => example.scorecard.present)
    .map((example) => example.scorecard.scorecardId)
    .sort();
  return {
    required: true,
    bypassAllowed: false,
    examplesWithScorecards: scorecardIds.length,
    missingRecordIds,
    scorecardIds,
    averageMetricDeltas: averageMetricDeltas(sourceExamples),
  };
};

const inventorySourceFor = (
  input: BuildCodaliFineTuneJobPlannerBundleInput,
): CodaliFineTuneInventorySource => {
  if (input.inventorySource) return input.inventorySource;
  if (input.inventory) {
    return {
      source: "provided",
      status: "succeeded",
      inventoryCount: input.inventory.length,
    };
  }
  return {
    source: "not_provided",
    command: DEFAULT_INVENTORY_COMMAND.command,
    args: [...DEFAULT_INVENTORY_COMMAND.args],
    status: "not_run",
    inventoryCount: 0,
  };
};

const summarizeAssignment = (
  resolverRole: string,
  assignment: CodaliGatewayAgentAssignment,
): CodaliFineTuneTargetAssignmentSummary => ({
  resolverRole,
  agentSlug: assignment.candidate.slug,
  adapter: assignment.candidate.adapter,
  ...(assignment.candidate.provider ? { provider: assignment.candidate.provider } : {}),
  model: assignment.candidate.model,
  source: assignment.candidate.source,
  tier: assignment.candidate.tier,
  runtimeHealth: {
    status: assignment.candidate.healthStatus,
    ...(assignment.candidate.latencyMs !== undefined ? {
      latencyMs: assignment.candidate.latencyMs,
    } : {}),
  },
  capabilities: assignment.candidate.capabilities,
  ...(assignment.candidate.contextWindow !== undefined ? {
    contextWindow: assignment.candidate.contextWindow,
  } : {}),
  ...(assignment.candidate.costPerMillion !== undefined ? {
    costPerMillion: assignment.candidate.costPerMillion,
  } : {}),
  score: Number(assignment.score.toFixed(6)),
  reasons: [...assignment.reasons],
});

const resolveTarget = (
  input: BuildCodaliFineTuneJobPlannerBundleInput,
  role: CodaliFineTuneWorkerRole,
): CodaliFineTuneTargetResolution => {
  const spec = roleSpecFor(role);
  const inventory = input.inventory ?? [];
  const inventorySource = inventorySourceFor(input);
  const refreshWarnings = input.inventoryWarnings ?? [];
  let resolution: AgentTierResolution | undefined;
  if (inventory.length > 0) {
    resolution = resolveCodaliGatewayAgentTiers({
      inventory,
      roles: [spec.resolverRole],
      allowImageWorker: false,
    });
  }
  const assignment = resolution?.assignments[spec.resolverRole];
  return {
    source: {
      ...inventorySource,
      inventoryCount: inventorySource.inventoryCount ?? inventory.length,
    },
    status: assignment ? "resolved" : "unresolved",
    resolverRole: spec.resolverRole,
    ...(inventory.length > 0 ? {
      inventorySnapshotHash: `sha256:${sha256Hex(inventory).slice(0, 24)}`,
    } : {}),
    inventoryCount: inventory.length,
    ...(assignment ? { assignment: summarizeAssignment(spec.resolverRole, assignment) } : {}),
    diagnostics: resolution?.diagnostics ?? [],
    warnings: resolution?.warnings ?? [],
    errors: resolution?.errors ?? (
      inventory.length === 0
        ? [{
            code: "GATEWAY_AGENT_INVENTORY_EMPTY",
            message: "No mcoda agent candidates were available to resolve fine-tune target.",
            role: spec.resolverRole,
          }]
        : []
    ),
    refreshWarnings,
  };
};

const buildEvalCommands = (
  role: CodaliFineTuneWorkerRole,
  trainingManifest: CodaliFineTuneTrainingManifest,
  scorecardSummary: CodaliFineTuneScorecardSummary,
): CodaliFineTuneEvalCommandSpec[] => [
  {
    commandId: stableId("fine-tune-eval-command", {
      kind: "phase-27-run-tests",
      role,
      manifestId: trainingManifest.manifestId,
    }),
    command: "docdexd",
    args: [
      "run-tests",
      "--repo",
      "<repo>",
      "--target",
      "packages/codali/src/improvement/__tests__/FineTuneJobPlanner.test.ts",
    ],
    dryRunSafe: true,
    expectedScorecards: scorecardSummary.scorecardIds,
    scorecardBypassAllowed: false,
  },
  {
    commandId: stableId("fine-tune-eval-command", {
      kind: "phase-27-pre-commit",
      role,
      manifestId: trainingManifest.manifestId,
    }),
    command: "docdexd",
    args: [
      "hook",
      "pre-commit",
      "--repo",
      "<repo>",
    ],
    dryRunSafe: true,
    expectedScorecards: [],
    scorecardBypassAllowed: false,
  },
];

const buildEvalPlan = (
  role: CodaliFineTuneWorkerRole,
  trainingManifest: CodaliFineTuneTrainingManifest,
  scorecardSummary: CodaliFineTuneScorecardSummary,
  targetResolution: CodaliFineTuneTargetResolution,
  blockedReasons: readonly string[],
): CodaliFineTuneEvalPlan => ({
  planId: stableId("fine-tune-eval-plan", {
    role,
    manifestId: trainingManifest.manifestId,
    scorecardIds: scorecardSummary.scorecardIds,
  }),
  scorecardRequired: true,
  bypassAllowed: false,
  scorecardIds: scorecardSummary.scorecardIds,
  gates: [
    {
      gateId: stableId("fine-tune-gate", {
        role,
        manifestId: trainingManifest.manifestId,
        type: "privacy",
      }),
      type: "privacy",
      required: true,
      passed:
        trainingManifest.rowCount > 0 &&
        trainingManifest.excludedTrainingBlockedRecordIds.length === 0,
      reasons: trainingManifest.excludedTrainingBlockedRecordIds.length
        ? ["training_allowed_required"]
        : [],
    },
    {
      gateId: stableId("fine-tune-gate", {
        role,
        manifestId: trainingManifest.manifestId,
        type: "scorecard",
      }),
      type: "scorecard",
      required: true,
      passed:
        scorecardSummary.missingRecordIds.length === 0 &&
        scorecardSummary.examplesWithScorecards === trainingManifest.rowCount &&
        trainingManifest.rowCount > 0,
      reasons: scorecardSummary.missingRecordIds.length
        ? ["scorecard_required"]
        : [],
    },
    {
      gateId: stableId("fine-tune-gate", {
        role,
        manifestId: trainingManifest.manifestId,
        type: "target_health",
      }),
      type: "target_health",
      required: true,
      passed: targetResolution.status === "resolved",
      reasons: targetResolution.status === "resolved" ? [] : ["target_resolution_required"],
    },
    {
      gateId: stableId("fine-tune-gate", {
        role,
        manifestId: trainingManifest.manifestId,
        type: "offline_eval",
      }),
      type: "offline_eval",
      required: true,
      passed: !blockedReasons.includes("scorecard_required") && trainingManifest.rowCount > 0,
      reasons: blockedReasons.includes("scorecard_required")
        ? ["scorecard_required"]
        : [],
    },
  ],
  commands: buildEvalCommands(role, trainingManifest, scorecardSummary),
});

const buildCostEstimate = (
  trainingManifest: CodaliFineTuneTrainingManifest,
  targetResolution: CodaliFineTuneTargetResolution,
): CodaliFineTuneCostEstimate => {
  const costPerMillionTokens = targetResolution.assignment?.costPerMillion;
  const estimatedProviderCostUsd = costPerMillionTokens === undefined
    ? undefined
    : Number(((trainingManifest.totalTokenEstimate / 1_000_000) * costPerMillionTokens)
      .toFixed(6));
  return {
    source: costPerMillionTokens === undefined ? "not_available" : "mcoda_inventory",
    currency: "USD",
    estimatedTrainingTokens: trainingManifest.totalTokenEstimate,
    ...(costPerMillionTokens !== undefined ? { costPerMillionTokens } : {}),
    ...(estimatedProviderCostUsd !== undefined ? { estimatedProviderCostUsd } : {}),
    notes: costPerMillionTokens === undefined
      ? ["target cost data was not present in the mcoda inventory snapshot"]
      : ["estimate uses mcoda inventory cost_per_million and manifest token estimate"],
  };
};

const providerSubmissionPolicy = (): CodaliFineTuneProviderSubmissionPolicy => ({
  automaticSubmission: false,
  approvalRequired: true,
  status: "not_submitted",
  runnerStatus: "not_approved",
  blocker: "provider_specific_runners_not_approved",
});

const buildRollbackPlan = (
  role: CodaliFineTuneWorkerRole,
  trainingManifest: CodaliFineTuneTrainingManifest,
): CodaliFineTuneRollbackPlan => ({
  planId: stableId("fine-tune-rollback-plan", {
    role,
    manifestId: trainingManifest.manifestId,
  }),
  automaticProviderJobSubmitted: false,
  triggers: [
    "scorecard_regression",
    "target_health_regression",
    "privacy_policy_revocation",
  ],
  steps: [
    "do_not_submit_provider_job_without_runner_approval",
    "remove_candidate_manifest_from improvement queue",
    "restore previous worker target assignment",
    "rerun scorecards before any later provider submission",
  ],
});

const blockedReasonsFor = (
  input: {
    role: CodaliFineTuneWorkerRole;
    exportKind: CodaliStorageExportKind;
    trainingManifest: CodaliFineTuneTrainingManifest;
    scorecardSummary: CodaliFineTuneScorecardSummary;
    targetResolution: CodaliFineTuneTargetResolution;
  },
): string[] => normalizedUniqueSorted([
  input.role === CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE
    ? "final_synthesizer_fine_tune_disabled_by_default"
    : undefined,
  supportedExportForRole(input.role, input.exportKind)
    ? undefined
    : "export_kind_not_supported_for_role",
  input.trainingManifest.rowCount === 0 ? "no_training_allowed_examples" : undefined,
  input.trainingManifest.excludedTrainingBlockedRecordIds.length > 0
    ? "training_allowed_required"
    : undefined,
  input.scorecardSummary.examplesWithScorecards === input.trainingManifest.rowCount &&
    input.trainingManifest.rowCount > 0 &&
    input.scorecardSummary.missingRecordIds.length === 0
    ? undefined
    : "scorecard_required",
  input.targetResolution.status === "resolved" ? undefined : "target_resolution_required",
]);

const buildJobSpec = (
  input: {
    inspection: DatasetExportManifestReaderResult;
    role: CodaliFineTuneWorkerRole;
    jobKind: CodaliFineTuneJobKind;
    trainingManifest: CodaliFineTuneTrainingManifest;
    targetResolution: CodaliFineTuneTargetResolution;
    scorecardSummary: CodaliFineTuneScorecardSummary;
    evalPlan: CodaliFineTuneEvalPlan;
    costEstimate: CodaliFineTuneCostEstimate;
    rollbackPlan: CodaliFineTuneRollbackPlan;
    providerSubmission: CodaliFineTuneProviderSubmissionPolicy;
    blockedReasons: readonly string[];
  },
): CodaliFineTuneJobSpec => {
  const jobPlanId = stableId("fine-tune-job-plan", {
    role: input.role,
    sourceManifestId: input.inspection.manifest.manifestId,
    trainingManifestId: input.trainingManifest.manifestId,
    policyHash: input.trainingManifest.reproducibleFrom.policyHash,
  });
  return {
    jobSpecId: stableId("fine-tune-job-spec", {
      jobPlanId,
      targetSnapshot: input.targetResolution.inventorySnapshotHash,
      targetSlug: input.targetResolution.assignment?.agentSlug,
    }),
    jobPlanId,
    status: input.blockedReasons.length ? "blocked" : "draft",
    jobKind: input.jobKind,
    role: input.role,
    targetResolution: input.targetResolution,
    trainingManifest: input.trainingManifest,
    datasetLineage: input.inspection.manifest.lineage,
    privacySummary: input.inspection.manifest.privacySummary,
    scorecardSummary: input.scorecardSummary,
    evalPlan: input.evalPlan,
    costEstimate: input.costEstimate,
    rollbackPlan: input.rollbackPlan,
    providerSubmission: input.providerSubmission,
  };
};

const buildCandidateSummary = (
  input: {
    inspection: DatasetExportManifestReaderResult;
    role: CodaliFineTuneWorkerRole;
    jobKind: CodaliFineTuneJobKind;
    sourceExamples: readonly CodaliFineTuneSourceExample[];
    jobSpecs: readonly CodaliFineTuneJobSpec[];
    blockedReasons: readonly string[];
  },
): CodaliFineTuneImprovementCandidateSummary => ({
  candidateId: stableId("fine-tune-candidate", {
    role: input.role,
    sourceManifestId: input.inspection.manifest.manifestId,
    sourceRecordIds: input.sourceExamples.map((example) => example.recordId),
    jobSpecIds: input.jobSpecs.map((spec) => spec.jobSpecId),
    blockedReasons: input.blockedReasons,
  }),
  candidateKind: "fine_tune_job_spec",
  status: input.blockedReasons.length ? "blocked" : "proposed",
  role: input.role,
  jobKind: input.jobKind,
  sourceExportIds: [input.inspection.manifest.manifestId],
  sourceRecordIds: input.sourceExamples.map((example) => example.recordId),
  artifactIds: input.inspection.manifest.artifactRefs.map((ref) => ref.refId),
  exampleCount: input.sourceExamples.length,
  objectBytes: input.inspection.manifest.artifactRefs
    .reduce((total, ref) => total + ref.byteSize, 0),
  jobSpecIds: input.jobSpecs.map((spec) => spec.jobSpecId),
  blockedReasons: [...input.blockedReasons],
  scorecardRequired: true,
  providerSubmissionEnabled: false,
});

export const buildCodaliFineTuneJobPlannerBundle = ({
  inspection,
  role = "extractor",
  artifact = CODALI_FINE_TUNE_PROPOSAL_ARTIFACT,
  ...input
}: BuildCodaliFineTuneJobPlannerBundleInput): CodaliFineTuneJobPlannerBundle => {
  const jobKind = jobKindForExportKind(inspection.manifest.exportKind);
  const { sourceExamples, excludedTrainingBlockedRecordIds } = buildSourceExampleSet(inspection);
  const trainingManifest = buildTrainingManifest(
    inspection,
    role,
    jobKind,
    sourceExamples,
    excludedTrainingBlockedRecordIds,
  );
  const targetResolution = resolveTarget({ inspection, role, artifact, ...input }, role);
  const scorecardSummary = buildScorecardSummary(sourceExamples);
  const providerSubmission = providerSubmissionPolicy();
  const initialBlockedReasons = blockedReasonsFor({
    role,
    exportKind: inspection.manifest.exportKind,
    trainingManifest,
    scorecardSummary,
    targetResolution,
  });
  const evalPlan = buildEvalPlan(
    role,
    trainingManifest,
    scorecardSummary,
    targetResolution,
    initialBlockedReasons,
  );
  const costEstimate = buildCostEstimate(trainingManifest, targetResolution);
  const rollbackPlan = buildRollbackPlan(role, trainingManifest);
  const blockedReasons = blockedReasonsFor({
    role,
    exportKind: inspection.manifest.exportKind,
    trainingManifest,
    scorecardSummary,
    targetResolution,
  });
  const jobSpecs = role === CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE
    ? []
    : [
        buildJobSpec({
          inspection,
          role,
          jobKind,
          trainingManifest,
          targetResolution,
          scorecardSummary,
          evalPlan,
          costEstimate,
          rollbackPlan,
          providerSubmission,
          blockedReasons,
        }),
      ];
  return {
    schemaVersion: CODALI_FINE_TUNE_JOB_PLANNER_SCHEMA_VERSION,
    artifact,
    source: {
      exportId: inspection.exportId,
      manifestId: inspection.manifest.manifestId,
      manifestPath: inspection.manifestPath,
      exportKind: inspection.manifest.exportKind,
      checksum: inspection.manifest.checksum,
      recordCount: inspection.manifest.recordCount,
      primaryArtifactRef: summarizeObjectRef(
        inspection.primaryArtifact?.ref ?? inspection.manifest.artifactRefs[0],
      ),
    },
    generationPolicy: {
      deterministic: true,
      modifiesRuntimePrompts: false,
      modifiesRuntimeCode: false,
      bodyPolicy: "object_refs_and_hashes_only",
      uploadEnabled: false,
      providerSubmissionEnabled: false,
      scorecardRequired: true,
      scorecardBypassAllowed: false,
      finalSynthesizerFineTuning: false,
    },
    expectedShape: {
      schemaVersion: CODALI_FINE_TUNE_JOB_PLANNER_SCHEMA_VERSION,
      artifact,
      requiredFields: [
        "sourceExamples",
        "trainingManifest",
        "targetResolution",
        "scorecardSummary",
        "evalPlan",
        "costEstimate",
        "rollbackPlan",
        "providerSubmission",
        "jobSpecs",
      ],
      jobSpecRequiredFields: [
        "targetResolution",
        "trainingManifest",
        "datasetLineage",
        "privacySummary",
        "evalPlan",
        "costEstimate",
        "rollbackPlan",
        "providerSubmission",
      ],
    },
    rolePolicy: {
      role,
      resolverRole: roleSpecFor(role).resolverRole,
      allowedWorkerRole: role !== CODALI_FINE_TUNE_FINAL_SYNTHESIZER_ROLE,
      supportedExportKinds: [...roleSpecFor(role).supportedExportKinds],
      finalSynthesizerAllowed: false,
      providerAutoSubmitAllowed: false,
    },
    sourceExamples,
    trainingManifest,
    targetResolution,
    scorecardSummary,
    evalPlan,
    costEstimate,
    rollbackPlan,
    providerSubmission,
    jobSpecs,
    rejectedEvidence: inspection.curationReport.rejected,
    candidates: [
      buildCandidateSummary({
        inspection,
        role,
        jobKind,
        sourceExamples,
        jobSpecs,
        blockedReasons,
      }),
    ],
  };
};
