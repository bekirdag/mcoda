import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { PathHelper } from "@mcoda/shared";
import {
  WorkspaceRepository,
  CommandStatus,
  JobStatus,
  TokenUsageInsert,
} from "@mcoda/db";

export type JobState = JobStatus;
export type CommandRunStatus = CommandStatus;

export interface CommandRunRecord {
  id: string;
  commandName: string;
  workspaceId: string;
  projectKey?: string;
  jobId?: string;
  agentId?: string;
  taskIds?: string[];
  gitBranch?: string;
  gitBaseBranch?: string;
  startedAt: string;
  completedAt?: string;
  status: CommandRunStatus;
  errorSummary?: string;
  durationSeconds?: number;
  spProcessed?: number | null;
}

export interface JobRecord {
  id: string;
  type: string;
  state: JobState;
  jobState?: JobState;
  jobStateDetail?: string;
  commandRunId?: string;
  commandName?: string;
  workspaceId: string;
  projectKey?: string;
  payload?: Record<string, unknown>;
  agentId?: string;
  agentIds?: string[];
  totalItems?: number;
  processedItems?: number;
  totalUnits?: number;
  completedUnits?: number;
  lastCheckpoint?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  errorSummary?: string;
  durationSeconds?: number;
}

export interface TokenUsageRecord extends TokenUsageInsert {
  commandName?: string;
  action?: string;
  invocationKind?: string;
  provider?: string;
  currency?: string;
  promptTokens?: number;
  completionTokens?: number;
  tokensCached?: number;
  tokensCacheRead?: number;
  tokensCacheWrite?: number;
  costUsd?: number;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface JobCheckpoint {
  stage: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface JobLogRow {
  timestamp: string;
  sequence?: number | null;
  level?: string | null;
  source?: string | null;
  message?: string | null;
  taskId?: string | null;
  taskKey?: string | null;
  phase?: string | null;
  details?: Record<string, unknown> | null;
}

export interface TaskRunSnapshotRow {
  taskId?: string | null;
  taskKey?: string | null;
  status?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  command?: string | null;
}

const nowIso = (): string => new Date().toISOString();
const TERMINAL_JOB_STATES = new Set<JobState>(["completed", "failed", "cancelled", "partial"]);

type JobServiceWorkspace =
  | string
  | {
      workspaceRoot: string;
      workspaceId?: string;
      mcodaDir?: string;
    };

export class JobService {
  private static activeJobs = new Map<string, { service: JobService; commandRunId?: string }>();
  private static signalHandlersRegistered = false;
  private static handlingSignal = false;
  private checkpointCounters = new Map<string, number>();
  private workspaceRepoInit = false;
  private telemetryConfig?: { optOut?: boolean; strict?: boolean };
  private telemetryWarningShown = false;
  private telemetryRemoteWarningShown = false;
  private perRunTelemetryDisabled: boolean;
  private envTelemetryDisabled: boolean;
  private requireRepo: boolean;
  private workspaceRoot: string;
  private workspaceId: string;
  private mcodaDirOverride?: string;

  private static ensureSignalHandlers(): void {
    if (JobService.signalHandlersRegistered) return;
    if (process.env.MCODA_DISABLE_JOB_SIGNAL_HANDLERS === "1") return;
    JobService.signalHandlersRegistered = true;
    const handler = (signal: NodeJS.Signals) => {
      void JobService.handleProcessSignal(signal);
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
    process.once("SIGTSTP", handler);
  }

  private static registerActiveJob(jobId: string, service: JobService, commandRunId?: string): void {
    JobService.activeJobs.set(jobId, { service, commandRunId });
    JobService.ensureSignalHandlers();
  }

  private static unregisterActiveJob(jobId: string): void {
    JobService.activeJobs.delete(jobId);
  }

  static async cancelActiveJobs(signal: NodeJS.Signals): Promise<void> {
    const active = Array.from(JobService.activeJobs.entries());
    await Promise.all(
      active.map(async ([jobId, entry]) => entry.service.cancelJobOnSignal(jobId, entry.commandRunId, signal)),
    );
  }

  private static async handleProcessSignal(signal: NodeJS.Signals): Promise<void> {
    if (JobService.handlingSignal) return;
    JobService.handlingSignal = true;
    await JobService.cancelActiveJobs(signal);
    const exitCode = signal === "SIGTERM" ? 143 : 130;
    process.exitCode = exitCode;
    process.exit(exitCode);
  }

  constructor(
    workspace: JobServiceWorkspace,
    private workspaceRepo?: WorkspaceRepository,
    options: { noTelemetry?: boolean; requireRepo?: boolean } = {},
  ) {
    const resolvedRoot = typeof workspace === "string" ? workspace : workspace.workspaceRoot;
    this.workspaceRoot = resolvedRoot;
    this.workspaceId = typeof workspace === "string" ? resolvedRoot : workspace.workspaceId ?? resolvedRoot;
    this.mcodaDirOverride = typeof workspace === "string" ? undefined : workspace.mcodaDir;
    this.perRunTelemetryDisabled = options.noTelemetry ?? false;
    this.envTelemetryDisabled = (process.env.MCODA_TELEMETRY ?? "").toLowerCase() === "off";
    this.requireRepo = options.requireRepo ?? false;
  }

  private get mcodaDir(): string {
    return this.mcodaDirOverride ?? PathHelper.getWorkspaceDir(this.workspaceRoot);
  }

  private get commandRunsPath(): string {
    return path.join(this.mcodaDir, "command_runs.json");
  }

  private get jobsStorePath(): string {
    return path.join(this.mcodaDir, "jobs.json");
  }

  private get tokenUsagePath(): string {
    return path.join(this.mcodaDir, "token_usage.json");
  }

  private jobDir(jobId: string): string {
    return path.join(this.mcodaDir, "jobs", jobId);
  }

  private manifestPath(jobId: string): string {
    return path.join(this.jobDir(jobId), "manifest.json");
  }

  private checkpointDir(jobId: string): string {
    return path.join(this.jobDir(jobId), "checkpoints");
  }

  private logsDir(jobId: string): string {
    return path.join(this.jobDir(jobId), "logs");
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.mcodaDir);
    if (this.workspaceRepoInit) return;
    this.workspaceRepoInit = true;
    if (process.env.MCODA_DISABLE_DB === "1") {
      if (this.requireRepo) {
        throw new Error("Workspace DB disabled via MCODA_DISABLE_DB; job operations require the workspace DB per SDS.");
      }
      this.workspaceRepo = undefined;
      return;
    }
    try {
      if (!this.workspaceRepo) {
        this.workspaceRepo = await WorkspaceRepository.create(this.workspaceRoot);
      }
    } catch (error) {
      if (this.requireRepo) {
        throw new Error(
          `Workspace DB could not be opened for jobs (${(error as Error).message}); run mcoda init/create-tasks to initialize the workspace.`,
        );
      }
      // Fall back to JSON stores if sqlite is unavailable or schema mismatches.
      this.workspaceRepo = undefined;
    }
  }

  private async cancelJobOnSignal(jobId: string, commandRunId: string | undefined, signal: NodeJS.Signals): Promise<void> {
    const reason = `Cancelled by ${signal}`;
    try {
      await this.ensureMcoda();
    } catch {
      // ignore workspace bootstrap failures during shutdown
    }
    if (this.workspaceRepo && "releaseTaskLocksByJob" in this.workspaceRepo) {
      try {
        await (this.workspaceRepo as any).releaseTaskLocksByJob(jobId);
      } catch {
        // ignore lock cleanup failures during shutdown
      }
    }
    try {
      await this.updateJobStatus(jobId, "cancelled", { errorSummary: reason });
    } catch {
      // ignore job status failures during shutdown
    }
    if (commandRunId) {
      try {
        await this.finishCommandRun(commandRunId, "cancelled", reason);
      } catch {
        // ignore command run failures during shutdown
      }
    }
  }

  private async readJsonArray<T>(filePath: string): Promise<T[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as T[];
      if (Array.isArray(parsed)) return parsed;
      return [];
    } catch {
      return [];
    }
  }

  private async writeJsonArray<T>(filePath: string, records: T[]): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
  }

  private async appendJsonArray<T>(filePath: string, record: T): Promise<void> {
    const existing = await this.readJsonArray<T>(filePath);
    existing.push(record);
    await this.writeJsonArray(filePath, existing);
  }

  async listJobs(): Promise<JobRecord[]> {
    await this.ensureMcoda();
    if (this.workspaceRepo && "listJobs" in this.workspaceRepo) {
      const rows = await (this.workspaceRepo as any).listJobs();
      return rows as JobRecord[];
    }
    return this.readJsonArray<JobRecord>(this.jobsStorePath);
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    await this.ensureMcoda();
    if (this.workspaceRepo && "getJob" in this.workspaceRepo) {
      return ((await (this.workspaceRepo as any).getJob(jobId)) as JobRecord | undefined) ?? undefined;
    }
    const jobs = await this.readJsonArray<JobRecord>(this.jobsStorePath);
    return jobs.find((j) => j.id === jobId);
  }

  async readCheckpoints(jobId: string): Promise<JobCheckpoint[]> {
    const dir = this.checkpointDir(jobId);
    try {
      const entries = await fs.readdir(dir);
      const checkpoints: JobCheckpoint[] = [];
      for (const entry of entries.sort()) {
        const raw = await fs.readFile(path.join(dir, entry), "utf8");
        checkpoints.push(JSON.parse(raw) as JobCheckpoint);
      }
      return checkpoints;
    } catch {
      return [];
    }
  }

  async readLog(jobId: string): Promise<string> {
    const logPath = path.join(this.logsDir(jobId), "stream.log");
    try {
      return await fs.readFile(logPath, "utf8");
    } catch {
      return "";
    }
  }

  async listJobLogs(
    jobId: string,
    options: { since?: string; after?: { timestamp: string; sequence?: number | null } } = {},
  ): Promise<JobLogRow[]> {
    await this.ensureMcoda();
    if (this.workspaceRepo && "getDb" in this.workspaceRepo) {
      const db = (this.workspaceRepo as any).getDb();
      const clauses = ["tr.job_id = ?"];
      const params: any[] = [jobId];
      if (options.since) {
        clauses.push("datetime(tl.timestamp) >= datetime(?)");
        params.push(options.since);
      }
      if (options.after?.timestamp) {
        clauses.push("(datetime(tl.timestamp) > datetime(?) OR (tl.timestamp = ? AND COALESCE(tl.sequence,0) > COALESCE(?,0)))");
        params.push(options.after.timestamp, options.after.timestamp, options.after.sequence ?? 0);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = (await db.all(
        `
        SELECT tl.timestamp, tl.sequence, tl.level, tl.source, tl.message, tl.details_json, tr.task_id, tr.command, t.key as task_key
        FROM task_logs tl
        JOIN task_runs tr ON tr.id = tl.task_run_id
        LEFT JOIN tasks t ON t.id = tr.task_id
        ${where}
        ORDER BY datetime(tl.timestamp) ASC, tl.sequence ASC
        LIMIT 500
        `,
        ...params
      )) as any[];
      return rows.map((row: any) => {
        const details = row.details_json ? JSON.parse(row.details_json) : null;
        return {
          timestamp: row.timestamp,
          sequence: row.sequence ?? null,
          level: row.level ?? null,
          source: row.source ?? null,
          message: row.message ?? null,
          taskId: row.task_id ?? null,
          taskKey: row.task_key ?? null,
          phase: (details as any)?.phase ?? row.command ?? null,
          details,
        };
      });
    }
    // Fallback to file-based stream log when DB access is not available.
    const raw = await this.readLog(jobId);
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.map((line, idx) => ({
      timestamp: nowIso(),
      sequence: idx,
      message: line,
    }));
  }

  async summarizeTaskRuns(jobId: string): Promise<TaskRunSnapshotRow[]> {
    await this.ensureMcoda();
    if (this.workspaceRepo && "getDb" in this.workspaceRepo) {
      const db = (this.workspaceRepo as any).getDb();
      const rows = (await db.all(
        `
        SELECT tr.task_id, tr.status, tr.started_at, tr.finished_at, tr.command, t.key as task_key
        FROM task_runs tr
        LEFT JOIN tasks t ON t.id = tr.task_id
        WHERE tr.job_id = ?
        ORDER BY datetime(tr.started_at) ASC, datetime(tr.finished_at) ASC
        `,
        jobId
      )) as any[];
      return rows.map((row: any) => ({
        taskId: row.task_id ?? null,
        taskKey: row.task_key ?? null,
        status: row.status ?? null,
        startedAt: row.started_at ?? null,
        finishedAt: row.finished_at ?? null,
        command: row.command ?? null,
      }));
    }
    return [];
  }

  async startCommandRun(
    commandName: string,
    projectKey?: string,
    options?: { gitBranch?: string; gitBaseBranch?: string; taskIds?: string[]; jobId?: string; agentId?: string },
  ): Promise<CommandRunRecord> {
    await this.ensureMcoda();
    const startedAt = nowIso();
    let record: CommandRunRecord = {
      id: randomUUID(),
      commandName,
      workspaceId: this.workspaceId,
      projectKey,
      jobId: options?.jobId,
      agentId: options?.agentId,
      taskIds: options?.taskIds,
      gitBranch: options?.gitBranch,
      gitBaseBranch: options?.gitBaseBranch,
      startedAt,
      status: "running",
      spProcessed: null,
    };
    if (this.workspaceRepo) {
      const row = await this.workspaceRepo.createCommandRun({
        workspaceId: this.workspaceId,
        commandName,
        jobId: record.jobId,
        agentId: record.agentId ?? null,
        taskIds: record.taskIds,
        gitBranch: record.gitBranch,
        gitBaseBranch: record.gitBaseBranch,
        startedAt,
        status: "running",
      });
      record = { ...record, id: row.id };
    }
    await this.appendJsonArray(this.commandRunsPath, record);
    return record;
  }

  async finishCommandRun(runId: string, status: CommandRunStatus, errorSummary?: string, spProcessed?: number): Promise<void> {
    const runs = await this.readJsonArray<CommandRunRecord>(this.commandRunsPath);
    const idx = runs.findIndex((r) => r.id === runId);
    if (idx === -1) return;
    const completedAt = nowIso();
    const durationSeconds =
      runs[idx].startedAt ? (Date.parse(completedAt) - Date.parse(runs[idx].startedAt)) / 1000 : undefined;
    runs[idx] = { ...runs[idx], completedAt, status, errorSummary, durationSeconds, spProcessed: spProcessed ?? runs[idx].spProcessed };
    await this.writeJsonArray(this.commandRunsPath, runs);
    if (this.workspaceRepo) {
      await this.workspaceRepo.completeCommandRun(runId, {
        status,
        completedAt,
        errorSummary,
        durationSeconds,
        spProcessed: spProcessed ?? runs[idx].spProcessed ?? null,
      });
    }
  }

  async startJob(
    type: string,
    commandRunId?: string,
    projectKey?: string,
    options: {
      payload?: Record<string, unknown>;
      commandName?: string;
      totalItems?: number;
      processedItems?: number;
      agentId?: string;
      agentIds?: string[];
    } = {},
  ): Promise<JobRecord> {
    await this.ensureMcoda();
    const createdAt = nowIso();
    let record: JobRecord = {
      id: randomUUID(),
      type,
      state: "running",
      commandRunId,
      commandName: options.commandName ?? type,
      workspaceId: this.workspaceId,
      projectKey,
      payload: options.payload,
      agentId: options.agentId,
      agentIds: options.agentIds ?? (options.agentId ? [options.agentId] : undefined),
      totalItems: options.totalItems,
      processedItems: options.processedItems,
      totalUnits: options.totalItems,
      completedUnits: options.processedItems,
      createdAt,
      updatedAt: createdAt,
    };
    if (this.workspaceRepo) {
      const row = await this.workspaceRepo.createJob({
        workspaceId: this.workspaceId,
        type,
        state: "running",
        commandName: record.commandName,
        payload: options.payload,
        agentId: record.agentId ?? null,
        agentIds: record.agentIds ?? null,
        totalItems: record.totalItems,
        processedItems: record.processedItems,
      });
      record = { ...record, id: row.id, createdAt: row.createdAt, updatedAt: row.updatedAt };
    }
    const jobs = await this.readJsonArray<JobRecord>(this.jobsStorePath);
    jobs.push(record);
    await this.writeJsonArray(this.jobsStorePath, jobs);
    await this.writeManifest(record);
    if (commandRunId) {
      await this.attachCommandRunToJob(commandRunId, record.id);
    }
    JobService.registerActiveJob(record.id, this, commandRunId);
    return record;
  }

  private async attachCommandRunToJob(commandRunId: string, jobId: string): Promise<void> {
    const runs = await this.readJsonArray<CommandRunRecord>(this.commandRunsPath);
    const idx = runs.findIndex((r) => r.id === commandRunId);
    if (idx !== -1) {
      runs[idx] = { ...runs[idx], jobId };
      await this.writeJsonArray(this.commandRunsPath, runs);
    }
    if (this.workspaceRepo && "setCommandRunJobId" in this.workspaceRepo) {
      try {
        await (this.workspaceRepo as any).setCommandRunJobId(commandRunId, jobId);
      } catch {
        // ignore linking failures
      }
    }
  }

  async updateJobStatus(
    jobId: string,
    state: JobState,
    metadata?: {
      payload?: Record<string, unknown>;
      totalItems?: number;
      processedItems?: number;
      totalUnits?: number;
      completedUnits?: number;
      lastCheckpoint?: string;
      errorSummary?: string;
      [key: string]: unknown;
    },
  ): Promise<void> {
    const jobs = await this.readJsonArray<JobRecord>(this.jobsStorePath);
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return;
    const completedAt = state !== "running" && state !== "queued" ? nowIso() : jobs[idx].completedAt;
    const durationSeconds =
      completedAt && jobs[idx].createdAt ? (Date.parse(completedAt) - Date.parse(jobs[idx].createdAt)) / 1000 : jobs[idx].durationSeconds;
    const jobStateDetail = (metadata as any)?.job_state_detail ?? (metadata as any)?.jobStateDetail ?? jobs[idx].jobStateDetail;
    const payloadUpdate =
      metadata?.payload ??
      (metadata
        ? Object.fromEntries(
            Object.entries(metadata).filter(
              ([key]) => !["payload", "totalItems", "processedItems", "lastCheckpoint", "errorSummary", "error"].includes(key),
            ),
          )
        : undefined);
    const updated: JobRecord = {
      ...jobs[idx],
      state,
      jobState: state,
      jobStateDetail,
      payload: payloadUpdate ? { ...(jobs[idx].payload ?? {}), ...payloadUpdate } : jobs[idx].payload,
      totalItems: metadata?.totalItems ?? jobs[idx].totalItems,
      processedItems: metadata?.processedItems ?? jobs[idx].processedItems,
      totalUnits: metadata?.totalUnits ?? metadata?.totalItems ?? jobs[idx].totalUnits ?? jobs[idx].totalItems,
      completedUnits: metadata?.completedUnits ?? metadata?.processedItems ?? jobs[idx].completedUnits ?? jobs[idx].processedItems,
      lastCheckpoint: metadata?.lastCheckpoint ?? jobs[idx].lastCheckpoint,
      errorSummary: metadata?.errorSummary ?? (metadata as any)?.error ?? jobs[idx].errorSummary,
      updatedAt: nowIso(),
      completedAt,
      durationSeconds,
    };
    jobs[idx] = updated;
    await this.writeJsonArray(this.jobsStorePath, jobs);
    await this.writeManifest(updated);
    if (this.workspaceRepo) {
      await this.workspaceRepo.updateJobState(jobId, {
        state,
        commandName: updated.commandName ?? updated.type,
        totalItems: updated.totalItems,
        processedItems: updated.processedItems,
        lastCheckpoint: updated.lastCheckpoint,
        errorSummary: updated.errorSummary,
        completedAt: updated.completedAt ?? null,
        payload: updated.payload,
      });
    }
    if (state === "cancelled" && this.workspaceRepo && "releaseTaskLocksByJob" in this.workspaceRepo) {
      try {
        await (this.workspaceRepo as any).releaseTaskLocksByJob(jobId);
      } catch {
        // ignore lock cleanup failures during cancellation
      }
    }
    if (TERMINAL_JOB_STATES.has(state)) {
      JobService.unregisterActiveJob(jobId);
    } else if (state === "running") {
      JobService.registerActiveJob(jobId, this, updated.commandRunId);
    }
  }

  async writeCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void> {
    const dir = this.checkpointDir(jobId);
    await PathHelper.ensureDir(dir);
    let current = this.checkpointCounters.get(jobId);
    if (current === undefined) {
      try {
        const entries = await fs.readdir(dir);
        const nums = entries
          .map((e) => Number.parseInt(e.replace(/\.ckpt\.json$/, ""), 10))
          .filter((n) => Number.isFinite(n));
        current = nums.length ? Math.max(...nums) : 0;
      } catch {
        current = 0;
      }
    }
    const next = (current ?? 0) + 1;
    this.checkpointCounters.set(jobId, next);
    const filename = `${String(next).padStart(6, "0")}.ckpt.json`;
    const target = path.join(dir, filename);
    const job = await this.getJob(jobId);
    const createdAt = nowIso();
    const payload = {
      schema_version: 1,
      job_id: jobId,
      checkpoint_seq: next,
      checkpoint_id: randomUUID(),
      created_at: createdAt,
      status: job?.state ?? "running",
      stage: checkpoint.stage,
      timestamp: checkpoint.timestamp ?? createdAt,
      reason: checkpoint.details?.reason,
      progress: {
        total: job?.totalItems ?? (checkpoint.details as any)?.totalItems ?? null,
        completed: job?.processedItems ?? (checkpoint.details as any)?.processedItems ?? null,
      },
      details: checkpoint.details,
    };
    await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
    if (this.workspaceRepo) {
      await this.workspaceRepo.updateJobState(jobId, {
        lastCheckpoint: checkpoint.stage,
      });
    }
  }

  async appendLog(jobId: string, content: string): Promise<void> {
    const logDir = this.logsDir(jobId);
    await PathHelper.ensureDir(logDir);
    const logPath = path.join(logDir, "stream.log");
    await fs.appendFile(logPath, content, "utf8");
  }

  private async readTelemetryConfig(): Promise<{ optOut?: boolean; strict?: boolean } | undefined> {
    const configPath = path.join(this.mcodaDir, "config.json");
    try {
      const raw = await fs.readFile(configPath, "utf8");
      const parsed = JSON.parse(raw) as { telemetry?: { optOut?: boolean; strict?: boolean } };
      return parsed.telemetry;
    } catch {
      return undefined;
    }
  }

  private async shouldRecordTokenUsage(): Promise<boolean> {
    if (this.telemetryConfig === undefined) {
      this.telemetryConfig = await this.readTelemetryConfig();
    }
    if (this.telemetryConfig?.strict) {
      if (!this.telemetryWarningShown) {
        // eslint-disable-next-line no-console
        console.warn("Telemetry strict mode is enabled; token usage will not be recorded locally.");
        this.telemetryWarningShown = true;
      }
      return false;
    }
    if (
      (this.perRunTelemetryDisabled || this.envTelemetryDisabled || this.telemetryConfig?.optOut) &&
      !this.telemetryRemoteWarningShown
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        "Remote telemetry export disabled for this run (--no-telemetry/MCODA_TELEMETRY=off or opt-out). Local logging still enabled unless telemetry.strict is set.",
      );
      this.telemetryRemoteWarningShown = true;
    }
    return true;
  }

  async recordTokenUsage(entry: TokenUsageRecord): Promise<void> {
    const recordTelemetry = await this.shouldRecordTokenUsage();
    if (!recordTelemetry) return;
    const normalized: TokenUsageInsert = {
      workspaceId: entry.workspaceId ?? this.workspaceId,
      agentId: entry.agentId ?? null,
      modelName: entry.modelName ?? null,
      jobId: entry.jobId ?? null,
      commandRunId: entry.commandRunId ?? null,
      taskRunId: entry.taskRunId ?? null,
      taskId: entry.taskId ?? null,
      projectId: entry.projectId ?? null,
      epicId: entry.epicId ?? null,
      userStoryId: entry.userStoryId ?? null,
      commandName: entry.commandName ?? null,
      action: entry.action ?? null,
      invocationKind: entry.invocationKind ?? null,
      provider: entry.provider ?? null,
      currency: entry.currency ?? null,
      tokensPrompt: entry.tokensPrompt ?? entry.promptTokens ?? null,
      tokensCompletion: entry.tokensCompletion ?? entry.completionTokens ?? null,
      tokensTotal: entry.tokensTotal ?? null,
      tokensCached: entry.tokensCached ?? null,
      tokensCacheRead: entry.tokensCacheRead ?? null,
      tokensCacheWrite: entry.tokensCacheWrite ?? null,
      costEstimate: entry.costEstimate ?? entry.costUsd ?? null,
      durationSeconds: entry.durationSeconds ?? null,
      durationMs: entry.durationMs ?? null,
      startedAt: entry.startedAt ?? null,
      finishedAt: entry.finishedAt ?? null,
      timestamp: entry.timestamp,
      metadata: {
        ...(entry.metadata ?? {}),
        ...(entry.commandName ? { commandName: entry.commandName } : {}),
        ...(entry.action ? { action: entry.action } : {}),
        ...(entry.invocationKind ? { invocationKind: entry.invocationKind } : {}),
        ...(entry.provider ? { provider: entry.provider } : {}),
        ...(entry.currency ? { currency: entry.currency } : {}),
      },
    };
    const fileRecord = {
      ...normalized,
      ...(entry.commandName ? { commandName: entry.commandName } : {}),
      ...(entry.action ? { action: entry.action } : {}),
      ...(entry.invocationKind ? { invocationKind: entry.invocationKind } : {}),
      ...(entry.provider ? { provider: entry.provider } : {}),
      ...(entry.currency ? { currency: entry.currency } : {}),
      ...(entry.tokensCached !== undefined && entry.tokensCached !== null ? { tokensCached: entry.tokensCached } : {}),
      ...(entry.tokensCacheRead !== undefined && entry.tokensCacheRead !== null ? { tokensCacheRead: entry.tokensCacheRead } : {}),
      ...(entry.tokensCacheWrite !== undefined && entry.tokensCacheWrite !== null ? { tokensCacheWrite: entry.tokensCacheWrite } : {}),
      ...(entry.durationMs !== undefined && entry.durationMs !== null ? { durationMs: entry.durationMs } : {}),
      ...(entry.startedAt ? { startedAt: entry.startedAt } : {}),
      ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
    };
    await this.appendJsonArray(this.tokenUsagePath, fileRecord as any);
    if (this.workspaceRepo) {
      await this.workspaceRepo.recordTokenUsage(normalized);
      if (entry.agentId) {
        if (entry.commandRunId) {
          try {
            await this.workspaceRepo.setCommandRunAgentId(entry.commandRunId, entry.agentId);
          } catch {
            // ignore attribution failures
          }
        }
        if (entry.jobId) {
          try {
            await this.workspaceRepo.setJobAgentIds(entry.jobId, entry.agentId);
          } catch {
            // ignore attribution failures
          }
        }
      }
    }
  }

  async writeManifest(job: JobRecord, extras: Record<string, unknown> = {}): Promise<void> {
    await PathHelper.ensureDir(this.jobDir(job.id));
    const manifestPath = this.manifestPath(job.id);
    const payload = {
      schema_version: 1,
      job_id: job.id,
      updated_at: new Date().toISOString(),
      status: (job as any).status ?? job.state,
      progress: { total: job.totalItems ?? null, completed: job.processedItems ?? null },
      ...job,
      ...extras,
    };
    await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2), "utf8");
  }

  async close(): Promise<void> {
    if (this.workspaceRepo) {
      await this.workspaceRepo.close();
    }
  }
}
