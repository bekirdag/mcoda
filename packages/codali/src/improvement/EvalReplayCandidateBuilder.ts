import { createHash } from "node:crypto";
import {
  type CodaliStorageDatasetKind,
  type CodaliStorageExportKind,
  type CodaliStorageObjectPrivacyFlags,
  type CodaliStorageObjectRef,
} from "../storage/CodaliStorageContracts.js";
import { CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION } from "../storage/DatasetExportJob.js";
import type {
  DatasetEligibilityGateAcceptedExample,
  DatasetEligibilityGateRejectedExample,
  DatasetEligibilityGateReason,
} from "./DatasetEligibilityGate.js";
import type { DatasetExportManifestReaderResult } from "./DatasetExportManifestReader.js";

export const CODALI_EVAL_REPLAY_CANDIDATE_SCHEMA_VERSION =
  "codali.improvement.eval_replay_candidate.v1" as const;

export type CodaliEvalReplayProposalArtifact = "eval";

export interface CodaliEvalReplayObjectRefSummary {
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

export interface CodaliEvalReplayRecordShape {
  requiredFields: string[];
  optionalRefFields: string[];
  presentFields: string[];
  missingRequiredFields: string[];
  bodyPolicy: "object_refs_only";
}

export interface CodaliEvalReplayRecordRefSummary {
  recordId: string;
  datasetKind?: CodaliStorageDatasetKind;
  sourceGatewayRecordId?: string;
  inputRef?: CodaliEvalReplayObjectRefSummary;
  outputRef?: CodaliEvalReplayObjectRefSummary;
  evidenceRefs: CodaliEvalReplayObjectRefSummary[];
  quality?: {
    score?: number;
    reviewed?: boolean;
    labels: string[];
  };
  metadataShape: {
    keys: string[];
    evalStage?: string;
    exampleType?: string;
    role?: string;
    tool?: string;
    sourceType?: string;
  };
  expectedShape: CodaliEvalReplayRecordShape;
}

export interface CodaliEvalReplayAcceptedEvidence {
  recordId: string;
  sourceGatewayRecordId?: string;
  lineageKey: DatasetEligibilityGateAcceptedExample["lineageKey"];
  deletionGroupIds: string[];
  runIds: string[];
  artifactTypes: string[];
  preferenceSignals: string[];
  priorityScore: number;
  recordShape: CodaliEvalReplayRecordShape;
  objectRefs: {
    inputRef?: CodaliEvalReplayObjectRefSummary;
    outputRef?: CodaliEvalReplayObjectRefSummary;
    evidenceRefs: CodaliEvalReplayObjectRefSummary[];
  };
}

export interface CodaliEvalReplayRejectedEvidence {
  targetType: DatasetEligibilityGateRejectedExample["targetType"];
  recordId?: string;
  dedupeKey?: string;
  failureLabels: string[];
  reasons: Array<{
    code: string;
    message: string;
    path?: string;
    details?: Record<string, unknown>;
  }>;
}

export interface CodaliEvalReplayExpectedShape {
  schemaVersion: typeof CODALI_EVAL_REPLAY_CANDIDATE_SCHEMA_VERSION;
  artifact: CodaliEvalReplayProposalArtifact;
  evalFixture: {
    requiredFields: string[];
    caseRequiredFields: string[];
    evidenceFields: string[];
    bodyPolicy: "object_refs_only";
  };
  replayFixture: {
    schemaVersion: typeof CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION;
    requiredFields: string[];
    recordRequiredFields: string[];
    bodyPolicy: "object_refs_only";
  };
}

export interface CodaliEvalFixtureCandidate {
  fixtureId: string;
  sourceExportId: string;
  caseCount: number;
  cases: Array<{
    caseId: string;
    sourceRecordId: string;
    datasetKind?: CodaliStorageDatasetKind;
    expectedShape: CodaliEvalReplayRecordShape;
    acceptedEvidenceRecordId: string;
    rejectedEvidenceRecordIds: string[];
    failureLabels: string[];
    objectRefs: {
      inputRef?: CodaliEvalReplayObjectRefSummary;
      outputRef?: CodaliEvalReplayObjectRefSummary;
      evidenceRefs: CodaliEvalReplayObjectRefSummary[];
    };
  }>;
}

export interface CodaliReplayFixtureCandidate {
  fixtureId: string;
  schemaVersion: typeof CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION;
  sourceExportId: string;
  exportKind: CodaliStorageExportKind;
  generatedAt: string;
  bodyStorage: "object_ref" | "record_refs_only";
  bodyRef?: CodaliEvalReplayObjectRefSummary;
  recordCount: number;
  records: CodaliEvalReplayRecordRefSummary[];
}

export interface CodaliEvalReplayImprovementCandidateSummary {
  candidateId: string;
  candidateKind: "eval_replay";
  status: "proposed" | "blocked";
  fixtureIds: {
    evalFixtureId: string;
    replayFixtureId: string;
  };
  sourceExportIds: string[];
  sourceRecordIds: string[];
  artifactIds: string[];
  exampleCount: number;
  objectBytes: number;
  failureLabels: string[];
}

export interface CodaliEvalReplayCandidateBundle {
  schemaVersion: typeof CODALI_EVAL_REPLAY_CANDIDATE_SCHEMA_VERSION;
  artifact: CodaliEvalReplayProposalArtifact;
  source: {
    exportId: string;
    manifestId: string;
    manifestPath: string;
    exportKind: CodaliStorageExportKind;
    checksum: string;
    recordCount: number;
    primaryArtifactRef: CodaliEvalReplayObjectRefSummary;
    replayFixtureRef?: CodaliEvalReplayObjectRefSummary;
  };
  generationPolicy: {
    deterministic: true;
    modifiesRuntimePrompts: false;
    modifiesRuntimeCode: false;
    bodyPolicy: "object_refs_only";
  };
  expectedShape: CodaliEvalReplayExpectedShape;
  fixtureIds: {
    evalFixtureId: string;
    replayFixtureId: string;
  };
  acceptedEvidence: CodaliEvalReplayAcceptedEvidence[];
  rejectedEvidence: CodaliEvalReplayRejectedEvidence[];
  failureLabels: string[];
  evalFixture: CodaliEvalFixtureCandidate;
  replayFixture: CodaliReplayFixtureCandidate;
  candidates: CodaliEvalReplayImprovementCandidateSummary[];
}

export interface BuildCodaliEvalReplayCandidateBundleInput {
  inspection: DatasetExportManifestReaderResult;
  artifact?: CodaliEvalReplayProposalArtifact;
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

const uniqueSorted = (values: Array<string | undefined>): string[] =>
  Array.from(new Set(values
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))))
    .sort();

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
  key: string,
): number | undefined => {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const readBoolean = (
  record: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined => {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

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

const summarizeObjectRef = (
  ref: CodaliStorageObjectRef,
): CodaliEvalReplayObjectRefSummary => ({
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

const refsForRow = (row: unknown): {
  inputRef?: CodaliStorageObjectRef;
  outputRef?: CodaliStorageObjectRef;
  evidenceRefs: CodaliStorageObjectRef[];
} => {
  const record = isRecord(row) ? row : {};
  const evidenceRefs = Array.isArray(record.evidenceRefs)
    ? record.evidenceRefs.map(objectRefFromValue)
      .filter((ref): ref is CodaliStorageObjectRef => Boolean(ref))
    : [];
  return {
    inputRef: objectRefFromValue(record.inputRef),
    outputRef: objectRefFromValue(record.outputRef),
    evidenceRefs,
  };
};

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

const expectedRecordShape = (row: unknown): CodaliEvalReplayRecordShape => {
  const presentFields = isRecord(row) ? Object.keys(row).sort() : [];
  const requiredFields = ["datasetKind", "inputRef", "privacy", "recordId"];
  return {
    requiredFields,
    optionalRefFields: ["outputRef", "evidenceRefs"],
    presentFields,
    missingRequiredFields: requiredFields
      .filter((field) => !presentFields.includes(field)),
    bodyPolicy: "object_refs_only",
  };
};

const metadataShapeForRow = (
  row: Record<string, unknown>,
): CodaliEvalReplayRecordRefSummary["metadataShape"] => {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return {
    keys: Object.keys(metadata).sort(),
    ...(readString(metadata, ["evalStage", "eval_stage", "gatewayEvalStage", "gateway_eval_stage"])
      ? { evalStage: readString(metadata, ["evalStage", "eval_stage", "gatewayEvalStage", "gateway_eval_stage"]) }
      : {}),
    ...(readString(metadata, ["exampleType", "example_type"])
      ? { exampleType: readString(metadata, ["exampleType", "example_type"]) }
      : {}),
    ...(readString(metadata, ["role"]) ? { role: readString(metadata, ["role"]) } : {}),
    ...(readString(metadata, ["tool"]) ? { tool: readString(metadata, ["tool"]) } : {}),
    ...(readString(metadata, ["sourceType", "source_type"])
      ? { sourceType: readString(metadata, ["sourceType", "source_type"]) }
      : {}),
  };
};

const summarizeRecordRow = (
  row: Record<string, unknown>,
): CodaliEvalReplayRecordRefSummary => {
  const refs = refsForRow(row);
  const quality = isRecord(row.quality) ? row.quality : undefined;
  return {
    recordId: readString(row, ["recordId", "record_id"]) ?? "unknown-record",
    ...(readString(row, ["datasetKind", "dataset_kind"])
      ? { datasetKind: readString(row, ["datasetKind", "dataset_kind"]) as CodaliStorageDatasetKind }
      : {}),
    ...(readString(row, ["sourceGatewayRecordId", "source_gateway_record_id"])
      ? { sourceGatewayRecordId: readString(row, ["sourceGatewayRecordId", "source_gateway_record_id"]) }
      : {}),
    ...(refs.inputRef ? { inputRef: summarizeObjectRef(refs.inputRef) } : {}),
    ...(refs.outputRef ? { outputRef: summarizeObjectRef(refs.outputRef) } : {}),
    evidenceRefs: refs.evidenceRefs.map(summarizeObjectRef),
    ...(quality ? {
      quality: {
        score: readNumber(quality, "score"),
        reviewed: readBoolean(quality, "reviewed"),
        labels: stringList(quality.labels).sort(),
      },
    } : {}),
    metadataShape: metadataShapeForRow(row),
    expectedShape: expectedRecordShape(row),
  };
};

const failureLabelsForReasons = (
  reasons: readonly DatasetEligibilityGateReason[],
): string[] => uniqueSorted(reasons.map((reason) => reason.code));

const rejectedEvidence = (
  rejected: readonly DatasetEligibilityGateRejectedExample[],
): CodaliEvalReplayRejectedEvidence[] =>
  rejected.map((item) => ({
    targetType: item.targetType,
    ...(item.recordId ? { recordId: item.recordId } : {}),
    ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
    failureLabels: failureLabelsForReasons(item.reasons),
    reasons: item.reasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
      ...(reason.path ? { path: reason.path } : {}),
      ...(reason.details ? { details: reason.details } : {}),
    })),
  }));

const acceptedEvidence = (
  accepted: readonly DatasetEligibilityGateAcceptedExample[],
  rowMap: ReadonlyMap<string, Record<string, unknown>>,
): CodaliEvalReplayAcceptedEvidence[] =>
  accepted.map((item) => {
    const row = rowMap.get(item.recordId);
    const refs = refsForRow(row);
    return {
      recordId: item.recordId,
      ...(item.sourceGatewayRecordId ? { sourceGatewayRecordId: item.sourceGatewayRecordId } : {}),
      lineageKey: item.lineageKey,
      deletionGroupIds: item.deletionGroupIds,
      runIds: item.runIds,
      artifactTypes: item.artifactTypes,
      preferenceSignals: item.preferenceSignals,
      priorityScore: item.priorityScore,
      recordShape: expectedRecordShape(row),
      objectRefs: {
        ...(refs.inputRef ? { inputRef: summarizeObjectRef(refs.inputRef) } : {}),
        ...(refs.outputRef ? { outputRef: summarizeObjectRef(refs.outputRef) } : {}),
        evidenceRefs: refs.evidenceRefs.map(summarizeObjectRef),
      },
    };
  });

const allFailureLabels = (
  inspection: DatasetExportManifestReaderResult,
): string[] => {
  const curationLabels = inspection.curationReport.rejected
    .flatMap((item) => item.reasons.map((reason) => reason.code));
  const warningLabels = inspection.warnings.map((warning) => warning.code);
  return uniqueSorted([
    ...curationLabels,
    ...warningLabels,
    inspection.curationReport.acceptedCount === 0 ? "no_accepted_examples" : undefined,
    inspection.manifest.exportKind !== "eval-replay" ? "export_kind_not_eval_replay" : undefined,
    inspection.curationReport.artifactReadAllowed ? undefined : "artifact_payload_read_blocked",
    inspection.curationReport.lineageValid ? undefined : "lineage_invalid",
  ]);
};

const replayFixtureRefForInspection = (
  inspection: DatasetExportManifestReaderResult,
): CodaliStorageObjectRef | undefined =>
  inspection.manifest.artifactRefs.find((ref) => {
    const metadata = isRecord(ref.metadata) ? ref.metadata : {};
    return readString(metadata, ["artifactType", "artifact_type"]) === "replay_fixture";
  });

const primaryArtifactRefForInspection = (
  inspection: DatasetExportManifestReaderResult,
): CodaliStorageObjectRef => {
  const ref = inspection.primaryArtifact?.ref ?? inspection.manifest.artifactRefs[0];
  if (!ref) {
    throw new Error("CODALI_EVAL_REPLAY_PRIMARY_ARTIFACT_MISSING");
  }
  return ref;
};

const expectedShape = (
  artifact: CodaliEvalReplayProposalArtifact,
): CodaliEvalReplayExpectedShape => ({
  schemaVersion: CODALI_EVAL_REPLAY_CANDIDATE_SCHEMA_VERSION,
  artifact,
  evalFixture: {
    requiredFields: [
      "fixtureId",
      "cases",
      "acceptedEvidence",
      "rejectedEvidence",
      "failureLabels",
    ],
    caseRequiredFields: [
      "caseId",
      "sourceRecordId",
      "expectedShape",
      "objectRefs",
    ],
    evidenceFields: [
      "recordId",
      "lineageKey",
      "artifactTypes",
      "preferenceSignals",
    ],
    bodyPolicy: "object_refs_only",
  },
  replayFixture: {
    schemaVersion: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
    requiredFields: ["fixtureId", "schemaVersion", "records"],
    recordRequiredFields: ["recordId", "datasetKind", "inputRef"],
    bodyPolicy: "object_refs_only",
  },
});

const objectBytesForRecords = (
  rows: readonly Record<string, unknown>[],
  replayFixtureRef: CodaliStorageObjectRef | undefined,
): number => {
  const refs = new Map<string, CodaliStorageObjectRef>();
  for (const row of rows) {
    const rowRefs = refsForRow(row);
    for (const ref of [
      rowRefs.inputRef,
      rowRefs.outputRef,
      ...rowRefs.evidenceRefs,
    ]) {
      if (ref) refs.set(`${ref.refId}:${ref.contentHash}`, ref);
    }
  }
  if (replayFixtureRef) {
    refs.set(`${replayFixtureRef.refId}:${replayFixtureRef.contentHash}`, replayFixtureRef);
  }
  return Array.from(refs.values())
    .reduce((total, ref) => total + ref.byteSize, 0);
};

export const buildCodaliEvalReplayCandidateBundle = (
  input: BuildCodaliEvalReplayCandidateBundleInput,
): CodaliEvalReplayCandidateBundle => {
  const artifact = input.artifact ?? "eval";
  const inspection = input.inspection;
  const rowMap = rowsByRecordId(inspection.primaryArtifactRows);
  const acceptedRows = inspection.curationReport.acceptedRecordIds
    .map((recordId) => rowMap.get(recordId))
    .filter((row): row is Record<string, unknown> => Boolean(row));
  const replayFixtureRef = replayFixtureRefForInspection(inspection);
  const failureLabels = allFailureLabels(inspection);
  const idSeed = {
    artifact,
    manifestId: inspection.manifest.manifestId,
    checksum: inspection.manifest.checksum,
    acceptedRecordIds: inspection.curationReport.acceptedRecordIds,
    failureLabels,
  };
  const evalFixtureId = stableId("eval-fixture", idSeed);
  const replayFixtureId = stableId("replay-fixture", {
    ...idSeed,
    replayFixtureContentHash: replayFixtureRef?.contentHash,
  });
  const candidateId = stableId("candidate", {
    ...idSeed,
    evalFixtureId,
    replayFixtureId,
  });
  const accepted = acceptedEvidence(inspection.curationReport.accepted, rowMap);
  const rejected = rejectedEvidence(inspection.curationReport.rejected);
  const replayRecords = acceptedRows.map(summarizeRecordRow);
  const evalCases = replayRecords.map((record) => ({
    caseId: stableId("eval-case", {
      evalFixtureId,
      recordId: record.recordId,
      inputHash: record.inputRef?.contentHash,
      outputHash: record.outputRef?.contentHash,
    }),
    sourceRecordId: record.recordId,
    ...(record.datasetKind ? { datasetKind: record.datasetKind } : {}),
    expectedShape: record.expectedShape,
    acceptedEvidenceRecordId: record.recordId,
    rejectedEvidenceRecordIds: rejected
      .filter((item) => item.recordId === record.recordId)
      .map((item) => item.recordId)
      .filter((recordId): recordId is string => Boolean(recordId)),
    failureLabels: rejected
      .filter((item) => item.recordId === record.recordId)
      .flatMap((item) => item.failureLabels),
    objectRefs: {
      ...(record.inputRef ? { inputRef: record.inputRef } : {}),
      ...(record.outputRef ? { outputRef: record.outputRef } : {}),
      evidenceRefs: record.evidenceRefs,
    },
  }));
  const candidateStatus: CodaliEvalReplayImprovementCandidateSummary["status"] =
    acceptedRows.length > 0 &&
    inspection.manifest.exportKind === "eval-replay" &&
    inspection.curationReport.artifactReadAllowed &&
    inspection.curationReport.lineageValid
      ? "proposed"
      : "blocked";

  return {
    schemaVersion: CODALI_EVAL_REPLAY_CANDIDATE_SCHEMA_VERSION,
    artifact,
    source: {
      exportId: inspection.exportId,
      manifestId: inspection.manifest.manifestId,
      manifestPath: inspection.manifestPath,
      exportKind: inspection.manifest.exportKind,
      checksum: inspection.manifest.checksum,
      recordCount: inspection.manifest.recordCount,
      primaryArtifactRef: summarizeObjectRef(primaryArtifactRefForInspection(inspection)),
      ...(replayFixtureRef ? { replayFixtureRef: summarizeObjectRef(replayFixtureRef) } : {}),
    },
    generationPolicy: {
      deterministic: true,
      modifiesRuntimePrompts: false,
      modifiesRuntimeCode: false,
      bodyPolicy: "object_refs_only",
    },
    expectedShape: expectedShape(artifact),
    fixtureIds: {
      evalFixtureId,
      replayFixtureId,
    },
    acceptedEvidence: accepted,
    rejectedEvidence: rejected,
    failureLabels,
    evalFixture: {
      fixtureId: evalFixtureId,
      sourceExportId: inspection.manifest.manifestId,
      caseCount: evalCases.length,
      cases: evalCases,
    },
    replayFixture: {
      fixtureId: replayFixtureId,
      schemaVersion: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
      sourceExportId: inspection.manifest.manifestId,
      exportKind: inspection.manifest.exportKind,
      generatedAt: inspection.manifest.createdAt,
      bodyStorage: replayFixtureRef ? "object_ref" : "record_refs_only",
      ...(replayFixtureRef ? { bodyRef: summarizeObjectRef(replayFixtureRef) } : {}),
      recordCount: replayRecords.length,
      records: replayRecords,
    },
    candidates: [{
      candidateId,
      candidateKind: "eval_replay",
      status: candidateStatus,
      fixtureIds: {
        evalFixtureId,
        replayFixtureId,
      },
      sourceExportIds: [inspection.manifest.manifestId],
      sourceRecordIds: inspection.curationReport.acceptedRecordIds,
      artifactIds: inspection.manifest.artifactRefs.map((ref) => ref.refId),
      exampleCount: acceptedRows.length,
      objectBytes: objectBytesForRecords(acceptedRows, replayFixtureRef),
      failureLabels,
    }],
  };
};
