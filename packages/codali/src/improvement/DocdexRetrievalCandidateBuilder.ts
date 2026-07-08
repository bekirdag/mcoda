import { createHash } from "node:crypto";
import type {
  CodaliStorageDatasetKind,
  CodaliStorageExportKind,
  CodaliStorageObjectPrivacyFlags,
  CodaliStorageObjectRef,
  CodaliStoragePrivacyMetadata,
} from "../storage/CodaliStorageContracts.js";
import type {
  DatasetEligibilityGateAcceptedExample,
  DatasetEligibilityGateRejectedExample,
} from "./DatasetEligibilityGate.js";
import type { DatasetExportManifestReaderResult } from "./DatasetExportManifestReader.js";

export const CODALI_DOCDEX_RETRIEVAL_CANDIDATE_SCHEMA_VERSION =
  "codali.improvement.docdex_retrieval_candidate.v1" as const;

export const CODALI_DOCDEX_RETRIEVAL_PROPOSAL_ARTIFACT =
  "docdex-retrieval" as const;

export const CODALI_DOCDEX_RETRIEVAL_SOURCE_ARTIFACT_TYPES = [
  "docdex_retrieval",
  "query_expander",
  "query_expander_sft",
  "rag_reranker",
  "rerank",
  "reranker",
  "retrieval",
  "freshness",
  "duplicate_detection",
  "source_selection",
] as const;

export const CODALI_DOCDEX_RETRIEVAL_SUPPORTED_EXPORT_KINDS = [
  "query-expander-sft",
  "rag-reranker",
] as const satisfies readonly CodaliStorageExportKind[];

export type CodaliDocdexRetrievalProposalArtifact =
  typeof CODALI_DOCDEX_RETRIEVAL_PROPOSAL_ARTIFACT;

export type CodaliDocdexRetrievalCandidateKind = "docdex_retrieval";

export type CodaliDocdexRetrievalRegressionKind =
  | "freshness"
  | "duplicate_detection"
  | "source_selection";

export interface CodaliDocdexRetrievalObjectRefSummary {
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

export interface CodaliDocdexRetrievalPrivacyScope {
  tenantScoped: boolean;
  broadReuseAllowed: boolean;
  rawTextAllowed: boolean;
  reasons: string[];
  policyTags: string[];
}

export interface CodaliDocdexRetrievalQueryVariant {
  variantId: string;
  queryHash: string;
  text?: string;
}

export interface CodaliDocdexRetrievalQuerySummary {
  queryHash: string;
  text?: string;
  storage: "inline_allowed" | "object_ref_or_hash_only";
  variants: CodaliDocdexRetrievalQueryVariant[];
}

export interface CodaliDocdexRetrievalSourceSelection {
  sourceHashes: string[];
  sourceIds?: string[];
  sourceTypes: string[];
  selectedCount: number;
}

export interface CodaliDocdexRetrievalScorecard {
  recall?: {
    before?: number;
    after?: number;
    delta?: number;
  };
  precision?: {
    before?: number;
    after?: number;
    delta?: number;
  };
  freshness?: {
    before?: number;
    after?: number;
    delta?: number;
  };
}

export interface CodaliDocdexRetrievalSourceExample {
  recordId: string;
  sourceGatewayRecordId?: string;
  datasetKind?: CodaliStorageDatasetKind;
  artifactTypes: string[];
  preferenceSignals: string[];
  priorityScore: number;
  fineTuningPriority: "high" | "medium" | "low";
  lineageKey: DatasetEligibilityGateAcceptedExample["lineageKey"];
  privacyScope: CodaliDocdexRetrievalPrivacyScope;
  query: CodaliDocdexRetrievalQuerySummary;
  sourceSelection: CodaliDocdexRetrievalSourceSelection;
  scorecard: CodaliDocdexRetrievalScorecard;
  objectRefs: {
    inputRef?: CodaliDocdexRetrievalObjectRefSummary;
    outputRef?: CodaliDocdexRetrievalObjectRefSummary;
    evidenceRefs: CodaliDocdexRetrievalObjectRefSummary[];
  };
  metadataShape: {
    keys: string[];
    retrievalKeys: string[];
    scorecardKeys: string[];
  };
}

export interface CodaliDocdexQueryExpanderEvalCandidate {
  suiteId: string;
  sourceExportId: string;
  fineTuningPriority: {
    strategy: "human_reviewed_then_accepted_correction_then_high_confidence";
    orderedRecordIds: string[];
  };
  cases: Array<{
    caseId: string;
    sourceRecordId: string;
    query: CodaliDocdexRetrievalQuerySummary;
    expectedExpansionCount: number;
    expectedRecallDeltaMin?: number;
    privacyScope: CodaliDocdexRetrievalPrivacyScope;
    objectRefs: CodaliDocdexRetrievalSourceExample["objectRefs"];
  }>;
}

export interface CodaliDocdexRerankLabel {
  labelId: string;
  source: "accepted_evidence" | "rejected_evidence";
  label: "positive" | "negative";
  recordId?: string;
  dedupeKey?: string;
  queryHash?: string;
  sourceHashes: string[];
  reasonCodes: string[];
  weight: number;
}

export interface CodaliDocdexRetrievalRegressionCase {
  caseId: string;
  kind: CodaliDocdexRetrievalRegressionKind;
  sourceRecordIds: string[];
  assertion: string;
  queryHash?: string;
  sourceHashes: string[];
  reasonCodes: string[];
}

export interface CodaliDocdexEvalCommandSpec {
  commandId: string;
  command: "docdexd";
  args: string[];
  dryRunSafe: true;
  requiresTenantScopedFixture: boolean;
  expectedScorecards: Array<"recall" | "precision" | "freshness">;
}

export interface CodaliDocdexRetrievalImprovementCandidateSummary {
  candidateId: string;
  candidateKind: CodaliDocdexRetrievalCandidateKind;
  status: "proposed" | "blocked";
  sourceExportIds: string[];
  sourceRecordIds: string[];
  artifactIds: string[];
  exampleCount: number;
  objectBytes: number;
  queryExpanderCaseCount: number;
  rerankLabelCount: number;
  regressionCaseCount: number;
  blockedReasons: string[];
}

export interface CodaliDocdexRetrievalCandidateBundle {
  schemaVersion: typeof CODALI_DOCDEX_RETRIEVAL_CANDIDATE_SCHEMA_VERSION;
  artifact: CodaliDocdexRetrievalProposalArtifact;
  source: {
    exportId: string;
    manifestId: string;
    manifestPath: string;
    exportKind: CodaliStorageExportKind;
    checksum: string;
    recordCount: number;
    primaryArtifactRef: CodaliDocdexRetrievalObjectRefSummary;
  };
  generationPolicy: {
    deterministic: true;
    modifiesRuntimePrompts: false;
    modifiesRuntimeCode: false;
    bodyPolicy: "object_refs_and_hashes_only_for_private_sources";
    tenantPrivateExamplesScoped: true;
    uploadEnabled: false;
    finalSynthesizerFineTuning: false;
  };
  expectedShape: {
    schemaVersion: typeof CODALI_DOCDEX_RETRIEVAL_CANDIDATE_SCHEMA_VERSION;
    artifact: CodaliDocdexRetrievalProposalArtifact;
    requiredFields: string[];
    sourceExampleRequiredFields: string[];
    evalCommandRequiredFields: string[];
  };
  sourceExamples: CodaliDocdexRetrievalSourceExample[];
  queryExpanderEval: CodaliDocdexQueryExpanderEvalCandidate;
  rerankLabels: CodaliDocdexRerankLabel[];
  regressionCases: CodaliDocdexRetrievalRegressionCase[];
  docdexEvalCommands: CodaliDocdexEvalCommandSpec[];
  scorecardSummary: {
    recallDelta: number;
    precisionDelta: number;
    freshnessDelta: number;
  };
  candidates: CodaliDocdexRetrievalImprovementCandidateSummary[];
}

export interface BuildCodaliDocdexRetrievalCandidateBundleInput {
  inspection: DatasetExportManifestReaderResult;
  artifact?: CodaliDocdexRetrievalProposalArtifact;
}

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

const stringList = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
};

const objectList = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const metadataForRow = (row: Record<string, unknown> | undefined): Record<string, unknown> =>
  isRecord(row?.metadata) ? row.metadata : {};

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

const summarizeObjectRef = (
  ref: CodaliStorageObjectRef,
): CodaliDocdexRetrievalObjectRefSummary => ({
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

const privacyForRow = (
  row: Record<string, unknown> | undefined,
): CodaliStoragePrivacyMetadata | undefined =>
  isRecord(row?.privacy)
    ? row.privacy as unknown as CodaliStoragePrivacyMetadata
    : undefined;

const policyTagsForPrivacy = (
  privacy: CodaliStoragePrivacyMetadata | undefined,
): string[] => uniqueSorted(privacy?.policyTags ?? []);

const privateReasonCodes = (
  privacy: CodaliStoragePrivacyMetadata | undefined,
  refs: readonly CodaliStorageObjectRef[],
): string[] => {
  const reasons: string[] = [];
  if (privacy?.containsPersonalData) reasons.push("record_contains_personal_data");
  if (privacy?.exportAllowed !== true) reasons.push("record_export_not_allowed");
  if (refs.some((ref) => ref.privacyFlags.containsPersonalData)) {
    reasons.push("object_contains_personal_data");
  }
  if (refs.some((ref) => ref.privacyFlags.containsSecrets)) {
    reasons.push("object_contains_secrets");
  }
  if (refs.some((ref) => ref.privacyFlags.containsTenantPrivateData)) {
    reasons.push("object_contains_tenant_private_data");
  }
  if (refs.some((ref) => ref.privacyFlags.containsSourceCode)) {
    reasons.push("object_contains_source_code");
  }
  if (refs.some((ref) => ref.privacyFlags.containsCustomerData)) {
    reasons.push("object_contains_customer_data");
  }
  if (refs.some((ref) => ref.privacyFlags.exportAllowed !== true)) {
    reasons.push("object_export_not_allowed");
  }
  return uniqueSorted(reasons);
};

const privacyScopeFor = (
  row: Record<string, unknown> | undefined,
  refs: readonly CodaliStorageObjectRef[],
): CodaliDocdexRetrievalPrivacyScope => {
  const privacy = privacyForRow(row);
  const reasons = privateReasonCodes(privacy, refs);
  const broadReuseAllowed = reasons.length === 0 && privacy?.exportAllowed === true;
  return {
    tenantScoped: !broadReuseAllowed,
    broadReuseAllowed,
    rawTextAllowed: broadReuseAllowed,
    reasons,
    policyTags: policyTagsForPrivacy(privacy),
  };
};

const readRetrievalMetadata = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => nestedRecord(metadata, [
  "retrieval",
  "docdexRetrieval",
  "docdex_retrieval",
  "retrievalEvidence",
  "retrieval_evidence",
]);

const readScorecardMetadata = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
): Record<string, unknown> => {
  const topLevel = nestedRecord(metadata, ["scorecard", "retrievalScorecard", "docdexScorecard"]);
  return Object.keys(topLevel).length > 0
    ? topLevel
    : nestedRecord(retrieval, ["scorecard", "retrievalScorecard", "docdexScorecard"]);
};

const queryTextForRow = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
  row: Record<string, unknown> | undefined,
): string => readString(retrieval, [
  "query",
  "originalQuery",
  "original_query",
  "userQuery",
  "user_query",
  "searchQuery",
  "search_query",
]) ?? readString(metadata, [
  "query",
  "originalQuery",
  "original_query",
  "userQuery",
  "user_query",
  "searchQuery",
  "search_query",
]) ?? readString(row, ["query", "request"]) ?? `record:${recordIdForRow(row) ?? "unknown"}`;

const queryVariantsFor = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
): string[] => uniqueSorted([
  ...stringList(metadata.expandedQueries),
  ...stringList(metadata.expanded_queries),
  ...stringList(metadata.queryVariants),
  ...stringList(metadata.query_variants),
  ...stringList(retrieval.expandedQueries),
  ...stringList(retrieval.expanded_queries),
  ...stringList(retrieval.queryVariants),
  ...stringList(retrieval.query_variants),
]);

const buildQuerySummary = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
  row: Record<string, unknown> | undefined,
  privacyScope: CodaliDocdexRetrievalPrivacyScope,
): CodaliDocdexRetrievalQuerySummary => {
  const queryText = queryTextForRow(metadata, retrieval, row);
  const queryHash = `sha256:${sha256Hex(queryText)}`;
  const variants = queryVariantsFor(metadata, retrieval).map((variant) => ({
    variantId: stableId("query-variant", { queryHash, variant }),
    queryHash: `sha256:${sha256Hex(variant)}`,
    ...(privacyScope.rawTextAllowed ? { text: variant } : {}),
  }));
  return {
    queryHash,
    ...(privacyScope.rawTextAllowed ? { text: queryText } : {}),
    storage: privacyScope.rawTextAllowed ? "inline_allowed" : "object_ref_or_hash_only",
    variants,
  };
};

const sourceRecordsFor = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
): Record<string, unknown>[] => [
  ...objectList(metadata.selectedSources),
  ...objectList(metadata.selected_sources),
  ...objectList(metadata.sources),
  ...objectList(metadata.candidates),
  ...objectList(retrieval.selectedSources),
  ...objectList(retrieval.selected_sources),
  ...objectList(retrieval.sources),
  ...objectList(retrieval.candidates),
];

const sourceIdsFor = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
): string[] => uniqueSorted([
  ...stringList(metadata.selectedSources),
  ...stringList(metadata.selected_sources),
  ...stringList(metadata.sourceIds),
  ...stringList(metadata.source_ids),
  ...stringList(retrieval.selectedSources),
  ...stringList(retrieval.selected_sources),
  ...stringList(retrieval.sourceIds),
  ...stringList(retrieval.source_ids),
  ...sourceRecordsFor(metadata, retrieval).flatMap((source) => [
    readString(source, ["sourceId", "source_id", "docId", "doc_id", "path", "uri", "refId"]),
  ]),
]);

const sourceTypesFor = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
): string[] => normalizedUniqueSorted([
  ...stringList(metadata.sourceTypes),
  ...stringList(metadata.source_types),
  ...stringList(retrieval.sourceTypes),
  ...stringList(retrieval.source_types),
  ...sourceRecordsFor(metadata, retrieval).flatMap((source) => [
    readString(source, ["sourceType", "source_type", "kind", "type"]),
  ]),
]);

const sourceSelectionFor = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
  privacyScope: CodaliDocdexRetrievalPrivacyScope,
): CodaliDocdexRetrievalSourceSelection => {
  const sourceIds = sourceIdsFor(metadata, retrieval);
  return {
    sourceHashes: sourceIds.map((sourceId) => `sha256:${sha256Hex(sourceId)}`).sort(),
    ...(privacyScope.rawTextAllowed ? { sourceIds } : {}),
    sourceTypes: sourceTypesFor(metadata, retrieval),
    selectedCount: sourceIds.length,
  };
};

const metricDelta = (
  scorecard: Record<string, unknown>,
  metric: "recall" | "precision" | "freshness",
): CodaliDocdexRetrievalScorecard["recall"] => {
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
  return before !== undefined || after !== undefined || delta !== undefined
    ? {
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
        ...(delta !== undefined ? { delta } : {}),
      }
    : undefined;
};

const scorecardFor = (
  metadata: Record<string, unknown>,
  retrieval: Record<string, unknown>,
): CodaliDocdexRetrievalScorecard => {
  const scorecard = readScorecardMetadata(metadata, retrieval);
  return {
    ...(metricDelta(scorecard, "recall") ? { recall: metricDelta(scorecard, "recall") } : {}),
    ...(metricDelta(scorecard, "precision") ? { precision: metricDelta(scorecard, "precision") } : {}),
    ...(metricDelta(scorecard, "freshness") ? { freshness: metricDelta(scorecard, "freshness") } : {}),
  };
};

const fineTuningPriorityFor = (
  accepted: DatasetEligibilityGateAcceptedExample,
): CodaliDocdexRetrievalSourceExample["fineTuningPriority"] => {
  const signals = accepted.preferenceSignals.map(String);
  if (
    signals.includes("human_reviewed") ||
    signals.includes("accepted_correction") ||
    signals.includes("high_confidence") ||
    accepted.priorityScore >= 500
  ) {
    return "high";
  }
  return accepted.priorityScore >= 50 ? "medium" : "low";
};

const sourceExampleForAccepted = (
  accepted: DatasetEligibilityGateAcceptedExample,
  row: Record<string, unknown> | undefined,
): CodaliDocdexRetrievalSourceExample => {
  const refs = refsForRow(row);
  const allRefs = [refs.inputRef, refs.outputRef, ...refs.evidenceRefs]
    .filter((ref): ref is CodaliStorageObjectRef => Boolean(ref));
  const privacyScope = privacyScopeFor(row, allRefs);
  const metadata = metadataForRow(row);
  const retrieval = readRetrievalMetadata(metadata);
  const scorecard = readScorecardMetadata(metadata, retrieval);
  return {
    recordId: accepted.recordId,
    ...(accepted.sourceGatewayRecordId ? {
      sourceGatewayRecordId: accepted.sourceGatewayRecordId,
    } : {}),
    ...(isRecord(row) && typeof row.datasetKind === "string" ? {
      datasetKind: row.datasetKind as CodaliStorageDatasetKind,
    } : {}),
    artifactTypes: accepted.artifactTypes,
    preferenceSignals: accepted.preferenceSignals.map(String).sort(),
    priorityScore: accepted.priorityScore,
    fineTuningPriority: fineTuningPriorityFor(accepted),
    lineageKey: accepted.lineageKey,
    privacyScope,
    query: buildQuerySummary(metadata, retrieval, row, privacyScope),
    sourceSelection: sourceSelectionFor(metadata, retrieval, privacyScope),
    scorecard: scorecardFor(metadata, retrieval),
    objectRefs: {
      ...(refs.inputRef ? { inputRef: summarizeObjectRef(refs.inputRef) } : {}),
      ...(refs.outputRef ? { outputRef: summarizeObjectRef(refs.outputRef) } : {}),
      evidenceRefs: refs.evidenceRefs.map(summarizeObjectRef),
    },
    metadataShape: {
      keys: Object.keys(metadata).sort(),
      retrievalKeys: Object.keys(retrieval).sort(),
      scorecardKeys: Object.keys(scorecard).sort(),
    },
  };
};

const buildSourceExamples = (
  inspection: DatasetExportManifestReaderResult,
): CodaliDocdexRetrievalSourceExample[] => {
  const rowMap = rowsByRecordId(inspection.primaryArtifactRows);
  return inspection.curationReport.accepted
    .map((accepted) => sourceExampleForAccepted(accepted, rowMap.get(accepted.recordId)))
    .sort((left, right) =>
      right.priorityScore - left.priorityScore || left.recordId.localeCompare(right.recordId));
};

const averageDelta = (
  examples: readonly CodaliDocdexRetrievalSourceExample[],
  key: "recall" | "precision" | "freshness",
): number => {
  const deltas = examples
    .map((example) => example.scorecard[key]?.delta)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (deltas.length === 0) return 0;
  return Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(6));
};

const buildQueryExpanderEval = (
  inspection: DatasetExportManifestReaderResult,
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
): CodaliDocdexQueryExpanderEvalCandidate => {
  const orderedExamples = [...sourceExamples].sort(compareQueryExpanderPriority);
  return {
    suiteId: stableId("docdex-query-expander-suite", {
      manifestId: inspection.manifest.manifestId,
      recordIds: orderedExamples.map((example) => example.recordId),
    }),
    sourceExportId: inspection.manifest.manifestId,
    fineTuningPriority: {
      strategy: "human_reviewed_then_accepted_correction_then_high_confidence",
      orderedRecordIds: orderedExamples.map((example) => example.recordId),
    },
    cases: orderedExamples.map((example) => ({
      caseId: stableId("query-expander-case", {
        recordId: example.recordId,
        queryHash: example.query.queryHash,
      }),
      sourceRecordId: example.recordId,
      query: example.query,
      expectedExpansionCount: Math.max(1, example.query.variants.length),
      ...(example.scorecard.recall?.delta !== undefined ? {
        expectedRecallDeltaMin: example.scorecard.recall.delta,
      } : {}),
      privacyScope: example.privacyScope,
      objectRefs: example.objectRefs,
    })),
  };
};

const queryExpanderPriorityRank = (
  example: CodaliDocdexRetrievalSourceExample,
): number => {
  const signals = new Set(example.preferenceSignals);
  if (signals.has("human_reviewed")) return 6;
  if (signals.has("accepted_correction")) return 5;
  if (signals.has("high_confidence")) return 4;
  if (example.fineTuningPriority === "high") return 3;
  if (example.fineTuningPriority === "medium") return 2;
  return 1;
};

const compareQueryExpanderPriority = (
  left: CodaliDocdexRetrievalSourceExample,
  right: CodaliDocdexRetrievalSourceExample,
): number =>
  queryExpanderPriorityRank(right) - queryExpanderPriorityRank(left) ||
  right.priorityScore - left.priorityScore ||
  left.recordId.localeCompare(right.recordId);

const labelWeightForAccepted = (
  accepted: CodaliDocdexRetrievalSourceExample,
): number => Number(Math.max(0.1, accepted.priorityScore).toFixed(6));

const labelsFromAccepted = (
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
): CodaliDocdexRerankLabel[] => sourceExamples.map((example) => ({
  labelId: stableId("rerank-label", {
    source: "accepted",
    recordId: example.recordId,
    queryHash: example.query.queryHash,
  }),
  source: "accepted_evidence",
  label: "positive",
  recordId: example.recordId,
  queryHash: example.query.queryHash,
  sourceHashes: example.sourceSelection.sourceHashes,
  reasonCodes: ["accepted_evidence"],
  weight: labelWeightForAccepted(example),
}));

const labelsFromRejected = (
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): CodaliDocdexRerankLabel[] => rejected.map((item) => {
  const reasonCodes = uniqueSorted(item.reasons.map((reason) => reason.code));
  return {
    labelId: stableId("rerank-label", {
      source: "rejected",
      recordId: item.recordId,
      dedupeKey: item.dedupeKey,
      reasonCodes,
    }),
    source: "rejected_evidence",
    label: "negative",
    ...(item.recordId ? { recordId: item.recordId } : {}),
    ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
    sourceHashes: item.dedupeKey ? [`sha256:${sha256Hex(item.dedupeKey)}`] : [],
    reasonCodes,
    weight: reasonCodes.includes("duplicate_lineage") ? 0.9 : 0.6,
  };
});

const buildRerankLabels = (
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): CodaliDocdexRerankLabel[] => [
  ...labelsFromAccepted(sourceExamples),
  ...labelsFromRejected(rejected),
].sort((left, right) => left.labelId.localeCompare(right.labelId));

const freshnessRegressionCases = (
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
): CodaliDocdexRetrievalRegressionCase[] => sourceExamples
  .filter((example) =>
    example.scorecard.freshness?.delta !== undefined ||
    example.sourceSelection.sourceTypes.includes("fresh") ||
    example.sourceSelection.sourceTypes.includes("recent"))
  .map((example) => ({
    caseId: stableId("freshness-regression", {
      recordId: example.recordId,
      queryHash: example.query.queryHash,
    }),
    kind: "freshness",
    sourceRecordIds: [example.recordId],
    assertion: "fresh_sources_rank_above_stale_or_unknown_sources",
    queryHash: example.query.queryHash,
    sourceHashes: example.sourceSelection.sourceHashes,
    reasonCodes: ["freshness_scorecard"],
  }));

const sourceSelectionRegressionCases = (
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
): CodaliDocdexRetrievalRegressionCase[] => sourceExamples
  .filter((example) => example.sourceSelection.selectedCount > 0)
  .map((example) => ({
    caseId: stableId("source-selection-regression", {
      recordId: example.recordId,
      sourceHashes: example.sourceSelection.sourceHashes,
    }),
    kind: "source_selection",
    sourceRecordIds: [example.recordId],
    assertion: "selected_sources_must_support_query_intent",
    queryHash: example.query.queryHash,
    sourceHashes: example.sourceSelection.sourceHashes,
    reasonCodes: ["accepted_source_selection"],
  }));

const duplicateRegressionCases = (
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): CodaliDocdexRetrievalRegressionCase[] => rejected
  .filter((item) => item.reasons.some((reason) => reason.code === "duplicate_lineage"))
  .map((item) => ({
    caseId: stableId("duplicate-regression", {
      recordId: item.recordId,
      dedupeKey: item.dedupeKey,
    }),
    kind: "duplicate_detection",
    sourceRecordIds: item.recordId ? [item.recordId] : [],
    assertion: "duplicate_lineage_candidates_must_not_increase_recall_or_rerank_weight",
    sourceHashes: item.dedupeKey ? [`sha256:${sha256Hex(item.dedupeKey)}`] : [],
    reasonCodes: uniqueSorted(item.reasons.map((reason) => reason.code)),
  }));

const buildRegressionCases = (
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): CodaliDocdexRetrievalRegressionCase[] => [
  ...freshnessRegressionCases(sourceExamples),
  ...sourceSelectionRegressionCases(sourceExamples),
  ...duplicateRegressionCases(rejected),
].sort((left, right) => left.caseId.localeCompare(right.caseId));

const buildDocdexEvalCommands = (
  queryExpanderEval: CodaliDocdexQueryExpanderEvalCandidate,
  regressionCases: readonly CodaliDocdexRetrievalRegressionCase[],
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
): CodaliDocdexEvalCommandSpec[] => {
  const requiresTenantScopedFixture = sourceExamples.some((example) =>
    example.privacyScope.tenantScoped);
  const regressionSuiteId = stableId("docdex-retrieval-regression-suite", {
    querySuiteId: queryExpanderEval.suiteId,
    regressionCaseIds: regressionCases.map((testCase) => testCase.caseId),
  });
  return [
    {
      commandId: stableId("docdex-eval-command", {
        kind: "phase-26-run-tests",
        suiteId: queryExpanderEval.suiteId,
        regressionSuiteId,
      }),
      command: "docdexd",
      args: [
        "run-tests",
        "--repo",
        "<repo>",
        "--target",
        "packages/codali/src/improvement/__tests__/DocdexRetrievalCandidateBuilder.test.ts",
      ],
      dryRunSafe: true,
      requiresTenantScopedFixture,
      expectedScorecards: ["recall", "precision", "freshness"],
    },
    {
      commandId: stableId("docdex-eval-command", {
        kind: "phase-26-pre-commit",
        suiteId: regressionSuiteId,
      }),
      command: "docdexd",
      args: [
        "hook",
        "pre-commit",
        "--repo",
        "<repo>",
      ],
      dryRunSafe: true,
      requiresTenantScopedFixture: false,
      expectedScorecards: [],
    },
  ];
};

const blockedReasonsFor = (
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
  rerankLabels: readonly CodaliDocdexRerankLabel[],
  regressionCases: readonly CodaliDocdexRetrievalRegressionCase[],
): string[] => uniqueSorted([
  sourceExamples.length === 0 ? "no_accepted_retrieval_examples" : undefined,
  sourceExamples.some((example) => example.query.variants.length > 0)
    ? undefined
    : "no_query_expander_variants",
  rerankLabels.some((label) => label.label === "positive") &&
    rerankLabels.some((label) => label.label === "negative")
    ? undefined
    : "accepted_and_rejected_rerank_labels_required",
  regressionCases.some((testCase) => testCase.kind === "freshness")
    ? undefined
    : "freshness_regression_case_required",
  regressionCases.some((testCase) => testCase.kind === "duplicate_detection")
    ? undefined
    : "duplicate_detection_regression_case_required",
  regressionCases.some((testCase) => testCase.kind === "source_selection")
    ? undefined
    : "source_selection_regression_case_required",
]);

const buildCandidateSummary = (
  inspection: DatasetExportManifestReaderResult,
  sourceExamples: readonly CodaliDocdexRetrievalSourceExample[],
  rerankLabels: readonly CodaliDocdexRerankLabel[],
  regressionCases: readonly CodaliDocdexRetrievalRegressionCase[],
  blockedReasons: readonly string[],
): CodaliDocdexRetrievalImprovementCandidateSummary => ({
  candidateId: stableId("docdex-retrieval-candidate", {
    manifestId: inspection.manifest.manifestId,
    sourceRecordIds: sourceExamples.map((example) => example.recordId),
    rerankLabelIds: rerankLabels.map((label) => label.labelId),
    regressionCaseIds: regressionCases.map((testCase) => testCase.caseId),
  }),
  candidateKind: "docdex_retrieval",
  status: blockedReasons.length ? "blocked" : "proposed",
  sourceExportIds: [inspection.manifest.manifestId],
  sourceRecordIds: sourceExamples.map((example) => example.recordId),
  artifactIds: inspection.manifest.artifactRefs.map((ref) => ref.refId),
  exampleCount: sourceExamples.length,
  objectBytes: inspection.manifest.artifactRefs.reduce((total, ref) => total + ref.byteSize, 0),
  queryExpanderCaseCount: sourceExamples.length,
  rerankLabelCount: rerankLabels.length,
  regressionCaseCount: regressionCases.length,
  blockedReasons: [...blockedReasons],
});

export const buildCodaliDocdexRetrievalCandidateBundle = ({
  inspection,
  artifact = CODALI_DOCDEX_RETRIEVAL_PROPOSAL_ARTIFACT,
}: BuildCodaliDocdexRetrievalCandidateBundleInput): CodaliDocdexRetrievalCandidateBundle => {
  const sourceExamples = buildSourceExamples(inspection);
  const queryExpanderEval = buildQueryExpanderEval(inspection, sourceExamples);
  const rerankLabels = buildRerankLabels(sourceExamples, inspection.curationReport.rejected);
  const regressionCases = buildRegressionCases(sourceExamples, inspection.curationReport.rejected);
  const docdexEvalCommands = buildDocdexEvalCommands(
    queryExpanderEval,
    regressionCases,
    sourceExamples,
  );
  const blockedReasons = blockedReasonsFor(sourceExamples, rerankLabels, regressionCases);
  return {
    schemaVersion: CODALI_DOCDEX_RETRIEVAL_CANDIDATE_SCHEMA_VERSION,
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
      bodyPolicy: "object_refs_and_hashes_only_for_private_sources",
      tenantPrivateExamplesScoped: true,
      uploadEnabled: false,
      finalSynthesizerFineTuning: false,
    },
    expectedShape: {
      schemaVersion: CODALI_DOCDEX_RETRIEVAL_CANDIDATE_SCHEMA_VERSION,
      artifact,
      requiredFields: [
        "sourceExamples",
        "queryExpanderEval",
        "rerankLabels",
        "regressionCases",
        "docdexEvalCommands",
      ],
      sourceExampleRequiredFields: [
        "recordId",
        "privacyScope",
        "query",
        "sourceSelection",
        "scorecard",
        "objectRefs",
      ],
      evalCommandRequiredFields: [
        "command",
        "args",
        "dryRunSafe",
        "expectedScorecards",
      ],
    },
    sourceExamples,
    queryExpanderEval,
    rerankLabels,
    regressionCases,
    docdexEvalCommands,
    scorecardSummary: {
      recallDelta: averageDelta(sourceExamples, "recall"),
      precisionDelta: averageDelta(sourceExamples, "precision"),
      freshnessDelta: averageDelta(sourceExamples, "freshness"),
    },
    candidates: [
      buildCandidateSummary(
        inspection,
        sourceExamples,
        rerankLabels,
        regressionCases,
        blockedReasons,
      ),
    ],
  };
};
