import { promises as fs } from "node:fs";
import path from "node:path";
import type { PhaseArtifactError, PhaseArtifactV1, VerificationReport } from "../cognitive/Types.js";
import {
  normalizePhaseTelemetryRecord,
  normalizeRunEventPayload,
  normalizeRunSummaryData,
  stableSortValue,
  type PhaseTelemetryInput,
  type PhaseTelemetryRecord,
  type RunSummaryInput,
  type SafetyTelemetryEventData,
} from "./RunTelemetryTypes.js";

export type {
  SafetyTelemetryEventData,
  RunSummaryEventData,
  RunFinalDisposition,
  RunFailureClass,
  RunDisposition,
  RunQualityDimensions,
  RunArtifactReference,
  TelemetryReasonCode,
  SafetyTelemetryCategory,
  SafetyTelemetryDisposition,
  RunTelemetryValidationError,
  PhaseTelemetryRecord,
  PhaseTelemetryInput,
  PhaseUsageTelemetry,
  PhaseCostTelemetry,
} from "./RunTelemetryTypes.js";

export interface RunLogEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export type InvestigationGateStatus = "not_checked" | "pass" | "fail";

export interface InvestigationGateSummary {
  status: InvestigationGateStatus;
  reason?: string;
  missing?: string[];
  required?: Record<string, number>;
  observed?: Record<string, number>;
  score?: number;
  threshold?: number;
}

export interface InvestigationTelemetry extends Record<string, unknown> {
  phase: "research";
  status: "skipped" | "completed";
  duration_ms: number;
  tool_usage: Record<string, { ok: number; failed: number; skipped: number; total: number }>;
  tool_usage_totals: { ok: number; failed: number; skipped: number; total: number };
  evidence_gate: InvestigationGateSummary;
  quota: InvestigationGateSummary;
  budget: InvestigationGateSummary & {
    required_cycles?: number;
    cycles?: number;
    required_ms?: number;
    elapsed_ms?: number;
  };
  warnings?: string[];
  summary?: string;
}

export interface InvestigationTelemetryEvent extends RunLogEvent {
  type: "investigation_telemetry";
  data: InvestigationTelemetry;
}

const summarizePayload = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== "object") return { type: typeof payload };
  const objectPayload = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["status", "phase", "reason", "code"]) {
    if (key in objectPayload) summary[key] = objectPayload[key];
  }
  if (typeof objectPayload.error === "string") summary.error = objectPayload.error;
  if (Array.isArray(objectPayload.warnings)) summary.warning_count = objectPayload.warnings.length;
  return summary;
};

export const buildPhaseArtifact = (params: {
  runId: string;
  phase: string;
  kind: string;
  payload: unknown;
  startedAtMs?: number;
  endedAtMs?: number;
  error?: PhaseArtifactError;
}): PhaseArtifactV1 => ({
  schema_version: 1,
  phase: params.phase,
  kind: params.kind,
  run_id: params.runId,
  started_at_ms: params.startedAtMs,
  ended_at_ms: params.endedAtMs,
  duration_ms:
    params.startedAtMs !== undefined && params.endedAtMs !== undefined
      ? params.endedAtMs - params.startedAtMs
      : undefined,
  error: params.error,
  payload: params.payload,
});

export class RunLogger {
  readonly logPath: string;
  readonly logDir: string;
  readonly runId: string;

  constructor(workspaceRoot: string, logDir: string, runId: string) {
    const resolvedDir = path.resolve(workspaceRoot, logDir);
    this.logDir = resolvedDir;
    this.runId = runId;
    this.logPath = path.join(resolvedDir, `${runId}.jsonl`);
  }

  async log(type: string, data: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const normalizedData = normalizeRunEventPayload(type, data, this.runId);
    const event: RunLogEvent = {
      type,
      timestamp: new Date().toISOString(),
      data: stableSortValue(normalizedData) as Record<string, unknown>,
    };
    await fs.appendFile(this.logPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  async logSafetyEvent(
    data: Omit<SafetyTelemetryEventData, "schema_version" | "run_id">,
  ): Promise<void> {
    await this.log("safety_event", {
      schema_version: 1,
      run_id: this.runId,
      ...data,
    });
  }

  async logPhaseTelemetry(
    data: PhaseTelemetryInput,
  ): Promise<void> {
    const normalized = normalizePhaseTelemetryRecord({
      ...data,
      run_id: data.run_id ?? this.runId,
    });
    await this.log(
      "phase_telemetry",
      { ...normalized },
    );
  }

  async logRunSummary(data: RunSummaryInput): Promise<void> {
    await this.log(
      "run_summary",
      normalizeRunSummaryData({ ...data, run_id: data.run_id ?? this.runId }, this.runId),
    );
  }

  async logVerificationReport(report: VerificationReport): Promise<void> {
    await this.log("verification_report", {
      run_id: this.runId,
      report,
    });
  }

  async writePhaseArtifact(
    phase: string,
    kind: string,
    payload: unknown,
  ): Promise<string> {
    const endedAt = Date.now();
    const artifact = buildPhaseArtifact({
      runId: this.runId,
      phase,
      kind,
      payload,
      endedAtMs: endedAt,
    });
    const phaseDir = path.join(this.logDir, "phase");
    await fs.mkdir(phaseDir, { recursive: true });
    const safePhase = phase.replace(/[^a-z0-9_-]/gi, "_");
    const safeKind = kind.replace(/[^a-z0-9_-]/gi, "_");
    const ext = "json";
    const timestamp = Date.now();
    const filename = `${this.runId}-${safePhase}-${safeKind}-${timestamp}.${ext}`;
    const filePath = path.join(phaseDir, filename);
    const content = JSON.stringify(artifact, null, 2);
    await fs.writeFile(filePath, content, "utf8");
    await this.log("phase_artifact", {
      phase,
      kind,
      path: filePath,
      schema_version: artifact.schema_version,
      payload_summary: summarizePayload(payload),
    });
    return filePath;
  }
}
