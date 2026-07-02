import { createHash } from "node:crypto";
import type {
  CodaliEvidenceItem,
  CodaliGatewayFreshness,
} from "./CodaliGatewayTypes.js";

export interface CodaliEvidenceNormalizerToolCall {
  tool: string;
  status?: "success" | "failed" | "blocked" | string;
  args?: unknown;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliEvidenceNormalizerInput {
  runId: string;
  taskId?: string;
  stageId?: string;
  originalQuery?: string;
  workerOutput?: unknown;
  evidence?: unknown[];
  toolCalls?: CodaliEvidenceNormalizerToolCall[];
  requireTenantScope?: boolean;
  defaultTenantScoped?: boolean;
  defaultSourceType?: string;
  defaultTool?: string;
  maxEvidenceItems?: number;
}

export interface CodaliEvidenceRejectedItem {
  reason: string;
  claim?: string;
  sourceType?: string;
  sourceId?: string;
  sourceUri?: string;
  usedTool?: string;
  value?: unknown;
}

export interface CodaliEvidenceNormalizerResult {
  evidence: CodaliEvidenceItem[];
  rejected: CodaliEvidenceRejectedItem[];
  warnings: string[];
  duplicateCount: number;
}

interface EvidenceCandidate {
  claim?: string;
  summary?: string;
  sourceType?: string;
  sourceId?: string;
  sourceUri?: string;
  sourceTitle?: string;
  sourceTimestamp?: string;
  rawExcerpt?: string;
  rawPayloadRef?: string;
  confidence?: number;
  relevance?: number;
  freshness?: CodaliGatewayFreshness;
  usedTool?: string;
  tenantScoped?: boolean;
  metadata?: Record<string, unknown>;
  value?: unknown;
  unprovenanced?: boolean;
}

interface CollectionContext {
  sourceType?: string;
  usedTool?: string;
  tenantScoped?: boolean;
  metadata?: Record<string, unknown>;
  depth: number;
  rootStringMode?: boolean;
  allowGenericPayload?: boolean;
}

const MAX_DEPTH = 5;
const MAX_EXCERPT_CHARS = 1_200;

const EVIDENCE_ARRAY_KEYS = [
  "evidence",
  "evidenceItems",
  "evidence_items",
  "facts",
  "sources",
  "sourceRecords",
  "source_records",
  "citations",
  "results",
  "hits",
  "items",
  "records",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
};

const readNumber = (
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
};

const readBoolean = (
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
};

const readRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
};

const clamp = (value: number | undefined, fallback: number): number => {
  const candidate = Number.isFinite(value) ? value as number : fallback;
  return Math.max(0, Math.min(1, candidate));
};

const truncate = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  return value.length > MAX_EXCERPT_CHARS
    ? `${value.slice(0, MAX_EXCERPT_CHARS - 3)}...`
    : value;
};

const canonicalize = (value: string | undefined): string =>
  (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

const stableHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const stableEvidenceId = (
  runId: string,
  taskId: string | undefined,
  candidate: EvidenceCandidate,
): string => {
  const fingerprint = [
    runId,
    taskId ?? "",
    canonicalize(candidate.sourceType),
    canonicalize(candidate.sourceId),
    canonicalize(candidate.sourceUri),
    canonicalize(candidate.sourceTitle),
    canonicalize(candidate.claim),
  ].join("|");
  return `ev-${stableHash(fingerprint)}`;
};

const fingerprintCandidate = (candidate: EvidenceCandidate): string => [
  canonicalize(candidate.sourceType),
  canonicalize(candidate.sourceId),
  canonicalize(candidate.sourceUri),
  canonicalize(candidate.sourceTitle),
  canonicalize(candidate.claim),
].join("|");

const metadataFromRecord = (record: Record<string, unknown>): Record<string, unknown> | undefined =>
  isRecord(record.metadata) ? record.metadata : undefined;

const sourceRecord = (record: Record<string, unknown>): Record<string, unknown> | undefined =>
  readRecord(record, ["source", "provenance", "citation"]);

const docdexTelemetryMetadata = (
  record: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!record) return undefined;
  const requestId = readString(record, [
    "docdex_request_id",
    "docdexRequestId",
    "request_id",
    "requestId",
    "x-docdex-request-id",
    "x_docdex_request_id",
    "x-request-id",
    "x_request_id",
    "correlation_id",
    "correlationId",
  ]);
  const operation = readString(record, ["docdex_operation", "docdexOperation", "operation"]);
  const metadata: Record<string, unknown> = {};
  if (requestId) metadata.docdex_request_id = requestId;
  if (operation) metadata.docdex_operation = operation;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const mergeDocdexTelemetryMetadata = (
  base: Record<string, unknown> | undefined,
  ...records: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined => {
  const metadata: Record<string, unknown> = { ...(base ?? {}) };
  for (const record of records) {
    Object.assign(metadata, docdexTelemetryMetadata(record) ?? {});
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const sourceTypeFromTool = (tool: string | undefined): string | undefined => {
  if (!tool) return undefined;
  if (tool.startsWith("docdex_")) return "docdex";
  return "app_tool";
};

const hasDocdexShape = (record: Record<string, unknown>): boolean =>
  Boolean(
    readString(record, ["doc_id", "docId", "documentId"]) ||
    readString(record, ["rel_path", "relPath", "path", "file"]) ||
    readString(record, ["snippet", "excerpt"]),
  );

const provenancePresent = (candidate: EvidenceCandidate): boolean =>
  Boolean(
    candidate.sourceId ||
    candidate.sourceUri ||
    candidate.sourceTitle ||
    candidate.rawExcerpt ||
    candidate.usedTool,
  );

const safeJsonExcerpt = (value: unknown): string | undefined => {
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return undefined;
  }
};

const parseMaybeJson = (value: string): { parsed?: unknown; malformed: boolean } => {
  const trimmed = value.trim();
  if (!trimmed) return { malformed: false };
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return { malformed: false };
  }
  try {
    return { parsed: JSON.parse(trimmed), malformed: false };
  } catch {
    return { malformed: true };
  }
};

const buildCandidateFromRecord = (
  record: Record<string, unknown>,
  context: CollectionContext,
): EvidenceCandidate | undefined => {
  const source = sourceRecord(record);
  const docdexLike = hasDocdexShape(record);
  const sourceType =
    readString(record, ["sourceType", "source_type", "type"]) ??
    (source ? readString(source, ["sourceType", "source_type", "type"]) : undefined) ??
    (docdexLike ? "docdex" : context.sourceType);
  const sourceId =
    readString(record, ["sourceId", "source_id", "doc_id", "docId", "documentId", "id"]) ??
    (source ? readString(source, ["sourceId", "source_id", "doc_id", "docId", "id"]) : undefined);
  const sourceUri =
    readString(record, ["sourceUri", "source_uri", "url", "uri", "href"]) ??
    (source ? readString(source, ["sourceUri", "source_uri", "url", "uri", "href"]) : undefined);
  const sourceTitle =
    readString(record, ["sourceTitle", "source_title", "title", "name", "rel_path", "relPath", "path", "file"]) ??
    (source ? readString(source, ["sourceTitle", "source_title", "title", "name", "path"]) : undefined);
  const rawExcerpt =
    truncate(readString(record, ["rawExcerpt", "raw_excerpt", "excerpt", "snippet", "text"])) ??
    (source ? truncate(readString(source, ["rawExcerpt", "raw_excerpt", "excerpt", "snippet", "text"])) : undefined);
  const claim =
    readString(record, ["claim", "fact", "statement", "summary", "description", "text", "content"]) ??
    rawExcerpt ??
    sourceTitle;

  if (!claim) {
    return undefined;
  }

  const tenantScoped =
    readBoolean(record, ["tenantScoped", "tenant_scoped"]) ??
    (source ? readBoolean(source, ["tenantScoped", "tenant_scoped"]) : undefined) ??
    context.tenantScoped;
  const usedTool =
    readString(record, ["usedTool", "used_tool", "tool"]) ??
    context.usedTool;
  const recordMetadata = metadataFromRecord(record);
  const metadata: Record<string, unknown> = {
    ...(context.metadata ?? {}),
    ...(recordMetadata ?? {}),
    ...(docdexTelemetryMetadata(record) ?? {}),
    ...(docdexTelemetryMetadata(recordMetadata) ?? {}),
    ...(source ? docdexTelemetryMetadata(source) ?? {} : {}),
  };
  const path = readString(record, ["rel_path", "relPath", "path", "file"]);
  if (path) metadata.path = path;
  if (source && Object.keys(source).length > 0) metadata.source = source;

  const unprovenanced = !provenancePresent({
    sourceId,
    sourceUri,
    sourceTitle,
    rawExcerpt,
    usedTool,
  });

  return {
    claim,
    summary: readString(record, ["summary"]),
    sourceType: sourceType ?? (unprovenanced ? "model_observation" : "worker_output"),
    sourceId,
    sourceUri,
    sourceTitle,
    sourceTimestamp:
      readString(record, ["sourceTimestamp", "source_timestamp", "timestamp", "updatedAt", "updated_at"]) ??
      (source ? readString(source, ["sourceTimestamp", "source_timestamp", "timestamp", "updatedAt", "updated_at"]) : undefined),
    rawExcerpt,
    rawPayloadRef: readString(record, ["rawPayloadRef", "raw_payload_ref"]),
    confidence: readNumber(record, ["confidence", "score"]),
    relevance: readNumber(record, ["relevance", "rankScore", "rank_score", "score"]),
    freshness: readFreshness(record),
    usedTool,
    tenantScoped,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    value: record,
    unprovenanced,
  };
};

const readFreshness = (record: Record<string, unknown>): CodaliGatewayFreshness | undefined => {
  const freshness = readString(record, ["freshness"]);
  if (
    freshness === "fresh" ||
    freshness === "recent" ||
    freshness === "stale" ||
    freshness === "unknown"
  ) {
    return freshness;
  }
  return undefined;
};

const collectCandidates = (
  value: unknown,
  context: CollectionContext,
  warnings: string[],
): EvidenceCandidate[] => {
  if (context.depth > MAX_DEPTH || value === undefined || value === null) {
    return [];
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    const parsed = parseMaybeJson(trimmed);
    if (parsed.parsed !== undefined) {
      return collectCandidates(parsed.parsed, { ...context, depth: context.depth + 1 }, warnings);
    }
    if (parsed.malformed) {
      warnings.push("malformed_worker_json");
    }
    if (!context.rootStringMode) {
      return [];
    }
    return [{
      claim: trimmed,
      rawExcerpt: truncate(trimmed),
      sourceType: "model_observation",
      confidence: 0.2,
      relevance: 0.4,
      usedTool: context.usedTool,
      tenantScoped: context.tenantScoped,
      metadata: context.metadata,
      value,
      unprovenanced: true,
    }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      collectCandidates(item, {
        ...context,
        depth: context.depth + 1,
        rootStringMode: true,
      }, warnings),
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  const recordMetadata = metadataFromRecord(value);
  const metaRecord = readRecord(value, ["meta"]);
  const scopedMetadata = mergeDocdexTelemetryMetadata(
    context.metadata,
    value,
    recordMetadata,
    metaRecord,
  );
  const scopedContext: CollectionContext = scopedMetadata
    ? { ...context, metadata: scopedMetadata }
    : context;
  const candidates: EvidenceCandidate[] = [];
  const directCandidate = buildCandidateFromRecord(value, scopedContext);
  if (directCandidate) {
    candidates.push(directCandidate);
  }

  for (const key of EVIDENCE_ARRAY_KEYS) {
    const child = value[key];
    if (child === undefined) continue;
    candidates.push(...collectCandidates(child, {
      ...scopedContext,
      depth: context.depth + 1,
      rootStringMode: key === "facts",
    }, warnings));
  }

  if (candidates.length === 0 && context.allowGenericPayload && Object.keys(value).length > 0) {
    candidates.push({
      claim: context.usedTool
        ? `Tool ${context.usedTool} returned structured data.`
        : "Worker returned structured data.",
      summary: safeJsonExcerpt(value),
      sourceType: context.sourceType ?? "app_tool",
      rawExcerpt: safeJsonExcerpt(value),
      confidence: 0.55,
      relevance: 0.5,
      usedTool: scopedContext.usedTool,
      tenantScoped: scopedContext.tenantScoped,
      metadata: scopedContext.metadata,
      value,
    });
  }

  return candidates;
};

const normalizeCandidate = (
  input: CodaliEvidenceNormalizerInput,
  candidate: EvidenceCandidate,
): CodaliEvidenceItem | undefined => {
  const claim = candidate.claim?.trim();
  if (!claim) {
    return undefined;
  }
  const unprovenanced = candidate.unprovenanced || !provenancePresent(candidate);
  const sourceType = unprovenanced
    ? "model_observation"
    : candidate.sourceType ?? input.defaultSourceType ?? "worker_output";
  const fallbackConfidence =
    sourceType === "model_observation"
      ? 0.2
      : sourceType === "docdex"
        ? 0.75
        : sourceType === "app_tool"
          ? 0.7
          : 0.55;
  const fallbackRelevance =
    sourceType === "model_observation"
      ? 0.4
      : sourceType === "docdex"
        ? 0.65
        : 0.55;
  const confidence = unprovenanced
    ? Math.min(0.25, clamp(candidate.confidence, fallbackConfidence))
    : clamp(candidate.confidence, fallbackConfidence);
  const relevance = clamp(candidate.relevance, fallbackRelevance);

  return {
    id: stableEvidenceId(input.runId, input.taskId, { ...candidate, claim, sourceType }),
    runId: input.runId,
    taskId: input.taskId,
    stageId: input.stageId,
    claim,
    summary: candidate.summary,
    sourceType,
    sourceId: candidate.sourceId,
    sourceUri: candidate.sourceUri,
    sourceTitle: candidate.sourceTitle,
    sourceTimestamp: candidate.sourceTimestamp,
    rawExcerpt: candidate.rawExcerpt,
    rawPayloadRef: candidate.rawPayloadRef,
    confidence,
    relevance,
    freshness: candidate.freshness,
    usedTool: candidate.usedTool ?? input.defaultTool,
    tenantScoped: candidate.tenantScoped ?? input.defaultTenantScoped ?? false,
    metadata: {
      ...(candidate.metadata ?? {}),
      normalizedBy: "codali_gateway_evidence_normalizer",
      unprovenanced,
      originalQuery: input.originalQuery,
    },
  };
};

export const normalizeCodaliEvidence = (
  input: CodaliEvidenceNormalizerInput,
): CodaliEvidenceNormalizerResult => {
  const warnings: string[] = [];
  const rejected: CodaliEvidenceRejectedItem[] = [];
  const candidates: EvidenceCandidate[] = [];

  for (const evidence of input.evidence ?? []) {
    candidates.push(...collectCandidates(evidence, {
      sourceType: input.defaultSourceType,
      usedTool: input.defaultTool,
      tenantScoped: input.defaultTenantScoped,
      depth: 0,
      rootStringMode: true,
    }, warnings));
  }

  if (input.workerOutput !== undefined) {
    candidates.push(...collectCandidates(input.workerOutput, {
      sourceType: input.defaultSourceType,
      usedTool: input.defaultTool,
      tenantScoped: input.defaultTenantScoped,
      depth: 0,
      rootStringMode: true,
    }, warnings));
  }

  for (const call of input.toolCalls ?? []) {
    if (call.status && call.status !== "success") {
      continue;
    }
    const toolSourceType = sourceTypeFromTool(call.tool) ?? input.defaultSourceType;
    const before = candidates.length;
    candidates.push(...collectCandidates(call.result, {
      sourceType: toolSourceType,
      usedTool: call.tool,
      tenantScoped: input.defaultTenantScoped,
      metadata: {
        tool: call.tool,
        toolArgs: call.args,
        toolMetadata: call.metadata,
      },
      depth: 0,
      rootStringMode: false,
      allowGenericPayload: toolSourceType === "app_tool",
    }, warnings));
    if (
      candidates.length === before &&
      toolSourceType === "app_tool" &&
      call.result !== undefined
    ) {
      candidates.push({
        claim: `Tool ${call.tool} returned structured data.`,
        sourceType: "app_tool",
        rawExcerpt: safeJsonExcerpt(call.result),
        confidence: 0.55,
        relevance: 0.5,
        usedTool: call.tool,
        tenantScoped: input.defaultTenantScoped,
        metadata: { tool: call.tool, toolArgs: call.args, toolMetadata: call.metadata },
        value: call.result,
      });
    }
  }

  const deduped = new Map<string, CodaliEvidenceItem>();
  let duplicateCount = 0;
  for (const candidate of candidates) {
    const normalized = normalizeCandidate(input, candidate);
    if (!normalized) {
      rejected.push({
        reason: "missing_claim",
        value: candidate.value,
      });
      continue;
    }
    if (input.requireTenantScope && !normalized.tenantScoped) {
      rejected.push({
        reason: "tenant_scope_required",
        claim: normalized.claim,
        sourceType: normalized.sourceType,
        sourceId: normalized.sourceId,
        sourceUri: normalized.sourceUri,
        usedTool: normalized.usedTool,
        value: candidate.value,
      });
      continue;
    }
    const fingerprint = fingerprintCandidate(normalized);
    const existing = deduped.get(fingerprint);
    if (existing) {
      duplicateCount += 1;
      existing.metadata = {
        ...(existing.metadata ?? {}),
        duplicateCount: Number(existing.metadata?.duplicateCount ?? 0) + 1,
        duplicateEvidenceIds: [
          ...(
            Array.isArray(existing.metadata?.duplicateEvidenceIds)
              ? existing.metadata.duplicateEvidenceIds as string[]
              : []
          ),
          normalized.id,
        ],
      };
      existing.confidence = Math.max(existing.confidence, normalized.confidence);
      existing.relevance = Math.max(existing.relevance, normalized.relevance);
      continue;
    }
    deduped.set(fingerprint, normalized);
  }

  const evidence = [...deduped.values()]
    .sort((left, right) =>
      right.relevance - left.relevance ||
      right.confidence - left.confidence ||
      left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(0, input.maxEvidenceItems ?? Number.MAX_SAFE_INTEGER));

  if ((input.maxEvidenceItems ?? Number.MAX_SAFE_INTEGER) < deduped.size) {
    warnings.push("evidence_truncated_to_budget");
  }

  return {
    evidence,
    rejected,
    warnings,
    duplicateCount,
  };
};

export const normalizeGatewayEvidence = normalizeCodaliEvidence;
