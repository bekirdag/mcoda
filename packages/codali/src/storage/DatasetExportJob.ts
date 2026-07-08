import {
  CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
  CODALI_STORAGE_EXPORT_KINDS,
  validateCodaliStorageDatasetRecord,
  validateCodaliStorageExportManifest,
  type CodaliStorageDatasetRecord,
  type CodaliStorageExportDeletionGroupSnapshot,
  type CodaliStorageExportKind,
  type CodaliStorageExportLineage,
  type CodaliStorageExportManifest,
  type CodaliStorageExportManifestRecordRef,
  type CodaliStorageExportPrivacySummary,
  type CodaliStorageObjectPrivacyFlags,
  type CodaliStorageObjectRef,
  type CodaliStoragePrivacyMetadata,
} from "./CodaliStorageContracts.js";
import {
  evaluateCodaliDatasetObjectPayloadRead,
  type CodaliDatasetEligibilityBlocker,
  type CodaliDatasetPrivacyPurpose,
} from "./CodaliDatasetPrivacyEngine.js";
import {
  createGatewayDatasetLocalOnlyObjectPrivacyFlags,
  createGatewayDatasetLocalOnlyPrivacy,
  hashGatewayDatasetRequestBody,
  type GatewayDatasetObjectStore,
  type GatewayDatasetStorageScope,
} from "./GatewayDatasetStore.js";

export const CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION = "codali.dataset.export.job.v1" as const;
export const CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION =
  "codali.dataset.replay.fixture.v1" as const;

export const CODALI_DATASET_SFT_EXPORT_KINDS = CODALI_STORAGE_EXPORT_KINDS.filter(
  (kind): kind is Extract<CodaliStorageExportKind, `${string}-sft`> => kind.endsWith("-sft"),
);

export type CodaliDatasetExportStatus = "dry_run" | "exported" | "blocked";

export interface CodaliDatasetExportExclusionReason {
  recordId: string;
  code: string;
  message: string;
  purpose: CodaliDatasetPrivacyPurpose;
  path?: string;
}

export interface CodaliDatasetExportDryRunSummary {
  totalCount: number;
  eligibleCount: number;
  excludedCount: number;
  exclusionReasonCounts: Record<string, number>;
}

export interface CodaliDatasetExportJobInput {
  exportKind: CodaliStorageExportKind;
  records: CodaliStorageDatasetRecord[];
  objectStore: GatewayDatasetObjectStore;
  scope: GatewayDatasetStorageScope;
  dryRun?: boolean;
  generatedBy?: string;
  manifestId?: string;
  exportFormat?: "jsonl";
  now?: () => Date;
  metadata?: Record<string, unknown>;
}

export interface CodaliDatasetExportJobResult {
  schemaVersion: typeof CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION;
  accepted: boolean;
  status: CodaliDatasetExportStatus;
  dryRun: CodaliDatasetExportDryRunSummary;
  exportKind: CodaliStorageExportKind;
  exportFormat: "jsonl";
  manifest?: CodaliStorageExportManifest;
  manifestRef?: CodaliStorageObjectRef;
  jsonlRef?: CodaliStorageObjectRef;
  replayFixtureRef?: CodaliStorageObjectRef;
  exclusionReasons: CodaliDatasetExportExclusionReason[];
}

export class CodaliDatasetExportJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CodaliDatasetExportJobError";
    this.code = code;
  }
}

const isSftExportKind = (kind: CodaliStorageExportKind): boolean =>
  CODALI_DATASET_SFT_EXPORT_KINDS.includes(
    kind as Extract<CodaliStorageExportKind, `${string}-sft`>,
  );

const validateRecordOrThrow = (record: CodaliStorageDatasetRecord): CodaliStorageDatasetRecord => {
  const validation = validateCodaliStorageDatasetRecord(record);
  if (!validation.ok) {
    throw new CodaliDatasetExportJobError(
      "CODALI_DATASET_EXPORT_RECORD_INVALID",
      validation.issues
        .map((issue) => `${issue.path}:${issue.code}:${issue.message}`)
        .join("; "),
    );
  }
  return validation.value;
};

const refsForRecord = (record: CodaliStorageDatasetRecord): CodaliStorageObjectRef[] => [
  record.inputRef,
  ...(record.outputRef ? [record.outputRef] : []),
  ...(record.evidenceRefs ?? []),
];

const addReasonCounts = (
  counts: Record<string, number>,
  reasons: readonly CodaliDatasetExportExclusionReason[],
): void => {
  for (const reason of reasons) {
    counts[reason.code] = (counts[reason.code] ?? 0) + 1;
  }
};

const blockerToReason = (
  recordId: string,
  purpose: CodaliDatasetPrivacyPurpose,
  blocker: CodaliDatasetEligibilityBlocker,
): CodaliDatasetExportExclusionReason => ({
  recordId,
  purpose,
  code: blocker.code,
  message: blocker.message,
  ...(blocker.path ? { path: blocker.path } : {}),
});

const requiredReadPurposes = (
  exportKind: CodaliStorageExportKind,
): Array<Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">> => {
  const purposes: Array<Exclude<CodaliDatasetPrivacyPurpose, "durable_persistence">> = ["export"];
  if (exportKind === "eval-replay") purposes.push("eval", "replay");
  if (isSftExportKind(exportKind)) purposes.push("training");
  return purposes;
};

const evaluateRecordEligibility = (
  exportKind: CodaliStorageExportKind,
  record: CodaliStorageDatasetRecord,
): CodaliDatasetExportExclusionReason[] => {
  const reasons: CodaliDatasetExportExclusionReason[] = [];
  for (const purpose of requiredReadPurposes(exportKind)) {
    for (const ref of refsForRecord(record)) {
      const decision = evaluateCodaliDatasetObjectPayloadRead(purpose, ref, record.privacy);
      if (!decision.allowed) {
        reasons.push(...decision.blockers.map((blocker) =>
          blockerToReason(record.recordId, purpose, blocker)));
      }
    }
  }
  return reasons;
};

const mergeFlags = (
  current: CodaliStorageObjectPrivacyFlags,
  ref: CodaliStorageObjectRef,
): CodaliStorageObjectPrivacyFlags => ({
  containsPersonalData: current.containsPersonalData || ref.privacyFlags.containsPersonalData,
  containsSecrets: current.containsSecrets || ref.privacyFlags.containsSecrets,
  containsTenantPrivateData:
    current.containsTenantPrivateData || ref.privacyFlags.containsTenantPrivateData,
  containsSourceCode: current.containsSourceCode || ref.privacyFlags.containsSourceCode,
  containsCustomerData: current.containsCustomerData || ref.privacyFlags.containsCustomerData,
  trainingAllowed: current.trainingAllowed && ref.privacyFlags.trainingAllowed,
  evalAllowed: current.evalAllowed && ref.privacyFlags.evalAllowed,
  replayAllowed: current.replayAllowed && ref.privacyFlags.replayAllowed,
  exportAllowed: current.exportAllowed && ref.privacyFlags.exportAllowed,
});

const increment = (counts: Record<string, number>, key: string | undefined): void => {
  if (!key) return;
  counts[key] = (counts[key] ?? 0) + 1;
};

const privacySummaryForRecords = (
  records: readonly CodaliStorageDatasetRecord[],
): CodaliStorageExportPrivacySummary => {
  const classifications: Record<string, number> = {};
  const redactionStatuses: Record<string, number> = {};
  const policyTags = new Set<string>();
  let exportAllowedCount = 0;
  let trainingAllowedCount = 0;
  let evalAllowedCount = 0;
  let replayAllowedCount = 0;
  let mergedFlags = createGatewayDatasetLocalOnlyObjectPrivacyFlags({
    containsTenantPrivateData: false,
    containsCustomerData: false,
    trainingAllowed: true,
    evalAllowed: true,
    replayAllowed: true,
    exportAllowed: true,
  });

  for (const record of records) {
    increment(classifications, record.privacy.classification);
    increment(redactionStatuses, record.privacy.redactionStatus);
    for (const tag of record.privacy.policyTags ?? []) policyTags.add(tag);
    const refs = refsForRecord(record);
    for (const ref of refs) mergedFlags = mergeFlags(mergedFlags, ref);
    if (record.privacy.exportAllowed && refs.every((ref) => ref.privacyFlags.exportAllowed)) {
      exportAllowedCount += 1;
    }
    if (record.privacy.trainingAllowed && refs.every((ref) => ref.privacyFlags.trainingAllowed)) {
      trainingAllowedCount += 1;
    }
    if (refs.every((ref) => ref.privacyFlags.evalAllowed)) evalAllowedCount += 1;
    if (refs.every((ref) => ref.privacyFlags.replayAllowed)) replayAllowedCount += 1;
  }

  return {
    recordCount: records.length,
    containsPersonalData:
      records.some((record) => record.privacy.containsPersonalData) ||
      mergedFlags.containsPersonalData,
    containsSecrets: mergedFlags.containsSecrets,
    containsTenantPrivateData: mergedFlags.containsTenantPrivateData,
    containsSourceCode: mergedFlags.containsSourceCode,
    containsCustomerData: mergedFlags.containsCustomerData,
    exportAllowedCount,
    trainingAllowedCount,
    evalAllowedCount,
    replayAllowedCount,
    classifications,
    redactionStatuses,
    ...(policyTags.size ? { policyTags: [...policyTags].sort() } : {}),
  };
};

const deletionGroupSnapshotForRecords = (
  records: readonly CodaliStorageDatasetRecord[],
  capturedAt: string,
): CodaliStorageExportDeletionGroupSnapshot => {
  const allIds = new Set<string>();
  const byRecordId: Record<string, string[]> = {};
  for (const record of records) {
    const ids = [...new Set(refsForRecord(record).map((ref) => ref.deletionGroupId))].sort();
    byRecordId[record.recordId] = ids;
    ids.forEach((id) => allIds.add(id));
  }
  return {
    capturedAt,
    deletionGroupIds: [...allIds].sort(),
    byRecordId,
  };
};

const lineageForRecords = (
  exportKind: CodaliStorageExportKind,
  records: readonly CodaliStorageDatasetRecord[],
  generatedBy: string | undefined,
): CodaliStorageExportLineage => ({
  exportKind,
  sourceRecordIds: records.map((record) => record.recordId),
  sourceGatewayRecordIds: [
    ...new Set(records.flatMap((record) => record.sourceGatewayRecordId ? [record.sourceGatewayRecordId] : [])),
  ].sort(),
  sourceObjectHashes: [
    ...new Set(records.flatMap((record) => refsForRecord(record).map((ref) => ref.contentHash))),
  ].sort(),
  ...(generatedBy ? { generatedBy } : {}),
});

const primaryRecordObjectRef = (record: CodaliStorageDatasetRecord): CodaliStorageObjectRef =>
  record.outputRef ?? record.inputRef;

const manifestRecordRefs = (
  records: readonly CodaliStorageDatasetRecord[],
): CodaliStorageExportManifestRecordRef[] =>
  records.map((record) => ({
    recordType: record.recordType,
    recordId: record.recordId,
    schemaVersion: record.schemaVersion,
    objectRef: primaryRecordObjectRef(record),
  }));

const exportRows = (records: readonly CodaliStorageDatasetRecord[]) =>
  records.map((record) => ({
    schemaVersion: CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION,
    recordType: record.recordType,
    recordId: record.recordId,
    datasetKind: record.datasetKind,
    sourceGatewayRecordId: record.sourceGatewayRecordId,
    inputRef: record.inputRef,
    outputRef: record.outputRef,
    evidenceRefs: record.evidenceRefs,
    quality: record.quality,
    privacy: record.privacy,
    metadata: record.metadata,
  }));

const toJsonl = (rows: readonly unknown[]): string =>
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

const replayFixturePayload = (
  exportKind: CodaliStorageExportKind,
  generatedAt: string,
  records: readonly CodaliStorageDatasetRecord[],
) => ({
  schemaVersion: CODALI_DATASET_REPLAY_FIXTURE_SCHEMA_VERSION,
  exportKind,
  generatedAt,
  records: records.map((record) => ({
    recordId: record.recordId,
    datasetKind: record.datasetKind,
    sourceGatewayRecordId: record.sourceGatewayRecordId,
    inputRef: record.inputRef,
    outputRef: record.outputRef,
    evidenceRefs: record.evidenceRefs,
    quality: record.quality,
    metadata: record.metadata,
  })),
});

const manifestPrivacy = (
  summary: CodaliStorageExportPrivacySummary,
): CodaliStoragePrivacyMetadata =>
  createGatewayDatasetLocalOnlyPrivacy({
    containsPersonalData: summary.containsPersonalData,
    redactionStatus: summary.containsPersonalData ? "redacted" : "not_required",
    exportAllowed: true,
    trainingAllowed: false,
    metadata: {
      exportPrivacySummary: summary,
    },
  });

const artifactPrivacyFlags = (
  summary: CodaliStorageExportPrivacySummary,
): CodaliStorageObjectPrivacyFlags =>
  createGatewayDatasetLocalOnlyObjectPrivacyFlags({
    containsPersonalData: summary.containsPersonalData,
    containsSecrets: summary.containsSecrets,
    containsTenantPrivateData: summary.containsTenantPrivateData,
    containsSourceCode: summary.containsSourceCode,
    containsCustomerData: summary.containsCustomerData,
    exportAllowed: true,
    trainingAllowed: false,
    evalAllowed: true,
    replayAllowed: true,
  });

export const runCodaliDatasetExportJob = async (
  input: CodaliDatasetExportJobInput,
): Promise<CodaliDatasetExportJobResult> => {
  if (!CODALI_STORAGE_EXPORT_KINDS.includes(input.exportKind)) {
    throw new CodaliDatasetExportJobError(
      "CODALI_DATASET_EXPORT_KIND_INVALID",
      `Unsupported dataset export kind: ${input.exportKind}.`,
    );
  }
  if (input.exportFormat && input.exportFormat !== "jsonl") {
    throw new CodaliDatasetExportJobError(
      "CODALI_DATASET_EXPORT_FORMAT_INVALID",
      "The dataset exporter currently supports JSONL output.",
    );
  }

  const records = input.records.map(validateRecordOrThrow);
  const exclusionReasons: CodaliDatasetExportExclusionReason[] = [];
  const eligibleRecords: CodaliStorageDatasetRecord[] = [];
  for (const record of records) {
    const reasons = evaluateRecordEligibility(input.exportKind, record);
    if (reasons.length > 0) {
      exclusionReasons.push(...reasons);
    } else {
      eligibleRecords.push(record);
    }
  }
  const exclusionReasonCounts: Record<string, number> = {};
  addReasonCounts(exclusionReasonCounts, exclusionReasons);
  const dryRunSummary: CodaliDatasetExportDryRunSummary = {
    totalCount: records.length,
    eligibleCount: eligibleRecords.length,
    excludedCount: exclusionReasons.length === 0
      ? 0
      : records.length - eligibleRecords.length,
    exclusionReasonCounts,
  };

  if (input.dryRun) {
    return {
      schemaVersion: CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION,
      accepted: true,
      status: "dry_run",
      dryRun: dryRunSummary,
      exportKind: input.exportKind,
      exportFormat: "jsonl",
      exclusionReasons,
    };
  }

  if (records.length === 0 || exclusionReasons.length > 0 || eligibleRecords.length !== records.length) {
    return {
      schemaVersion: CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION,
      accepted: false,
      status: "blocked",
      dryRun: dryRunSummary,
      exportKind: input.exportKind,
      exportFormat: "jsonl",
      exclusionReasons,
    };
  }

  const now = input.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const manifestId = input.manifestId ??
    `dataset-export-${hashGatewayDatasetRequestBody({
      exportKind: input.exportKind,
      createdAt,
      records: records.map((record) => record.recordId),
    }).slice(0, 16)}`;
  const summary = privacySummaryForRecords(records);
  const privacyFlags = artifactPrivacyFlags(summary);
  const rows = exportRows(records);
  const jsonlPayload = toJsonl(rows);
  const jsonlRef = await input.objectStore.putObject({
    scope: input.scope,
    ownerType: "export_manifest",
    ownerId: manifestId,
    kind: "export",
    mimeType: "application/x-ndjson",
    retentionClass: "dataset",
    privacyFlags,
    payload: jsonlPayload,
    metadata: {
      artifactType: "jsonl",
      exportKind: input.exportKind,
      recordCount: records.length,
    },
  });
  const replayFixtureRef = await input.objectStore.putObject({
    scope: input.scope,
    ownerType: "export_manifest",
    ownerId: manifestId,
    kind: "export",
    mimeType: "application/json",
    retentionClass: "dataset",
    privacyFlags,
    payload: replayFixturePayload(input.exportKind, createdAt, records),
    metadata: {
      artifactType: "replay_fixture",
      exportKind: input.exportKind,
      recordCount: records.length,
    },
  });
  const manifest: CodaliStorageExportManifest = {
    schemaVersion: CODALI_STORAGE_CONTRACT_SCHEMA_VERSION,
    recordType: "export_manifest",
    manifestId,
    createdAt,
    exportKind: input.exportKind,
    exportFormat: "jsonl",
    recordCount: records.length,
    records: manifestRecordRefs(records),
    artifactRefs: [jsonlRef, replayFixtureRef],
    checksum: jsonlRef.contentHash,
    privacySummary: summary,
    lineage: lineageForRecords(input.exportKind, records, input.generatedBy),
    deletionGroupSnapshot: deletionGroupSnapshotForRecords(records, createdAt),
    generatedBy: input.generatedBy,
    privacy: manifestPrivacy(summary),
    metadata: {
      schemaVersion: CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION,
      explicitExport: true,
      dryRun: false,
      ...(input.metadata ?? {}),
    },
  };
  const validation = validateCodaliStorageExportManifest(manifest);
  if (!validation.ok) {
    throw new CodaliDatasetExportJobError(
      "CODALI_DATASET_EXPORT_MANIFEST_INVALID",
      validation.issues.map((issue) => `${issue.path}:${issue.code}`).join("; "),
    );
  }
  const manifestRef = await input.objectStore.putObject({
    scope: input.scope,
    ownerType: "export_manifest",
    ownerId: manifestId,
    kind: "export",
    mimeType: "application/json",
    retentionClass: "dataset",
    privacyFlags,
    payload: validation.value,
    metadata: {
      artifactType: "manifest",
      exportKind: input.exportKind,
      recordCount: records.length,
    },
  });

  return {
    schemaVersion: CODALI_DATASET_EXPORT_JOB_SCHEMA_VERSION,
    accepted: true,
    status: "exported",
    dryRun: dryRunSummary,
    exportKind: input.exportKind,
    exportFormat: "jsonl",
    manifest: validation.value,
    manifestRef,
    jsonlRef,
    replayFixtureRef,
    exclusionReasons,
  };
};
