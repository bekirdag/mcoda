import fs from "node:fs/promises";
import path from "node:path";
import { Connection, GlobalRepository, type Database } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { TelemetryClient, TokenUsageRow, TokenUsageSummaryRow, type TelemetryConfig as ApiTelemetryConfig } from "@mcoda/integrations";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

export type { TokenUsageRow, TokenUsageSummaryRow } from "@mcoda/integrations";

type GroupByDimension = "project" | "agent" | "command" | "day" | "model" | "job" | "action";

export interface TelemetryConfigState extends ApiTelemetryConfig {
  configPath: string;
}

export interface TelemetrySummaryOptions {
  projectKey?: string;
  agent?: string;
  command?: string;
  jobId?: string;
  since?: string;
  until?: string;
  groupBy?: GroupByDimension[];
}

export interface TokenUsageQueryOptions {
  projectKey?: string;
  agent?: string;
  command?: string;
  jobId?: string;
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

interface DbTokenUsageRow {
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
  metadata_json?: string | null;
}

const hasTables = async (db: Database, required: string[]): Promise<boolean> => {
  const rows = await db.all<{ name: string }[]>(`SELECT name FROM sqlite_master WHERE type='table'`);
  const names = new Set(rows.map((r) => r.name));
  return required.every((name) => names.has(name));
};

const parseMetadata = (raw?: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const addCost = (current: number | null, value: number | null | undefined): number | null => {
  if (value === null || value === undefined) return current;
  return (current ?? 0) + value;
};

const parseDurationMs = (input: string): number | undefined => {
  const match = input.trim().match(/^(\d+)([smhdw])$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return multipliers[unit] ? amount * multipliers[unit] : undefined;
};

const parseTimeInput = (input?: string): string | undefined => {
  if (!input) return undefined;
  const duration = parseDurationMs(input);
  if (duration !== undefined) {
    return new Date(Date.now() - duration).toISOString();
  }
  const parsed = Date.parse(input);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return undefined;
};

const normalizeGroupBy = (groupBy?: GroupByDimension[]): GroupByDimension[] => {
  if (!groupBy || groupBy.length === 0) {
    return ["project", "command", "agent"];
  }
  const seen = new Set<GroupByDimension>();
  for (const dim of groupBy) {
    if (["project", "agent", "command", "day", "model", "job", "action"].includes(dim)) {
      seen.add(dim);
    }
  }
  return Array.from(seen);
};

const dayFromTimestamp = (timestamp: string | undefined): string | null => {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
};

export class TelemetryService {
  private globalRepo?: GlobalRepository;
  private client?: TelemetryClient;
  private db?: Database;
  private connection?: Connection;

  private constructor(private workspace: WorkspaceResolution, deps: { db?: Database; connection?: Connection; client?: TelemetryClient }) {
    this.db = deps.db;
    this.connection = deps.connection;
    this.client = deps.client;
  }

  static async create(
    workspace: WorkspaceResolution,
    options: { allowMissingTelemetry?: boolean; requireApi?: boolean } = {},
  ): Promise<TelemetryService> {
    const baseUrl = workspace.config?.telemetry?.endpoint ?? process.env.MCODA_TELEMETRY_API;
    const authToken = workspace.config?.telemetry?.authToken ?? process.env.MCODA_TELEMETRY_TOKEN;
    if (baseUrl) {
      return new TelemetryService(workspace, { client: new TelemetryClient({ baseUrl, authToken }) });
    }
    if (options.requireApi) {
      throw new Error(
        "Telemetry API is not configured (set MCODA_TELEMETRY_API/MCODA_TELEMETRY_TOKEN or telemetry.endpoint in workspace config).",
      );
    }

    const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
    try {
      await fs.access(dbPath);
    } catch {
      if (!options.allowMissingTelemetry) {
        throw new Error(`No workspace DB found at ${dbPath}. Run mcoda init or create-tasks first.`);
      }
    }
    const connection = await Connection.open(dbPath);
    const ok = await hasTables(connection.db, ["token_usage"]);
    if (!ok && !options.allowMissingTelemetry) {
      await connection.close();
      throw new Error("Workspace DB is missing telemetry tables (token_usage). Run create-tasks to initialize it.");
    }
    return new TelemetryService(workspace, { db: connection.db, connection });
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
    if (this.globalRepo) {
      await this.globalRepo.close();
    }
  }

  private get configPath(): string {
    return path.join(this.workspace.mcodaDir, "config.json");
  }

  private async readConfigFile(): Promise<Record<string, any>> {
    try {
      const raw = await fs.readFile(this.configPath, "utf8");
      return JSON.parse(raw) as Record<string, any>;
    } catch {
      return {};
    }
  }

  private async writeConfigFile(config: Record<string, any>): Promise<void> {
    await fs.mkdir(this.workspace.mcodaDir, { recursive: true });
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2), "utf8");
  }

  private async resolveProjectId(projectKey?: string): Promise<string | undefined> {
    if (!projectKey || !this.db) return undefined;
    const row = await this.db.get<{ id: string } | undefined>(`SELECT id FROM projects WHERE key = ?`, projectKey);
    return row?.id;
  }

  private async getGlobalRepo(): Promise<GlobalRepository> {
    if (!this.globalRepo) {
      this.globalRepo = await GlobalRepository.create();
    }
    return this.globalRepo;
  }

  private async resolveAgentId(agent?: string): Promise<string | undefined> {
    if (!agent) return undefined;
    try {
      const repo = await this.getGlobalRepo();
      const asId = await repo.getAgentById(agent);
      if (asId) return asId.id;
      const bySlug = await repo.getAgentBySlug(agent);
      if (bySlug) return bySlug.id;
    } catch {
      // ignore lookup failures; fall through to raw value
    }
    return agent;
  }

  private filterRows(
    rows: DbTokenUsageRow[],
    options: { command?: string },
  ): { row: DbTokenUsageRow; metadata: Record<string, unknown> }[] {
    const filtered: { row: DbTokenUsageRow; metadata: Record<string, unknown> }[] = [];
    for (const row of rows) {
      const metadata = parseMetadata(row.metadata_json);
      const commandName =
        (metadata.commandName as string | undefined) ??
        (metadata.command_name as string | undefined) ??
        (metadata.command as string | undefined);
      if (options.command && commandName && options.command !== commandName) {
        continue;
      }
      filtered.push({ row, metadata });
    }
    return filtered;
  }

  private mapConfig(apiConfig: ApiTelemetryConfig): TelemetryConfigState {
    return {
      ...apiConfig,
      localRecording: apiConfig.localRecording ?? true,
      remoteExport: apiConfig.remoteExport ?? true,
      optOut: apiConfig.optOut ?? false,
      strict: apiConfig.strict ?? false,
      configPath: this.configPath,
    };
  }

  async getSummary(options: TelemetrySummaryOptions = {}): Promise<TokenUsageSummaryRow[]> {
    const groupBy = normalizeGroupBy(options.groupBy);
    const since = parseTimeInput(options.since ?? "7d") ?? undefined;
    const until = parseTimeInput(options.until);
    const projectId = options.projectKey ? await this.resolveProjectId(options.projectKey) : undefined;
    if (options.projectKey && !projectId && !this.client) {
      throw new Error(`Unknown project key: ${options.projectKey}`);
    }
    const agentId = await this.resolveAgentId(options.agent);

    if (this.client) {
      return this.client.getSummary({
        workspaceId: this.workspace.workspaceId,
        projectId: projectId ?? options.projectKey,
        agentId: agentId ?? options.agent,
        commandName: options.command,
        jobId: options.jobId,
        from: since,
        to: until,
        groupBy,
      });
    }

    if (!this.db) {
      throw new Error("Telemetry DB not available and no telemetry client configured.");
    }
    const clauses = ["workspace_id = ?"];
    const params: any[] = [this.workspace.workspaceId];
    if (projectId) {
      clauses.push("project_id = ?");
      params.push(projectId);
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      params.push(agentId);
    }
    if (options.jobId) {
      clauses.push("job_id = ?");
      params.push(options.jobId);
    }
    if (since) {
      clauses.push("timestamp >= ?");
      params.push(since);
    }
    if (until) {
      clauses.push("timestamp <= ?");
      params.push(until);
    }
    const query = `SELECT * FROM token_usage ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`;
    const rows = await this.db.all<DbTokenUsageRow[]>(query, ...params);
    const filtered = this.filterRows(rows, { command: options.command });

    const summary = new Map<string, TokenUsageSummaryRow>();
    for (const { row, metadata } of filtered) {
      const commandName =
        (metadata.commandName as string | undefined) ??
        (metadata.command_name as string | undefined) ??
        (metadata.command as string | undefined) ??
        null;
      const action = (metadata.action as string | undefined) ?? (metadata.phase as string | undefined) ?? null;
      const keyParts = groupBy.map((dim) => {
        switch (dim) {
          case "project":
            return row.project_id ?? "";
          case "agent":
            return row.agent_id ?? "";
          case "model":
            return row.model_name ?? "";
          case "command":
            return commandName ?? "";
          case "day":
            return dayFromTimestamp(row.timestamp) ?? "";
          case "job":
            return row.job_id ?? "";
          case "action":
            return action ?? "";
          default:
            return "";
        }
      });
      const key = keyParts.join("|");
      let record = summary.get(key);
      if (!record) {
        record = {
          workspace_id: this.workspace.workspaceId,
          project_id: groupBy.includes("project") ? row.project_id ?? null : undefined,
          agent_id: groupBy.includes("agent") ? row.agent_id ?? null : undefined,
          model_name: groupBy.includes("model") ? row.model_name ?? null : undefined,
          command_name: groupBy.includes("command") ? commandName : undefined,
          action: groupBy.includes("action") ? action : undefined,
          job_id: groupBy.includes("job") ? row.job_id ?? null : undefined,
          day: groupBy.includes("day") ? dayFromTimestamp(row.timestamp) : undefined,
          calls: 0,
          tokens_prompt: 0,
          tokens_completion: 0,
          tokens_total: 0,
          cost_estimate: null,
        };
        summary.set(key, record);
      }
      record.calls += 1;
      record.tokens_prompt += row.tokens_prompt ?? 0;
      record.tokens_completion += row.tokens_completion ?? 0;
      record.tokens_total += row.tokens_total ?? 0;
      record.cost_estimate = addCost(record.cost_estimate, row.cost_estimate);
    }
    return Array.from(summary.values());
  }

  async getTokenUsage(options: TokenUsageQueryOptions = {}): Promise<TokenUsageRow[]> {
    const since = parseTimeInput(options.since);
    const until = parseTimeInput(options.until);
    const projectId = options.projectKey ? await this.resolveProjectId(options.projectKey) : undefined;
    if (options.projectKey && !projectId && !this.client) {
      throw new Error(`Unknown project key: ${options.projectKey}`);
    }
    const agentId = await this.resolveAgentId(options.agent);

    if (this.client) {
      const rows = await this.client.getTokenUsage({
        workspaceId: this.workspace.workspaceId,
        projectId: projectId ?? options.projectKey,
        agentId: agentId ?? options.agent,
        commandName: options.command,
        jobId: options.jobId,
        from: since,
        to: until,
        page: options.page,
        pageSize: options.pageSize,
        sort: "timestamp:asc",
      });
      return rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    }

    if (!this.db) {
      throw new Error("Telemetry DB not available and no telemetry client configured.");
    }

    const clauses = ["workspace_id = ?"];
    const params: any[] = [this.workspace.workspaceId];
    if (projectId) {
      clauses.push("project_id = ?");
      params.push(projectId);
    }
    if (agentId) {
      clauses.push("agent_id = ?");
      params.push(agentId);
    }
    if (options.jobId) {
      clauses.push("job_id = ?");
      params.push(options.jobId);
    }
    if (since) {
      clauses.push("timestamp >= ?");
      params.push(since);
    }
    if (until) {
      clauses.push("timestamp <= ?");
      params.push(until);
    }
    const query = `SELECT * FROM token_usage ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}`;
    const rows = await this.db.all<DbTokenUsageRow[]>(query, ...params);
    const filtered = this.filterRows(rows, { command: options.command });
    const mapped: TokenUsageRow[] = filtered
      .map(({ row, metadata }) => {
        const commandName =
          (metadata.commandName as string | undefined) ??
          (metadata.command_name as string | undefined) ??
          (metadata.command as string | undefined) ??
          null;
        const action = (metadata.action as string | undefined) ?? (metadata.phase as string | undefined) ?? null;
        const errorKind =
          (metadata.error_kind as string | undefined) ??
          (metadata.errorKind as string | undefined) ??
          (metadata.error as string | undefined) ??
          null;
        return {
          workspace_id: row.workspace_id,
          agent_id: row.agent_id,
          model_name: row.model_name,
          job_id: row.job_id,
          command_run_id: row.command_run_id,
          task_run_id: row.task_run_id,
          task_id: row.task_id,
          project_id: row.project_id,
          epic_id: row.epic_id,
          user_story_id: row.user_story_id,
          tokens_prompt: row.tokens_prompt,
          tokens_completion: row.tokens_completion,
          tokens_total: row.tokens_total,
          cost_estimate: row.cost_estimate,
          duration_seconds: row.duration_seconds,
          timestamp: row.timestamp,
          command_name: commandName,
          action,
          error_kind: errorKind,
          metadata,
        };
      })
      .sort((a, b) => {
        const aTs = Date.parse(a.timestamp);
        const bTs = Date.parse(b.timestamp);
        if (Number.isNaN(aTs) || Number.isNaN(bTs)) return 0;
        return aTs - bTs;
      });
    if (options.page && options.pageSize) {
      const start = (options.page - 1) * options.pageSize;
      return mapped.slice(start, start + options.pageSize);
    }
    return mapped;
  }

  async getConfig(): Promise<TelemetryConfigState> {
    if (this.client) {
      const config = await this.client.getConfig(this.workspace.workspaceId);
      return this.mapConfig(config);
    }
    const config = await this.readConfigFile();
    const telemetry = config.telemetry ?? {};
    const envOptOut = (process.env.MCODA_TELEMETRY ?? "").toLowerCase() === "off";
    const optOut = telemetry.optOut === true || telemetry.optedOut === true || false;
    const strict = telemetry.strict === true || false;
    const remoteExport = !optOut && !envOptOut;
    const localRecording = !strict;
    return {
      localRecording,
      remoteExport,
      optOut,
      strict,
      configPath: this.configPath,
    };
  }

  async optOut(strict = false): Promise<TelemetryConfigState> {
    if (this.client) {
      const config = await this.client.optOut(this.workspace.workspaceId, strict);
      return this.mapConfig(config);
    }
    const config = await this.readConfigFile();
    config.telemetry = {
      ...(config.telemetry ?? {}),
      optOut: true,
      strict: strict || (config.telemetry?.strict ?? false),
    };
    await this.writeConfigFile(config);
    return this.getConfig();
  }

  async optIn(): Promise<TelemetryConfigState> {
    if (this.client) {
      const config = await this.client.optIn(this.workspace.workspaceId);
      return this.mapConfig(config);
    }
    const config = await this.readConfigFile();
    config.telemetry = {
      ...(config.telemetry ?? {}),
      optOut: false,
      strict: false,
    };
    await this.writeConfigFile(config);
    return this.getConfig();
  }
}
