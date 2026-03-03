export const RUN_TELEMETRY_SCHEMA_VERSION = 1 as const;

export type RunTelemetrySchemaVersion = typeof RUN_TELEMETRY_SCHEMA_VERSION;

export type RunDisposition = "pass" | "fail" | "degraded";

export type RunFailureClass =
  | "execution_failure"
  | "verification_failure"
  | "policy_failure"
  | "safety_failure"
  | "patch_failure"
  | "provider_failure"
  | "unknown_failure";

export type QualityDimensionStatus = "available" | "missing" | "degraded";

export type TelemetrySource = "actual_usage" | "estimated_usage" | "unknown";

export type TelemetryReasonCode =
  | "usage_missing"
  | "cost_missing"
  | "provider_usage_not_exposed"
  | "pricing_unavailable"
  | "phase_not_model_invoking"
  | "not_applicable"
  | "unknown";

export type SafetyTelemetryCategory = "tool" | "patch" | "critic" | "policy";

export type SafetyTelemetryDisposition = "retryable" | "non_retryable";

export interface SafetyTelemetryEventData {
  schema_version: RunTelemetrySchemaVersion;
  run_id: string;
  phase: string;
  category: SafetyTelemetryCategory;
  code: string;
  disposition: SafetyTelemetryDisposition;
  message: string;
  source?: string;
  tool?: string;
  failure_class?: RunFailureClass;
  reason_codes?: string[];
  details?: Record<string, unknown>;
}

export interface RunArtifactReference {
  phase: string;
  kind: string;
  path?: string | null;
  status: "present" | "missing";
  reason_code?: string;
}

export interface PhaseUsageTelemetry {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface PhaseCostTelemetry {
  usd?: number;
  source: TelemetrySource;
  pricing_source?: string;
  reason_code?: TelemetryReasonCode;
}

export interface PhaseTelemetryRecord {
  schema_version: RunTelemetrySchemaVersion;
  run_id: string;
  phase: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  usage?: PhaseUsageTelemetry;
  cost?: PhaseCostTelemetry;
  missing_usage_reason?: TelemetryReasonCode;
  missing_cost_reason?: TelemetryReasonCode;
  metadata?: Record<string, unknown>;
}

export interface PhaseTelemetryInput {
  run_id?: string;
  phase?: string;
  provider?: string;
  model?: string;
  duration_ms?: number;
  usage?: PhaseUsageTelemetry;
  cost?: PhaseCostTelemetry;
  missing_usage_reason?: TelemetryReasonCode;
  missing_cost_reason?: TelemetryReasonCode;
  metadata?: Record<string, unknown>;
}

export interface RunQualityDimensions {
  plan: QualityDimensionStatus;
  retrieval: QualityDimensionStatus;
  patch: QualityDimensionStatus;
  verification: QualityDimensionStatus;
  final_disposition: QualityDimensionStatus;
}

export interface RunFinalDisposition {
  status: RunDisposition;
  failure_class?: RunFailureClass;
  reason_codes: string[];
  stage?: string;
  retryable?: boolean | null;
}

export interface RunSummaryEventData extends Record<string, unknown> {
  schema_version: RunTelemetrySchemaVersion;
  run_id: string;
  runId: string;
  durationMs: number;
  touchedFiles: string[];
  quality_dimensions: RunQualityDimensions;
  final_disposition: RunFinalDisposition;
  artifact_references: RunArtifactReference[];
  phase_telemetry: PhaseTelemetryRecord[];
  missing_artifacts: string[];
}

export interface RunSummaryInput extends Record<string, unknown> {
  schema_version?: number;
  run_id?: string;
  runId?: string;
  durationMs?: number;
  touchedFiles?: string[];
  quality_dimensions?: Partial<RunQualityDimensions>;
  final_disposition?: Partial<RunFinalDisposition>;
  artifact_references?: RunArtifactReference[];
  phase_telemetry?: PhaseTelemetryInput[];
  missing_artifacts?: string[];
}

export class RunTelemetryValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunTelemetryValidationError";
    this.code = code;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const normalizeNonEmptyString = (
  value: unknown,
  code: string,
  message: string,
): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunTelemetryValidationError(code, message);
  }
  return value.trim();
};

const normalizeFiniteNumber = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
};

const uniqueSortedStrings = (values: unknown): string[] => {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
};

export const stableSortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSortValue(entry));
  }
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const ordered = Object.keys(source)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, stableSortValue(source[key])]);
  return Object.fromEntries(ordered);
};

const QUALITY_DEFAULTS: RunQualityDimensions = {
  plan: "missing",
  retrieval: "missing",
  patch: "missing",
  verification: "missing",
  final_disposition: "available",
};

const DISPOSITION_STATUSES: RunDisposition[] = ["pass", "fail", "degraded"];

const FAILURE_CLASSES: RunFailureClass[] = [
  "execution_failure",
  "verification_failure",
  "policy_failure",
  "safety_failure",
  "patch_failure",
  "provider_failure",
  "unknown_failure",
];

const TELEMETRY_REASON_CODES: TelemetryReasonCode[] = [
  "usage_missing",
  "cost_missing",
  "provider_usage_not_exposed",
  "pricing_unavailable",
  "phase_not_model_invoking",
  "not_applicable",
  "unknown",
];

const normalizeQualityDimension = (value: unknown): QualityDimensionStatus => {
  if (value === "available" || value === "missing" || value === "degraded") return value;
  return "missing";
};

export const normalizeFailureClass = (value: unknown): RunFailureClass | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if ((FAILURE_CLASSES as string[]).includes(normalized)) {
    return normalized as RunFailureClass;
  }
  return undefined;
};

const normalizeReasonCode = (value: unknown): TelemetryReasonCode | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if ((TELEMETRY_REASON_CODES as string[]).includes(normalized)) {
    return normalized as TelemetryReasonCode;
  }
  return undefined;
};

const normalizeArtifactReference = (value: unknown): RunArtifactReference | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  const phase = typeof record.phase === "string" ? record.phase.trim() : "";
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  if (!phase || !kind) return undefined;
  const status =
    record.status === "present" || record.status === "missing" ? record.status : "present";
  const pathValue =
    typeof record.path === "string"
      ? record.path
      : record.path === null
      ? null
      : undefined;
  const reasonCode =
    typeof record.reason_code === "string" && record.reason_code.trim().length > 0
      ? record.reason_code.trim()
      : undefined;
  return {
    phase,
    kind,
    status,
    path: pathValue,
    reason_code: reasonCode,
  };
};

const normalizeTelemetrySource = (value: unknown): TelemetrySource => {
  if (value === "actual_usage" || value === "estimated_usage" || value === "unknown") {
    return value;
  }
  return "unknown";
};

export const normalizePhaseTelemetryRecord = (
  input: PhaseTelemetryInput,
): PhaseTelemetryRecord => {
  const runId = normalizeNonEmptyString(
    input.run_id,
    "phase_telemetry_missing_run_id",
    "phase telemetry requires run_id",
  );
  const phase = normalizeNonEmptyString(
    input.phase,
    "phase_telemetry_missing_phase",
    "phase telemetry requires phase",
  );

  const usageRecord = asRecord(input.usage);
  const inputTokens = normalizeFiniteNumber(usageRecord?.input_tokens);
  const outputTokens = normalizeFiniteNumber(usageRecord?.output_tokens);
  const totalTokens = normalizeFiniteNumber(usageRecord?.total_tokens);
  const hasUsage = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined;

  const costRecord = asRecord(input.cost);
  const costUsd = normalizeFiniteNumber(costRecord?.usd);
  const costSource = normalizeTelemetrySource(costRecord?.source);
  const costPricingSource =
    typeof costRecord?.pricing_source === "string" ? costRecord.pricing_source : undefined;
  const costReasonCode = normalizeReasonCode(costRecord?.reason_code);
  const hasCost = costUsd !== undefined || costSource !== "unknown" || costReasonCode !== undefined;

  const missingUsageReason = normalizeReasonCode(input.missing_usage_reason);
  const missingCostReason = normalizeReasonCode(input.missing_cost_reason);

  if (!hasUsage && !missingUsageReason) {
    throw new RunTelemetryValidationError(
      "phase_telemetry_missing_usage_reason",
      "phase telemetry without usage requires missing_usage_reason",
    );
  }
  if (!hasCost && !missingCostReason) {
    throw new RunTelemetryValidationError(
      "phase_telemetry_missing_cost_reason",
      "phase telemetry without cost requires missing_cost_reason",
    );
  }

  return {
    schema_version: RUN_TELEMETRY_SCHEMA_VERSION,
    run_id: runId,
    phase,
    provider: typeof input.provider === "string" ? input.provider : undefined,
    model: typeof input.model === "string" ? input.model : undefined,
    duration_ms: normalizeFiniteNumber(input.duration_ms),
    usage: hasUsage
      ? {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: totalTokens,
        }
      : undefined,
    cost: hasCost
      ? {
          usd: costUsd,
          source: costSource,
          pricing_source: costPricingSource,
          reason_code: costReasonCode,
        }
      : undefined,
    missing_usage_reason: missingUsageReason,
    missing_cost_reason: missingCostReason,
    metadata: asRecord(input.metadata),
  };
};

const normalizeDisposition = (value: unknown): RunDisposition => {
  if (typeof value === "string" && DISPOSITION_STATUSES.includes(value as RunDisposition)) {
    return value as RunDisposition;
  }
  return "pass";
};

const normalizeFinalDisposition = (
  value: unknown,
): RunFinalDisposition => {
  const record = asRecord(value);
  const status = normalizeDisposition(record?.status);
  const reasonCodes = uniqueSortedStrings(record?.reason_codes);
  const failureClass = normalizeFailureClass(record?.failure_class);
  const retryable =
    typeof record?.retryable === "boolean" || record?.retryable === null
      ? (record.retryable as boolean | null)
      : undefined;
  return {
    status,
    failure_class: status === "pass" ? undefined : failureClass ?? "unknown_failure",
    reason_codes: reasonCodes,
    stage: typeof record?.stage === "string" ? record.stage : undefined,
    retryable,
  };
};

export const normalizeRunSummaryData = (
  input: RunSummaryInput,
  fallbackRunId?: string,
): RunSummaryEventData => {
  const resolvedRunIdCandidate =
    (typeof input.run_id === "string" ? input.run_id : undefined)
    ?? (typeof input.runId === "string" ? input.runId : undefined)
    ?? fallbackRunId;
  const runId = normalizeNonEmptyString(
    resolvedRunIdCandidate,
    "run_summary_missing_run_id",
    "run summary requires run_id or runId",
  );
  const durationMs = normalizeFiniteNumber(input.durationMs) ?? 0;
  const touchedFiles = uniqueSortedStrings(input.touchedFiles);
  const qualityInput = asRecord(input.quality_dimensions);
  const qualityDimensions: RunQualityDimensions = {
    plan: normalizeQualityDimension(qualityInput?.plan ?? QUALITY_DEFAULTS.plan),
    retrieval: normalizeQualityDimension(qualityInput?.retrieval ?? QUALITY_DEFAULTS.retrieval),
    patch: normalizeQualityDimension(qualityInput?.patch ?? QUALITY_DEFAULTS.patch),
    verification: normalizeQualityDimension(qualityInput?.verification ?? QUALITY_DEFAULTS.verification),
    final_disposition: normalizeQualityDimension(
      qualityInput?.final_disposition ?? QUALITY_DEFAULTS.final_disposition,
    ),
  };
  const finalDisposition = normalizeFinalDisposition(input.final_disposition);

  const artifactReferencesRaw = Array.isArray(input.artifact_references)
    ? input.artifact_references
    : [];
  const artifactReferences = artifactReferencesRaw
    .map((entry) => normalizeArtifactReference(entry))
    .filter((entry): entry is RunArtifactReference => Boolean(entry))
    .sort((left, right) =>
      `${left.phase}:${left.kind}:${left.path ?? ""}`.localeCompare(
        `${right.phase}:${right.kind}:${right.path ?? ""}`,
      ));
  const missingArtifacts = uniqueSortedStrings(
    input.missing_artifacts
    ?? artifactReferences
      .filter((entry) => entry.status === "missing")
      .map((entry) => `${entry.phase}:${entry.kind}`),
  );

  const phaseTelemetryRaw = Array.isArray(input.phase_telemetry) ? input.phase_telemetry : [];
  const phaseTelemetry = phaseTelemetryRaw
    .map((entry) => normalizePhaseTelemetryRecord({ ...entry, run_id: runId }))
    .sort((left, right) => left.phase.localeCompare(right.phase));

  const knownKeys = new Set([
    "schema_version",
    "run_id",
    "runId",
    "durationMs",
    "touchedFiles",
    "quality_dimensions",
    "final_disposition",
    "artifact_references",
    "phase_telemetry",
    "missing_artifacts",
  ]);
  const passthrough: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (knownKeys.has(key)) continue;
    passthrough[key] = value;
  }

  return {
    ...passthrough,
    schema_version: RUN_TELEMETRY_SCHEMA_VERSION,
    run_id: runId,
    runId,
    durationMs,
    touchedFiles,
    quality_dimensions: qualityDimensions,
    final_disposition: finalDisposition,
    artifact_references: artifactReferences,
    phase_telemetry: phaseTelemetry,
    missing_artifacts: missingArtifacts,
  };
};

export const normalizeSafetyTelemetryEventData = (
  input: Omit<SafetyTelemetryEventData, "schema_version"> & { schema_version?: number },
  fallbackRunId?: string,
): SafetyTelemetryEventData => {
  const runId = normalizeNonEmptyString(
    input.run_id ?? fallbackRunId,
    "safety_event_missing_run_id",
    "safety telemetry requires run_id",
  );
  const phase = normalizeNonEmptyString(
    input.phase,
    "safety_event_missing_phase",
    "safety telemetry requires phase",
  );
  const code = normalizeNonEmptyString(
    input.code,
    "safety_event_missing_code",
    "safety telemetry requires code",
  );
  const message = normalizeNonEmptyString(
    input.message,
    "safety_event_missing_message",
    "safety telemetry requires message",
  );
  if (!input.category) {
    throw new RunTelemetryValidationError(
      "safety_event_missing_category",
      "safety telemetry requires category",
    );
  }
  if (!input.disposition) {
    throw new RunTelemetryValidationError(
      "safety_event_missing_disposition",
      "safety telemetry requires disposition",
    );
  }
  return {
    schema_version: RUN_TELEMETRY_SCHEMA_VERSION,
    run_id: runId,
    phase,
    category: input.category,
    code,
    disposition: input.disposition,
    message,
    source: typeof input.source === "string" ? input.source : undefined,
    tool: typeof input.tool === "string" ? input.tool : undefined,
    failure_class: normalizeFailureClass(input.failure_class),
    reason_codes: uniqueSortedStrings(input.reason_codes),
    details: asRecord(input.details),
  };
};

export const normalizeRunEventPayload = (
  type: string,
  data: Record<string, unknown>,
  fallbackRunId?: string,
): Record<string, unknown> => {
  if (type === "run_summary") {
    return stableSortValue(normalizeRunSummaryData(data as RunSummaryInput, fallbackRunId)) as Record<
      string,
      unknown
    >;
  }
  if (type === "phase_telemetry") {
    return stableSortValue(
      normalizePhaseTelemetryRecord({
        ...(data as Record<string, unknown>),
        run_id: typeof data.run_id === "string" ? data.run_id : fallbackRunId,
      }),
    ) as Record<string, unknown>;
  }
  if (type === "safety_event") {
    return stableSortValue(
      normalizeSafetyTelemetryEventData(
        data as Omit<SafetyTelemetryEventData, "schema_version"> & { schema_version?: number },
        fallbackRunId,
      ),
    ) as Record<string, unknown>;
  }
  return stableSortValue(data) as Record<string, unknown>;
};
