import { randomUUID } from "node:crypto";
import { Connection } from "../../sqlite/connection.js";
import { GlobalMigrations } from "../../migrations/global/GlobalMigrations.js";
const toBool = (value) => {
    if (value === null || value === undefined) {
        return undefined;
    }
    return Boolean(value);
};
const mapAgentRow = (row) => ({
    id: row.id,
    slug: row.slug,
    adapter: row.adapter,
    defaultModel: row.default_model ?? undefined,
    openaiCompatible: toBool(row.openai_compatible),
    contextWindow: row.context_window ?? undefined,
    maxOutputTokens: row.max_output_tokens ?? undefined,
    supportsTools: toBool(row.supports_tools),
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
        const rows = await this.db.all("SELECT id, slug, adapter, default_model, openai_compatible, context_window, max_output_tokens, supports_tools, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at FROM agents ORDER BY slug ASC");
        return rows.map(mapAgentRow);
    }
    async getAgentById(id) {
        const row = await this.db.get("SELECT id, slug, adapter, default_model, openai_compatible, context_window, max_output_tokens, supports_tools, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at FROM agents WHERE id = ?", id);
        return row ? mapAgentRow(row) : undefined;
    }
    async getAgentBySlug(slug) {
        const row = await this.db.get("SELECT id, slug, adapter, default_model, openai_compatible, context_window, max_output_tokens, supports_tools, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at FROM agents WHERE slug = ?", slug);
        return row ? mapAgentRow(row) : undefined;
    }
    async createAgent(input) {
        const now = new Date().toISOString();
        const id = randomUUID();
        await this.db.run(`INSERT INTO agents (id, slug, adapter, default_model, openai_compatible, context_window, max_output_tokens, supports_tools, rating, reasoning_rating, best_usage, cost_per_million, max_complexity, rating_samples, rating_last_score, rating_updated_at, complexity_samples, complexity_updated_at, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, input.slug, input.adapter, input.defaultModel ?? null, input.openaiCompatible === undefined ? null : input.openaiCompatible ? 1 : 0, input.contextWindow ?? null, input.maxOutputTokens ?? null, input.supportsTools === undefined ? null : input.supportsTools ? 1 : 0, input.rating ?? null, input.reasoningRating ?? null, input.bestUsage ?? null, input.costPerMillion ?? null, input.maxComplexity ?? null, input.ratingSamples ?? null, input.ratingLastScore ?? null, input.ratingUpdatedAt ?? null, input.complexitySamples ?? null, input.complexityUpdatedAt ?? null, input.config ? JSON.stringify(input.config) : null, now, now);
        if (input.capabilities) {
            await this.setAgentCapabilities(id, input.capabilities);
        }
        if (input.models) {
            await this.setAgentModels(id, input.models);
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
        if (patch.openaiCompatible !== undefined) {
            updates.push("openai_compatible = ?");
            params.push(patch.openaiCompatible ? 1 : 0);
        }
        if (patch.contextWindow !== undefined) {
            updates.push("context_window = ?");
            params.push(patch.contextWindow);
        }
        if (patch.maxOutputTokens !== undefined) {
            updates.push("max_output_tokens = ?");
            params.push(patch.maxOutputTokens);
        }
        if (patch.supportsTools !== undefined) {
            updates.push("supports_tools = ?");
            params.push(patch.supportsTools ? 1 : 0);
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
    async setAgentModels(agentId, models) {
        await this.db.run("DELETE FROM agent_models WHERE agent_id = ?", agentId);
        for (const model of models) {
            await this.db.run("INSERT INTO agent_models (agent_id, model_name, is_default, config_json) VALUES (?, ?, ?, ?)", agentId, model.modelName, model.isDefault ? 1 : 0, model.config ? JSON.stringify(model.config) : null);
        }
    }
    async getAgentModels(agentId) {
        const rows = await this.db.all("SELECT agent_id, model_name, is_default, config_json FROM agent_models WHERE agent_id = ? ORDER BY model_name ASC", agentId);
        return rows.map((row) => ({
            agentId: row.agent_id,
            modelName: row.model_name,
            isDefault: Boolean(row.is_default),
            config: row.config_json ? JSON.parse(row.config_json) : undefined,
        }));
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
    async setWorkspaceDefault(workspaceId, commandName, agentId, options = {}) {
        const now = new Date().toISOString();
        await this.db.run(`INSERT INTO workspace_defaults (workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, command_name) DO UPDATE SET
         agent_id=excluded.agent_id,
         qa_profile=excluded.qa_profile,
         docdex_scope=excluded.docdex_scope,
         updated_at=excluded.updated_at`, workspaceId, commandName, agentId, options.qaProfile ?? null, options.docdexScope ?? null, now);
    }
    async getWorkspaceDefaults(workspaceId) {
        const rows = await this.db.all("SELECT workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at FROM workspace_defaults WHERE workspace_id = ?", workspaceId);
        return rows.map((row) => ({
            workspaceId: row.workspace_id,
            commandName: row.command_name,
            agentId: row.agent_id,
            qaProfile: row.qa_profile ?? undefined,
            docdexScope: row.docdex_scope ?? undefined,
            updatedAt: row.updated_at,
        }));
    }
    async removeWorkspaceDefault(workspaceId, commandName) {
        await this.db.run("DELETE FROM workspace_defaults WHERE workspace_id = ? AND command_name = ?", workspaceId, commandName);
    }
    async findWorkspaceReferences(agentId) {
        const rows = await this.db.all("SELECT workspace_id, command_name, agent_id, qa_profile, docdex_scope, updated_at FROM workspace_defaults WHERE agent_id = ?", agentId);
        return rows.map((row) => ({
            workspaceId: row.workspace_id,
            commandName: row.command_name,
            agentId: row.agent_id,
            qaProfile: row.qa_profile ?? undefined,
            docdexScope: row.docdex_scope ?? undefined,
            updatedAt: row.updated_at,
        }));
    }
    async createCommandRun(record) {
        const id = randomUUID();
        await this.db.run(`INSERT INTO command_runs (id, command_name, started_at, status, exit_code, error_summary, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, id, record.commandName, record.startedAt, record.status, record.exitCode ?? null, record.errorSummary ?? null, record.payload ? JSON.stringify(record.payload) : null);
        return {
            id,
            ...record,
            completedAt: null,
        };
    }
    async completeCommandRun(id, update) {
        await this.db.run(`UPDATE command_runs
       SET status = ?, completed_at = ?, exit_code = ?, error_summary = ?, result_json = ?
       WHERE id = ?`, update.status, update.completedAt, update.exitCode ?? null, update.errorSummary ?? null, update.result ? JSON.stringify(update.result) : null, id);
    }
    async recordTokenUsage(entry) {
        const id = randomUUID();
        await this.db.run(`INSERT INTO token_usage (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, entry.agentId ?? null, entry.commandRunId ?? null, entry.modelName ?? null, entry.commandName ?? null, entry.action ?? null, entry.invocationKind ?? null, entry.provider ?? null, entry.currency ?? null, entry.tokensPrompt ?? null, entry.tokensCompletion ?? null, entry.tokensTotal ?? null, entry.tokensCached ?? null, entry.tokensCacheRead ?? null, entry.tokensCacheWrite ?? null, entry.costEstimate ?? null, entry.durationSeconds ?? null, entry.durationMs ?? null, entry.startedAt ?? null, entry.finishedAt ?? null, entry.timestamp, entry.metadata ? JSON.stringify(entry.metadata) : null);
    }
    async insertAgentRunRating(entry) {
        const id = randomUUID();
        await this.db.run(`INSERT INTO agent_run_ratings (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, entry.agentId, entry.jobId ?? null, entry.commandRunId ?? null, entry.taskId ?? null, entry.taskKey ?? null, entry.commandName ?? null, entry.discipline ?? null, entry.complexity ?? null, entry.qualityScore ?? null, entry.tokensTotal ?? null, entry.durationSeconds ?? null, entry.iterations ?? null, entry.totalCost ?? null, entry.runScore ?? null, entry.ratingVersion ?? null, entry.rawReview ? JSON.stringify(entry.rawReview) : null, entry.createdAt);
        return { ...entry, id };
    }
    async listAgentRunRatings(agentId, limit = 50) {
        const rows = await this.db.all(`SELECT id, agent_id, job_id, command_run_id, task_id, task_key, command_name, discipline, complexity, quality_score,
              tokens_total, duration_seconds, iterations, total_cost, run_score, rating_version, raw_review_json, created_at
       FROM agent_run_ratings
       WHERE agent_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT ?`, agentId, limit);
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
