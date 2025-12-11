import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

export interface JobsApiJob {
  id: string;
  type: string;
  command_name?: string;
  job_state?: string;
  job_state_detail?: string;
  job_state_detail_code?: string;
  total_units?: number | null;
  completed_units?: number | null;
  created_at?: string;
  updated_at?: string;
  last_checkpoint_at?: string;
  completed_at?: string | null;
  payload_json?: unknown;
}

export interface JobsApiLogs {
  entries: Array<{
    timestamp: string;
    sequence?: number | null;
    level?: string | null;
    source?: string | null;
    message?: string | null;
    task_id?: string | null;
    task_key?: string | null;
    phase?: string | null;
    details?: Record<string, unknown> | null;
  }>;
  cursor?: { timestamp: string; sequence?: number | null };
}

export interface JobsApiTasksSummary {
  totals: Record<string, number>;
  tasks: Array<{
    task_id?: string | null;
    task_key?: string | null;
    status?: string | null;
    started_at?: string | null;
    finished_at?: string | null;
    command?: string | null;
  }>;
}

export class JobsApiClient {
  constructor(private workspace: WorkspaceResolution, private baseUrl: string) {}

  private async fetchJson<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T | undefined> {
    try {
      const url = new URL(path, this.baseUrl);
      if (query) {
        Object.entries(query).forEach(([key, value]) => {
          if (value === undefined) return;
          url.searchParams.set(key, String(value));
        });
      }
      const resp = await fetch(url.toString(), { headers: { accept: "application/json" } });
      if (!resp.ok) return undefined;
      return (await resp.json()) as T;
    } catch {
      return undefined;
    }
  }

  private async postJson<T>(path: string, body?: Record<string, unknown>): Promise<T | undefined> {
    try {
      const resp = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!resp.ok) return undefined;
      return (await resp.json()) as T;
    } catch {
      return undefined;
    }
  }

  async listJobs(params: { status?: string; type?: string; project?: string; since?: string; limit?: number }): Promise<JobsApiJob[] | undefined> {
    return this.fetchJson<JobsApiJob[]>("/jobs", params as any);
  }

  async getJob(jobId: string): Promise<JobsApiJob | undefined> {
    return this.fetchJson<JobsApiJob>(`/jobs/${jobId}`);
  }

  async getCheckpoint(jobId: string): Promise<Record<string, unknown> | undefined> {
    return this.fetchJson<Record<string, unknown>>(`/jobs/${jobId}/checkpoint`);
  }

  async getLogs(jobId: string, params: { since?: string; after?: { timestamp: string; sequence?: number | null } }): Promise<JobsApiLogs | undefined> {
    const sequence =
      params.after && typeof params.after.sequence === "number" ? params.after.sequence : undefined;
    const after = params.after?.timestamp;
    return this.fetchJson<JobsApiLogs>(`/jobs/${jobId}/logs`, {
      since: params.since,
      after: after || undefined,
      sequence,
    });
  }

  async getTasksSummary(jobId: string): Promise<JobsApiTasksSummary | undefined> {
    return this.fetchJson<JobsApiTasksSummary>(`/jobs/${jobId}/tasks/summary`);
  }

  async cancelJob(jobId: string, options: { force?: boolean; reason?: string } = {}): Promise<void> {
    await this.postJson(`/jobs/${jobId}/cancel`, {
      force: options.force ?? false,
      reason: options.reason ?? (options.force ? "force" : "user"),
    });
  }
}
