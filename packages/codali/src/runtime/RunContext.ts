import { createHash } from "node:crypto";
import type { RunContractFingerprint } from "../cognitive/Types.js";

export interface RunFingerprintInput {
  request: string;
  command?: string;
  workspaceRoot: string;
  smart?: boolean;
  provider?: string;
  model?: string;
  builderMode?: string;
  maxRetries?: number;
  maxContextRefreshes?: number;
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

const stableSort = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => stableSort(entry));
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, stableSort(entry)]);
  return Object.fromEntries(entries);
};

const buildFingerprint = (input: RunFingerprintInput): RunContractFingerprint => {
  const normalized = stableSort({
    request: input.request,
    command: input.command ?? "",
    workspaceRoot: input.workspaceRoot,
    smart: input.smart ?? false,
    provider: input.provider ?? "",
    model: input.model ?? "",
    builderMode: input.builderMode ?? "",
    maxRetries: input.maxRetries ?? null,
    maxContextRefreshes: input.maxContextRefreshes ?? null,
    maxSteps: input.maxSteps ?? null,
    maxToolCalls: input.maxToolCalls ?? null,
    maxTokens: input.maxTokens ?? null,
    timeoutMs: input.timeoutMs ?? null,
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
  return {
    algorithm: "sha256",
    value: digest,
  };
};

export class RunContext {
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly startedAt: number;
  readonly fingerprint?: RunContractFingerprint;
  private touchedFiles = new Set<string>();

  constructor(runId: string, workspaceRoot: string, fingerprintInput?: RunFingerprintInput) {
    this.runId = runId;
    this.workspaceRoot = workspaceRoot;
    this.startedAt = Date.now();
    this.fingerprint = fingerprintInput ? buildFingerprint(fingerprintInput) : undefined;
  }

  recordTouchedFile(filePath: string): void {
    this.touchedFiles.add(filePath);
  }

  getTouchedFiles(): string[] {
    return Array.from(this.touchedFiles).sort();
  }
}
