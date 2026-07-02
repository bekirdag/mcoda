import { randomUUID } from "node:crypto";
import type {
  CodaliContextPack,
  CodaliEvidenceItem,
  CodaliGatewayRequest,
  CodaliGatewayStatus,
} from "./CodaliGatewayTypes.js";

export type CodaliGatewayStoreRunStatus =
  | "pending"
  | "running"
  | CodaliGatewayStatus
  | "cancelled";

export type CodaliGatewayStoreTaskStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";

export type CodaliGatewayStoredToolStatus =
  | "success"
  | "failed"
  | "blocked";

export type CodaliGatewayStoredModelStatus =
  | "success"
  | "failed"
  | "repaired";

export interface CodaliGatewayStoredRun {
  runId: string;
  status: CodaliGatewayStoreRunStatus;
  createdAt: string;
  updatedAt: string;
  request?: CodaliGatewayRequest | Record<string, unknown>;
  warnings: string[];
  errors: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayStoredTask {
  id: string;
  runId: string;
  status: CodaliGatewayStoreTaskStatus;
  workerRole?: string;
  objective?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayStoredToolCall {
  id: string;
  runId: string;
  taskId?: string;
  tool: string;
  status: CodaliGatewayStoredToolStatus;
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  args?: unknown;
  result?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayStoredModelCall {
  id: string;
  runId: string;
  taskId?: string;
  role: string;
  status: CodaliGatewayStoredModelStatus;
  startedAt: string;
  endedAt?: string;
  latencyMs?: number;
  agentSlug?: string;
  model?: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayStoredArtifact {
  id: string;
  runId: string;
  taskId?: string;
  type: string;
  uri?: string;
  path?: string;
  model?: string;
  prompt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface CodaliGatewayRunTrace {
  run: CodaliGatewayStoredRun;
  tasks: CodaliGatewayStoredTask[];
  evidence: CodaliEvidenceItem[];
  toolCalls: CodaliGatewayStoredToolCall[];
  modelCalls: CodaliGatewayStoredModelCall[];
  contextPack?: CodaliContextPack;
  artifacts: CodaliGatewayStoredArtifact[];
}

export interface CodaliGatewayCreateRunInput {
  runId?: string;
  request?: CodaliGatewayRequest | Record<string, unknown>;
  status?: CodaliGatewayStoreRunStatus;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayUpdateRunInput {
  status?: CodaliGatewayStoreRunStatus;
  warnings?: string[];
  errors?: string[];
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayCreateTaskInput {
  id?: string;
  runId: string;
  status?: CodaliGatewayStoreTaskStatus;
  workerRole?: string;
  objective?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayUpdateTaskInput {
  status?: CodaliGatewayStoreTaskStatus;
  workerRole?: string;
  objective?: string;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayStore {
  createRun(input: CodaliGatewayCreateRunInput): Promise<CodaliGatewayStoredRun>;
  updateRun(
    runId: string,
    input: CodaliGatewayUpdateRunInput,
  ): Promise<CodaliGatewayStoredRun>;
  createTask(input: CodaliGatewayCreateTaskInput): Promise<CodaliGatewayStoredTask>;
  updateTask(
    runId: string,
    taskId: string,
    input: CodaliGatewayUpdateTaskInput,
  ): Promise<CodaliGatewayStoredTask>;
  appendEvidence(runId: string, evidence: CodaliEvidenceItem[]): Promise<CodaliEvidenceItem[]>;
  appendToolCall(
    call: Omit<CodaliGatewayStoredToolCall, "id" | "startedAt"> & {
      id?: string;
      startedAt?: string;
    },
  ): Promise<CodaliGatewayStoredToolCall>;
  appendModelCall(
    call: Omit<CodaliGatewayStoredModelCall, "id" | "startedAt"> & {
      id?: string;
      startedAt?: string;
    },
  ): Promise<CodaliGatewayStoredModelCall>;
  saveContextPack(runId: string, contextPack: CodaliContextPack): Promise<CodaliContextPack>;
  saveArtifact(
    artifact: Omit<CodaliGatewayStoredArtifact, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): Promise<CodaliGatewayStoredArtifact>;
  readRunTrace(runId: string): Promise<CodaliGatewayRunTrace | undefined>;
}

const REDACTED = "[redacted]";

const SENSITIVE_KEY_PATTERNS = [
  /api[-_]?key/i,
  /authorization/i,
  /bearer/i,
  /credential/i,
  /password/i,
  /secret/i,
  /token/i,
  /^x[-_]?api[-_]?key$/i,
] as const;

const NON_SECRET_TOKEN_KEY_PATTERNS = [
  /^input[-_]?tokens?$/i,
  /^max[-_]?context[-_]?pack[-_]?tokens?$/i,
  /^max[-_]?tokens?$/i,
  /^output[-_]?tokens?$/i,
  /^token[-_]?estimate$/i,
  /^total[-_]?tokens?$/i,
] as const;

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  /\bsk-[A-Za-z0-9]{16,}\b/g,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isSensitiveKey = (key: string): boolean =>
  !NON_SECRET_TOKEN_KEY_PATTERNS.some((pattern) => pattern.test(key)) &&
  SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));

const redactString = (value: string): string => {
  let redacted = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted;
};

export const redactCodaliGatewaySecrets = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => redactCodaliGatewaySecrets(item)) as T;
  }
  if (typeof value === "string") {
    return redactString(value) as T;
  }
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactCodaliGatewaySecrets(child);
  }
  return output as T;
};

const clone = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

const cloneRedacted = <T>(value: T): T => redactCodaliGatewaySecrets(clone(value));

const nowIso = (): string => new Date().toISOString();

const requireRun = (
  runs: Map<string, CodaliGatewayStoredRun>,
  runId: string,
): CodaliGatewayStoredRun => {
  const run = runs.get(runId);
  if (!run) {
    throw new Error(`GATEWAY_RUN_NOT_FOUND: ${runId}`);
  }
  return run;
};

const requireTask = (
  tasks: CodaliGatewayStoredTask[],
  runId: string,
  taskId: string,
): CodaliGatewayStoredTask => {
  const task = tasks.find((item) => item.runId === runId && item.id === taskId);
  if (!task) {
    throw new Error(`GATEWAY_TASK_NOT_FOUND: ${taskId}`);
  }
  return task;
};

export class InMemoryCodaliGatewayStore implements CodaliGatewayStore {
  private runs = new Map<string, CodaliGatewayStoredRun>();
  private tasks: CodaliGatewayStoredTask[] = [];
  private evidence = new Map<string, CodaliEvidenceItem[]>();
  private toolCalls: CodaliGatewayStoredToolCall[] = [];
  private modelCalls: CodaliGatewayStoredModelCall[] = [];
  private contextPacks = new Map<string, CodaliContextPack>();
  private artifacts: CodaliGatewayStoredArtifact[] = [];

  async createRun(input: CodaliGatewayCreateRunInput): Promise<CodaliGatewayStoredRun> {
    const runId = input.runId ?? randomUUID();
    if (this.runs.has(runId)) {
      throw new Error(`GATEWAY_RUN_ALREADY_EXISTS: ${runId}`);
    }
    const createdAt = nowIso();
    const run: CodaliGatewayStoredRun = {
      runId,
      status: input.status ?? "pending",
      createdAt,
      updatedAt: createdAt,
      request: input.request ? cloneRedacted(input.request) : undefined,
      warnings: [],
      errors: [],
      metadata: input.metadata ? cloneRedacted(input.metadata) : undefined,
    };
    this.runs.set(runId, run);
    return clone(run);
  }

  async updateRun(
    runId: string,
    input: CodaliGatewayUpdateRunInput,
  ): Promise<CodaliGatewayStoredRun> {
    const run = requireRun(this.runs, runId);
    const updated: CodaliGatewayStoredRun = {
      ...run,
      status: input.status ?? run.status,
      warnings: input.warnings ? [...input.warnings] : run.warnings,
      errors: input.errors ? [...input.errors] : run.errors,
      metadata: input.metadata ? cloneRedacted(input.metadata) : run.metadata,
      updatedAt: nowIso(),
    };
    this.runs.set(runId, updated);
    return clone(updated);
  }

  async createTask(input: CodaliGatewayCreateTaskInput): Promise<CodaliGatewayStoredTask> {
    requireRun(this.runs, input.runId);
    const id = input.id ?? randomUUID();
    if (this.tasks.some((task) => task.runId === input.runId && task.id === id)) {
      throw new Error(`GATEWAY_TASK_ALREADY_EXISTS: ${id}`);
    }
    const createdAt = nowIso();
    const task: CodaliGatewayStoredTask = {
      id,
      runId: input.runId,
      status: input.status ?? "pending",
      workerRole: input.workerRole,
      objective: input.objective,
      createdAt,
      updatedAt: createdAt,
      metadata: input.metadata ? cloneRedacted(input.metadata) : undefined,
    };
    this.tasks.push(task);
    return clone(task);
  }

  async updateTask(
    runId: string,
    taskId: string,
    input: CodaliGatewayUpdateTaskInput,
  ): Promise<CodaliGatewayStoredTask> {
    requireRun(this.runs, runId);
    const task = requireTask(this.tasks, runId, taskId);
    const updated: CodaliGatewayStoredTask = {
      ...task,
      status: input.status ?? task.status,
      workerRole: input.workerRole ?? task.workerRole,
      objective: input.objective ?? task.objective,
      metadata: input.metadata ? cloneRedacted(input.metadata) : task.metadata,
      updatedAt: nowIso(),
    };
    const index = this.tasks.indexOf(task);
    this.tasks[index] = updated;
    return clone(updated);
  }

  async appendEvidence(
    runId: string,
    evidence: CodaliEvidenceItem[],
  ): Promise<CodaliEvidenceItem[]> {
    requireRun(this.runs, runId);
    const existing = this.evidence.get(runId) ?? [];
    const redacted = cloneRedacted(evidence);
    existing.push(...redacted);
    this.evidence.set(runId, existing);
    return clone(redacted);
  }

  async appendToolCall(
    call: Omit<CodaliGatewayStoredToolCall, "id" | "startedAt"> & {
      id?: string;
      startedAt?: string;
    },
  ): Promise<CodaliGatewayStoredToolCall> {
    requireRun(this.runs, call.runId);
    const record: CodaliGatewayStoredToolCall = cloneRedacted({
      ...call,
      id: call.id ?? randomUUID(),
      startedAt: call.startedAt ?? nowIso(),
    });
    this.toolCalls.push(record);
    return clone(record);
  }

  async appendModelCall(
    call: Omit<CodaliGatewayStoredModelCall, "id" | "startedAt"> & {
      id?: string;
      startedAt?: string;
    },
  ): Promise<CodaliGatewayStoredModelCall> {
    requireRun(this.runs, call.runId);
    const record: CodaliGatewayStoredModelCall = cloneRedacted({
      ...call,
      id: call.id ?? randomUUID(),
      startedAt: call.startedAt ?? nowIso(),
    });
    this.modelCalls.push(record);
    return clone(record);
  }

  async saveContextPack(
    runId: string,
    contextPack: CodaliContextPack,
  ): Promise<CodaliContextPack> {
    requireRun(this.runs, runId);
    const redacted = cloneRedacted(contextPack);
    this.contextPacks.set(runId, redacted);
    return clone(redacted);
  }

  async saveArtifact(
    artifact: Omit<CodaliGatewayStoredArtifact, "id" | "createdAt"> & {
      id?: string;
      createdAt?: string;
    },
  ): Promise<CodaliGatewayStoredArtifact> {
    requireRun(this.runs, artifact.runId);
    const record: CodaliGatewayStoredArtifact = cloneRedacted({
      ...artifact,
      id: artifact.id ?? randomUUID(),
      createdAt: artifact.createdAt ?? nowIso(),
    });
    this.artifacts.push(record);
    return clone(record);
  }

  async readRunTrace(runId: string): Promise<CodaliGatewayRunTrace | undefined> {
    const run = this.runs.get(runId);
    if (!run) {
      return undefined;
    }
    return clone({
      run,
      tasks: this.tasks.filter((task) => task.runId === runId),
      evidence: this.evidence.get(runId) ?? [],
      toolCalls: this.toolCalls.filter((call) => call.runId === runId),
      modelCalls: this.modelCalls.filter((call) => call.runId === runId),
      contextPack: this.contextPacks.get(runId),
      artifacts: this.artifacts.filter((artifact) => artifact.runId === runId),
    });
  }
}

export const createInMemoryCodaliGatewayStore = (): InMemoryCodaliGatewayStore =>
  new InMemoryCodaliGatewayStore();
