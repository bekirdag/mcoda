import path from "node:path";

export type SubagentRole = "explorer" | "reviewer" | "worker" | "verifier" | "custom";
export type SubagentStatus = "completed" | "failed" | "timed_out";

export interface SubagentPermissions {
  readOnly?: boolean;
  allowedPaths?: string[];
  writePaths?: string[];
  allowNetwork?: boolean;
}

export interface SubagentSpec {
  id?: string;
  role: SubagentRole;
  goal: string;
  agentRef?: string;
  model?: string;
  tools?: string[];
  permissions?: SubagentPermissions;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

export interface SubagentResult {
  id: string;
  role: SubagentRole;
  goal: string;
  status: SubagentStatus;
  summary: string;
  output: string;
  toolCallsExecuted: number;
  touchedFiles: string[];
  warnings: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentRunnerInput {
  spec: Required<Pick<SubagentSpec, "id" | "role" | "goal">> & SubagentSpec;
  parentRunId: string;
}

export interface SubagentRunnerResult {
  output: string;
  toolCallsExecuted?: number;
  touchedFiles?: string[];
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

export type SubagentRunner = (input: SubagentRunnerInput) => Promise<SubagentRunnerResult>;

export interface SubagentOrchestratorOptions {
  parentRunId: string;
  maxParallel?: number;
  maxSubagents?: number;
  defaultTimeoutMs?: number;
  runner: SubagentRunner;
  onEvent?: (event: { type: "subagent_start" | "subagent_result"; result?: SubagentResult; spec?: SubagentSpec }) => void;
}

const normalizeScopePath = (value: string): string => {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Subagent scope path is outside workspace: ${value}`);
  }
  return normalized;
};

const scopeContains = (outer: string, inner: string): boolean => {
  if (outer === ".") return true;
  return inner === outer || inner.startsWith(`${outer}/`);
};

const scopesOverlap = (a: string, b: string): boolean => scopeContains(a, b) || scopeContains(b, a);

const stableSpecId = (spec: SubagentSpec, index: number): string => {
  if (spec.id?.trim()) return spec.id.trim().replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${spec.role}-${index + 1}`;
};

const summarizeOutput = (output: string): string => {
  const trimmed = output.trim().replace(/\s+/g, " ");
  if (!trimmed) return "No output.";
  return trimmed.length > 240 ? `${trimmed.slice(0, 240)}...` : trimmed;
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number | undefined): Promise<T> => {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("subagent_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

export const normalizeSubagentSpec = (spec: SubagentSpec, index: number): SubagentRunnerInput["spec"] => {
  if (!spec.goal.trim()) throw new Error("Subagent goal is required");
  const readOnly = spec.permissions?.readOnly ?? spec.role !== "worker";
  const allowedPaths = spec.permissions?.allowedPaths?.map(normalizeScopePath);
  const writePaths = spec.permissions?.writePaths?.map(normalizeScopePath);
  if (readOnly && writePaths?.length) {
    throw new Error(`Read-only subagent ${spec.id ?? spec.role} cannot declare write paths`);
  }
  return {
    ...spec,
    id: stableSpecId(spec, index),
    role: spec.role,
    goal: spec.goal.trim(),
    permissions: {
      ...spec.permissions,
      readOnly,
      allowedPaths,
      writePaths,
    },
  };
};

export const assertNoOverlappingWriteScopes = (specs: SubagentSpec[]): void => {
  const writers = specs
    .map((spec, index) => normalizeSubagentSpec(spec, index))
    .filter((spec) => !spec.permissions?.readOnly && (spec.permissions?.writePaths?.length ?? 0) > 0);
  for (let left = 0; left < writers.length; left += 1) {
    for (let right = left + 1; right < writers.length; right += 1) {
      for (const leftScope of writers[left]!.permissions?.writePaths ?? []) {
        for (const rightScope of writers[right]!.permissions?.writePaths ?? []) {
          if (scopesOverlap(leftScope, rightScope)) {
            throw new Error(
              `Subagent write scopes overlap: ${writers[left]!.id}:${leftScope} and ${writers[right]!.id}:${rightScope}`,
            );
          }
        }
      }
    }
  }
};

export class SubagentOrchestrator {
  constructor(private options: SubagentOrchestratorOptions) {}

  async run(specs: SubagentSpec[]): Promise<SubagentResult[]> {
    const maxSubagents = Math.max(1, this.options.maxSubagents ?? 8);
    if (specs.length > maxSubagents) {
      throw new Error(`Too many subagents requested: ${specs.length} > ${maxSubagents}`);
    }
    assertNoOverlappingWriteScopes(specs);
    const normalized = specs.map(normalizeSubagentSpec);
    const maxParallel = Math.max(1, this.options.maxParallel ?? 2);
    const results: SubagentResult[] = new Array(normalized.length);
    let nextIndex = 0;

    const runOne = async (index: number): Promise<void> => {
      const spec = normalized[index]!;
      const started = Date.now();
      const startedAt = new Date(started).toISOString();
      this.options.onEvent?.({ type: "subagent_start", spec });
      try {
        const runnerResult = await withTimeout(
          this.options.runner({ spec, parentRunId: this.options.parentRunId }),
          spec.timeoutMs ?? this.options.defaultTimeoutMs,
        );
        const ended = Date.now();
        results[index] = {
          id: spec.id,
          role: spec.role,
          goal: spec.goal,
          status: "completed",
          summary: summarizeOutput(runnerResult.output),
          output: runnerResult.output,
          toolCallsExecuted: runnerResult.toolCallsExecuted ?? 0,
          touchedFiles: runnerResult.touchedFiles ?? [],
          warnings: runnerResult.warnings ?? [],
          startedAt,
          endedAt: new Date(ended).toISOString(),
          durationMs: ended - started,
          metadata: runnerResult.metadata,
        };
      } catch (error) {
        const ended = Date.now();
        const message = error instanceof Error ? error.message : String(error);
        results[index] = {
          id: spec.id,
          role: spec.role,
          goal: spec.goal,
          status: message === "subagent_timeout" ? "timed_out" : "failed",
          summary: message,
          output: "",
          toolCallsExecuted: 0,
          touchedFiles: [],
          warnings: [],
          startedAt,
          endedAt: new Date(ended).toISOString(),
          durationMs: ended - started,
          error: message,
        };
      }
      this.options.onEvent?.({ type: "subagent_result", result: results[index] });
    };

    const workers = Array.from({ length: Math.min(maxParallel, normalized.length) }, async () => {
      while (nextIndex < normalized.length) {
        const index = nextIndex;
        nextIndex += 1;
        await runOne(index);
      }
    });
    await Promise.all(workers);
    return results;
  }
}
