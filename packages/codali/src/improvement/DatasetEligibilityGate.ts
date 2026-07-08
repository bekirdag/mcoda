import { createHash } from "node:crypto";
import {
  type CodaliStorageExportKind,
  type CodaliStorageExportManifest,
  type CodaliStorageObjectRef,
  type CodaliStoragePrivacyMetadata,
} from "../storage/CodaliStorageContracts.js";
import {
  evaluateCodaliDatasetObjectPayloadRead,
  type CodaliDatasetPrivacyPurpose,
} from "../storage/CodaliDatasetPrivacyEngine.js";

export const CODALI_IMPROVEMENT_ELIGIBILITY_GATE_SCHEMA_VERSION =
  "codali.improvement.eligibility_gate.v1" as const;

export type DatasetEligibilityGateReasonCode =
  | "artifact_privacy_read_disallowed"
  | "artifact_type_missing"
  | "artifact_type_not_allowed"
  | "deletion_group_revoked"
  | "duplicate_lineage"
  | "privacy_metadata_missing"
  | "row_invalid"
  | "row_privacy_read_disallowed";

export type DatasetEligibilityGateWarningCode =
  | "artifact_payload_read_blocked"
  | "duplicate_lineage_dropped"
  | "lineage_revoked"
  | "no_accepted_examples";

export type DatasetEligibilityGatePreferenceSignal =
  | "human_reviewed"
  | "accepted_correction"
  | "high_confidence"
  | "strong_negative";

export interface DatasetEligibilityGateReason {
  code: DatasetEligibilityGateReasonCode;
  message: string;
  path?: string;
  details?: Record<string, unknown>;
}

export interface DatasetEligibilityGateWarning {
  code: DatasetEligibilityGateWarningCode;
  message: string;
  recordId?: string;
  dedupeKey?: string;
  details?: Record<string, unknown>;
}

export interface DatasetEligibilityGateAcceptedExample {
  recordId: string;
  sourceGatewayRecordId?: string;
  dedupeKey: string;
  lineageKey: DatasetEligibilityLineageKey;
  deletionGroupIds: string[];
  runIds: string[];
  artifactTypes: string[];
  preferenceSignals: DatasetEligibilityGatePreferenceSignal[];
  priorityScore: number;
}

export interface DatasetEligibilityGateRejectedExample {
  targetType: "artifact" | "example";
  recordId?: string;
  dedupeKey?: string;
  reasons: DatasetEligibilityGateReason[];
}

export interface DatasetEligibilityGateReport {
  schemaVersion: typeof CODALI_IMPROVEMENT_ELIGIBILITY_GATE_SCHEMA_VERSION;
  exportId: string;
  manifestId: string;
  exportKind: CodaliStorageExportKind;
  artifactReadAllowed: boolean;
  lineageValid: boolean;
  totalExamples: number;
  acceptedCount: number;
  rejectedCount: number;
  warningCount: number;
  acceptedRecordIds: string[];
  rejectedRecordIds: string[];
  reasonCounts: Record<string, number>;
  accepted: DatasetEligibilityGateAcceptedExample[];
  rejected: DatasetEligibilityGateRejectedExample[];
  warnings: DatasetEligibilityGateWarning[];
}

export interface DatasetEligibilityLineageKey {
  runIds: string[];
  deletionGroupIds: string[];
  taskHash?: string;
  promptHash?: string;
  toolContractHash?: string;
  expectedTargetHash?: string;
}

export interface DatasetEligibilityGateInput {
  exportId?: string;
  manifest: CodaliStorageExportManifest;
  primaryArtifactRef: CodaliStorageObjectRef;
  rows?: readonly unknown[];
  allowedArtifactTypes?: readonly string[];
  revokedDeletionGroupIds?: readonly string[];
}

interface ParsedExample {
  record: Record<string, unknown>;
  recordId: string;
  sourceGatewayRecordId?: string;
  refs: CodaliStorageObjectRef[];
  privacy?: CodaliStoragePrivacyMetadata;
  artifactTypes: string[];
  lineageKey: DatasetEligibilityLineageKey;
  dedupeKey: string;
  preferenceSignals: DatasetEligibilityGatePreferenceSignal[];
  priorityScore: number;
  reasons: DatasetEligibilityGateReason[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

const uniqueSorted = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))))
    .sort();

const normalizeToken = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s-]+/g, "_");

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

const refRecord = (value: unknown): CodaliStorageObjectRef | undefined =>
  isRecord(value) &&
  typeof value.refId === "string" &&
  typeof value.contentHash === "string" &&
  typeof value.deletionGroupId === "string" &&
  isRecord(value.privacyFlags)
    ? value as unknown as CodaliStorageObjectRef
    : undefined;

const refsForExample = (record: Record<string, unknown>): CodaliStorageObjectRef[] => {
  const refs = [
    refRecord(record.inputRef),
    refRecord(record.outputRef),
    ...recordList(record.evidenceRefs).map((entry) => refRecord(entry)),
  ];
  return refs.filter((ref): ref is CodaliStorageObjectRef => Boolean(ref));
};

const privacyForExample = (
  record: Record<string, unknown>,
): CodaliStoragePrivacyMetadata | undefined =>
  isRecord(record.privacy)
    ? record.privacy as unknown as CodaliStoragePrivacyMetadata
    : undefined;

const labelsForExample = (record: Record<string, unknown>): string[] => {
  const quality = isRecord(record.quality) ? record.quality : undefined;
  const labels = Array.isArray(quality?.labels) ? quality.labels : [];
  return labels
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    .map(normalizeToken);
};

const metadataForExample = (record: Record<string, unknown>): Record<string, unknown> =>
  isRecord(record.metadata) ? record.metadata : {};

const refMetadataToken = (
  ref: CodaliStorageObjectRef,
  keys: readonly string[],
): string | undefined => readString(isRecord(ref.metadata) ? ref.metadata : undefined, keys);

const explicitArtifactTypesForExample = (
  record: Record<string, unknown>,
  refs: readonly CodaliStorageObjectRef[],
): string[] => uniqueSorted([
  readString(metadataForExample(record), [
    "artifactType",
    "artifact_type",
    "exampleType",
    "example_type",
  ]),
  ...refs.map((ref) => refMetadataToken(ref, ["artifactType", "artifact_type"])),
]).map(normalizeToken);

const artifactTypesForExportKind = (
  exportKind: CodaliStorageExportKind,
): string[] => {
  const normalized = normalizeToken(exportKind);
  if (exportKind === "prompt-regression") return [normalized, "prompt"];
  if (exportKind === "eval-replay") return [normalized, "eval_replay", "replay"];
  if (exportKind.endsWith("-sft")) return [normalized, "sft", "training"];
  return [normalized];
};

const artifactTypesForExample = (
  record: Record<string, unknown>,
  refs: readonly CodaliStorageObjectRef[],
  manifest: CodaliStorageExportManifest,
): string[] => uniqueSorted([
  ...explicitArtifactTypesForExample(record, refs),
  ...artifactTypesForExportKind(manifest.exportKind),
  ...refs.flatMap((ref) => [
    ref.kind,
    ref.mediaType,
    ref.mimeType,
    refMetadataToken(ref, ["artifactType", "artifact_type", "part"]),
  ]),
]).map(normalizeToken);

const artifactFilterTypesForExample = (
  record: Record<string, unknown>,
  refs: readonly CodaliStorageObjectRef[],
  manifest: CodaliStorageExportManifest,
): string[] => {
  const explicitTypes = explicitArtifactTypesForExample(record, refs);
  return explicitTypes.length > 0
    ? explicitTypes
    : artifactTypesForExportKind(manifest.exportKind).map(normalizeToken);
};

const extractNestedHash = (
  metadata: Record<string, unknown>,
  directKeys: readonly string[],
  nestedKeys: readonly string[],
): string | undefined => {
  const direct = readString(metadata, directKeys);
  if (direct) return direct;
  for (const key of nestedKeys) {
    const nested = metadata[key];
    if (!isRecord(nested)) continue;
    const hash = readString(nested, ["hash", "contentHash", "content_hash"]);
    if (hash) return hash;
  }
  return undefined;
};

const lineageKeyForExample = (
  record: Record<string, unknown>,
  refs: readonly CodaliStorageObjectRef[],
  manifest: CodaliStorageExportManifest,
): DatasetEligibilityLineageKey => {
  const metadata = metadataForExample(record);
  const recordId = readString(record, ["recordId", "record_id"]) ?? "";
  return {
    runIds: uniqueSorted([
      readString(metadata, ["runId", "run_id"]),
      ...refs.map((ref) => ref.ownerScope?.runId),
    ]),
    deletionGroupIds: uniqueSorted([
      ...(manifest.deletionGroupSnapshot.byRecordId[recordId] ?? []),
      ...refs.map((ref) => ref.deletionGroupId),
      readString(metadata, ["deletionGroupId", "deletion_group_id"]),
    ]),
    taskHash: extractNestedHash(
      metadata,
      ["taskHash", "task_hash"],
      ["task", "taskMetadata", "task_metadata"],
    ),
    promptHash: extractNestedHash(
      metadata,
      ["promptHash", "prompt_hash"],
      ["prompt", "promptMetadata", "prompt_metadata"],
    ) ?? refs[0]?.contentHash,
    toolContractHash: extractNestedHash(
      metadata,
      ["toolContractHash", "tool_contract_hash"],
      ["toolContract", "tool_contract", "toolMetadata", "tool_metadata"],
    ),
    expectedTargetHash: extractNestedHash(
      metadata,
      ["expectedTargetHash", "expected_target_hash", "targetHash", "target_hash"],
      ["expectedTarget", "expected_target", "target"],
    ) ?? refs.find((ref) => ref !== refs[0])?.contentHash,
  };
};

const dedupeKeyForLineage = (
  lineageKey: DatasetEligibilityLineageKey,
  recordId: string,
): string => {
  const hasLineage =
    lineageKey.runIds.length > 0 ||
    lineageKey.deletionGroupIds.length > 0 ||
    Boolean(lineageKey.taskHash) ||
    Boolean(lineageKey.promptHash) ||
    Boolean(lineageKey.toolContractHash) ||
    Boolean(lineageKey.expectedTargetHash);
  return `lineage-${sha256Hex(JSON.stringify(hasLineage
    ? lineageKey
    : { recordId })).slice(0, 24)}`;
};

const hasLabel = (labels: readonly string[], tokens: readonly string[]): boolean =>
  labels.some((label) => tokens.some((token) => label.includes(token)));

const preferenceSignalsForExample = (
  record: Record<string, unknown>,
): DatasetEligibilityGatePreferenceSignal[] => {
  const quality = isRecord(record.quality) ? record.quality : {};
  const metadata = metadataForExample(record);
  const labels = labelsForExample(record);
  const score = readNumber(quality, ["score"]);
  const confidence = normalizeToken(readString(metadata, [
    "confidence",
    "confidenceBucket",
    "confidence_bucket",
  ]) ?? "");
  const signals: DatasetEligibilityGatePreferenceSignal[] = [];
  const humanReviewed =
    readBoolean(quality, ["reviewed"]) === true ||
    Boolean(readString(metadata, ["reviewId", "review_id", "reviewerId", "reviewer_id"])) ||
    hasLabel(labels, ["human_reviewed", "reviewed", "review_approved", "review_gold"]);
  if (humanReviewed) signals.push("human_reviewed");
  const acceptedCorrection =
    readBoolean(metadata, ["acceptedCorrection", "accepted_correction"]) === true ||
    hasLabel(labels, [
      "accepted_correction",
      "correction_accepted",
      "review_accepted",
      "review_approved",
    ]) ||
    ["accepted", "approved"].includes(normalizeToken(readString(metadata, [
      "reviewDecision",
      "review_decision",
      "correctionDecision",
      "correction_decision",
    ]) ?? ""));
  if (acceptedCorrection) signals.push("accepted_correction");
  if (
    confidence === "high" ||
    hasLabel(labels, ["confidence_high", "high_confidence"]) ||
    (score !== undefined && score >= 0.8)
  ) {
    signals.push("high_confidence");
  }
  const negativeStrength = readNumber(metadata, [
    "negativeExampleStrength",
    "negative_example_strength",
  ]);
  if (
    readBoolean(metadata, ["strongNegative", "strong_negative"]) === true ||
    hasLabel(labels, ["strong_negative", "negative_strong", "hard_negative"]) ||
    negativeStrength !== undefined && negativeStrength >= 0.8
  ) {
    signals.push("strong_negative");
  }
  return Array.from(new Set(signals));
};

const priorityScoreForExample = (
  record: Record<string, unknown>,
  signals: readonly DatasetEligibilityGatePreferenceSignal[],
): number => {
  const quality = isRecord(record.quality) ? record.quality : {};
  const score = readNumber(quality, ["score"]) ?? 0;
  return (
    (signals.includes("human_reviewed") ? 1_000 : 0) +
    (signals.includes("accepted_correction") ? 800 : 0) +
    (signals.includes("high_confidence") ? 500 : 0) +
    (signals.includes("strong_negative") ? 400 : 0) +
    Math.round(score * 100)
  );
};

const purposesForExportKind = (
  exportKind: CodaliStorageExportKind,
): Array<Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">> => {
  const purposes: Array<Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">> =
    ["export"];
  if (exportKind === "eval-replay") purposes.push("eval", "replay");
  if (exportKind.endsWith("-sft")) purposes.push("training");
  return purposes;
};

const reasonFromBlocker = (
  code: DatasetEligibilityGateReasonCode,
  message: string,
  blocker: { code: string; path?: string },
  details: Record<string, unknown>,
): DatasetEligibilityGateReason => ({
  code,
  message,
  ...(blocker.path ? { path: blocker.path } : {}),
  details: {
    ...details,
    privacyCode: blocker.code,
  },
});

export const evaluateDatasetExportArtifactPayloadRead = (
  manifest: CodaliStorageExportManifest,
  primaryArtifactRef: CodaliStorageObjectRef,
): DatasetEligibilityGateReason[] => {
  if (!manifest.privacy) {
    return [{
      code: "privacy_metadata_missing",
      message: "Export manifest privacy metadata is required before artifact payload reads.",
      path: "$.privacy",
    }];
  }
  const decision = evaluateCodaliDatasetObjectPayloadRead(
    "export",
    primaryArtifactRef,
    manifest.privacy,
  );
  if (decision.allowed) return [];
  return decision.blockers.map((blocker) =>
    reasonFromBlocker(
      "artifact_privacy_read_disallowed",
      blocker.message,
      blocker,
      {
        purpose: "export",
        refId: primaryArtifactRef.refId,
      },
    ));
};

const revokedDeletionGroupIds = (
  manifest: CodaliStorageExportManifest,
  explicitIds: readonly string[] | undefined,
): string[] => {
  const metadata = isRecord(manifest.metadata) ? manifest.metadata : {};
  const snapshot = manifest.deletionGroupSnapshot as unknown;
  const snapshotRecord = isRecord(snapshot) ? snapshot : {};
  return uniqueSorted([
    ...(explicitIds ?? []),
    ...stringList(metadata.revokedDeletionGroupIds),
    ...stringList(metadata.revoked_deletion_group_ids),
    ...recordList(metadata.deletionGroupRevocations)
      .map((entry) => readString(entry, ["deletionGroupId", "deletion_group_id"])),
    ...stringList(snapshotRecord.revokedDeletionGroupIds),
    ...stringList(snapshotRecord.revoked_deletion_group_ids),
  ]);
};

const artifactTypeReasons = (
  artifactTypes: readonly string[],
  allowedArtifactTypes: readonly string[] | undefined,
): DatasetEligibilityGateReason[] => {
  if (!allowedArtifactTypes || allowedArtifactTypes.length === 0) return [];
  const allowed = new Set(allowedArtifactTypes.map(normalizeToken));
  if (artifactTypes.length === 0) {
    return [{
      code: "artifact_type_missing",
      message: "Example artifact type is required by the curation filter.",
      path: "$.metadata.artifactType",
      details: {
        allowedArtifactTypes: [...allowed].sort(),
      },
    }];
  }
  if (artifactTypes.some((type) => allowed.has(type))) return [];
  return [{
    code: "artifact_type_not_allowed",
    message: "Example artifact type is not allowed by the curation filter.",
    path: "$.metadata.artifactType",
    details: {
      artifactTypes,
      allowedArtifactTypes: [...allowed].sort(),
    },
  }];
};

const parseExample = (
  row: unknown,
  index: number,
  input: DatasetEligibilityGateInput,
  revokedIds: Set<string>,
): ParsedExample => {
  const record = isRecord(row) ? row : {};
  const recordId = readString(record, ["recordId", "record_id"]) ?? `row-${index + 1}`;
  const sourceGatewayRecordId = readString(record, [
    "sourceGatewayRecordId",
    "source_gateway_record_id",
  ]);
  const refs = refsForExample(record);
  const privacy = privacyForExample(record);
  const reasons: DatasetEligibilityGateReason[] = [];
  if (!isRecord(row)) {
    reasons.push({
      code: "row_invalid",
      message: "Curated example row must be an object.",
      path: `$[${index}]`,
    });
  }
  if (!readString(record, ["recordId", "record_id"])) {
    reasons.push({
      code: "row_invalid",
      message: "Curated example row must include a record id.",
      path: `$[${index}].recordId`,
    });
  }
  if (refs.length === 0) {
    reasons.push({
      code: "row_invalid",
      message: "Curated example row must include at least one object ref.",
      path: `$[${index}].inputRef`,
    });
  }
  if (!privacy) {
    reasons.push({
      code: "privacy_metadata_missing",
      message: "Curated example privacy metadata is required before row object reads.",
      path: `$[${index}].privacy`,
    });
  }
  if (privacy) {
    for (const purpose of purposesForExportKind(input.manifest.exportKind)) {
      for (const ref of refs) {
        const decision = evaluateCodaliDatasetObjectPayloadRead(purpose, ref, privacy);
        if (!decision.allowed) {
          reasons.push(...decision.blockers.map((blocker) =>
            reasonFromBlocker(
              "row_privacy_read_disallowed",
              blocker.message,
              blocker,
              {
                purpose,
                refId: ref.refId,
                recordId,
              },
            )));
        }
      }
    }
  }
  const artifactTypes = artifactTypesForExample(record, refs, input.manifest);
  const artifactFilterTypes = artifactFilterTypesForExample(record, refs, input.manifest);
  reasons.push(...artifactTypeReasons(artifactFilterTypes, input.allowedArtifactTypes));
  const lineageKey = lineageKeyForExample(record, refs, input.manifest);
  const revokedForExample = lineageKey.deletionGroupIds.filter((id) => revokedIds.has(id));
  if (revokedForExample.length > 0) {
    reasons.push({
      code: "deletion_group_revoked",
      message: "Example lineage references a revoked deletion group.",
      path: "$.deletionGroupSnapshot",
      details: {
        deletionGroupIds: revokedForExample,
      },
    });
  }
  const dedupeKey = dedupeKeyForLineage(lineageKey, recordId);
  const preferenceSignals = preferenceSignalsForExample(record);
  return {
    record,
    recordId,
    ...(sourceGatewayRecordId ? { sourceGatewayRecordId } : {}),
    refs,
    privacy,
    artifactTypes,
    lineageKey,
    dedupeKey,
    preferenceSignals,
    priorityScore: priorityScoreForExample(record, preferenceSignals),
    reasons,
  };
};

const rejectedExample = (
  parsed: ParsedExample,
  reasons: DatasetEligibilityGateReason[],
): DatasetEligibilityGateRejectedExample => ({
  targetType: "example",
  recordId: parsed.recordId,
  dedupeKey: parsed.dedupeKey,
  reasons,
});

const reasonCounts = (
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const item of rejected) {
    for (const reason of item.reasons) {
      counts[reason.code] = (counts[reason.code] ?? 0) + 1;
    }
  }
  return counts;
};

export class DatasetEligibilityGate {
  curate(input: DatasetEligibilityGateInput): DatasetEligibilityGateReport {
    const exportId = input.exportId?.trim() || input.manifest.manifestId;
    const artifactReadReasons = evaluateDatasetExportArtifactPayloadRead(
      input.manifest,
      input.primaryArtifactRef,
    );
    const warnings: DatasetEligibilityGateWarning[] = [];
    const rejected: DatasetEligibilityGateRejectedExample[] = [];
    if (artifactReadReasons.length > 0) {
      rejected.push({
        targetType: "artifact",
        recordId: input.primaryArtifactRef.refId,
        reasons: artifactReadReasons,
      });
      warnings.push({
        code: "artifact_payload_read_blocked",
        message: "Primary export artifact payload was not read because privacy metadata disallowed it.",
        details: {
          refId: input.primaryArtifactRef.refId,
        },
      });
    }

    const rows = artifactReadReasons.length === 0 ? input.rows ?? [] : [];
    const revokedIds = new Set(revokedDeletionGroupIds(
      input.manifest,
      input.revokedDeletionGroupIds,
    ));
    const parsedRows = rows.map((row, index) =>
      parseExample(row, index, input, revokedIds));
    const eligibleRows: ParsedExample[] = [];
    for (const parsed of parsedRows) {
      if (parsed.reasons.length > 0) {
        rejected.push(rejectedExample(parsed, parsed.reasons));
      } else {
        eligibleRows.push(parsed);
      }
    }

    const accepted: DatasetEligibilityGateAcceptedExample[] = [];
    const byDedupeKey = new Map<string, ParsedExample[]>();
    for (const parsed of eligibleRows) {
      const group = byDedupeKey.get(parsed.dedupeKey) ?? [];
      group.push(parsed);
      byDedupeKey.set(parsed.dedupeKey, group);
    }
    for (const [dedupeKey, group] of byDedupeKey.entries()) {
      const sorted = [...group].sort((left, right) =>
        right.priorityScore - left.priorityScore ||
        left.recordId.localeCompare(right.recordId));
      const winner = sorted[0];
      if (!winner) continue;
      accepted.push({
        recordId: winner.recordId,
        ...(winner.sourceGatewayRecordId ? {
          sourceGatewayRecordId: winner.sourceGatewayRecordId,
        } : {}),
        dedupeKey,
        lineageKey: winner.lineageKey,
        deletionGroupIds: winner.lineageKey.deletionGroupIds,
        runIds: winner.lineageKey.runIds,
        artifactTypes: winner.artifactTypes,
        preferenceSignals: winner.preferenceSignals,
        priorityScore: winner.priorityScore,
      });
      for (const duplicate of sorted.slice(1)) {
        rejected.push(rejectedExample(duplicate, [{
          code: "duplicate_lineage",
          message: "Example duplicates an already accepted lineage key.",
          details: {
            acceptedRecordId: winner.recordId,
            dedupeKey,
            lineageKey: duplicate.lineageKey,
          },
        }]));
        warnings.push({
          code: "duplicate_lineage_dropped",
          message: "Duplicate lineage example was rejected during curation.",
          recordId: duplicate.recordId,
          dedupeKey,
          details: {
            acceptedRecordId: winner.recordId,
          },
        });
      }
    }

    accepted.sort((left, right) =>
      right.priorityScore - left.priorityScore ||
      left.recordId.localeCompare(right.recordId));
    const lineageValid = !rejected.some((item) =>
      item.reasons.some((reason) => reason.code === "deletion_group_revoked"));
    if (!lineageValid) {
      warnings.push({
        code: "lineage_revoked",
        message: "At least one curated example references a revoked deletion group.",
      });
    }
    if (artifactReadReasons.length === 0 && rows.length > 0 && accepted.length === 0) {
      warnings.push({
        code: "no_accepted_examples",
        message: "No examples passed the improvement eligibility gate.",
      });
    }

    return {
      schemaVersion: CODALI_IMPROVEMENT_ELIGIBILITY_GATE_SCHEMA_VERSION,
      exportId,
      manifestId: input.manifest.manifestId,
      exportKind: input.manifest.exportKind,
      artifactReadAllowed: artifactReadReasons.length === 0,
      lineageValid,
      totalExamples: rows.length,
      acceptedCount: accepted.length,
      rejectedCount: rejected.length,
      warningCount: warnings.length,
      acceptedRecordIds: accepted.map((item) => item.recordId),
      rejectedRecordIds: rejected
        .map((item) => item.recordId)
        .filter((value): value is string => Boolean(value)),
      reasonCounts: reasonCounts(rejected),
      accepted,
      rejected,
      warnings,
    };
  }
}

export const curateDatasetExportForImprovement = (
  input: DatasetEligibilityGateInput,
): DatasetEligibilityGateReport => new DatasetEligibilityGate().curate(input);
