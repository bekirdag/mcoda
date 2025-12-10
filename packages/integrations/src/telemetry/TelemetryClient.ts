export interface TokenUsageSummaryRow {
  workspace_id: string;
  project_id?: string | null;
  agent_id?: string | null;
  model_name?: string | null;
  command_name?: string | null;
  action?: string | null;
  job_id?: string | null;
  day?: string | null;
  calls: number;
  tokens_prompt: number;
  tokens_completion: number;
  tokens_total: number;
  cost_estimate: number | null;
}

export interface TokenUsageRow {
  workspace_id: string;
  agent_id: string | null;
  model_name: string | null;
  job_id: string | null;
  command_run_id: string | null;
  task_run_id: string | null;
  task_id: string | null;
  project_id: string | null;
  epic_id: string | null;
  user_story_id: string | null;
  tokens_prompt: number | null;
  tokens_completion: number | null;
  tokens_total: number | null;
  cost_estimate: number | null;
  duration_seconds: number | null;
  timestamp: string;
  command_name?: string | null;
  action?: string | null;
  error_kind?: string | null;
  metadata?: Record<string, unknown>;
}

export interface TelemetryConfig {
  localRecording: boolean;
  remoteExport: boolean;
  optOut: boolean;
  strict: boolean;
  [key: string]: unknown;
}

export class TelemetryClient {
  constructor(
    private options: {
      baseUrl: string;
      authToken?: string;
    },
  ) {}

  private async request<T>(pathname: string, init?: RequestInit): Promise<T> {
    const url = new URL(pathname, this.options.baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as any) } });
    if (!response.ok) {
      throw new Error(`Telemetry request failed (${response.status}): ${await response.text()}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async getSummary(params: {
    workspaceId: string;
    projectId?: string;
    agentId?: string;
    commandName?: string;
    jobId?: string;
    from?: string;
    to?: string;
    groupBy?: string[];
  }): Promise<TokenUsageSummaryRow[]> {
    const search = new URLSearchParams();
    search.set("workspace_id", params.workspaceId);
    if (params.projectId) search.set("project_id", params.projectId);
    if (params.agentId) search.set("agent_id", params.agentId);
    if (params.commandName) search.set("command_name", params.commandName);
    if (params.jobId) search.set("job_id", params.jobId);
    if (params.from) search.set("from", params.from);
    if (params.to) search.set("to", params.to);
    if (params.groupBy && params.groupBy.length > 0) {
      search.set("group_by", params.groupBy.join(","));
    }
    return this.request<TokenUsageSummaryRow[]>(`/telemetry/summary?${search.toString()}`);
  }

  async getTokenUsage(params: {
    workspaceId: string;
    projectId?: string;
    agentId?: string;
    commandName?: string;
    jobId?: string;
    taskId?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
    sort?: string;
  }): Promise<TokenUsageRow[]> {
    const search = new URLSearchParams();
    search.set("workspace_id", params.workspaceId);
    if (params.projectId) search.set("project_id", params.projectId);
    if (params.agentId) search.set("agent_id", params.agentId);
    if (params.commandName) search.set("command_name", params.commandName);
    if (params.jobId) search.set("job_id", params.jobId);
    if (params.taskId) search.set("task_id", params.taskId);
    if (params.from) search.set("from", params.from);
    if (params.to) search.set("to", params.to);
    if (params.page !== undefined) search.set("page", String(params.page));
    if (params.pageSize !== undefined) search.set("page_size", String(params.pageSize));
    if (params.sort) search.set("sort", params.sort);
    return this.request<TokenUsageRow[]>(`/telemetry/token-usage?${search.toString()}`);
  }

  async getConfig(workspaceId: string): Promise<TelemetryConfig> {
    const search = new URLSearchParams();
    search.set("workspace_id", workspaceId);
    return this.request<TelemetryConfig>(`/telemetry/config?${search.toString()}`);
  }

  async optOut(workspaceId: string, strict?: boolean): Promise<TelemetryConfig> {
    return this.request<TelemetryConfig>(`/telemetry/opt-out`, {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId, strict: strict ?? false }),
    });
  }

  async optIn(workspaceId: string): Promise<TelemetryConfig> {
    return this.request<TelemetryConfig>(`/telemetry/opt-in`, {
      method: "POST",
      body: JSON.stringify({ workspace_id: workspaceId }),
    });
  }
}
