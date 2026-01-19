import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobRecord, JobService, JobState } from "./JobService.js";
import { JobsApiClient } from "./JobsApiClient.js";
import { TelemetryService, TokenUsageRow } from "../telemetry/TelemetryService.js";

export interface JobListFilters {
  status?: string;
  type?: string;
  projectKey?: string;
  since?: string;
  limit?: number;
}

export interface JobSummary extends JobRecord {
  progressPct?: number | null;
  lastCheckpointStage?: string;
  lastCheckpointAt?: string;
  stateDetail?: string;
  jobState?: JobState;
  jobStateDetail?: string;
  totalUnits?: number;
  completedUnits?: number;
}

export interface CheckpointSummary {
  stage?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
  path?: string;
}

export interface JobLogEntry {
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

export interface JobLogsResult {
  entries: JobLogEntry[];
  cursor?: { timestamp: string; sequence?: number | null };
}

export interface TaskRunSnapshot {
  taskId?: string | null;
  taskKey?: string | null;
  status?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  command?: string | null;
}

export interface TaskRunSummary {
  totals: Record<string, number>;
  tasks: TaskRunSnapshot[];
}

export interface TokenUsageSummary {
  agentId?: string | null;
  modelName?: string | null;
  commandName?: string | null;
  commandRunId?: string | null;
  taskId?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;
  tokensCached?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  durationMs?: number | null;
  cost?: number | null;
}

const parseSinceInput = (input?: string): string | undefined => {
  if (!input) return undefined;
  const trimmed = input.trim();
  const durationMatch = trimmed.match(/^(\d+)([smhdw])$/i);
  if (durationMatch) {
    const amount = Number(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
    };
    if (multipliers[unit]) {
      return new Date(Date.now() - amount * multipliers[unit]).toISOString();
    }
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return undefined;
};

const computeProgress = (job: { totalItems?: number | null; processedItems?: number | null }): number | null => {
  const total = (job as any).totalUnits ?? job.totalItems ?? null;
  const completed = (job as any).completedUnits ?? job.processedItems ?? 0;
  if (!total || total <= 0) return null;
  return Math.round((completed / total) * 100);
};

const mapJobRow = (row: any): JobSummary => {
  const payload = row.payload_json ? JSON.parse(row.payload_json) : undefined;
  const totalUnits = row.total_units ?? row.totalUnits ?? row.total_items ?? row.totalItems ?? undefined;
  const completedUnits = row.completed_units ?? row.completedUnits ?? row.processed_items ?? row.processedItems ?? undefined;
  const progressPct = computeProgress({ totalItems: totalUnits, processedItems: completedUnits });
  return {
    id: row.id,
    type: row.type,
    state: row.state ?? row.job_state,
    jobState: row.job_state ?? row.state,
    jobStateDetail: row.job_state_detail ?? row.state_detail ?? row.errorSummary,
    stateDetail: row.job_state_detail ?? row.state_detail ?? row.errorSummary,
    commandName: row.command_name ?? row.commandName,
    commandRunId: row.command_run_id ?? row.commandRunId,
    workspaceId: row.workspace_id ?? row.workspaceId,
    projectKey: row.projectKey,
    payload,
    totalItems: totalUnits,
    processedItems: completedUnits,
    totalUnits,
    completedUnits,
    lastCheckpoint: row.last_checkpoint ?? row.lastCheckpoint,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    completedAt: row.completed_at ?? row.completedAt,
    errorSummary: row.error_summary ?? row.errorSummary,
    progressPct,
  };
};

const matchesProject = (payload: Record<string, unknown> | undefined, projectKey?: string): boolean => {
  if (!projectKey) return true;
  if (!payload) return false;
  const candidates = [
    (payload as any).projectKey,
    (payload as any).project_id,
    (payload as any).project,
    (payload as any).projectId,
  ].filter(Boolean);
  return candidates.includes(projectKey);
};

export class JobInsightsService {
  private apiClient?: JobsApiClient;

  constructor(private workspace: WorkspaceResolution, private jobService: JobService, apiBaseUrl?: string) {
    if (apiBaseUrl) {
      this.apiClient = new JobsApiClient(workspace, apiBaseUrl);
    }
  }

  static async create(workspace: WorkspaceResolution): Promise<JobInsightsService> {
    const jobService = new JobService(workspace, undefined, { requireRepo: true });
    const apiBaseUrl =
      (workspace as any).config?.api?.baseUrl ??
      process.env.MCODA_API_BASE_URL ??
      process.env.MCODA_JOBS_API_URL ??
      undefined;
    return new JobInsightsService(workspace, jobService, apiBaseUrl);
  }

  async close(): Promise<void> {
    await this.jobService.close();
  }

  async listJobs(filters: JobListFilters = {}): Promise<JobSummary[]> {
    if (!this.apiClient) {
      throw new Error(
        "Jobs API is not configured; set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl to query jobs.",
      );
    }
    const remote = (await this.apiClient.listJobs({
      status: filters.status,
      type: filters.type,
      project: filters.projectKey,
      since: filters.since,
      limit: filters.limit,
    })) ?? [];
    const rows = remote.map(mapJobRow);
    const sinceIso = parseSinceInput(filters.since);
    return rows
      .filter((job) => {
        const state = (job as any).jobState ?? job.state;
        return !filters.status || state === filters.status;
      })
      .filter((job) => (!filters.type || job.type === filters.type))
      .filter((job) => matchesProject(job.payload, filters.projectKey))
      .filter((job) => {
        if (!sinceIso) return true;
        const updated = job.updatedAt ?? job.createdAt;
        if (!updated) return true;
        return Date.parse(updated) >= Date.parse(sinceIso);
      })
      .slice(0, Number.isFinite(filters.limit) ? (filters.limit as number) : rows.length)
      .map((job) => ({ ...job, progressPct: computeProgress(job) }));
  }

  async getJob(jobId: string): Promise<JobSummary | undefined> {
    if (!this.apiClient) {
      throw new Error(
        "Jobs API is not configured; set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl to read job status.",
      );
    }
    const remote = await this.apiClient.getJob(jobId);
    const job = remote ? mapJobRow(remote) : undefined;
    if (!job) return undefined;
    const detail = (job as any).job_state_detail ?? (job as any).jobStateDetail ?? job.errorSummary;
    const totalUnits = (job as any).totalUnits ?? job.totalItems ?? (job as any).total_units ?? undefined;
    const completedUnits = (job as any).completedUnits ?? job.processedItems ?? (job as any).completed_units ?? undefined;
    return {
      ...job,
      jobState: (job as any).job_state ?? job.state,
      jobStateDetail: detail,
      stateDetail: detail,
      totalUnits,
      completedUnits,
      progressPct: computeProgress({ totalItems: totalUnits, processedItems: completedUnits }),
    };
  }

  async latestCheckpoint(jobId: string): Promise<CheckpointSummary | undefined> {
    if (!this.apiClient) {
      throw new Error(
        "Jobs API is not configured; set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl to read checkpoints.",
      );
    }
    const remote = await this.apiClient.getCheckpoint(jobId);
    if (remote && ((remote as any).stage || (remote as any).status || (remote as any).timestamp)) {
      const data = remote as any;
      return {
        stage: data.stage ?? data.status,
        timestamp: data.timestamp ?? data.created_at,
        details: data.details ?? data.progress,
      };
    }
    const checkpoints = await this.jobService.readCheckpoints(jobId);
    if (!checkpoints.length) return undefined;
    const last = checkpoints[checkpoints.length - 1] as any;
    return {
      stage: last.stage ?? last.status,
      timestamp: last.timestamp ?? last.created_at,
      details: last.details,
    };
  }

  async getJobLogs(
    jobId: string,
    options: { since?: string; after?: { timestamp: string; sequence?: number | null } } = {},
  ): Promise<JobLogsResult> {
    if (!this.apiClient) {
      throw new Error(
        "Jobs API is not configured; set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl to stream job logs.",
      );
    }
    const remote = await this.apiClient.getLogs(jobId, options);
    if (!remote) return { entries: [], cursor: undefined };
    return remote;
  }

  async summarizeTasks(jobId: string): Promise<TaskRunSummary> {
    if (!this.apiClient) {
      throw new Error(
        "Jobs API is not configured; set MCODA_API_BASE_URL/MCODA_JOBS_API_URL or workspace api.baseUrl to read task summaries.",
      );
    }
    const remote = (await this.apiClient.getTasksSummary(jobId)) ?? { totals: {}, tasks: [] };
    const runs = (remote.tasks ?? []).map((t) => {
      const taskId = (t as any).taskId ?? t.task_id ?? null;
      const taskKey = (t as any).taskKey ?? t.task_key ?? null;
      const startedAt = (t as any).startedAt ?? t.started_at ?? null;
      const finishedAt = (t as any).finishedAt ?? t.finished_at ?? null;
      const command = (t as any).command ?? null;
      return { taskId, taskKey, status: t.status ?? null, startedAt, finishedAt, command };
    });
    const totalsRemote = remote.totals ?? {};
    const totals: Record<string, number> = {};
    for (const run of runs) {
      const status = run.status ?? "unknown";
      totals[status] = (totals[status] ?? 0) + 1;
    }
    Object.entries(totalsRemote ?? {}).forEach(([k, v]) => {
      totals[k] = v as number;
    });
    const tasks: TaskRunSnapshot[] = runs.map((run) => ({
      taskId: run.taskId ?? undefined,
      taskKey: run.taskKey ?? undefined,
      status: run.status ?? undefined,
      startedAt: run.startedAt ?? undefined,
      finishedAt: run.finishedAt ?? undefined,
      command: run.command ?? undefined,
    }));
    return { totals, tasks };
  }

  async summarizeTokenUsage(jobId: string): Promise<TokenUsageSummary[]> {
    const telemetry = await TelemetryService.create(this.workspace, { allowMissingTelemetry: false, requireApi: true });
    try {
      const summary = await telemetry.getSummary({
        jobId,
        groupBy: ["command", "agent", "model"],
        since: undefined,
        until: undefined,
      });
      return summary.map((row) => ({
        commandName: row.command_name ?? null,
        agentId: row.agent_id ?? null,
        modelName: row.model_name ?? null,
        tokensPrompt: row.tokens_prompt ?? null,
        tokensCompletion: row.tokens_completion ?? null,
        tokensTotal: row.tokens_total ?? null,
        tokensCached: row.tokens_cached ?? null,
        tokensCacheRead: row.tokens_cache_read ?? null,
        tokensCacheWrite: row.tokens_cache_write ?? null,
        durationMs: row.duration_ms ?? null,
        cost: row.cost_estimate ?? null,
      }));
    } finally {
      await telemetry.close();
    }
  }

  async readJobLog(jobId: string): Promise<string> {
    return this.jobService.readLog(jobId);
  }

  async readJobLogTail(jobId: string, offset: number): Promise<{ content: string; nextOffset: number }> {
    const logPath = path.join(this.workspace.mcodaDir, "jobs", jobId, "logs", "stream.log");
    try {
      const content = await fs.readFile(logPath, "utf8");
      const slice = offset > 0 ? content.slice(offset) : content;
      return { content: slice, nextOffset: content.length };
    } catch {
      return { content: "", nextOffset: offset };
    }
  }

  async updateJobState(jobId: string, state: JobState, meta?: Record<string, unknown>): Promise<void> {
    await this.jobService.updateJobStatus(jobId, state, meta);
  }

  async cancelJob(jobId: string, options: { force?: boolean; reason?: string } = {}): Promise<void> {
    if (this.apiClient) {
      await this.apiClient.cancelJob(jobId, options);
      return;
    }
    throw new Error(
      "Cancel requires the jobs API; set MCODA_API_BASE_URL or workspace baseUrl so the cancel endpoint can enforce state transitions.",
    );
  }
}
