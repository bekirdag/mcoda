import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceRepository } from "@mcoda/db";

export type JobStatus = "running" | "succeeded" | "failed";

export interface CommandRunRecord {
  id: string;
  name: string;
  workspaceId: string;
  projectKey?: string;
  startedAt: string;
  endedAt?: string;
  status: JobStatus;
  error?: string;
  durationSeconds?: number;
}

export interface JobRecord {
  id: string;
  type: string;
  status: JobStatus;
  commandRunId: string;
  workspaceId: string;
  projectKey?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  durationSeconds?: number;
}

export interface TokenUsageRecord {
  timestamp: string;
  workspaceId: string;
  commandName: string;
  jobId?: string;
  agentId?: string;
  modelName?: string;
  action: string;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface JobCheckpoint {
  stage: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

const nowIso = (): string => new Date().toISOString();

export class JobService {
  private checkpointCounters = new Map<string, number>();

  constructor(private workspaceRoot: string, private workspaceRepo?: WorkspaceRepository) {}

  private get mcodaDir(): string {
    return path.join(this.workspaceRoot, ".mcoda");
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
    if (!this.workspaceRepo) {
      this.workspaceRepo = await WorkspaceRepository.create(this.workspaceRoot);
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
    return this.readJsonArray<JobRecord>(this.jobsStorePath);
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
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

  async startCommandRun(name: string, projectKey?: string): Promise<CommandRunRecord> {
    await this.ensureMcoda();
    const record: CommandRunRecord = {
      id: randomUUID(),
      name,
      workspaceId: this.workspaceRoot,
      projectKey,
      startedAt: nowIso(),
      status: "running",
    };
    await this.appendJsonArray(this.commandRunsPath, record);
    if (this.workspaceRepo) {
      await this.workspaceRepo.insertCommandRun(record);
    }
    return record;
  }

  async finishCommandRun(runId: string, status: JobStatus, error?: string): Promise<void> {
    const runs = await this.readJsonArray<CommandRunRecord>(this.commandRunsPath);
    const idx = runs.findIndex((r) => r.id === runId);
    if (idx === -1) return;
    const endedAt = nowIso();
    const durationSeconds = runs[idx].startedAt ? (Date.parse(endedAt) - Date.parse(runs[idx].startedAt)) / 1000 : undefined;
    runs[idx] = { ...runs[idx], endedAt, status, error, durationSeconds };
    await this.writeJsonArray(this.commandRunsPath, runs);
    if (this.workspaceRepo) {
      await this.workspaceRepo.updateCommandRun(runId, { endedAt, status, error, durationSeconds });
    }
  }

  async startJob(type: string, commandRunId: string, projectKey?: string): Promise<JobRecord> {
    await this.ensureMcoda();
    const record: JobRecord = {
      id: randomUUID(),
      type,
      status: "running",
      commandRunId,
      workspaceId: this.workspaceRoot,
      projectKey,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      metadata: {},
    };
    const jobs = await this.readJsonArray<JobRecord>(this.jobsStorePath);
    jobs.push(record);
    await this.writeJsonArray(this.jobsStorePath, jobs);
    await this.writeManifest(record);
    if (this.workspaceRepo) {
      await this.workspaceRepo.insertJob(record);
    }
    return record;
  }

  async updateJobStatus(jobId: string, status: JobStatus, metadata?: Record<string, unknown>): Promise<void> {
    const jobs = await this.readJsonArray<JobRecord>(this.jobsStorePath);
    const idx = jobs.findIndex((j) => j.id === jobId);
    if (idx === -1) return;
    const endedAt = status !== "running" ? nowIso() : undefined;
    const durationSeconds =
      endedAt && jobs[idx].createdAt ? (Date.parse(endedAt) - Date.parse(jobs[idx].createdAt)) / 1000 : jobs[idx].durationSeconds;
    const updated: JobRecord = {
      ...jobs[idx],
      status,
      updatedAt: endedAt ?? nowIso(),
      durationSeconds,
      metadata: { ...(jobs[idx].metadata ?? {}), ...(metadata ?? {}) },
    };
    jobs[idx] = updated;
    await this.writeJsonArray(this.jobsStorePath, jobs);
    await this.writeManifest(updated);
    if (this.workspaceRepo) {
      await this.workspaceRepo.updateJob(jobId, {
        status,
        updatedAt: updated.updatedAt,
        durationSeconds,
        metadata,
      });
    }
  }

  async writeCheckpoint(jobId: string, checkpoint: JobCheckpoint): Promise<void> {
    await PathHelper.ensureDir(this.checkpointDir(jobId));
    const current = this.checkpointCounters.get(jobId) ?? 0;
    const next = current + 1;
    this.checkpointCounters.set(jobId, next);
    const filename = `${String(next).padStart(6, "0")}.ckpt.json`;
    const target = path.join(this.checkpointDir(jobId), filename);
    await fs.writeFile(target, JSON.stringify(checkpoint, null, 2), "utf8");
    if (this.workspaceRepo) {
      await this.workspaceRepo.insertCheckpoint({
        jobId,
        seq: next,
        stage: checkpoint.stage,
        timestamp: checkpoint.timestamp,
        details: checkpoint.details,
      });
    }
  }

  async appendLog(jobId: string, content: string): Promise<void> {
    const logDir = this.logsDir(jobId);
    await PathHelper.ensureDir(logDir);
    const logPath = path.join(logDir, "stream.log");
    await fs.appendFile(logPath, content, "utf8");
  }

  async recordTokenUsage(entry: TokenUsageRecord): Promise<void> {
    await this.appendJsonArray<TokenUsageRecord>(this.tokenUsagePath, entry);
    if (this.workspaceRepo) {
      await this.workspaceRepo.insertTokenUsage(entry);
    }
  }

  async writeManifest(job: JobRecord, extras: Record<string, unknown> = {}): Promise<void> {
    await PathHelper.ensureDir(this.jobDir(job.id));
    const manifestPath = this.manifestPath(job.id);
    const payload = { ...job, ...extras };
    await fs.writeFile(manifestPath, JSON.stringify(payload, null, 2), "utf8");
  }

  async close(): Promise<void> {
    if (this.workspaceRepo) {
      await this.workspaceRepo.close();
    }
  }
}
