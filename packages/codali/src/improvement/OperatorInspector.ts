import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type CodaliStorageDatasetRecord,
  type CodaliStorageExportManifest,
  type CodaliStorageObjectRef,
} from "../storage/CodaliStorageContracts.js";
import type { GatewayDatasetStorageScope } from "../storage/GatewayDatasetStore.js";
import {
  datasetRecordBusinessValue,
  datasetRecordConfidence,
  datasetRecordFailureCluster,
  datasetRecordIntegration,
  latestDatasetRecordEntries,
  readLocalDatasetCollection,
  summarizeDatasetCollection,
  type DatasetCollectionSummary,
  type DatasetRecordEntry,
} from "../storage/DatasetReviewQueue.js";
import {
  DEFAULT_STORAGE_SERVICE_IMPROVEMENT_PRODUCT_QUALITY_SUMMARY_ENDPOINT,
  DEFAULT_STORAGE_SERVICE_IMPROVEMENT_RELEASE_LINEAGE_ENDPOINT,
} from "./StorageServiceImprovementClient.js";
import type {
  CodaliImprovementCandidate,
  CodaliImprovementGate,
  CodaliImprovementOutcome,
  CodaliImprovementRelease,
  CodaliImprovementScope,
  CodaliImprovementScorecard,
} from "./ImprovementPolicy.js";
import type {
  CodaliReleaseOutcomeReport,
  CodaliReleaseRollbackTriggerCode,
} from "./ReleaseOutcomeReporter.js";

export const CODALI_OPERATOR_INSPECTOR_SCHEMA_VERSION =
  "codali.operator.inspector.v1" as const;

export const DEFAULT_CODALI_OPERATOR_INSPECTION_SEARCH_DIRECTORIES = [
  path.resolve(".codali", "improvement", "candidates"),
  path.resolve(".codali", "improvement"),
  path.resolve(".codali", "dataset", "exports", "objects"),
  path.resolve(".codali", "dataset", "exports"),
  path.resolve(".codali", "dataset"),
] as const;

export interface CodaliOperatorAuditSummary {
  redactedFields: string[];
  secretRedactionCount: number;
  customerDataRedactionCount: number;
  containsSecretReferences: boolean;
  containsCustomerDataReferences: boolean;
  noSecretsOrUnredactedCustomerData: true;
}

export interface CodaliOperatorDatasetRecordSummary {
  recordId: string;
  datasetKind: string;
  createdAt: string;
  quality: {
    score?: number;
    labels: string[];
    reviewed: boolean;
  };
  facets: {
    failureCluster: string;
    integration: string;
    confidence: string;
    businessValue: string;
  };
  privacy: {
    classification: string;
    redactionStatus: string;
    exportAllowed: boolean;
    trainingAllowed: boolean;
    containsSecrets: boolean;
    containsCustomerData: boolean;
  };
  metadata?: unknown;
}

export interface CodaliOperatorDatasetRunSummary {
  runId: string;
  scope?: GatewayDatasetStorageScope;
  recordCount: number;
  reviewedCount: number;
  unreviewedCount: number;
  exportAllowedCount: number;
  trainingAllowedCount: number;
  byDatasetKind: Record<string, number>;
  byFailureCluster: Record<string, number>;
  byIntegration: Record<string, number>;
  byConfidence: Record<string, number>;
  byBusinessValue: Record<string, number>;
  privacy: {
    containsSecretsCount: number;
    containsCustomerDataCount: number;
    classifications: Record<string, number>;
    redactionStatuses: Record<string, number>;
  };
  records: CodaliOperatorDatasetRecordSummary[];
}

export interface CodaliDatasetRunOperatorInspection {
  schemaVersion: typeof CODALI_OPERATOR_INSPECTOR_SCHEMA_VERSION;
  inspectionType: "dataset_run";
  dashboardReady: true;
  generatedAt: string;
  directory: string;
  filters: {
    runId?: string;
  };
  collectionSummary: DatasetCollectionSummary;
  runs: CodaliOperatorDatasetRunSummary[];
  audit: CodaliOperatorAuditSummary;
  warnings: string[];
}

export interface CodaliOperatorReleaseArtifactSummary {
  artifactType:
    | "release"
    | "candidate"
    | "dataset_export"
    | "scorecard"
    | "outcome"
    | "rollback";
  id: string;
  sourcePath?: string;
  status?: string;
  createdAt?: string;
  metadata?: unknown;
}

export interface CodaliOperatorEvalGateSummary {
  gateId: string;
  candidateId: string;
  gateType?: string;
  status: string;
  required: boolean;
  passed: boolean;
  reasons: string[];
  score?: number;
  sourcePath?: string;
}

export interface CodaliOperatorBlockedCandidateSummary {
  candidateId: string;
  status: string;
  reasons: string[];
  sources: string[];
  sourceExportIds: string[];
  releaseIds: string[];
  scorecardIds: string[];
}

export interface CodaliOperatorRollbackSummary {
  releaseId: string;
  status: string;
  triggerCodes: CodaliReleaseRollbackTriggerCode[];
  events: Array<{
    eventId: string;
    eventType: string;
    createdAt: string;
    triggerCodes: CodaliReleaseRollbackTriggerCode[];
  }>;
  sourcePath?: string;
}

export interface CodaliReleaseOperatorInspection {
  schemaVersion: typeof CODALI_OPERATOR_INSPECTOR_SCHEMA_VERSION;
  inspectionType: "release";
  dashboardReady: true;
  generatedAt: string;
  releaseId: string;
  searchDirectories: string[];
  storageServiceQueryEndpoints: {
    releaseLineage: string;
    productQualitySummary: string;
  };
  releaseLineage: {
    releases: CodaliOperatorReleaseArtifactSummary[];
    exports: CodaliOperatorReleaseArtifactSummary[];
    candidates: CodaliOperatorReleaseArtifactSummary[];
    scorecards: CodaliOperatorReleaseArtifactSummary[];
    outcomes: CodaliOperatorReleaseArtifactSummary[];
    evalGates: CodaliOperatorEvalGateSummary[];
    rollbacks: CodaliOperatorRollbackSummary[];
    traceability: {
      traceableToExports: boolean;
      traceableToEvalGates: boolean;
      releaseIds: string[];
      candidateIds: string[];
      exportIds: string[];
      scorecardIds: string[];
      gateIds: string[];
    };
  };
  blockedCandidates: CodaliOperatorBlockedCandidateSummary[];
  productQualitySummary: {
    productId?: string;
    releaseCount: number;
    candidateCount: number;
    blockedCandidateCount: number;
    exportCount: number;
    scorecardCount: number;
    evalGateCount: number;
    rollbackCount: number;
    gateStatuses: Record<string, number>;
    releaseStatuses: Record<string, number>;
    candidateStatuses: Record<string, number>;
    privacy: {
      containsSecretsExportCount: number;
      containsCustomerDataExportCount: number;
      noSecretsOrUnredactedCustomerData: true;
    };
  };
  audit: CodaliOperatorAuditSummary;
  warnings: string[];
}

export interface InspectCodaliDatasetRunForOperatorsInput {
  directory: string;
  runId?: string;
  now?: () => Date;
  recordSampleLimit?: number;
}

export interface InspectCodaliReleaseForOperatorsInput {
  releaseId: string;
  directory?: string;
  directories?: readonly string[];
  now?: () => Date;
  maxFiles?: number;
}

type JsonRecord = Record<string, unknown>;

interface JsonArtifactPayload {
  sourcePath: string;
  outputType?: string;
  payload: JsonRecord;
}

interface ArtifactRecord<T> {
  value: T;
  sourcePath: string;
}

type JsonExportManifest = JsonRecord & CodaliStorageExportManifest;
type JsonImprovementCandidate = JsonRecord & CodaliImprovementCandidate;
type JsonImprovementOutcome = JsonRecord & CodaliImprovementOutcome;
type JsonImprovementRelease = JsonRecord & CodaliImprovementRelease;
type JsonImprovementScorecard = JsonRecord & CodaliImprovementScorecard;
type JsonReleaseOutcomeReport = JsonRecord & CodaliReleaseOutcomeReport;

const isRecord = (value: unknown): value is JsonRecord =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const stringValue = (
  record: JsonRecord | undefined,
  key: string,
): string | undefined => {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const stringArray = (
  record: JsonRecord | undefined,
  key: string,
): string[] => {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
};

const increment = (counts: Record<string, number>, key: string | undefined): void => {
  counts[key ?? "unknown"] = (counts[key ?? "unknown"] ?? 0) + 1;
};

const unique = (values: readonly string[]): string[] =>
  [...new Set(values.filter((value) => value.trim()).map((value) => value.trim()))]
    .sort((left, right) => left.localeCompare(right));

const pushUnique = (values: string[], value: string | undefined): void => {
  if (value && !values.includes(value)) values.push(value);
};

const createAuditSummary = (): CodaliOperatorAuditSummary => ({
  redactedFields: [],
  secretRedactionCount: 0,
  customerDataRedactionCount: 0,
  containsSecretReferences: false,
  containsCustomerDataReferences: false,
  noSecretsOrUnredactedCustomerData: true,
});

const secretKeyPattern =
  /(^|[_./-])(authorization|bearer|cookie|hmac|password|secret|token|api[-_]?key|api[-_]?token|access[-_]?token|refresh[-_]?token)([_./-]|$)/u;
const customerDataKeyPattern =
  /(^|[_./-])(customer[-_]?data|raw[-_]?customer|unredacted[-_]?customer|customer[-_]?payload|customer[-_]?text)([_./-]|$)/u;
const secretValuePattern =
  /(bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|token[:=][a-z0-9._-]+)/iu;

const auditKey = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

const redactForAudit = (
  value: unknown,
  audit: CodaliOperatorAuditSummary,
  pathParts: readonly string[] = [],
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactForAudit(item, audit, [...pathParts, String(index)]));
  }
  if (!isRecord(value)) {
    if (typeof value === "string" && secretValuePattern.test(value)) {
      audit.secretRedactionCount += 1;
      audit.containsSecretReferences = true;
      return "[redacted]";
    }
    return value;
  }
  const redacted: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    const itemPath = [...pathParts, key];
    const pathLabel = itemPath.join(".");
    const normalizedKey = auditKey(key);
    if (secretKeyPattern.test(normalizedKey)) {
      audit.secretRedactionCount += 1;
      audit.containsSecretReferences = true;
      audit.redactedFields.push(pathLabel);
      redacted[key] = "[redacted]";
      continue;
    }
    if (customerDataKeyPattern.test(normalizedKey)) {
      audit.customerDataRedactionCount += 1;
      audit.containsCustomerDataReferences = true;
      audit.redactedFields.push(pathLabel);
      redacted[key] = "[redacted]";
      continue;
    }
    redacted[key] = redactForAudit(item, audit, itemPath);
  }
  return redacted;
};

const isStorageObjectRef = (
  value: CodaliStorageObjectRef | undefined,
): value is CodaliStorageObjectRef => Boolean(value);

const refsForRecord = (
  record: CodaliStorageDatasetRecord,
): CodaliStorageObjectRef[] => [
  record.inputRef,
  record.outputRef,
  ...(record.evidenceRefs ?? []),
].filter(isStorageObjectRef);

const recordContainsSecrets = (record: CodaliStorageDatasetRecord): boolean =>
  refsForRecord(record).some((ref) => ref.privacyFlags.containsSecrets) ||
  (record.privacy.policyTags ?? []).some((tag) => tag.toLowerCase().includes("secret"));

const recordContainsCustomerData = (record: CodaliStorageDatasetRecord): boolean =>
  refsForRecord(record).some((ref) => ref.privacyFlags.containsCustomerData) ||
  (record.privacy.policyTags ?? []).some((tag) => tag.toLowerCase().includes("customer"));

const summarizeDatasetRecord = (
  entry: DatasetRecordEntry,
  audit: CodaliOperatorAuditSummary,
): CodaliOperatorDatasetRecordSummary => {
  const containsSecrets = recordContainsSecrets(entry.record);
  const containsCustomerData = recordContainsCustomerData(entry.record);
  if (containsSecrets) audit.containsSecretReferences = true;
  if (containsCustomerData) audit.containsCustomerDataReferences = true;
  const metadata = entry.record.metadata
    ? redactForAudit(entry.record.metadata, audit, ["record", entry.record.recordId, "metadata"])
    : undefined;
  return {
    recordId: entry.record.recordId,
    datasetKind: entry.record.datasetKind,
    createdAt: entry.record.createdAt,
    quality: {
      score: entry.record.quality?.score,
      labels: entry.record.quality?.labels ?? [],
      reviewed: entry.record.quality?.reviewed === true,
    },
    facets: {
      failureCluster: datasetRecordFailureCluster(entry.record),
      integration: datasetRecordIntegration(entry.record),
      confidence: datasetRecordConfidence(entry.record),
      businessValue: datasetRecordBusinessValue(entry.record),
    },
    privacy: {
      classification: entry.record.privacy.classification,
      redactionStatus: entry.record.privacy.redactionStatus,
      exportAllowed: entry.record.privacy.exportAllowed,
      trainingAllowed: entry.record.privacy.trainingAllowed,
      containsSecrets,
      containsCustomerData,
    },
    ...(metadata === undefined ? {} : { metadata }),
  };
};

const summarizeDatasetRun = (
  runId: string,
  entries: readonly DatasetRecordEntry[],
  audit: CodaliOperatorAuditSummary,
  recordSampleLimit: number,
): CodaliOperatorDatasetRunSummary => {
  const summary: CodaliOperatorDatasetRunSummary = {
    runId,
    scope: entries[0]?.scope,
    recordCount: entries.length,
    reviewedCount: 0,
    unreviewedCount: 0,
    exportAllowedCount: 0,
    trainingAllowedCount: 0,
    byDatasetKind: {},
    byFailureCluster: {},
    byIntegration: {},
    byConfidence: {},
    byBusinessValue: {},
    privacy: {
      containsSecretsCount: 0,
      containsCustomerDataCount: 0,
      classifications: {},
      redactionStatuses: {},
    },
    records: [],
  };
  for (const entry of entries) {
    if (entry.record.quality?.reviewed === true) summary.reviewedCount += 1;
    else summary.unreviewedCount += 1;
    if (entry.record.privacy.exportAllowed) summary.exportAllowedCount += 1;
    if (entry.record.privacy.trainingAllowed) summary.trainingAllowedCount += 1;
    increment(summary.byDatasetKind, entry.record.datasetKind);
    increment(summary.byFailureCluster, datasetRecordFailureCluster(entry.record));
    increment(summary.byIntegration, datasetRecordIntegration(entry.record));
    increment(summary.byConfidence, datasetRecordConfidence(entry.record));
    increment(summary.byBusinessValue, datasetRecordBusinessValue(entry.record));
    increment(summary.privacy.classifications, entry.record.privacy.classification);
    increment(summary.privacy.redactionStatuses, entry.record.privacy.redactionStatus);
    if (recordContainsSecrets(entry.record)) summary.privacy.containsSecretsCount += 1;
    if (recordContainsCustomerData(entry.record)) {
      summary.privacy.containsCustomerDataCount += 1;
    }
  }
  summary.records = entries
    .slice(0, Math.max(0, Math.floor(recordSampleLimit)))
    .map((entry) => summarizeDatasetRecord(entry, audit));
  return summary;
};

export const inspectCodaliDatasetRunForOperators = async (
  input: InspectCodaliDatasetRunForOperatorsInput,
): Promise<CodaliDatasetRunOperatorInspection> => {
  const collection = await readLocalDatasetCollection({ directory: input.directory });
  const collectionSummary = summarizeDatasetCollection(collection);
  const latestEntries = latestDatasetRecordEntries(collection);
  const entries = input.runId
    ? latestEntries.filter((entry) => entry.scope.runId === input.runId)
    : latestEntries;
  const audit = createAuditSummary();
  const runIds = unique(entries.map((entry) => entry.scope.runId));
  const recordSampleLimit = input.recordSampleLimit ?? 25;
  const runs = runIds.map((runId) =>
    summarizeDatasetRun(
      runId,
      entries.filter((entry) => entry.scope.runId === runId),
      audit,
      recordSampleLimit,
    ));
  const warnings = input.runId && runs.length === 0
    ? [`dataset_run_not_found:${input.runId}`]
    : [];
  return {
    schemaVersion: CODALI_OPERATOR_INSPECTOR_SCHEMA_VERSION,
    inspectionType: "dataset_run",
    dashboardReady: true,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    directory: collection.directory,
    filters: {
      ...(input.runId ? { runId: input.runId } : {}),
    },
    collectionSummary,
    runs,
    audit,
    warnings,
  };
};

const pathExists = async (value: string): Promise<boolean> => {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
};

const listJsonFiles = async (
  directory: string,
  maxFiles: number,
): Promise<string[]> => {
  const root = path.resolve(directory);
  if (!(await pathExists(root))) return [];
  const stack = [root];
  const files: string[] = [];
  const excludedNames = new Set([".git", "node_modules", "dist", "build", "coverage"]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = (await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (excludedNames.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      files.push(entryPath);
      if (files.length > maxFiles) {
        throw new Error(`Operator inspection inspected more than ${maxFiles} JSON files under ${root}.`);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
};

const collectPayloads = (
  value: unknown,
  maxDepth = 4,
): JsonRecord[] => {
  if (maxDepth < 0 || !isRecord(value)) return [];
  const payloads = [value];
  for (const nested of Object.values(value)) {
    if (isRecord(nested)) {
      payloads.push(...collectPayloads(nested, maxDepth - 1));
    }
    if (Array.isArray(nested)) {
      for (const item of nested) {
        if (isRecord(item)) payloads.push(...collectPayloads(item, maxDepth - 1));
      }
    }
  }
  return payloads;
};

const readJsonPayloads = async (
  filePath: string,
  warnings: string[],
): Promise<JsonArtifactPayload[]> => {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const root = isRecord(parsed) ? parsed : undefined;
    const outputType = stringValue(root, "outputType");
    const payloads = collectPayloads(parsed);
    return payloads.map((payload) => ({
      sourcePath: filePath,
      outputType,
      payload,
    }));
  } catch {
    warnings.push(`json_parse_skipped:${filePath}`);
    return [];
  }
};

const isExportManifest = (value: JsonRecord): value is JsonExportManifest =>
  value.recordType === "export_manifest" &&
  typeof value.manifestId === "string" &&
  Array.isArray(value.artifactRefs) &&
  isRecord(value.lineage);

const isRelease = (value: JsonRecord): value is JsonImprovementRelease =>
  typeof value.releaseId === "string" &&
  typeof value.candidateId === "string" &&
  typeof value.releaseLevel === "number" &&
  Array.isArray(value.artifactIds);

const isCandidate = (value: JsonRecord): value is JsonImprovementCandidate =>
  typeof value.candidateId === "string" &&
  !("releaseId" in value) &&
  (
    typeof value.candidateKind === "string" ||
    Array.isArray(value.sourceExportIds) ||
    Array.isArray(value.blockedReasons)
  );

const isScorecard = (value: JsonRecord): value is JsonImprovementScorecard =>
  typeof value.scorecardId === "string" &&
  typeof value.candidateId === "string" &&
  Array.isArray(value.gates);

const isOutcome = (value: JsonRecord): value is JsonImprovementOutcome =>
  typeof value.outcomeId === "string" &&
  typeof value.releaseId === "string" &&
  typeof value.status === "string";

const isReleaseReport = (value: JsonRecord): value is JsonReleaseOutcomeReport =>
  typeof value.releaseId === "string" &&
  Array.isArray(value.rollbackTriggers) &&
  Array.isArray(value.rollbackEvents) &&
  isRecord(value.outcome);

const artifactSummary = (
  artifactType: CodaliOperatorReleaseArtifactSummary["artifactType"],
  id: string,
  sourcePath: string,
  value: JsonRecord,
  audit: CodaliOperatorAuditSummary,
): CodaliOperatorReleaseArtifactSummary => ({
  artifactType,
  id,
  sourcePath,
  status: stringValue(value, "status"),
  createdAt: stringValue(value, "createdAt") ?? stringValue(value, "generatedAt"),
  metadata: isRecord(value.metadata)
    ? redactForAudit(value.metadata, audit, [artifactType, id, "metadata"])
    : undefined,
});

const scopeProductId = (
  scope: CodaliImprovementScope | undefined,
): string | undefined => scope?.productId;

const manifestSourceExportIds = (
  manifest: CodaliStorageExportManifest,
): string[] => [manifest.manifestId];

const sourceExportIdsForCandidate = (
  candidate: CodaliImprovementCandidate,
): string[] => [
  ...(candidate.sourceExportIds ?? []),
  ...stringArray(candidate.metadata, "sourceExportIds"),
  ...stringArray(candidate.metadata, "source_export_ids"),
];

const sourceExportIdsForRelease = (
  release: CodaliImprovementRelease,
): string[] => [
  ...stringArray(release.metadata, "sourceExportIds"),
  ...stringArray(release.metadata, "source_export_ids"),
  ...[stringValue(release.metadata, "sourceExportId")].filter((item): item is string => Boolean(item)),
  ...[stringValue(release.metadata, "manifestId")].filter((item): item is string => Boolean(item)),
];

const sourceExportIdsForScorecard = (
  scorecard: CodaliImprovementScorecard,
): string[] => [
  ...[stringValue(scorecard.metadata, "manifestId")].filter((item): item is string => Boolean(item)),
  ...[stringValue(scorecard.metadata, "sourceExportId")].filter((item): item is string => Boolean(item)),
  ...stringArray(scorecard.metadata, "sourceExportIds"),
];

const gateSummary = (
  gate: CodaliImprovementGate,
  sourcePath: string,
): CodaliOperatorEvalGateSummary => ({
  gateId: gate.gateId,
  candidateId: gate.candidateId,
  gateType: gate.gateType,
  status: gate.status,
  required: gate.required,
  passed: gate.passed,
  reasons: gate.reasons ?? [],
  score: gate.score,
  sourcePath,
});

const buildBlockedCandidates = (input: {
  releases: Array<ArtifactRecord<CodaliImprovementRelease>>;
  candidates: Array<ArtifactRecord<CodaliImprovementCandidate>>;
  scorecards: Array<ArtifactRecord<CodaliImprovementScorecard>>;
}): CodaliOperatorBlockedCandidateSummary[] => {
  const byCandidate = new Map<string, CodaliOperatorBlockedCandidateSummary>();
  const ensure = (candidateId: string): CodaliOperatorBlockedCandidateSummary => {
    const existing = byCandidate.get(candidateId);
    if (existing) return existing;
    const created: CodaliOperatorBlockedCandidateSummary = {
      candidateId,
      status: "unknown",
      reasons: [],
      sources: [],
      sourceExportIds: [],
      releaseIds: [],
      scorecardIds: [],
    };
    byCandidate.set(candidateId, created);
    return created;
  };

  for (const { value, sourcePath } of input.candidates) {
    const reasons = value.blockedReasons ?? [];
    if (value.status !== "blocked" && reasons.length === 0) continue;
    const blocked = ensure(value.candidateId);
    blocked.status = value.status;
    for (const reason of reasons.length ? reasons : ["candidate_status_blocked"]) {
      pushUnique(blocked.reasons, reason);
    }
    pushUnique(blocked.sources, sourcePath);
    for (const exportId of sourceExportIdsForCandidate(value)) {
      pushUnique(blocked.sourceExportIds, exportId);
    }
  }

  for (const { value, sourcePath } of input.scorecards) {
    const failedGates = value.gates.filter((gate) =>
      gate.status === "failed" || gate.status === "blocked" ||
      (gate.required && !gate.passed));
    if (value.status === "passed" && failedGates.length === 0) continue;
    const blocked = ensure(value.candidateId);
    blocked.status = value.status === "passed" ? blocked.status : value.status;
    pushUnique(blocked.sources, sourcePath);
    pushUnique(blocked.scorecardIds, value.scorecardId);
    for (const exportId of sourceExportIdsForScorecard(value)) {
      pushUnique(blocked.sourceExportIds, exportId);
    }
    for (const gate of failedGates) {
      pushUnique(blocked.sources, `gate:${gate.gateId}`);
      for (const reason of gate.reasons?.length ? gate.reasons : [`gate_${gate.status}:${gate.gateId}`]) {
        pushUnique(blocked.reasons, reason);
      }
    }
  }

  for (const { value, sourcePath } of input.releases) {
    const reasons = value.blockedReasons ?? [];
    if (value.status !== "blocked" && reasons.length === 0) continue;
    const blocked = ensure(value.candidateId);
    blocked.status = value.status === "blocked" ? "blocked" : blocked.status;
    pushUnique(blocked.sources, sourcePath);
    pushUnique(blocked.releaseIds, value.releaseId);
    for (const reason of reasons.length ? reasons : ["release_status_blocked"]) {
      pushUnique(blocked.reasons, reason);
    }
    for (const exportId of sourceExportIdsForRelease(value)) {
      pushUnique(blocked.sourceExportIds, exportId);
    }
  }

  return [...byCandidate.values()]
    .map((candidate) => ({
      ...candidate,
      reasons: unique(candidate.reasons),
      sources: unique(candidate.sources),
      sourceExportIds: unique(candidate.sourceExportIds),
      releaseIds: unique(candidate.releaseIds),
      scorecardIds: unique(candidate.scorecardIds),
    }))
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
};

const rollbackSummary = (
  report: ArtifactRecord<CodaliReleaseOutcomeReport>,
): CodaliOperatorRollbackSummary => {
  const triggerCodes = report.value.rollbackTriggers
    .filter((trigger) => trigger.triggered)
    .map((trigger) => trigger.code);
  return {
    releaseId: report.value.releaseId,
    status: report.value.status,
    triggerCodes: unique(triggerCodes) as CodaliReleaseRollbackTriggerCode[],
    events: report.value.rollbackEvents.map((event) => ({
      eventId: event.eventId,
      eventType: event.eventType,
      createdAt: event.createdAt,
      triggerCodes: [...event.triggerCodes],
    })),
    sourcePath: report.sourcePath,
  };
};

const relatedByCandidateId = <T extends { candidateId: string }>(
  records: Array<ArtifactRecord<T>>,
  candidateIds: ReadonlySet<string>,
): Array<ArtifactRecord<T>> =>
  records.filter((record) => candidateIds.has(record.value.candidateId));

const relatedManifests = (
  manifests: Array<ArtifactRecord<JsonExportManifest>>,
  exportIds: ReadonlySet<string>,
): Array<ArtifactRecord<JsonExportManifest>> =>
  manifests.filter((record) => exportIds.has(record.value.manifestId));

export const inspectCodaliReleaseForOperators = async (
  input: InspectCodaliReleaseForOperatorsInput,
): Promise<CodaliReleaseOperatorInspection> => {
  const warnings: string[] = [];
  const directories = unique(
    (input.directories?.length
      ? [...input.directories]
      : input.directory
        ? [input.directory]
        : [...DEFAULT_CODALI_OPERATOR_INSPECTION_SEARCH_DIRECTORIES])
      .map((directory) => path.resolve(directory)),
  );
  const maxFiles = input.maxFiles ?? 5_000;
  const jsonFiles = (await Promise.all(directories.map((directory) =>
    listJsonFiles(directory, maxFiles)))).flat();
  const payloads = (await Promise.all(jsonFiles.map((file) =>
    readJsonPayloads(file, warnings)))).flat();
  const releases: Array<ArtifactRecord<JsonImprovementRelease>> = [];
  const candidates: Array<ArtifactRecord<JsonImprovementCandidate>> = [];
  const scorecards: Array<ArtifactRecord<JsonImprovementScorecard>> = [];
  const manifests: Array<ArtifactRecord<JsonExportManifest>> = [];
  const outcomes: Array<ArtifactRecord<JsonImprovementOutcome>> = [];
  const reports: Array<ArtifactRecord<JsonReleaseOutcomeReport>> = [];

  for (const { payload, sourcePath } of payloads) {
    if (isRelease(payload)) releases.push({ value: payload, sourcePath });
    if (isCandidate(payload)) candidates.push({ value: payload, sourcePath });
    if (isScorecard(payload)) scorecards.push({ value: payload, sourcePath });
    if (isExportManifest(payload)) manifests.push({ value: payload, sourcePath });
    if (isOutcome(payload)) outcomes.push({ value: payload, sourcePath });
    if (isReleaseReport(payload)) reports.push({ value: payload, sourcePath });
  }

  const releaseRecords = releases.filter((record) => record.value.releaseId === input.releaseId);
  const releaseCandidateIds = new Set(releaseRecords.map((record) => record.value.candidateId));
  for (const report of reports.filter((record) => record.value.releaseId === input.releaseId)) {
    if (report.value.outcome.releaseId === input.releaseId) {
      const candidateId = stringValue(report.value.outcome.metadata, "candidateId");
      if (candidateId) releaseCandidateIds.add(candidateId);
    }
  }
  const relatedOutcomes = outcomes.filter((record) => record.value.releaseId === input.releaseId);
  const relatedReports = reports.filter((record) => record.value.releaseId === input.releaseId);
  const candidateRecords = relatedByCandidateId(candidates, releaseCandidateIds);
  for (const candidate of candidateRecords) releaseCandidateIds.add(candidate.value.candidateId);
  const scorecardRecords = relatedByCandidateId(scorecards, releaseCandidateIds);
  const exportIds = new Set<string>([
    ...releaseRecords.flatMap((record) => sourceExportIdsForRelease(record.value)),
    ...candidateRecords.flatMap((record) => sourceExportIdsForCandidate(record.value)),
    ...scorecardRecords.flatMap((record) => sourceExportIdsForScorecard(record.value)),
  ]);
  const manifestRecords = relatedManifests(manifests, exportIds);
  for (const manifest of manifestRecords) {
    for (const exportId of manifestSourceExportIds(manifest.value)) exportIds.add(exportId);
  }
  const audit = createAuditSummary();
  const evalGates = scorecardRecords.flatMap((record) =>
    record.value.gates.map((gate) => gateSummary(gate, record.sourcePath)));
  const blockedCandidates = buildBlockedCandidates({
    releases: releaseRecords,
    candidates: candidateRecords,
    scorecards: scorecardRecords,
  });
  const rollbacks = relatedReports
    .filter((record) =>
      record.value.status === "rollback_required" ||
      record.value.status === "rolled_back" ||
      record.value.rollbackEvents.length > 0)
    .map(rollbackSummary);
  const releaseStatuses: Record<string, number> = {};
  const candidateStatuses: Record<string, number> = {};
  const gateStatuses: Record<string, number> = {};
  for (const release of releaseRecords) increment(releaseStatuses, release.value.status);
  for (const candidate of candidateRecords) increment(candidateStatuses, candidate.value.status);
  for (const gate of evalGates) increment(gateStatuses, gate.status);
  const productId = releaseRecords
    .map((record) => scopeProductId(record.value.scope))
    .find((value): value is string => Boolean(value));

  if (releaseRecords.length === 0) warnings.push(`release_not_found:${input.releaseId}`);
  if (manifestRecords.length === 0) warnings.push(`release_export_lineage_missing:${input.releaseId}`);
  if (evalGates.length === 0) warnings.push(`release_eval_gates_missing:${input.releaseId}`);

  return {
    schemaVersion: CODALI_OPERATOR_INSPECTOR_SCHEMA_VERSION,
    inspectionType: "release",
    dashboardReady: true,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    releaseId: input.releaseId,
    searchDirectories: directories,
    storageServiceQueryEndpoints: {
      releaseLineage:
        `${DEFAULT_STORAGE_SERVICE_IMPROVEMENT_RELEASE_LINEAGE_ENDPOINT}/${encodeURIComponent(input.releaseId)}/lineage`,
      productQualitySummary:
        `${DEFAULT_STORAGE_SERVICE_IMPROVEMENT_PRODUCT_QUALITY_SUMMARY_ENDPOINT}/${encodeURIComponent(productId ?? "product-neutral")}/quality-summary`,
    },
    releaseLineage: {
      releases: releaseRecords.map((record) =>
        artifactSummary("release", record.value.releaseId, record.sourcePath, record.value, audit)),
      exports: manifestRecords.map((record) =>
        artifactSummary("dataset_export", record.value.manifestId, record.sourcePath, record.value, audit)),
      candidates: candidateRecords.map((record) =>
        artifactSummary("candidate", record.value.candidateId, record.sourcePath, record.value, audit)),
      scorecards: scorecardRecords.map((record) =>
        artifactSummary("scorecard", record.value.scorecardId, record.sourcePath, record.value, audit)),
      outcomes: relatedOutcomes.map((record) =>
        artifactSummary("outcome", record.value.outcomeId, record.sourcePath, record.value, audit)),
      evalGates,
      rollbacks,
      traceability: {
        traceableToExports: manifestRecords.length > 0,
        traceableToEvalGates: evalGates.length > 0,
        releaseIds: unique(releaseRecords.map((record) => record.value.releaseId)),
        candidateIds: unique([...releaseCandidateIds]),
        exportIds: unique([...exportIds]),
        scorecardIds: unique(scorecardRecords.map((record) => record.value.scorecardId)),
        gateIds: unique(evalGates.map((gate) => gate.gateId)),
      },
    },
    blockedCandidates,
    productQualitySummary: {
      productId,
      releaseCount: releaseRecords.length,
      candidateCount: candidateRecords.length,
      blockedCandidateCount: blockedCandidates.length,
      exportCount: manifestRecords.length,
      scorecardCount: scorecardRecords.length,
      evalGateCount: evalGates.length,
      rollbackCount: rollbacks.length,
      gateStatuses,
      releaseStatuses,
      candidateStatuses,
      privacy: {
        containsSecretsExportCount: manifestRecords.filter((record) =>
          record.value.privacySummary?.containsSecrets === true).length,
        containsCustomerDataExportCount: manifestRecords.filter((record) =>
          record.value.privacySummary?.containsCustomerData === true).length,
        noSecretsOrUnredactedCustomerData: true,
      },
    },
    audit,
    warnings,
  };
};

export const formatCodaliDatasetRunOperatorInspectionText = (
  inspection: CodaliDatasetRunOperatorInspection,
): string => {
  const lines = [
    "dataset inspect",
    `directory: ${inspection.directory}`,
    `dashboard_ready: ${inspection.dashboardReady}`,
    `runs: ${inspection.runs.length}`,
  ];
  for (const run of inspection.runs) {
    lines.push(
      `run: ${run.runId} records=${run.recordCount} reviewed=${run.reviewedCount} export_allowed=${run.exportAllowedCount}`,
    );
  }
  if (inspection.warnings.length) lines.push(`warnings: ${inspection.warnings.join(", ")}`);
  return lines.join("\n");
};

export const formatCodaliReleaseOperatorInspectionText = (
  inspection: CodaliReleaseOperatorInspection,
): string => {
  const traceability = inspection.releaseLineage.traceability;
  const lines = [
    "improvement inspect release",
    `release: ${inspection.releaseId}`,
    `dashboard_ready: ${inspection.dashboardReady}`,
    `exports: ${traceability.exportIds.join(", ") || "none"}`,
    `eval_gates: ${traceability.gateIds.length}`,
    `blocked_candidates: ${inspection.blockedCandidates.length}`,
    `rollbacks: ${inspection.releaseLineage.rollbacks.length}`,
  ];
  if (inspection.warnings.length) lines.push(`warnings: ${inspection.warnings.join(", ")}`);
  return lines.join("\n");
};
