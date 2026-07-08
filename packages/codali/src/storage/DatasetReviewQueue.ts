import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  validateCodaliStorageDatasetRecord,
  type CodaliStorageDatasetRecord,
  type CodaliStorageReviewDecision,
  type CodaliStorageReviewPromotionTarget,
} from "./CodaliStorageContracts.js";
import {
  applyCodaliStorageReviewPromotion,
  buildCodaliStorageReviewRecord,
} from "./CodaliFeedbackReviewIngestion.js";
import type { GatewayDatasetStorageScope } from "./GatewayDatasetStore.js";

export const CODALI_DATASET_RECORDS_FILE = "records.jsonl";

export interface LocalDatasetBatch {
  raw: Record<string, unknown>;
  collectedAt?: string;
  idempotencyKey?: string;
  scope: GatewayDatasetStorageScope;
  records: CodaliStorageDatasetRecord[];
  metadata?: Record<string, unknown>;
}

export interface LocalDatasetCollection {
  directory: string;
  recordsPath: string;
  batches: LocalDatasetBatch[];
  invalidLineCount: number;
  invalidRecordCount: number;
}

export interface DatasetRecordEntry {
  record: CodaliStorageDatasetRecord;
  batchIndex: number;
  recordIndex: number;
  scope: GatewayDatasetStorageScope;
  collectedAt?: string;
  idempotencyKey?: string;
  batchMetadata?: Record<string, unknown>;
}

export interface DatasetSampleOptions {
  seed?: string;
  limit?: number;
  tenantId?: string;
  productId?: string;
  deploymentId?: string;
  runId?: string;
  failureCluster?: string;
  integration?: string;
  confidence?: string;
  businessValue?: string;
  unreviewedOnly?: boolean;
}

export interface DatasetCollectionSummary {
  directory: string;
  recordsPath: string;
  batchCount: number;
  totalRecordRows: number;
  uniqueRecordCount: number;
  invalidLineCount: number;
  invalidRecordCount: number;
  reviewedCount: number;
  unreviewedCount: number;
  exportAllowedCount: number;
  trainingAllowedCount: number;
  byTenant: Record<string, number>;
  byProduct: Record<string, number>;
  byDatasetKind: Record<string, number>;
  byExampleType: Record<string, number>;
  byFailureCluster: Record<string, number>;
  byIntegration: Record<string, number>;
  byConfidence: Record<string, number>;
  byBusinessValue: Record<string, number>;
}

export interface DatasetLabelInput extends DatasetSampleOptions {
  recordId: string;
  labels: string[];
  reviewerId?: string;
  reason?: string;
  now?: () => Date;
}

export interface DatasetPromotionInput extends DatasetSampleOptions {
  recordId: string;
  promotionTarget: CodaliStorageReviewPromotionTarget;
  decision?: CodaliStorageReviewDecision;
  labels?: string[];
  reasons?: string[];
  reviewerId?: string;
  now?: () => Date;
}

export interface DatasetMutationResult {
  updatedCount: number;
  recordIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeToken = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
};

const readOptionalString = (
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
};

const readOptionalNumber = (
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
    if (typeof candidate === "string" && candidate.trim() && Number.isFinite(Number(candidate))) {
      return Number(candidate);
    }
  }
  return undefined;
};

const labels = (record: CodaliStorageDatasetRecord): string[] =>
  record.quality?.labels ?? [];

const labelValue = (
  record: CodaliStorageDatasetRecord,
  prefixes: readonly string[],
): string | undefined => {
  for (const label of labels(record)) {
    for (const prefix of prefixes) {
      if (label.toLowerCase().startsWith(prefix.toLowerCase())) {
        return label.slice(prefix.length).trim();
      }
    }
  }
  return undefined;
};

const confidenceBucket = (score: number | undefined): string => {
  if (score === undefined) return "unknown";
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
};

export const datasetRecordFailureCluster = (
  record: CodaliStorageDatasetRecord,
): string => {
  const metadata = record.metadata;
  return readOptionalString(metadata, [
    "failureCluster",
    "failure_cluster",
    "failureClusterId",
    "failure_cluster_id",
    "errorCode",
    "error_code",
    "policyEventType",
    "policy_event_type",
    "status",
  ])
    ?? labelValue(record, ["cluster:", "failure:", "auto:status:", "auto:policy:"])
    ?? (metadata?.exampleType === "schema_failure" ? "schema_failure" : "none");
};

export const datasetRecordIntegration = (
  record: CodaliStorageDatasetRecord,
): string => {
  const metadata = record.metadata;
  return readOptionalString(metadata, [
    "integration",
    "integrationId",
    "integration_id",
    "sourceType",
    "source_type",
    "usedTool",
    "used_tool",
    "tool",
    "provider",
    "finalModelTier",
    "final_model_tier",
  ])
    ?? labelValue(record, ["integration:", "auto:tool:", "auto:source:", "auto:provider:"])
    ?? "none";
};

export const datasetRecordConfidence = (
  record: CodaliStorageDatasetRecord,
): string =>
  readOptionalString(record.metadata, ["confidence", "confidenceBucket", "confidence_bucket"])
  ?? labelValue(record, ["confidence:", "auto:confidence:"])
  ?? confidenceBucket(record.quality?.score);

export const datasetRecordBusinessValue = (
  record: CodaliStorageDatasetRecord,
): string =>
  readOptionalString(record.metadata, [
    "businessValue",
    "business_value",
    "businessValueTier",
    "business_value_tier",
    "valueTier",
    "value_tier",
  ])
  ?? labelValue(record, ["business:", "value:"])
  ?? "unknown";

const datasetRecordBusinessValueScore = (
  record: CodaliStorageDatasetRecord,
): number | undefined =>
  readOptionalNumber(record.metadata, [
    "businessValue",
    "business_value",
    "businessValueScore",
    "business_value_score",
    "valueScore",
    "value_score",
  ]);

const stableHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const deterministicSortKey = (entry: DatasetRecordEntry, seed: string | undefined): string => {
  const scopeKey = `${entry.scope.tenantId}:${entry.scope.productId}:${entry.scope.deploymentId}:${entry.scope.runId}`;
  const base = `${scopeKey}:${entry.record.recordId}:${entry.record.createdAt}`;
  return seed ? stableHash(`${seed}:${base}`) : base;
};

const increment = (counts: Record<string, number>, key: string | undefined): void => {
  const normalized = key?.trim() || "unknown";
  counts[normalized] = (counts[normalized] ?? 0) + 1;
};

const uniqueStrings = (values: readonly string[]): string[] =>
  Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));

const parseScope = (value: unknown): GatewayDatasetStorageScope => {
  const record = isRecord(value) ? value : {};
  return {
    tenantId: typeof record.tenantId === "string" ? record.tenantId : "local",
    productId: typeof record.productId === "string" ? record.productId : "product-neutral",
    deploymentId: typeof record.deploymentId === "string" ? record.deploymentId : "local",
    runId: typeof record.runId === "string" ? record.runId : "dataset-local",
  };
};

const isEnoent = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

export const readLocalDatasetCollection = async (input: {
  directory: string;
  recordsFileName?: string;
}): Promise<LocalDatasetCollection> => {
  const recordsPath = path.join(input.directory, input.recordsFileName ?? CODALI_DATASET_RECORDS_FILE);
  let raw = "";
  try {
    raw = await readFile(recordsPath, "utf8");
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }

  const batches: LocalDatasetBatch[] = [];
  let invalidLineCount = 0;
  let invalidRecordCount = 0;
  for (const line of raw.split(/\r?\n/g)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      invalidLineCount += 1;
      continue;
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.records)) {
      invalidLineCount += 1;
      continue;
    }
    const records: CodaliStorageDatasetRecord[] = [];
    for (const item of parsed.records) {
      const validation = validateCodaliStorageDatasetRecord(item);
      if (validation.ok) {
        records.push(validation.value);
      } else {
        invalidRecordCount += 1;
      }
    }
    batches.push({
      raw: parsed,
      collectedAt: typeof parsed.collectedAt === "string" ? parsed.collectedAt : undefined,
      idempotencyKey: typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : undefined,
      scope: parseScope(parsed.scope),
      records,
      metadata: isRecord(parsed.metadata) ? parsed.metadata : undefined,
    });
  }

  return {
    directory: input.directory,
    recordsPath,
    batches,
    invalidLineCount,
    invalidRecordCount,
  };
};

export const writeLocalDatasetCollection = async (
  collection: LocalDatasetCollection,
): Promise<void> => {
  await mkdir(collection.directory, { recursive: true });
  const body = collection.batches
    .map((batch) => JSON.stringify({
      ...batch.raw,
      scope: batch.scope,
      records: batch.records,
      metadata: batch.metadata,
    }))
    .join("\n");
  const tempPath = `${collection.recordsPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, body ? `${body}\n` : "", "utf8");
  await rename(tempPath, collection.recordsPath);
};

export const datasetRecordEntries = (
  collection: LocalDatasetCollection,
): DatasetRecordEntry[] =>
  collection.batches.flatMap((batch, batchIndex) =>
    batch.records.map((record, recordIndex) => ({
      record,
      batchIndex,
      recordIndex,
      scope: batch.scope,
      collectedAt: batch.collectedAt,
      idempotencyKey: batch.idempotencyKey,
      batchMetadata: batch.metadata,
    })));

const scopedRecordIdentityKey = (entry: DatasetRecordEntry): string =>
  [
    entry.scope.tenantId,
    entry.scope.productId,
    entry.scope.deploymentId,
    entry.scope.runId,
    entry.record.recordId,
  ].join("\t");

export const latestDatasetRecordEntries = (
  collection: LocalDatasetCollection,
): DatasetRecordEntry[] => {
  const byRecordId = new Map<string, DatasetRecordEntry>();
  for (const entry of datasetRecordEntries(collection)) {
    byRecordId.set(scopedRecordIdentityKey(entry), entry);
  }
  return Array.from(byRecordId.values()).sort((left, right) =>
    scopedRecordIdentityKey(left).localeCompare(scopedRecordIdentityKey(right)));
};

const matchesTextFilter = (actual: string | undefined, expected: string | undefined): boolean =>
  !expected || normalizeToken(actual) === normalizeToken(expected);

const matchesConfidence = (
  record: CodaliStorageDatasetRecord,
  expected: string | undefined,
): boolean => {
  if (!expected) return true;
  const numeric = Number(expected);
  if (Number.isFinite(numeric)) return (record.quality?.score ?? 0) >= numeric;
  return normalizeToken(datasetRecordConfidence(record)) === normalizeToken(expected);
};

const matchesBusinessValue = (
  record: CodaliStorageDatasetRecord,
  expected: string | undefined,
): boolean => {
  if (!expected) return true;
  const numeric = Number(expected);
  const score = datasetRecordBusinessValueScore(record);
  if (Number.isFinite(numeric)) return score !== undefined && score >= numeric;
  return normalizeToken(datasetRecordBusinessValue(record)) === normalizeToken(expected);
};

export const matchesDatasetSampleOptions = (
  entry: DatasetRecordEntry,
  options: DatasetSampleOptions,
): boolean => {
  if (options.unreviewedOnly && entry.record.quality?.reviewed === true) return false;
  return matchesTextFilter(entry.scope.tenantId, options.tenantId)
    && matchesTextFilter(entry.scope.productId, options.productId)
    && matchesTextFilter(entry.scope.deploymentId, options.deploymentId)
    && matchesTextFilter(entry.scope.runId, options.runId)
    && matchesTextFilter(datasetRecordFailureCluster(entry.record), options.failureCluster)
    && matchesTextFilter(datasetRecordIntegration(entry.record), options.integration)
    && matchesConfidence(entry.record, options.confidence)
    && matchesBusinessValue(entry.record, options.businessValue);
};

export const sampleDatasetRecordEntries = (
  collection: LocalDatasetCollection,
  options: DatasetSampleOptions = {},
): DatasetRecordEntry[] => {
  const limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
  const entries = latestDatasetRecordEntries(collection)
    .filter((entry) => matchesDatasetSampleOptions(entry, options))
    .sort((left, right) =>
      deterministicSortKey(left, options.seed).localeCompare(deterministicSortKey(right, options.seed))
      || left.record.recordId.localeCompare(right.record.recordId));
  return limit ? entries.slice(0, limit) : entries;
};

export const summarizeDatasetCollection = (
  collection: LocalDatasetCollection,
): DatasetCollectionSummary => {
  const entries = latestDatasetRecordEntries(collection);
  const summary: DatasetCollectionSummary = {
    directory: collection.directory,
    recordsPath: collection.recordsPath,
    batchCount: collection.batches.length,
    totalRecordRows: datasetRecordEntries(collection).length,
    uniqueRecordCount: entries.length,
    invalidLineCount: collection.invalidLineCount,
    invalidRecordCount: collection.invalidRecordCount,
    reviewedCount: 0,
    unreviewedCount: 0,
    exportAllowedCount: 0,
    trainingAllowedCount: 0,
    byTenant: {},
    byProduct: {},
    byDatasetKind: {},
    byExampleType: {},
    byFailureCluster: {},
    byIntegration: {},
    byConfidence: {},
    byBusinessValue: {},
  };
  for (const entry of entries) {
    if (entry.record.quality?.reviewed === true) summary.reviewedCount += 1;
    else summary.unreviewedCount += 1;
    if (entry.record.privacy.exportAllowed) summary.exportAllowedCount += 1;
    if (entry.record.privacy.trainingAllowed) summary.trainingAllowedCount += 1;
    increment(summary.byTenant, entry.scope.tenantId);
    increment(summary.byProduct, entry.scope.productId);
    increment(summary.byDatasetKind, entry.record.datasetKind);
    increment(
      summary.byExampleType,
      typeof entry.record.metadata?.exampleType === "string"
        ? entry.record.metadata.exampleType
        : "unknown",
    );
    increment(summary.byFailureCluster, datasetRecordFailureCluster(entry.record));
    increment(summary.byIntegration, datasetRecordIntegration(entry.record));
    increment(summary.byConfidence, datasetRecordConfidence(entry.record));
    increment(summary.byBusinessValue, datasetRecordBusinessValue(entry.record));
  }
  return summary;
};

const mutableMatches = (
  collection: LocalDatasetCollection,
  recordId: string,
  options: DatasetSampleOptions,
): DatasetRecordEntry[] =>
  datasetRecordEntries(collection).filter((entry) =>
    entry.record.recordId === recordId && matchesDatasetSampleOptions(entry, options));

const scopeKey = (entry: DatasetRecordEntry): string =>
  `${entry.scope.tenantId}:${entry.scope.productId}:${entry.scope.deploymentId}:${entry.scope.runId}`;

const assertMutableMatches = (
  collection: LocalDatasetCollection,
  recordId: string,
  options: DatasetSampleOptions,
): DatasetRecordEntry[] => {
  const matches = mutableMatches(collection, recordId, options);
  if (matches.length === 0) {
    throw new Error(`No dataset record matched ${recordId} in the selected scope.`);
  }
  const scopes = new Set(matches.map(scopeKey));
  const scopeConstrained = Boolean(options.tenantId || options.productId || options.deploymentId || options.runId);
  if (scopes.size > 1 && !scopeConstrained) {
    throw new Error(
      `Dataset record ${recordId} exists in multiple scopes; pass --tenant/--product/--run to disambiguate.`,
    );
  }
  return matches;
};

export const applyDatasetLabel = (
  collection: LocalDatasetCollection,
  input: DatasetLabelInput,
): DatasetMutationResult => {
  const updatedAt = (input.now ?? (() => new Date()))().toISOString();
  const matches = assertMutableMatches(collection, input.recordId, input);
  const labelsToAdd = uniqueStrings(input.labels);
  const recordIds = new Set<string>();
  for (const match of matches) {
    const batch = collection.batches[match.batchIndex];
    const record = batch?.records[match.recordIndex];
    if (!record) continue;
    const existingLabels = record.quality?.labels ?? [];
    const nextRecord: CodaliStorageDatasetRecord = {
      ...record,
      quality: {
        ...(record.quality ?? {}),
        labels: uniqueStrings([...existingLabels, ...labelsToAdd]),
        reviewed: true,
      },
      metadata: {
        ...(record.metadata ?? {}),
        cliLabels: uniqueStrings([
          ...((Array.isArray(record.metadata?.cliLabels)
            ? record.metadata?.cliLabels.filter((value): value is string => typeof value === "string")
            : [])),
          ...labelsToAdd,
        ]),
        ...(input.reviewerId ? { reviewerId: input.reviewerId } : {}),
        ...(input.reason ? { labelReason: input.reason } : {}),
        rawTraceIncluded: false,
        labelledAt: updatedAt,
      },
    };
    batch.records[match.recordIndex] = nextRecord;
    recordIds.add(record.recordId);
  }
  return { updatedCount: matches.length, recordIds: [...recordIds].sort() };
};

const decisionForPromotionTarget = (
  promotionTarget: CodaliStorageReviewPromotionTarget,
): CodaliStorageReviewDecision => {
  if (promotionTarget === "gold") return "approved";
  if (promotionTarget === "reject") return "rejected";
  return "needs_changes";
};

export const applyDatasetPromotionTarget = (
  collection: LocalDatasetCollection,
  input: DatasetPromotionInput,
): DatasetMutationResult => {
  const reviewedAt = (input.now ?? (() => new Date()))().toISOString();
  const matches = assertMutableMatches(collection, input.recordId, input);
  const recordIds = new Set<string>();
  for (const match of matches) {
    const batch = collection.batches[match.batchIndex];
    const record = batch?.records[match.recordIndex];
    if (!record) continue;
    const review = buildCodaliStorageReviewRecord({
      reviewId: `dataset-cli-review-${stableHash(`${record.recordId}:${input.promotionTarget}:${reviewedAt}`).slice(0, 16)}`,
      createdAt: reviewedAt,
      reviewerType: "human",
      reviewerId: input.reviewerId,
      runId: match.scope.runId,
      deletionGroupId: record.inputRef.deletionGroupId,
      productScope: {
        productId: match.scope.productId,
        tenantHash: record.inputRef.ownerScope.tenantHash,
        deploymentId: match.scope.deploymentId,
      },
      requesterScope: {
        requesterHash: input.reviewerId ?? "dataset-cli-reviewer",
        visibility: "requester",
        tenantWide: false,
      },
      candidateRecords: [{
        recordType: "dataset_record",
        recordId: record.recordId,
        datasetKind: record.datasetKind,
        objectRef: record.outputRef ?? record.inputRef,
        labels: record.quality?.labels,
        metadata: {
          sourceGatewayRecordId: record.sourceGatewayRecordId,
          rawTraceIncluded: false,
        },
      }],
      targetType: "dataset_record",
      targetId: record.recordId,
      decision: input.decision ?? decisionForPromotionTarget(input.promotionTarget),
      labels: input.labels,
      reasons: input.reasons,
      promotionTarget: input.promotionTarget,
      promotedRecordIds: [record.recordId],
      privacy: {
        uploadAllowed: false,
        exportAllowed: false,
        trainingAllowed: false,
      },
      metadata: {
        source: "dataset_cli",
        rawTraceIncluded: false,
      },
    });
    const [promoted] = applyCodaliStorageReviewPromotion({
      review,
      records: [record],
      reviewedAt,
    });
    if (promoted) {
      batch.records[match.recordIndex] = cloneJson(promoted);
      recordIds.add(record.recordId);
    }
  }
  return { updatedCount: matches.length, recordIds: [...recordIds].sort() };
};
