import { randomUUID } from "node:crypto";
import { Database } from "sqlite";
import {
  Agent,
  AgentAuthMetadata,
  AgentAuthSecret,
  AgentHealth,
  AgentModel,
  AgentPromptManifest,
  CreateAgentInput,
  UpdateAgentInput,
  WorkspaceDefault,
} from "@mcoda/shared";
import { Connection } from "../../sqlite/connection.js";
import { GlobalMigrations } from "../../migrations/global/GlobalMigrations.js";

const mapAgentRow = (row: any): Agent => ({
  id: row.id,
  slug: row.slug,
  adapter: row.adapter,
  defaultModel: row.default_model ?? undefined,
  rating: row.rating ?? undefined,
  reasoningRating: row.reasoning_rating ?? undefined,
  bestUsage: row.best_usage ?? undefined,
  costPerMillion: row.cost_per_million ?? undefined,
  maxComplexity: row.max_complexity ?? undefined,
  ratingSamples: row.rating_samples ?? undefined,
  ratingLastScore: row.rating_last_score ?? undefined,
  ratingUpdatedAt: row.rating_updated_at ?? undefined,
  complexitySamples: row.complexity_samples ?? undefined,
  complexityUpdatedAt: row.complexity_updated_at ?? undefined,
  config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type GlobalCommandStatus = "running" | "succeeded" | "failed";

export interface GlobalCommandRunInsert {
  commandName: string;
  startedAt: string;
  status: GlobalCommandStatus;
  exitCode?: number | null;
  errorSummary?: string | null;
  payload?: Record<string, unknown>;
}

export interface GlobalCommandRun extends GlobalCommandRunInsert {
  id: string;
  completedAt?: string | null;
  result?: Record<string, unknown>;
}

export interface GlobalTokenUsageInsert {
  agentId?: string | null;
  commandRunId?: string | null;
  modelName?: string | null;
  commandName?: string | null;
  action?: string | null;
  invocationKind?: string | null;
  provider?: string | null;
  currency?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;
  tokensCached?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheWrite?: number | null;
  costEstimate?: number | null;
  durationSeconds?: number | null;
  durationMs?: number | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunRatingInsert {
  agentId: string;
  jobId?: string | null;
  commandRunId?: string | null;
  taskId?: string | null;
  taskKey?: string | null;
  commandName?: string | null;
  discipline?: string | null;
  complexity?: number | null;
  qualityScore?: number | null;
  tokensTotal?: number | null;
  durationSeconds?: number | null;
  iterations?: number | null;
  totalCost?: number | null;
  runScore?: number | null;
  ratingVersion?: string | null;
  rawReview?: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentRunRatingRow extends AgentRunRatingInsert {
  id: string;
}

export class GlobalRepository {
  constructor(private db: Database, private connection?: Connection) {}

  static async create(): Promise<GlobalRepository> {
    const connection = await Connection.openGlobal();
    await GlobalMigrations.run(connection.db);
    return new GlobalRepository(connection.db, connection);
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
  }

  async listAgents(): Promise<Agent[]> {
    const rows = await this.db.all(
      "SELECT id, slug, adapter, default_model, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at FROM agents ORDER BY slug ASC",
    );
    return rows.map(mapAgentRow);
  }

  async getAgentById(id: string): Promise<Agent | undefined> {
    const row = await this.db.get(
      "SELECT id, slug, adapter, default_model, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at FROM agents WHERE id = ?",
      id,
    );
    return row ? mapAgentRow(row) : undefined;
  }

  async getAgentBySlug(slug: string): Promise<Agent | undefined> {
    const row = await this.db.get(
      "SELECT id, slug, adapter, default_model, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at FROM agents WHERE slug = ?",
      slug,
    );
    return row ? mapAgentRow(row) : undefined;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO agents (id, slug, adapter, default_model, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.slug,
      input.adapter,
      input.defaultModel ?? null,
      input.rating ?? null,
      input.reasoningRating ?? null,
      input.bestUsage ?? null,
      input.costPerMillion ?? null,
      input.maxComplexity ?? null,
      input.ratingSamples ?? null,
      input.ratingLastScore ?? null,
      input.ratingUpdatedAt ?? null,
      input.complexitySamples ?? null,
      input.complexityUpdatedAt ?? null,
      input.config ? JSON.stringify(input.config) : null,
      now,
      now,
    );

    if (input.capabilities) {
      await this.setAgentCapabilities(id, input.capabilities);
    }
    if (input.models) {
      await this.setAgentModels(id, input.models);
    }
    if (input.prompts) {
      await this.setAgentPrompts(id, { ...input.prompts, agentId: id });
    }
    return (await this.getAgentById(id)) as Agent;
  }

  async updateAgent(id: string, patch: UpdateAgentInput): Promise<Agent | undefined> {
    const updates: string[] = [];
    const params: any[] = [];
    if (patch.adapter !== undefined) {
      updates.push("adapter = ?");
      params.push(patch.adapter);
    }
    if (patch.defaultModel !== undefined) {
      updates.push("default_model = ?");
      params.push(patch.defaultModel);
    }
    if (patch.rating !== undefined) {
      updates.push("rating = ?");
      params.push(patch.rating);
    }
    if (patch.reasoningRating !== undefined) {
      updates.push("reasoning_rating = ?");
      params.push(patch.reasoningRating);
    }
    if (patch.bestUsage !== undefined) {
      updates.push("best_usage = ?");
      params.push(patch.bestUsage);
    }
    if (patch.costPerMillion !== undefined) {
      updates.push("cost_per_million = ?");
      params.push(patch.costPerMillion);
    }
    if (patch.maxComplexity !== undefined) {
      updates.push("max_complexity = ?");
      params.push(patch.maxComplexity);
    }
    if (patch.ratingSamples !== undefined) {
      updates.push("rating_samples = ?");
      params.push(patch.ratingSamples);
    }
    if (patch.ratingLastScore !== undefined) {
      updates.push("rating_last_score = ?");
      params.push(patch.ratingLastScore);
    }
    if (patch.ratingUpdatedAt !== undefined) {
      updates.push("rating_updated_at = ?");
      params.push(patch.ratingUpdatedAt);
    }
    if (patch.complexitySamples !== undefined) {
      updates.push("complexity_samples = ?");
      params.push(patch.complexitySamples);
    }
    if (patch.complexityUpdatedAt !== undefined) {
      updates.push("complexity_updated_at = ?");
      params.push(patch.complexityUpdatedAt);
    }
    if (patch.config !== undefined) {
      updates.push("config_json = ?");
      params.push(patch.config ? JSON.stringify(patch.config) : null);
    }
    if (updates.length > 0) {
      updates.push("updated_at = ?");
      params.push(new Date().toISOString());
      params.push(id);
      await this.db.run(`UPDATE agents SET ${updates.join(", ")} WHERE id = ?`, ...params);
    }
    if (patch.capabilities) {
      await this.setAgentCapabilities(id, patch.capabilities);
    }
    if (patch.models) {
      await this.setAgentModels(id, patch.models);
    }
    if (patch.prompts) {
      await this.setAgentPrompts(id, { ...patch.prompts, agentId: id });
    }
    return this.getAgentById(id);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.db.run("DELETE FROM agents WHERE id = ?", id);
  }

  async setAgentCapabilities(agentId: string, capabilities: string[]): Promise<void> {
    await this.db.run("DELETE FROM agent_capabilities WHERE agent_id = ?", agentId);
    for (const capability of [...new Set(capabilities)]) {
      await this.db.run(
        "INSERT INTO agent_capabilities (agent_id, capability) VALUES (?, ?)",
        agentId,
        capability,
      );
    }
  }

  async getAgentCapabilities(agentId: string): Promise<string[]> {
    const rows = await this.db.all(
      "SELECT capability FROM agent_capabilities WHERE agent_id = ? ORDER BY capability ASC",
      agentId,
    );
    return rows.map((r: any) => r.capability as string);
  }

  async setAgentModels(agentId: string, models: AgentModel[]): Promise<void> {
    await this.db.run("DELETE FROM agent_models WHERE agent_id = ?", agentId);
    for (const model of models) {
      await this.db.run(
        "INSERT INTO agent_models (agent_id, model_name, is_default, config_json) VALUES (?, ?, ?, ?)",
        agentId,
        model.modelName,
        model.isDefault ? 1 : 0,
        model.config ? JSON.stringify(model.config) : null,
      );
    }
  }

  async getAgentModels(agentId: string): Promise<AgentModel[]> {
    const rows = await this.db.all(
      "SELECT agent_id, model_name, is_default, config_json FROM agent_models WHERE agent_id = ? ORDER BY model_name ASC",
      agentId,
    );
    return rows.map(
      (row: any): AgentModel => ({
        agentId: row.agent_id,
        modelName: row.model_name,
        isDefault: Boolean(row.is_default),
        config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : undefined,
      }),
    );
  }

  async setAgentPrompts(agentId: string, prompts: AgentPromptManifest): Promise<void> {
    const now = new Date().toISOString();
    const commandPromptsJson = prompts.commandPrompts ? JSON.stringify(prompts.commandPrompts) : null;
    await this.db.run(
      `INSERT INTO agent_prompts (agent_id, job_prompt, character_prompt, command_prompts_json, job_path, character_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         job_prompt=excluded.job_prompt,
         character_prompt=excluded.character_prompt,
         command_prompts_json=excluded.command_prompts_json,
         job_path=excluded.job_path,
         character_path=excluded.character_path,
         updated_at=excluded.updated_at`,
      agentId,
      prompts.jobPrompt ?? null,
      prompts.characterPrompt ?? null,
      commandPromptsJson,
      prompts.jobPath ?? null,
      prompts.characterPath ?? null,
      now,
      now,
    );
  }

  async getAgentPrompts(agentId: string): Promise<AgentPromptManifest | undefined> {
    const row = await this.db.get(
      `SELECT job_prompt, character_prompt, command_prompts_json, job_path, character_path
       FROM agent_prompts WHERE agent_id = ?`,
      agentId,
    );
    if (!row) return undefined;
    return {
      agentId,
      jobPrompt: row.job_prompt ?? undefined,
      characterPrompt: row.character_prompt ?? undefined,
      commandPrompts: row.command_prompts_json ? JSON.parse(row.command_prompts_json) : undefined,
      jobPath: row.job_path ?? undefined,
      characterPath: row.character_path ?? undefined,
    };
  }

  async setAgentAuth(agentId: string, encryptedSecret: string, lastVerifiedAt?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO agent_auth (agent_id, encrypted_secret, last_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         encrypted_secret=excluded.encrypted_secret,
         last_verified_at=excluded.last_verified_at,
         updated_at=excluded.updated_at`,
      agentId,
      encryptedSecret,
      lastVerifiedAt ?? null,
      now,
      now,
    );
  }

  async getAgentAuthMetadata(agentId: string): Promise<AgentAuthMetadata> {
    const row = await this.db.get(
      "SELECT agent_id, encrypted_secret, last_verified_at, updated_at FROM agent_auth WHERE agent_id = ?",
      agentId,
    );
    return {
      agentId,
      configured: Boolean(row?.encrypted_secret),
      lastUpdatedAt: row?.updated_at,
      lastVerifiedAt: row?.last_verified_at ?? undefined,
    };
  }

  async getAgentAuthSecret(agentId: string): Promise<AgentAuthSecret | undefined> {
    const row = await this.db.get(
      "SELECT agent_id, encrypted_secret, last_verified_at, updated_at FROM agent_auth WHERE agent_id = ?",
      agentId,
    );
    if (!row) return undefined;
    return {
      agentId,
      configured: true,
      encryptedSecret: row.encrypted_secret,
      lastVerifiedAt: row.last_verified_at ?? undefined,
      lastUpdatedAt: row.updated_at,
    };
  }

  async setAgentHealth(health: AgentHealth): Promise<void> {
    await this.db.run(
      `INSERT INTO agent_health (agent_id, status, last_checked_at, latency_ms, details_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         status=excluded.status,
         last_checked_at=excluded.last_checked_at,
         latency_ms=excluded.latency_ms,
         details_json=excluded.details_json`,
      health.agentId,
      health.status,
      health.lastCheckedAt,
      health.latencyMs ?? null,
      health.details ? JSON.stringify(health.details) : null,
    );
  }

  async getAgentHealth(agentId: string): Promise<AgentHealth | undefined> {
    const row = await this.db.get(
      "SELECT agent_id, status, last_checked_at, latency_ms, details_json FROM agent_health WHERE agent_id = ?",
      agentId,
    );
    if (!row) return undefined;
    return {
      agentId,
      status: row.status,
      lastCheckedAt: row.last_checked_at,
      latencyMs: row.latency_ms ?? undefined,
      details: row.details_json ? JSON.parse(row.details_json) : undefined,
    };
  }

  async listAgentHealthSummary(): Promise<AgentHealth[]> {
    const rows = await this.db.all(
      "SELECT agent_id, status, last_checked_at, latency_ms, details_json FROM agent_health",
    );
    return rows.map(
      (row: any): AgentHealth => ({
        agentId: row.agent_id,
        status: row.status,
        lastCheckedAt: row.last_checked_at,
        latencyMs: row.latency_ms ?? undefined,
        details: row.details_json ? JSON.parse(row.details_json) : undefined,
      }),
    );
  }

  async setWorkspaceDefault(
    workspaceId: string,
    commandName: string,
    agentId: string,
    options: { qaProfile?: string; docdexScope?: string } = {},
  ): Promise<void> {
    const now = new Date().toISOString();
    await this.db.run(
      `INSERT INTO workspace_defaults (workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, command_name) DO UPDATE SET
         agent_id=excluded.agent_id,
         qa_profile=excluded.qa_profile,
         docdex_scope=excluded.docdex_scope,
         updated_at=excluded.updated_at`,
      workspaceId,
      commandName,
      agentId,
      options.qaProfile ?? null,
      options.docdexScope ?? null,
      now,
    );
  }

  async getWorkspaceDefaults(workspaceId: string): Promise<WorkspaceDefault[]> {
    const rows = await this.db.all(
      "SELECT workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at FROM workspace_defaults WHERE workspace_id = ?",
      workspaceId,
    );
    return rows.map(
      (row: any): WorkspaceDefault => ({
        workspaceId: row.workspace_id,
        commandName: row.command_name,
        agentId: row.agent_id,
        qaProfile: row.qa_profile ?? undefined,
        docdexScope: row.docdex_scope ?? undefined,
        updatedAt: row.updated_at,
      }),
    );
  }

  async removeWorkspaceDefault(workspaceId: string, commandName: string): Promise<void> {
    await this.db.run(
      "DELETE FROM workspace_defaults WHERE workspace_id = ? AND command_name = ?",
      workspaceId,
      commandName,
    );
  }

  async findWorkspaceReferences(agentId: string): Promise<WorkspaceDefault[]> {
    const rows = await this.db.all(
      "SELECT workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at FROM workspace_defaults WHERE agent_id = ?",
      agentId,
    );
    return rows.map(
      (row: any): WorkspaceDefault => ({
        workspaceId: row.workspace_id,
        commandName: row.command_name,
        agentId: row.agent_id,
        qaProfile: row.qa_profile ?? undefined,
        docdexScope: row.docdex_scope ?? undefined,
        updatedAt: row.updated_at,
      }),
    );
  }

  async createCommandRun(record: GlobalCommandRunInsert): Promise<GlobalCommandRun> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO command_runs (id, command_name, started_at, status, exit_code, error_summary, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.commandName,
      record.startedAt,
      record.status,
      record.exitCode ?? null,
      record.errorSummary ?? null,
      record.payload ? JSON.stringify(record.payload) : null,
    );
    return {
      id,
      ...record,
      completedAt: null,
    };
  }

  async completeCommandRun(
    id: string,
    update: {
      status: GlobalCommandStatus;
      completedAt: string;
      exitCode?: number | null;
      errorSummary?: string | null;
      result?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.db.run(
      `UPDATE command_runs
       SET status = ?, completed_at = ?, exit_code = ?, error_summary = ?, result_json = ?
       WHERE id = ?`,
      update.status,
      update.completedAt,
      update.exitCode ?? null,
      update.errorSummary ?? null,
      update.result ? JSON.stringify(update.result) : null,
      id,
    );
  }

  async recordTokenUsage(entry: GlobalTokenUsageInsert): Promise<void> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO token_usage (
        id,
        agent_id,
        command_run_id,
        model_name,
        command_name,
        action,
        invocation_kind,
        provider,
        currency,
        tokens_prompt,
        tokens_completion,
        tokens_total,
        tokens_cached,
        tokens_cache_read,
        tokens_cache_write,
        cost_estimate,
        duration_seconds,
        duration_ms,
        started_at,
        finished_at,
        timestamp,
        metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.agentId ?? null,
      entry.commandRunId ?? null,
      entry.modelName ?? null,
      entry.commandName ?? null,
      entry.action ?? null,
      entry.invocationKind ?? null,
      entry.provider ?? null,
      entry.currency ?? null,
      entry.tokensPrompt ?? null,
      entry.tokensCompletion ?? null,
      entry.tokensTotal ?? null,
      entry.tokensCached ?? null,
      entry.tokensCacheRead ?? null,
      entry.tokensCacheWrite ?? null,
      entry.costEstimate ?? null,
      entry.durationSeconds ?? null,
      entry.durationMs ?? null,
      entry.startedAt ?? null,
      entry.finishedAt ?? null,
      entry.timestamp,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }

  async insertAgentRunRating(entry: AgentRunRatingInsert): Promise<AgentRunRatingRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO agent_run_ratings (
        id,
        agent_id,
        job_id,
        command_run_id,
        task_id,
        task_key,
        command_name,
        discipline,
        complexity,
        quality_score,
        tokens_total,
        duration_seconds,
        iterations,
        total_cost,
        run_score,
        rating_version,
        raw_review_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.agentId,
      entry.jobId ?? null,
      entry.commandRunId ?? null,
      entry.taskId ?? null,
      entry.taskKey ?? null,
      entry.commandName ?? null,
      entry.discipline ?? null,
      entry.complexity ?? null,
      entry.qualityScore ?? null,
      entry.tokensTotal ?? null,
      entry.durationSeconds ?? null,
      entry.iterations ?? null,
      entry.totalCost ?? null,
      entry.runScore ?? null,
      entry.ratingVersion ?? null,
      entry.rawReview ? JSON.stringify(entry.rawReview) : null,
      entry.createdAt,
    );
    return { ...entry, id };
  }

  async listAgentRunRatings(agentId: string, limit = 50): Promise<AgentRunRatingRow[]> {
    const rows = await this.db.all<any[]>(
      `SELECT id, agent_id, job_id, command_run_id, task_id, task_key, command_name, discipline, complexity, quality_score,
              tokens_total, duration_seconds, iterations, total_cost, run_score, rating_version, raw_review_json, created_at
       FROM agent_run_ratings
       WHERE agent_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT ?`,
      agentId,
      limit,
    );
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      jobId: row.job_id ?? null,
      commandRunId: row.command_run_id ?? null,
      taskId: row.task_id ?? null,
      taskKey: row.task_key ?? null,
      commandName: row.command_name ?? null,
      discipline: row.discipline ?? null,
      complexity: row.complexity ?? null,
      qualityScore: row.quality_score ?? null,
      tokensTotal: row.tokens_total ?? null,
      durationSeconds: row.duration_seconds ?? null,
      iterations: row.iterations ?? null,
      totalCost: row.total_cost ?? null,
      runScore: row.run_score ?? null,
      ratingVersion: row.rating_version ?? null,
      rawReview: row.raw_review_json ? JSON.parse(row.raw_review_json) : null,
      createdAt: row.created_at,
    }));
  }
}
