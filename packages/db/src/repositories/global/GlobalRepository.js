import { randomUUID } from "node:crypto";
import { Connection } from "../../sqlite/connection.js";
import { GlobalMigrations } from "../../migrations/global/GlobalMigrations.js";
const mapAgentRow = (row) => ({
    id: row.id,
    slug: row.slug,
    adapter: row.adapter,
    defaultModel: row.default_model ?? undefined,
    config: row.config_json ? JSON.parse(row.config_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});
export class GlobalRepository {
    constructor(db, connection) {
        this.db = db;
        this.connection = connection;
    }
    static async create() {
        const connection = await Connection.openGlobal();
        await GlobalMigrations.run(connection.db);
        return new GlobalRepository(connection.db, connection);
    }
    async close() {
        if (this.connection) {
            await this.connection.close();
        }
    }
    async listAgents() {
        const rows = await this.db.all("SELECT id, slug, adapter, default_model, config_json, created_at, updated_at FROM agents ORDER BY slug ASC");
        return rows.map(mapAgentRow);
    }
    async getAgentById(id) {
        const row = await this.db.get("SELECT id, slug, adapter, default_model, config_json, created_at, updated_at FROM agents WHERE id = ?", id);
        return row ? mapAgentRow(row) : undefined;
    }
    async getAgentBySlug(slug) {
        const row = await this.db.get("SELECT id, slug, adapter, default_model, config_json, created_at, updated_at FROM agents WHERE slug = ?", slug);
        return row ? mapAgentRow(row) : undefined;
    }
    async createAgent(input) {
        const now = new Date().toISOString();
        const id = randomUUID();
        await this.db.run(`INSERT INTO agents (id, slug, adapter, default_model, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id, input.slug, input.adapter, input.defaultModel ?? null, input.config ? JSON.stringify(input.config) : null, now, now);
        if (input.capabilities) {
            await this.setAgentCapabilities(id, input.capabilities);
        }
        if (input.prompts) {
            await this.setAgentPrompts(id, { ...input.prompts, agentId: id });
        }
        return (await this.getAgentById(id));
    }
    async updateAgent(id, patch) {
        const updates = [];
        const params = [];
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
        if (patch.prompts) {
            await this.setAgentPrompts(id, { ...patch.prompts, agentId: id });
        }
        return this.getAgentById(id);
    }
    async deleteAgent(id) {
        await this.db.run("DELETE FROM agents WHERE id = ?", id);
    }
    async setAgentCapabilities(agentId, capabilities) {
        await this.db.run("DELETE FROM agent_capabilities WHERE agent_id = ?", agentId);
        for (const capability of [...new Set(capabilities)]) {
            await this.db.run("INSERT INTO agent_capabilities (agent_id, capability) VALUES (?, ?)", agentId, capability);
        }
    }
    async getAgentCapabilities(agentId) {
        const rows = await this.db.all("SELECT capability FROM agent_capabilities WHERE agent_id = ? ORDER BY capability ASC", agentId);
        return rows.map((r) => r.capability);
    }
    async setAgentPrompts(agentId, prompts) {
        const now = new Date().toISOString();
        const commandPromptsJson = prompts.commandPrompts ? JSON.stringify(prompts.commandPrompts) : null;
        await this.db.run(`INSERT INTO agent_prompts (agent_id, job_prompt, character_prompt, command_prompts_json, job_path, character_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         job_prompt=excluded.job_prompt,
         character_prompt=excluded.character_prompt,
         command_prompts_json=excluded.command_prompts_json,
         job_path=excluded.job_path,
         character_path=excluded.character_path,
         updated_at=excluded.updated_at`, agentId, prompts.jobPrompt ?? null, prompts.characterPrompt ?? null, commandPromptsJson, prompts.jobPath ?? null, prompts.characterPath ?? null, now, now);
    }
    async getAgentPrompts(agentId) {
        const row = await this.db.get(`SELECT job_prompt, character_prompt, command_prompts_json, job_path, character_path
       FROM agent_prompts WHERE agent_id = ?`, agentId);
        if (!row)
            return undefined;
        return {
            agentId,
            jobPrompt: row.job_prompt ?? undefined,
            characterPrompt: row.character_prompt ?? undefined,
            commandPrompts: row.command_prompts_json ? JSON.parse(row.command_prompts_json) : undefined,
            jobPath: row.job_path ?? undefined,
            characterPath: row.character_path ?? undefined,
        };
    }
    async setAgentAuth(agentId, encryptedSecret, lastVerifiedAt) {
        const now = new Date().toISOString();
        await this.db.run(`INSERT INTO agent_auth (agent_id, encrypted_secret, last_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         encrypted_secret=excluded.encrypted_secret,
         last_verified_at=excluded.last_verified_at,
         updated_at=excluded.updated_at`, agentId, encryptedSecret, lastVerifiedAt ?? null, now, now);
    }
    async getAgentAuthMetadata(agentId) {
        const row = await this.db.get("SELECT agent_id, encrypted_secret, last_verified_at, updated_at FROM agent_auth WHERE agent_id = ?", agentId);
        return {
            agentId,
            configured: Boolean(row?.encrypted_secret),
            lastUpdatedAt: row?.updated_at,
            lastVerifiedAt: row?.last_verified_at ?? undefined,
        };
    }
    async getAgentAuthSecret(agentId) {
        const row = await this.db.get("SELECT agent_id, encrypted_secret, last_verified_at, updated_at FROM agent_auth WHERE agent_id = ?", agentId);
        if (!row)
            return undefined;
        return {
            agentId,
            configured: true,
            encryptedSecret: row.encrypted_secret,
            lastVerifiedAt: row.last_verified_at ?? undefined,
            lastUpdatedAt: row.updated_at,
        };
    }
    async setAgentHealth(health) {
        await this.db.run(`INSERT INTO agent_health (agent_id, status, last_checked_at, latency_ms, details_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         status=excluded.status,
         last_checked_at=excluded.last_checked_at,
         latency_ms=excluded.latency_ms,
         details_json=excluded.details_json`, health.agentId, health.status, health.lastCheckedAt, health.latencyMs ?? null, health.details ? JSON.stringify(health.details) : null);
    }
    async getAgentHealth(agentId) {
        const row = await this.db.get("SELECT agent_id, status, last_checked_at, latency_ms, details_json FROM agent_health WHERE agent_id = ?", agentId);
        if (!row)
            return undefined;
        return {
            agentId,
            status: row.status,
            lastCheckedAt: row.last_checked_at,
            latencyMs: row.latency_ms ?? undefined,
            details: row.details_json ? JSON.parse(row.details_json) : undefined,
        };
    }
    async listAgentHealthSummary() {
        const rows = await this.db.all("SELECT agent_id, status, last_checked_at, latency_ms, details_json FROM agent_health");
        return rows.map((row) => ({
            agentId: row.agent_id,
            status: row.status,
            lastCheckedAt: row.last_checked_at,
            latencyMs: row.latency_ms ?? undefined,
            details: row.details_json ? JSON.parse(row.details_json) : undefined,
        }));
    }
    async setWorkspaceDefault(workspaceId, commandName, agentId) {
        const now = new Date().toISOString();
        await this.db.run(`INSERT INTO workspace_defaults (workspace_id, command_name, agent_id, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, command_name) DO UPDATE SET
         agent_id=excluded.agent_id,
         updated_at=excluded.updated_at`, workspaceId, commandName, agentId, now);
    }
    async getWorkspaceDefaults(workspaceId) {
        const rows = await this.db.all("SELECT workspace_id, command_name, agent_id, updated_at FROM workspace_defaults WHERE workspace_id = ?", workspaceId);
        return rows.map((row) => ({
            workspaceId: row.workspace_id,
            commandName: row.command_name,
            agentId: row.agent_id,
            updatedAt: row.updated_at,
        }));
    }
    async findWorkspaceReferences(agentId) {
        const rows = await this.db.all("SELECT workspace_id, command_name, agent_id, updated_at FROM workspace_defaults WHERE agent_id = ?", agentId);
        return rows.map((row) => ({
            workspaceId: row.workspace_id,
            commandName: row.command_name,
            agentId: row.agent_id,
            updatedAt: row.updated_at,
        }));
    }
}
