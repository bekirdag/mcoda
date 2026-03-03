import { promises as fs } from "node:fs";
import path from "node:path";
import { getGlobalWorkspaceDir } from "./StoragePaths.js";
import {
  normalizeRunLogQueryInput,
  RUN_LOG_QUERY_SCHEMA_VERSION,
  type RunLogQueryEvent,
  type RunLogQueryInput,
  type RunLogQueryResult,
} from "./RunLogQuery.js";
import { normalizeFailureClass, type SafetyTelemetryEventData } from "./RunTelemetryTypes.js";
import type { PhaseArtifactV1, VerificationReport } from "../cognitive/Types.js";

interface RunMeta {
  runId: string;
  touchedFiles: string[];
  timestamp: number;
}

const parseJsonSafe = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const normalizeCandidatePath = (value: string): string =>
  path.normalize(value).replace(/\\/g, "/");

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const inferRunIdFromEvent = (data: Record<string, unknown>, fallbackRunId?: string): string | undefined =>
  asString(data.run_id) ?? asString(data.runId) ?? fallbackRunId;

const inferTaskIdFromEvent = (data: Record<string, unknown>): string | undefined =>
  asString(data.task_id) ?? asString(data.taskId);

const inferPhaseFromEvent = (data: Record<string, unknown>): string | undefined => {
  const direct = asString(data.phase);
  if (direct) return direct;
  const disposition = asRecord(data.final_disposition);
  const dispositionStage = asString(disposition?.stage);
  if (dispositionStage) return dispositionStage;
  const telemetry = asRecord(data.phase_telemetry);
  return asString(telemetry?.phase);
};

const inferFailureClassFromEvent = (data: Record<string, unknown>): string | undefined => {
  const direct = normalizeFailureClass(data.failure_class ?? data.failureClass);
  if (direct) return direct;
  const finalDisposition = asRecord(data.final_disposition);
  const fromDisposition = normalizeFailureClass(
    finalDisposition?.failure_class ?? finalDisposition?.failureClass,
  );
  if (fromDisposition) return fromDisposition;
  const reasonCodes = asStringArray(data.reason_codes ?? data.reasons);
  if (reasonCodes.some((reason) => reason.includes("verification"))) return "verification_failure";
  if (reasonCodes.some((reason) => reason.includes("policy") || reason.includes("guardrail"))) {
    return "policy_failure";
  }
  if (reasonCodes.some((reason) => reason.includes("patch"))) return "patch_failure";
  if (reasonCodes.some((reason) => reason.includes("provider"))) return "provider_failure";
  return undefined;
};

export class RunLogReader {
  private logDir: string;

  constructor(workspaceRoot: string, logDirName = "logs") {
    const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
    this.logDir = path.resolve(storageRoot, logDirName);
  }

  private async resolveLogFiles(runId?: string): Promise<string[]> {
    if (runId) {
      const file = path.join(this.logDir, `${runId}.jsonl`);
      try {
        await fs.access(file);
        return [file];
      } catch {
        return [];
      }
    }
    try {
      const files = await fs.readdir(this.logDir);
      return files
        .filter((entry) => entry.endsWith(".jsonl"))
        .sort((left, right) => left.localeCompare(right))
        .map((entry) => path.join(this.logDir, entry));
    } catch {
      return [];
    }
  }

  async queryEvents(input: RunLogQueryInput = {}): Promise<RunLogQueryResult> {
    const query = normalizeRunLogQueryInput(input);
    const files = await this.resolveLogFiles(query.filters.run_id);
    const matches: RunLogQueryEvent[] = [];
    let eventIndex = 0;

    for (const filePath of files) {
      const fallbackRunId = path.basename(filePath, ".jsonl");
      let content = "";
      try {
        content = await fs.readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
        const line = lines[lineNumber];
        if (!line.trim()) continue;
        const parsed = parseJsonSafe(line);
        const event = asRecord(parsed);
        if (!event) continue;
        const type = asString(event.type);
        if (!type) continue;
        const data = asRecord(event.data) ?? {};
        const timestamp = asString(event.timestamp) ?? "";
        const runId = inferRunIdFromEvent(data, fallbackRunId);
        const taskId = inferTaskIdFromEvent(data);
        const phase = inferPhaseFromEvent(data);
        const failureClass = inferFailureClassFromEvent(data);

        if (query.filters.event_type && type !== query.filters.event_type) continue;
        if (query.filters.run_id && runId !== query.filters.run_id) continue;
        if (query.filters.task_id && taskId !== query.filters.task_id) continue;
        if (query.filters.phase && phase !== query.filters.phase) continue;
        if (query.filters.failure_class && failureClass !== query.filters.failure_class) continue;

        matches.push({
          event_index: eventIndex,
          file: filePath,
          line: lineNumber + 1,
          type,
          timestamp,
          run_id: runId,
          task_id: taskId,
          phase,
          failure_class: failureClass,
          data,
        });
        eventIndex += 1;
      }
    }

    const compare = (left: RunLogQueryEvent, right: RunLogQueryEvent): number => {
      const byTimestamp = left.timestamp.localeCompare(right.timestamp);
      if (byTimestamp !== 0) return byTimestamp;
      const byRun = (left.run_id ?? "").localeCompare(right.run_id ?? "");
      if (byRun !== 0) return byRun;
      const byFile = left.file.localeCompare(right.file);
      if (byFile !== 0) return byFile;
      const byLine = left.line - right.line;
      if (byLine !== 0) return byLine;
      return left.event_index - right.event_index;
    };
    matches.sort((left, right) => (query.sort === "asc" ? compare(left, right) : compare(right, left)));

    const total = matches.length;
    const events = matches.slice(query.offset, query.offset + query.limit);
    const nextOffset = query.offset + events.length;

    return {
      schema_version: RUN_LOG_QUERY_SCHEMA_VERSION,
      query,
      total,
      returned: events.length,
      next_offset: nextOffset >= total ? null : nextOffset,
      events,
    };
  }

  async findLastRunForFile(filePath: string): Promise<string | undefined> {
    try {
      const files = await fs.readdir(this.logDir);
      const jsonlFiles = files.filter((entry) => entry.endsWith(".jsonl"));

      const sortedFiles = await Promise.all(
        jsonlFiles.map(async (entry) => {
          const stat = await fs.stat(path.join(this.logDir, entry));
          return { file: entry, mtime: stat.mtimeMs };
        }),
      );
      sortedFiles.sort((left, right) => right.mtime - left.mtime);

      for (const { file } of sortedFiles) {
        const content = await fs.readFile(path.join(this.logDir, file), "utf8");
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          const event = parseJsonSafe(line) as
            | { type?: string; data?: { touchedFiles?: string[]; runId?: string; run_id?: string } }
            | undefined;
          if (!event || event.type !== "run_summary") continue;
          const touched = event.data?.touchedFiles ?? [];
          const normalizedTarget = normalizeCandidatePath(filePath);
          const hit = touched.find((entry) => {
            const normalizedTouched = normalizeCandidatePath(entry);
            return (
              normalizedTouched.endsWith(normalizedTarget)
              || normalizedTarget.endsWith(normalizedTouched)
            );
          });
          if (hit) return event.data?.run_id ?? event.data?.runId;
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async getRunArtifact(runId: string, kind: string): Promise<string | undefined> {
    const phaseDir = path.join(this.logDir, "phase");
    try {
      const files = await fs.readdir(phaseDir);
      const candidates = files.filter((entry) => entry.startsWith(runId) && entry.includes(kind));
      if (candidates.length === 0) return undefined;

      const last = candidates.sort().pop();
      if (last) {
        return fs.readFile(path.join(phaseDir, last), "utf8");
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async getRunIntent(runId: string): Promise<string | undefined> {
    const logFile = path.join(this.logDir, `${runId}.jsonl`);
    try {
      const content = await fs.readFile(logFile, "utf8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        const event = parseJsonSafe(line) as
          | { type?: string; data?: { phase?: string; path?: string } }
          | undefined;
        if (!event) continue;
        if (event.type === "phase_input" && event.data?.phase === "librarian") {
          const artifactPath = event.data.path;
          if (artifactPath && typeof artifactPath === "string") {
            try {
              const artifact = parseJsonSafe(await fs.readFile(artifactPath, "utf8")) as
                | PhaseArtifactV1
                | { request?: string }
                | undefined;
              if (!artifact) continue;
              if (typeof (artifact as { request?: string }).request === "string") {
                return (artifact as { request: string }).request;
              }
              const payloadRequest = (artifact as PhaseArtifactV1).payload as
                | { request?: string }
                | undefined;
              if (typeof payloadRequest?.request === "string") return payloadRequest.request;
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  async getPhaseArtifacts(runId: string, phase?: string): Promise<PhaseArtifactV1[]> {
    const phaseDir = path.join(this.logDir, "phase");
    try {
      const files = await fs.readdir(phaseDir);
      const artifacts: PhaseArtifactV1[] = [];
      for (const file of files) {
        if (!file.startsWith(`${runId}-`)) continue;
        const parsed = parseJsonSafe(
          await fs.readFile(path.join(phaseDir, file), "utf8"),
        ) as PhaseArtifactV1 | undefined;
        if (!parsed || parsed.schema_version !== 1) continue;
        if (phase && parsed.phase !== phase) continue;
        artifacts.push(parsed);
      }
      return artifacts.sort(
        (left, right) => (left.ended_at_ms ?? 0) - (right.ended_at_ms ?? 0),
      );
    } catch {
      return [];
    }
  }

  async getSafetyEvents(
    runId: string,
    filters: { code?: string; phase?: string } = {},
  ): Promise<SafetyTelemetryEventData[]> {
    const logFile = path.join(this.logDir, `${runId}.jsonl`);
    try {
      const content = await fs.readFile(logFile, "utf8");
      const lines = content.split("\n").filter(Boolean);
      const events: SafetyTelemetryEventData[] = [];
      for (const line of lines) {
        const parsed = parseJsonSafe(line) as
          | { type?: string; data?: SafetyTelemetryEventData }
          | undefined;
        if (!parsed || parsed.type !== "safety_event" || !parsed.data) continue;
        const data = parsed.data;
        if (data.schema_version !== 1) continue;
        if (data.run_id !== runId) continue;
        if (filters.code && data.code !== filters.code) continue;
        if (filters.phase && data.phase !== filters.phase) continue;
        events.push(data);
      }
      return events;
    } catch {
      return [];
    }
  }

  async getVerificationReports(runId: string): Promise<VerificationReport[]> {
    const reports: VerificationReport[] = [];
    const seen = new Set<string>();
    const addReport = (candidate: unknown): void => {
      if (!candidate || typeof candidate !== "object") return;
      const value = candidate as Partial<VerificationReport>;
      if (value.schema_version !== 1) return;
      if (
        value.outcome !== "verified_passed"
        && value.outcome !== "verified_failed"
        && value.outcome !== "unverified_with_reason"
      ) {
        return;
      }
      const key = JSON.stringify(value);
      if (seen.has(key)) return;
      seen.add(key);
      reports.push(value as VerificationReport);
    };

    const artifacts = await this.getPhaseArtifacts(runId, "verify");
    for (const artifact of artifacts) {
      if (artifact.kind === "verification_report") {
        addReport(artifact.payload);
      }
    }

    const logFile = path.join(this.logDir, `${runId}.jsonl`);
    try {
      const content = await fs.readFile(logFile, "utf8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        const parsed = parseJsonSafe(line) as
          | {
              type?: string;
              data?: {
                run_id?: string;
                runId?: string;
                report?: VerificationReport;
                verification?: VerificationReport;
                smartRuntime?: { verification?: VerificationReport };
              };
            }
          | undefined;
        if (!parsed || !parsed.data) continue;
        if (
          parsed.type === "verification_report"
          && (parsed.data.run_id === runId || parsed.data.runId === runId)
        ) {
          addReport(parsed.data.report);
        }
        if (parsed.type === "run_summary") {
          addReport(parsed.data.verification);
          addReport(parsed.data.smartRuntime?.verification);
        }
      }
    } catch {
      // ignore
    }

    return reports;
  }
}
