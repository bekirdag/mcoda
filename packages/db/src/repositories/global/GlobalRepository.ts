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
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;
  costEstimate?: number | null;
  durationSeconds?: number | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
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
      "SELECT id, slug, adapter, default_model, config_json, created_at, updated_at FROM agents ORDER BY slug ASC",
    );
    return rows.map(mapAgentRow);
  }

  async getAgentById(id: string): Promise<Agent | undefined> {
    const row = await this.db.get(
      "SELECT id, slug, adapter, default_model, config_json, created_at, updated_at FROM agents WHERE id = ?",
      id,
    );
    return row ? mapAgentRow(row) : undefined;
  }

  async getAgentBySlug(slug: string): Promise<Agent | undefined> {
    const row = await this.db.get(
      "SELECT id, slug, adapter, default_model, config_json, created_at, updated_at FROM agents WHERE slug = ?",
      slug,
    );
    return row ? mapAgentRow(row) : undefined;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO agents (id, slug, adapter, default_model, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.slug,
      input.adapter,
      input.defaultModel ?? null,
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
        id, agent_id, command_run_id, model_name, tokens_prompt, tokens_completion, tokens_total,
        cost_estimate, duration_seconds, timestamp, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.agentId ?? null,
      entry.commandRunId ?? null,
      entry.modelName ?? null,
      entry.tokensPrompt ?? null,
      entry.tokensCompletion ?? null,
      entry.tokensTotal ?? null,
      entry.costEstimate ?? null,
      entry.durationSeconds ?? null,
      entry.timestamp,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    );
  }
}
