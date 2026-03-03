import type { VerificationOutcome } from "../cognitive/Types.js";

export type NormalizedRunStatus = "pass" | "fail" | "degraded" | "unknown";
export type NormalizedPhaseStatus = "available" | "missing" | "degraded";

export interface NormalizedArtifactReference {
  phase: string;
  kind: string;
  status: "present" | "missing";
  path: string | null;
  reason_code: string | null;
}

export interface NormalizedPhaseOutcome {
  phase: string;
  status: NormalizedPhaseStatus;
  duration_ms: number | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  missing_usage_reason: string | null;
  missing_cost_reason: string | null;
}

export interface NormalizedRunRecord {
  schema_version: 1;
  run_id: string | null;
  task_id: string | null;
  fingerprint: string | null;
  duration_ms: number | null;
  final_status: NormalizedRunStatus;
  failure_class: string | null;
  reason_codes: string[];
  retryable: boolean | null;
  verification_outcome: VerificationOutcome | null;
  touched_files: string[];
  artifact_references: NormalizedArtifactReference[];
  missing_artifacts: string[];
  phase_outcomes: NormalizedPhaseOutcome[];
  usage_tokens_total: number | null;
  cost_usd: number | null;
  missing_data_markers: string[];
}

export interface AdaptRunSummaryInput {
  runSummary?: unknown;
  runId?: string;
  taskId?: string;
  verificationOutcome?: VerificationOutcome | null;
  touchedFiles?: string[];
}

type PhaseTelemetrySource = {
  phase: string;
  duration_ms: number | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  missing_usage_reason: string | null;
  missing_cost_reason: string | null;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
};

const asBoolean = (value: unknown): boolean | null => {
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  return null;
};

const asNumber = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
};

const uniqueSortedStrings = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
};

const normalizeRunStatus = (value: unknown): NormalizedRunStatus => {
  if (value === "pass" || value === "fail" || value === "degraded") return value;
  return "unknown";
};

const normalizePhaseStatus = (value: unknown): NormalizedPhaseStatus => {
  if (value === "available" || value === "missing" || value === "degraded") return value;
  return "missing";
};

const normalizeVerificationOutcome = (value: unknown): VerificationOutcome | null => {
  if (
    value === "verified_passed"
    || value === "verified_failed"
    || value === "unverified_with_reason"
  ) {
    return value;
  }
  return null;
};

const normalizeArtifactReferences = (value: unknown): NormalizedArtifactReference[] => {
  if (!Array.isArray(value)) return [];
  const results: NormalizedArtifactReference[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const phase = asString(record.phase);
    const kind = asString(record.kind);
    if (!phase || !kind) continue;
    results.push({
      phase,
      kind,
      status: record.status === "missing" ? "missing" : "present",
      path: asString(record.path) ?? null,
      reason_code: asString(record.reason_code) ?? null,
    });
  }
  return results.sort((left, right) =>
    `${left.phase}:${left.kind}:${left.path ?? ""}`.localeCompare(
      `${right.phase}:${right.kind}:${right.path ?? ""}`,
    ));
};

const normalizePhaseTelemetry = (value: unknown): PhaseTelemetrySource[] => {
  if (!Array.isArray(value)) return [];
  const sources: PhaseTelemetrySource[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const phase = asString(record.phase);
    if (!phase) continue;
    const usage = asRecord(record.usage);
    const cost = asRecord(record.cost);
    const inputTokens = asNumber(usage?.input_tokens);
    const outputTokens = asNumber(usage?.output_tokens);
    const totalTokens =
      asNumber(usage?.total_tokens)
      ?? (
        inputTokens !== null || outputTokens !== null
          ? (inputTokens ?? 0) + (outputTokens ?? 0)
          : null
      );
    sources.push({
      phase,
      duration_ms: asNumber(record.duration_ms),
      provider: asString(record.provider) ?? null,
      model: asString(record.model) ?? null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      cost_usd: asNumber(cost?.usd),
      cost_source: asString(cost?.source) ?? null,
      missing_usage_reason: asString(record.missing_usage_reason) ?? null,
      missing_cost_reason: asString(record.missing_cost_reason) ?? null,
    });
  }
  return sources.sort((left, right) => left.phase.localeCompare(right.phase));
};

const phaseKeyToSummaryPhase = (key: string): string | undefined => {
  if (key === "plan") return "plan";
  if (key === "retrieval") return "retrieve";
  if (key === "patch") return "act";
  if (key === "verification") return "verify";
  return undefined;
};

const buildPhaseOutcomes = (
  runSummary: Record<string, unknown>,
  telemetry: PhaseTelemetrySource[],
): NormalizedPhaseOutcome[] => {
  const quality = asRecord(runSummary.quality_dimensions);
  const phaseStatus = new Map<string, NormalizedPhaseStatus>();
  if (quality) {
    for (const [key, rawValue] of Object.entries(quality)) {
      const phase = phaseKeyToSummaryPhase(key);
      if (!phase) continue;
      phaseStatus.set(phase, normalizePhaseStatus(rawValue));
    }
  }
  for (const entry of telemetry) {
    if (!phaseStatus.has(entry.phase)) {
      phaseStatus.set(entry.phase, "missing");
    }
  }
  if (phaseStatus.size === 0) {
    for (const phase of ["plan", "retrieve", "act", "verify"]) {
      phaseStatus.set(phase, "missing");
    }
  }

  const telemetryByPhase = new Map<string, PhaseTelemetrySource>();
  for (const entry of telemetry) {
    telemetryByPhase.set(entry.phase, entry);
  }

  const outcomes: NormalizedPhaseOutcome[] = [];
  for (const [phase, status] of phaseStatus.entries()) {
    const source = telemetryByPhase.get(phase);
    outcomes.push({
      phase,
      status,
      duration_ms: source?.duration_ms ?? null,
      provider: source?.provider ?? null,
      model: source?.model ?? null,
      input_tokens: source?.input_tokens ?? null,
      output_tokens: source?.output_tokens ?? null,
      total_tokens: source?.total_tokens ?? null,
      cost_usd: source?.cost_usd ?? null,
      cost_source: source?.cost_source ?? null,
      missing_usage_reason: source?.missing_usage_reason ?? null,
      missing_cost_reason: source?.missing_cost_reason ?? null,
    });
  }

  return outcomes.sort((left, right) => left.phase.localeCompare(right.phase));
};

const sumNullable = (values: Array<number | null>): number | null => {
  const present = values.filter((entry): entry is number => entry !== null);
  if (!present.length) return null;
  return present.reduce((sum, value) => sum + value, 0);
};

export const adaptRunSummaryForReport = (input: AdaptRunSummaryInput = {}): NormalizedRunRecord => {
  const runSummary = asRecord(input.runSummary);
  const finalDisposition = asRecord(runSummary?.final_disposition);
  const artifactReferences = normalizeArtifactReferences(runSummary?.artifact_references);
  const phaseTelemetry = normalizePhaseTelemetry(runSummary?.phase_telemetry);
  const phaseOutcomes = buildPhaseOutcomes(runSummary ?? {}, phaseTelemetry);

  const topLevelUsage = asRecord(runSummary?.usage);
  const topLevelTotalTokens =
    asNumber(topLevelUsage?.totalTokens)
    ?? (
      asNumber(topLevelUsage?.inputTokens) !== null || asNumber(topLevelUsage?.outputTokens) !== null
        ? (asNumber(topLevelUsage?.inputTokens) ?? 0) + (asNumber(topLevelUsage?.outputTokens) ?? 0)
        : null
    );
  const usageTokensTotal = topLevelTotalTokens ?? sumNullable(
    phaseOutcomes.map((phase) => phase.total_tokens),
  );

  const topLevelCost = asNumber(runSummary?.actualCost);
  const phaseCost = sumNullable(phaseOutcomes.map((phase) => phase.cost_usd));
  const costUsd = topLevelCost ?? phaseCost;

  const missingArtifacts = uniqueSortedStrings(
    runSummary?.missing_artifacts
    ?? artifactReferences
      .filter((entry) => entry.status === "missing")
      .map((entry) => `${entry.phase}:${entry.kind}`),
  );

  const verificationRecord = asRecord(runSummary?.verification);
  const verificationOutcome =
    normalizeVerificationOutcome(input.verificationOutcome)
    ?? normalizeVerificationOutcome(verificationRecord?.outcome);

  const markers = new Set<string>();
  if (!runSummary) markers.add("run_summary_missing");
  if (!asString(runSummary?.run_id ?? runSummary?.runId ?? input.runId)) markers.add("run_id_missing");
  if (!finalDisposition) markers.add("final_disposition_missing");
  if (!phaseTelemetry.length) markers.add("phase_telemetry_missing");
  if (verificationOutcome === null) markers.add("verification_outcome_missing");
  if (usageTokensTotal === null) markers.add("usage_tokens_missing");
  if (costUsd === null) markers.add("cost_missing");

  const touchedFiles = Array.from(
    new Set([
      ...uniqueSortedStrings(runSummary?.touchedFiles),
      ...(Array.isArray(input.touchedFiles) ? input.touchedFiles : []),
    ]),
  ).sort((left, right) => left.localeCompare(right));

  return {
    schema_version: 1,
    run_id: asString(runSummary?.run_id ?? runSummary?.runId ?? input.runId) ?? null,
    task_id: asString(runSummary?.task_id ?? runSummary?.taskId ?? input.taskId) ?? null,
    fingerprint: asString(runSummary?.fingerprint) ?? null,
    duration_ms: asNumber(runSummary?.durationMs),
    final_status: normalizeRunStatus(finalDisposition?.status),
    failure_class: asString(finalDisposition?.failure_class ?? finalDisposition?.failureClass) ?? null,
    reason_codes: uniqueSortedStrings(finalDisposition?.reason_codes ?? finalDisposition?.reasons),
    retryable: asBoolean(finalDisposition?.retryable),
    verification_outcome: verificationOutcome,
    touched_files: touchedFiles,
    artifact_references: artifactReferences,
    missing_artifacts: missingArtifacts,
    phase_outcomes: phaseOutcomes,
    usage_tokens_total: usageTokensTotal,
    cost_usd: costUsd,
    missing_data_markers: Array.from(markers).sort((left, right) => left.localeCompare(right)),
  };
};
