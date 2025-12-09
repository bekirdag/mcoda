import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "./sqlite.js";
import { getGlobalLayout, runGlobalMigrations, runWorkspaceMigrations } from "./migration.js";
import { resolveWorkspaceContext } from "./workspace.js";
const KEY_FILENAME = "key";
const AES_ALGO = "aes-256-gcm";
const GCM_TAG_LENGTH = 16;
const ensureDir = async (dirPath) => {
    await mkdir(dirPath, { recursive: true });
};
const loadOrCreateKey = async (rootDir) => {
    const keyPath = path.join(rootDir, KEY_FILENAME);
    await ensureDir(rootDir);
    try {
        const raw = await readFile(keyPath, "utf8");
        const trimmed = raw.trim();
        if (!trimmed)
            throw new Error("empty key file");
        return Buffer.from(trimmed, "hex");
    }
    catch {
        const key = crypto.randomBytes(32);
        await writeFile(keyPath, key.toString("hex"), { mode: 0o600, encoding: "utf8" });
        return key;
    }
};
const encrypt = (plaintext, key) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
};
const decrypt = (payload, key) => {
    const buffer = Buffer.from(payload, "base64");
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 12 + GCM_TAG_LENGTH);
    const data = buffer.subarray(12 + GCM_TAG_LENGTH);
    const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
    return plaintext.toString("utf8");
};
const parseLegacyPrompts = (value) => {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
    }
    catch {
        return [];
    }
};
export class GlobalStore {
    constructor(db, key) {
        this.db = db;
        this.key = key;
    }
    agentCapabilitiesMap() {
        const rows = this.db
            .prepare(`SELECT agent_name as agent, capability FROM agent_capabilities ORDER BY agent_name, capability`)
            .all();
        const map = new Map();
        for (const row of rows) {
            const existing = map.get(row.agent) ?? [];
            existing.push(row.capability);
            map.set(row.agent, existing);
        }
        return map;
    }
    agentPromptsMap() {
        const rows = this.db
            .prepare(`SELECT agent_name as agent, kind, command, path, created_at as createdAt, updated_at as updatedAt
         FROM agent_prompts
         ORDER BY agent_name, kind, command`)
            .all();
        const map = new Map();
        for (const row of rows) {
            const existing = map.get(row.agent) ?? [];
            existing.push({ ...row, command: row.command ?? undefined });
            map.set(row.agent, existing);
        }
        return map;
    }
    agentHealthMap() {
        const rows = this.db
            .prepare(`SELECT agent_name as agent, status, latency_ms as latencyMs, details_json as detailsJson, checked_at as checkedAt, created_at as createdAt
         FROM agent_health`)
            .all();
        const map = new Map();
        for (const row of rows) {
            map.set(row.agent, {
                agent: row.agent,
                status: row.status,
                latencyMs: row.latencyMs ?? undefined,
                detailsJson: row.detailsJson ?? undefined,
                checkedAt: row.checkedAt,
            });
        }
        return map;
    }
    resolvePrompts(agentName, promptMap, legacyPrompts) {
        const prompts = (promptMap.get(agentName) ?? []).map((p) => ({
            ...p,
            command: p.command ?? undefined,
        }));
        if (prompts.length)
            return prompts;
        const legacy = parseLegacyPrompts(legacyPrompts);
        if (!legacy.length)
            return [];
        const now = new Date().toISOString();
        return legacy.map((pathHint) => ({
            agent: agentName,
            kind: "command",
            command: undefined,
            path: pathHint,
            createdAt: now,
            updatedAt: now,
        }));
    }
    listAgents() {
        const capabilities = this.agentCapabilitiesMap();
        const prompts = this.agentPromptsMap();
        const health = this.agentHealthMap();
        const rows = this.db
            .prepare(`SELECT a.name, a.provider, a.model, a.is_default as isDefault, a.prompts as legacyPrompts, a.created_at as createdAt, a.updated_at as updatedAt, s.encrypted_payload as encrypted
         FROM agents a
         LEFT JOIN agent_secrets s ON s.agent_name = a.name
         ORDER BY a.name`)
            .all();
        return rows.map((row) => ({
            name: row.name,
            provider: row.provider,
            model: row.model,
            default: Boolean(row.isDefault),
            capabilities: capabilities.get(row.name) ?? [],
            prompts: this.resolvePrompts(row.name, prompts, row.legacyPrompts),
            health: health.get(row.name),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            hasAuth: Boolean(row.encrypted),
        }));
    }
    getAgent(name, opts = {}) {
        const capabilities = this.agentCapabilitiesMap();
        const prompts = this.agentPromptsMap();
        const health = this.agentHealthMap();
        const row = this.db
            .prepare(`SELECT a.name, a.provider, a.model, a.is_default as isDefault, a.prompts as legacyPrompts, a.created_at as createdAt, a.updated_at as updatedAt, s.encrypted_payload as encrypted
         FROM agents a
         LEFT JOIN agent_secrets s ON s.agent_name = a.name
         WHERE a.name = ?`)
            .get(name);
        if (!row)
            return undefined;
        const base = {
            name: row.name,
            provider: row.provider,
            model: row.model,
            default: Boolean(row.isDefault),
            capabilities: capabilities.get(row.name) ?? [],
            prompts: this.resolvePrompts(row.name, prompts, row.legacyPrompts),
            health: health.get(row.name),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            hasAuth: Boolean(row.encrypted),
        };
        if (opts.includeSecret && row.encrypted) {
            base.authToken = decrypt(row.encrypted, this.key);
        }
        return base;
    }
    addAgent(agent) {
        const now = new Date().toISOString();
        const makeDefault = agent.makeDefault || this.countAgents() === 0;
        if (makeDefault) {
            this.db.prepare(`UPDATE agents SET is_default = 0`).run();
        }
        this.db
            .prepare(`INSERT INTO agents (name, provider, model, is_default, prompts, created_at, updated_at)
         VALUES (@name, @provider, @model, @isDefault, @prompts, @createdAt, @updatedAt)`)
            .run({
            name: agent.name,
            provider: agent.provider,
            model: agent.model,
            isDefault: makeDefault ? 1 : 0,
            prompts: null,
            createdAt: now,
            updatedAt: now,
        });
        if (agent.authToken) {
            const encrypted = encrypt(agent.authToken, this.key);
            this.db
                .prepare(`INSERT INTO agent_secrets (agent_name, encrypted_payload)
           VALUES (?, ?)
           ON CONFLICT(agent_name) DO UPDATE SET encrypted_payload=excluded.encrypted_payload`)
                .run(agent.name, encrypted);
        }
        this.upsertCapabilities(agent.name, agent.capabilities ?? []);
        this.upsertPrompts(agent.name, agent.prompts);
        return this.getAgent(agent.name, { includeSecret: Boolean(agent.authToken) });
    }
    updateAgent(agent) {
        const existing = this.getAgent(agent.name, { includeSecret: true });
        if (!existing) {
            throw new Error(`Agent ${agent.name} not found`);
        }
        const now = new Date().toISOString();
        const isDefault = agent.makeDefault ? 1 : existing.default ? 1 : 0;
        if (agent.makeDefault) {
            this.db.prepare(`UPDATE agents SET is_default = 0 WHERE name != ?`).run(agent.name);
        }
        this.db
            .prepare(`UPDATE agents
         SET provider = @provider,
             model = @model,
             is_default = @isDefault,
             updated_at = @updatedAt
         WHERE name = @name`)
            .run({
            name: agent.name,
            provider: agent.provider ?? existing.provider,
            model: agent.model ?? existing.model,
            isDefault,
            updatedAt: now,
        });
        this.upsertCapabilities(agent.name, agent.capabilities);
        this.upsertPrompts(agent.name, agent.prompts);
        if (agent.authToken !== undefined) {
            if (agent.authToken === null || agent.authToken === "") {
                this.db.prepare(`DELETE FROM agent_secrets WHERE agent_name = ?`).run(agent.name);
            }
            else {
                const encrypted = encrypt(agent.authToken, this.key);
                this.db
                    .prepare(`INSERT INTO agent_secrets (agent_name, encrypted_payload)
             VALUES (?, ?)
             ON CONFLICT(agent_name) DO UPDATE SET encrypted_payload=excluded.encrypted_payload`)
                    .run(agent.name, encrypted);
            }
        }
        return this.getAgent(agent.name, { includeSecret: Boolean(agent.authToken) });
    }
    deleteAgent(name) {
        const result = this.db.prepare(`DELETE FROM agents WHERE name = ?`).run(name);
        if (result.changes === 0) {
            throw new Error(`Agent ${name} not found`);
        }
    }
    setDefault(name) {
        const exists = this.getAgent(name);
        if (!exists)
            throw new Error(`Agent ${name} not found`);
        this.db.prepare(`UPDATE agents SET is_default = CASE WHEN name = ? THEN 1 ELSE 0 END`).run(name);
        return this.getAgent(name);
    }
    upsertCapabilities(agentName, capabilities) {
        if (capabilities === undefined)
            return;
        const normalized = Array.from(new Set(capabilities.filter((c) => Boolean(c)))).map((c) => c.trim());
        this.db.prepare(`DELETE FROM agent_capabilities WHERE agent_name = ?`).run(agentName);
        if (!normalized.length)
            return;
        const stmt = this.db.prepare(`INSERT INTO agent_capabilities (agent_name, capability) VALUES (?, ?)`);
        for (const capability of normalized) {
            if (!capability)
                continue;
            stmt.run(agentName, capability);
        }
    }
    upsertPrompts(agentName, prompts) {
        if (!prompts)
            return;
        const existing = this.agentPromptsMap().get(agentName) ?? [];
        let jobPath = existing.find((p) => p.kind === "job")?.path ?? null;
        let characterPath = existing.find((p) => p.kind === "character")?.path ?? null;
        const commandMap = new Map();
        for (const prompt of existing) {
            if (prompt.kind === "command" && prompt.command) {
                commandMap.set(prompt.command, prompt.path);
            }
        }
        if (prompts.job !== undefined) {
            jobPath = prompts.job ? prompts.job : null;
        }
        if (prompts.character !== undefined) {
            characterPath = prompts.character ? prompts.character : null;
        }
        if (prompts.commands !== undefined) {
            commandMap.clear();
            for (const [command, pathHint] of Object.entries(prompts.commands)) {
                if (!command || !pathHint)
                    continue;
                commandMap.set(command, pathHint);
            }
        }
        this.db.prepare(`DELETE FROM agent_prompts WHERE agent_name = ?`).run(agentName);
        const insert = this.db.prepare(`INSERT INTO agent_prompts (agent_name, kind, command, path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`);
        const now = new Date().toISOString();
        if (jobPath)
            insert.run(agentName, "job", null, jobPath, now, now);
        if (characterPath)
            insert.run(agentName, "character", null, characterPath, now, now);
        for (const [command, pathHint] of commandMap.entries()) {
            insert.run(agentName, "command", command, pathHint, now, now);
        }
    }
    recordAgentHealth(health) {
        const checkedAt = health.checkedAt ?? new Date().toISOString();
        this.db
            .prepare(`INSERT INTO agent_health (agent_name, status, latency_ms, details_json, checked_at, created_at)
         VALUES (@agent, @status, @latencyMs, @detailsJson, @checkedAt, @createdAt)
         ON CONFLICT(agent_name) DO UPDATE SET
           status=excluded.status,
           latency_ms=excluded.latency_ms,
           details_json=excluded.details_json,
           checked_at=excluded.checked_at`)
            .run({
            agent: health.agent,
            status: health.status,
            latencyMs: health.latencyMs ?? null,
            detailsJson: health.detailsJson ?? null,
            checkedAt,
            createdAt: checkedAt,
        });
    }
    getWorkspaceDefault(workspace) {
        const row = this.db
            .prepare(`SELECT default_agent as agent FROM workspace_defaults WHERE workspace = ?`)
            .get(workspace);
        return row?.agent ?? null;
    }
    setWorkspaceDefault(workspace, agent, updatedAt = new Date().toISOString()) {
        this.db
            .prepare(`INSERT INTO workspace_defaults (workspace, default_agent, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(workspace) DO UPDATE SET default_agent=excluded.default_agent, updated_at=excluded.updated_at`)
            .run(workspace, agent, updatedAt);
    }
    listRoutingRules(workspace) {
        if (workspace) {
            return this.db
                .prepare(`SELECT workspace, command, agent, notes, updated_at as updatedAt
           FROM routing_rules
           WHERE workspace = ?
           ORDER BY command`)
                .all(workspace);
        }
        return this.db
            .prepare(`SELECT workspace, command, agent, notes, updated_at as updatedAt FROM routing_rules ORDER BY workspace, command`)
            .all();
    }
    upsertRoutingRule(rule) {
        const updatedAt = rule.updatedAt ?? new Date().toISOString();
        this.db
            .prepare(`INSERT INTO routing_rules (workspace, command, agent, notes, updated_at)
         VALUES (@workspace, @command, @agent, @notes, @updatedAt)
         ON CONFLICT(workspace, command) DO UPDATE SET
           agent=excluded.agent,
           notes=excluded.notes,
           updated_at=excluded.updated_at`)
            .run({
            workspace: rule.workspace,
            command: rule.command,
            agent: rule.agent,
            notes: rule.notes ?? null,
            updatedAt,
        });
    }
    deleteRoutingRule(workspace, command) {
        this.db.prepare(`DELETE FROM routing_rules WHERE workspace = ? AND command = ?`).run(workspace, command);
    }
    countAgents() {
        const row = this.db.prepare(`SELECT COUNT(*) as count FROM agents`).get();
        return row.count || 0;
    }
}
export class WorkspaceStore {
    constructor(db, workspaceRoot, workspaceId) {
        this.db = db;
        this.workspaceRoot = workspaceRoot;
        this.workspaceId = workspaceId ?? workspaceRoot;
    }
    normalizeJobState(value) {
        const normalized = (value ?? "").toLowerCase();
        if (normalized === "succeeded")
            return "completed";
        if (["queued", "running", "checkpointing", "paused", "completed", "failed", "cancelled"].includes(normalized)) {
            return normalized;
        }
        return "queued";
    }
    mapJobRow(row) {
        return {
            id: row.id,
            type: row.type ?? undefined,
            commandName: row.commandName ?? row.command ?? "",
            command: row.command ?? undefined,
            jobState: this.normalizeJobState(row.jobState ?? row.status),
            status: row.status ?? undefined,
            workspaceId: row.workspaceId ?? row.workspace ?? this.workspaceId,
            workspace: row.workspace ?? undefined,
            projectId: row.projectId ?? undefined,
            epicId: row.epicId ?? undefined,
            userStoryId: row.userStoryId ?? undefined,
            taskId: row.taskId ?? undefined,
            agentId: row.agentId ?? undefined,
            jobStateDetail: row.jobStateDetail ?? undefined,
            totalUnits: typeof row.totalUnits === "number" ? row.totalUnits : null,
            completedUnits: typeof row.completedUnits === "number" ? row.completedUnits : null,
            payloadJson: row.payloadJson ?? undefined,
            resultJson: row.resultJson ?? undefined,
            errorCode: row.errorCode ?? undefined,
            errorMessage: row.errorMessage ?? undefined,
            resumeSupported: row.resumeSupported === 0 ? false : true,
            checkpointPath: row.checkpointPath ?? undefined,
            notes: row.notes ?? undefined,
            startedAt: row.startedAt ?? undefined,
            lastCheckpointAt: row.lastCheckpointAt ?? undefined,
            completedAt: row.completedAt ?? undefined,
            rowVersion: typeof row.rowVersion === "number" ? row.rowVersion : undefined,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        };
    }
    recordCommandRun(run) {
        const payload = {
            ...run,
            updatedAt: run.updatedAt ?? new Date().toISOString(),
            workspace: run.workspace ?? this.workspaceId,
            startedAt: run.startedAt ?? run.updatedAt,
            completedAt: run.completedAt ?? undefined,
        };
        const result = this.db
            .prepare(`INSERT INTO command_runs (command, job_id, status, output_path, workspace, git_branch, git_base_branch, agent, started_at, completed_at, summary, updated_at)
         VALUES (@command, @jobId, @status, @outputPath, @workspace, @gitBranch, @gitBaseBranch, @agent, @startedAt, @completedAt, @summary, @updatedAt)`)
            .run({
            command: payload.command,
            jobId: payload.jobId ?? null,
            status: payload.status,
            outputPath: payload.outputPath ?? null,
            workspace: payload.workspace ?? null,
            gitBranch: payload.gitBranch ?? null,
            gitBaseBranch: payload.gitBaseBranch ?? null,
            agent: payload.agent ?? null,
            startedAt: payload.startedAt ?? null,
            completedAt: payload.completedAt ?? null,
            summary: payload.summary ?? null,
            updatedAt: payload.updatedAt,
        });
        return Number(result.lastInsertRowid);
    }
    recordTokenUsage(usage) {
        const payload = {
            ...usage,
            recordedAt: usage.recordedAt ?? new Date().toISOString(),
            workspace: usage.workspace ?? this.workspaceId,
            promptTokens: usage.promptTokens ?? 0,
            completionTokens: usage.completionTokens ?? 0,
        };
        const result = this.db
            .prepare(`INSERT INTO token_usage (command, agent, operation_id, action, model, workspace, task_id, job_id, command_run_id, task_run_id, prompt_tokens, completion_tokens, cost_estimate, recorded_at)
         VALUES (@command, @agent, @operationId, @action, @model, @workspace, @taskId, @jobId, @commandRunId, @taskRunId, @promptTokens, @completionTokens, @costEstimate, @recordedAt)`)
            .run({
            command: payload.command ?? null,
            agent: payload.agent ?? null,
            operationId: payload.operationId ?? null,
            action: payload.action ?? null,
            model: payload.model ?? null,
            workspace: payload.workspace ?? null,
            taskId: payload.taskId ?? null,
            jobId: payload.jobId ?? null,
            commandRunId: payload.commandRunId ?? null,
            taskRunId: payload.taskRunId ?? null,
            promptTokens: payload.promptTokens,
            completionTokens: payload.completionTokens,
            costEstimate: payload.costEstimate ?? null,
            recordedAt: payload.recordedAt,
        });
        return Number(result.lastInsertRowid);
    }
    recordTaskRunLog(log) {
        const payload = {
            ...log,
            createdAt: log.createdAt ?? new Date().toISOString(),
        };
        this.db
            .prepare(`INSERT INTO task_run_logs (command_run_id, task_id, phase, status, details_json, created_at)
         VALUES (@commandRunId, @taskId, @phase, @status, @detailsJson, @createdAt)`)
            .run({
            commandRunId: payload.commandRunId ?? null,
            taskId: payload.taskId ?? null,
            phase: payload.phase,
            status: payload.status,
            detailsJson: payload.detailsJson ?? null,
            createdAt: payload.createdAt,
        });
    }
    updateCommandRun(id, fields) {
        const existing = this.db
            .prepare(`SELECT id, command, job_id as jobId, status, output_path as outputPath, workspace, git_branch as gitBranch, git_base_branch as gitBaseBranch, agent, started_at as startedAt, completed_at as completedAt, summary, updated_at as updatedAt
         FROM command_runs WHERE id = ?`)
            .get(id);
        if (!existing)
            throw new Error(`command_run ${id} not found`);
        const payload = {
            ...existing,
            ...fields,
            updatedAt: fields.updatedAt ?? new Date().toISOString(),
        };
        this.db
            .prepare(`UPDATE command_runs
         SET status=@status,
             output_path=@outputPath,
             workspace=@workspace,
             git_branch=@gitBranch,
             git_base_branch=@gitBaseBranch,
             agent=@agent,
             started_at=@startedAt,
             completed_at=@completedAt,
             summary=@summary,
             updated_at=@updatedAt
         WHERE id=@id`)
            .run({
            id,
            status: payload.status,
            outputPath: payload.outputPath ?? null,
            workspace: payload.workspace ?? null,
            gitBranch: payload.gitBranch ?? null,
            gitBaseBranch: payload.gitBaseBranch ?? null,
            agent: payload.agent ?? null,
            startedAt: payload.startedAt ?? null,
            completedAt: payload.completedAt ?? null,
            summary: payload.summary ?? null,
            updatedAt: payload.updatedAt,
        });
    }
    recordTaskRun(run) {
        const payload = {
            ...run,
            createdAt: run.createdAt ?? new Date().toISOString(),
            workspace: run.workspace ?? this.workspaceId,
            storyPoints: run.storyPoints ?? null,
            durationSeconds: run.durationSeconds ?? null,
            notes: run.notes,
        };
        const result = this.db
            .prepare(`INSERT INTO task_runs (task_id, command, status, story_points, duration_seconds, workspace, job_id, notes, created_at)
         VALUES (@taskId, @command, @status, @storyPoints, @durationSeconds, @workspace, @jobId, @notes, @createdAt)`)
            .run({
            taskId: payload.taskId,
            command: payload.command,
            status: payload.status,
            storyPoints: payload.storyPoints,
            durationSeconds: payload.durationSeconds,
            workspace: payload.workspace ?? null,
            jobId: payload.jobId ?? null,
            notes: payload.notes ?? null,
            createdAt: payload.createdAt,
        });
        return Number(result.lastInsertRowid);
    }
    spPerHour(options = {}) {
        return this.spPerHourForCommands(options);
    }
    spPerHourForCommands(options = {}) {
        const window = options.window && options.window > 0 ? options.window : 10;
        const commands = options.commands?.filter(Boolean) ?? [];
        const where = [
            "story_points IS NOT NULL",
            "duration_seconds IS NOT NULL",
            "duration_seconds > 0",
        ];
        const joins = [];
        const params = [];
        if (commands.length) {
            where.push(`command IN (${commands.map(() => "?").join(",")})`);
            params.push(...commands);
        }
        if (options.epicId) {
            joins.push("JOIN tasks t ON t.id = task_runs.task_id");
            joins.push("LEFT JOIN user_stories s ON t.story_id = s.id");
            where.push("s.epic_id = ?");
            params.push(options.epicId);
        }
        params.push(window);
        const sql = `
      SELECT story_points as storyPoints, duration_seconds as durationSeconds
      FROM task_runs
      ${joins.length ? joins.join(" ") : ""}
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ?
    `;
        const rows = this.db.prepare(sql).all(...params);
        const valid = rows.filter((r) => typeof r.storyPoints === "number" && typeof r.durationSeconds === "number" && (r.durationSeconds ?? 0) > 0);
        if (!valid.length) {
            return { spPerHour: 15, sample: 0 };
        }
        const totalSp = valid.reduce((sum, r) => sum + (r.storyPoints ?? 0), 0);
        const totalHours = valid.reduce((sum, r) => sum + ((r.durationSeconds ?? 0) / 3600), 0);
        const spPerHour = totalHours > 0 ? totalSp / totalHours : 15;
        return { spPerHour, sample: valid.length };
    }
    listTokenUsage(filters = {}) {
        const clauses = [];
        const params = {};
        if (filters.command) {
            clauses.push("command = @command");
            params.command = filters.command;
        }
        if (filters.agent) {
            clauses.push("agent = @agent");
            params.agent = filters.agent;
        }
        if (filters.workspace) {
            clauses.push("workspace = @workspace");
            params.workspace = filters.workspace;
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        let limitClause = "";
        if (filters.limit && filters.limit > 0) {
            limitClause = "LIMIT @limit";
            params.limit = Number(filters.limit);
        }
        const rows = this.db
            .prepare(`SELECT id, command, agent, operation_id as operationId, action, model, workspace, task_id as taskId, job_id as jobId, command_run_id as commandRunId, task_run_id as taskRunId, prompt_tokens as promptTokens, completion_tokens as completionTokens, cost_estimate as costEstimate, recorded_at as recordedAt
         FROM token_usage
         ${where}
         ORDER BY recorded_at DESC
         ${limitClause}`)
            .all(params);
        return rows.map((row) => ({
            ...row,
            command: row.command ?? undefined,
            agent: row.agent ?? undefined,
            operationId: row.operationId ?? undefined,
            action: row.action ?? undefined,
            model: row.model ?? undefined,
            workspace: row.workspace ?? undefined,
            taskId: row.taskId ?? undefined,
            jobId: row.jobId ?? undefined,
            commandRunId: row.commandRunId ?? undefined,
            taskRunId: row.taskRunId ?? undefined,
            costEstimate: row.costEstimate ?? undefined,
        }));
    }
    listTasks(filters = {}) {
        const statusOrder = `
      CASE t.status
        WHEN 'not_started' THEN 0
        WHEN 'in_progress' THEN 1
        WHEN 'blocked' THEN 2
        WHEN 'ready_to_review' THEN 3
        WHEN 'ready_to_qa' THEN 4
        WHEN 'completed' THEN 5
        WHEN 'cancelled' THEN 6
        ELSE 7
      END
    `;
        const clauses = [];
        const params = [];
        if (filters.status?.length) {
            clauses.push(`t.status IN (${filters.status.map(() => "?").join(",")})`);
            params.push(...filters.status);
        }
        if (filters.epicId) {
            clauses.push("s.epic_id = ?");
            params.push(filters.epicId);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const orderParts = ["status_order"];
        const orderBy = filters.orderBy ?? "default";
        if (orderBy === "dependencies") {
            orderParts.push("COALESCE(dep.dependents, 0) DESC");
        }
        else if (orderBy === "story_points") {
            orderParts.push("COALESCE(t.estimate, 0) DESC");
        }
        orderParts.push("t.id");
        const limitClause = filters.limit && filters.limit > 0 ? `LIMIT ${Number(filters.limit)}` : "";
        const sql = `
      SELECT
        t.id,
        t.story_id as storyId,
        s.epic_id as epicId,
        e.title as epicTitle,
        s.title as storyTitle,
        t.title,
        t.status,
        t.estimate as storyPoints,
        t.notes,
        t.assignee,
        t.created_at as createdAt,
        t.updated_at as updatedAt,
        ${statusOrder} as status_order,
        dep.dependents
      FROM tasks t
      LEFT JOIN user_stories s ON t.story_id = s.id
      LEFT JOIN epics e ON s.epic_id = e.id
      LEFT JOIN (
        SELECT to_task_id as task_id, COUNT(*) as dependents
        FROM task_dependencies
        GROUP BY to_task_id
      ) dep ON dep.task_id = t.id
      ${where}
      ORDER BY ${orderParts.join(", ")}
      ${limitClause}
    `;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((row) => ({
            id: row.id,
            storyId: row.storyId ?? null,
            epicId: row.epicId ?? null,
            epicTitle: row.epicTitle ?? null,
            storyTitle: row.storyTitle ?? null,
            title: row.title,
            status: row.status,
            storyPoints: typeof row.storyPoints === "number" ? row.storyPoints : null,
            notes: row.notes ?? null,
            assignee: row.assignee ?? null,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            dependents: row.dependents ?? null,
        }));
    }
    listTaskDependencies(filters = {}) {
        const clauses = [];
        const params = [];
        if (filters.taskIds && filters.taskIds.length) {
            const placeholders = filters.taskIds.map(() => "?").join(",");
            clauses.push(`(from_task_id IN (${placeholders}) OR to_task_id IN (${placeholders}))`);
            params.push(...filters.taskIds, ...filters.taskIds);
        }
        const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
        const sql = `
      SELECT from_task_id as taskId, to_task_id as dependsOnTaskId
      FROM task_dependencies
      ${where}
    `;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map((row) => ({
            taskId: row.taskId,
            dependsOnTaskId: row.dependsOnTaskId,
            relationType: null,
        }));
    }
    listJobs() {
        const rows = this.db
            .prepare(`SELECT id,
                type,
                command_name as commandName,
                command,
                job_state as jobState,
                status,
                workspace_id as workspaceId,
                workspace,
                project_id as projectId,
                epic_id as epicId,
                user_story_id as userStoryId,
                task_id as taskId,
                agent_id as agentId,
                job_state_detail as jobStateDetail,
                total_units as totalUnits,
                completed_units as completedUnits,
                payload_json as payloadJson,
                result_json as resultJson,
                error_code as errorCode,
                error_message as errorMessage,
                resume_supported as resumeSupported,
                checkpoint_path as checkpointPath,
                notes,
                started_at as startedAt,
                last_checkpoint_at as lastCheckpointAt,
                completed_at as completedAt,
                row_version as rowVersion,
                created_at as createdAt,
                updated_at as updatedAt
         FROM jobs
         ORDER BY updated_at DESC`)
            .all();
        if (rows.length === 0) {
            const now = new Date().toISOString();
            const stubJobs = [
                {
                    id: "job-1",
                    type: "work",
                    commandName: "work-on-tasks",
                    command: "work-on-tasks",
                    jobState: "running",
                    status: "running",
                    workspaceId: this.workspaceId,
                    workspace: this.workspaceId,
                    notes: "Stub running job",
                    resumeSupported: true,
                    createdAt: now,
                    updatedAt: now,
                },
                {
                    id: "job-2",
                    type: "review",
                    commandName: "code-review",
                    command: "code-review",
                    jobState: "completed",
                    status: "completed",
                    workspaceId: this.workspaceId,
                    workspace: this.workspaceId,
                    notes: "Stub completed job",
                    resumeSupported: true,
                    createdAt: now,
                    updatedAt: now,
                },
            ];
            for (const job of stubJobs) {
                this.saveJob(job);
            }
            return stubJobs.map((job) => this.mapJobRow({
                id: job.id,
                type: job.type ?? null,
                commandName: job.commandName ?? job.command ?? null,
                command: job.command ?? null,
                jobState: job.jobState,
                status: job.status ?? null,
                workspaceId: job.workspaceId ?? null,
                workspace: job.workspace ?? null,
                projectId: null,
                epicId: null,
                userStoryId: null,
                taskId: null,
                agentId: null,
                jobStateDetail: null,
                totalUnits: null,
                completedUnits: null,
                payloadJson: null,
                resultJson: null,
                errorCode: null,
                errorMessage: null,
                resumeSupported: job.resumeSupported ? 1 : 0,
                checkpointPath: null,
                notes: job.notes ?? null,
                startedAt: null,
                lastCheckpointAt: null,
                completedAt: null,
                rowVersion: null,
                createdAt: job.createdAt,
                updatedAt: job.updatedAt,
            }));
        }
        return rows.map((row) => this.mapJobRow(row));
    }
    getJob(id) {
        const row = this.db
            .prepare(`SELECT id,
                type,
                command_name as commandName,
                command,
                job_state as jobState,
                status,
                workspace_id as workspaceId,
                workspace,
                project_id as projectId,
                epic_id as epicId,
                user_story_id as userStoryId,
                task_id as taskId,
                agent_id as agentId,
                job_state_detail as jobStateDetail,
                total_units as totalUnits,
                completed_units as completedUnits,
                payload_json as payloadJson,
                result_json as resultJson,
                error_code as errorCode,
                error_message as errorMessage,
                resume_supported as resumeSupported,
                checkpoint_path as checkpointPath,
                notes,
                started_at as startedAt,
                last_checkpoint_at as lastCheckpointAt,
                completed_at as completedAt,
                row_version as rowVersion,
                created_at as createdAt,
                updated_at as updatedAt
         FROM jobs
         WHERE id = ?`)
            .get(id);
        if (!row)
            return undefined;
        return this.mapJobRow(row);
    }
    saveJob(job) {
        const jobState = this.normalizeJobState(job.jobState ?? job.status);
        const commandName = job.commandName ?? job.command ?? "";
        const workspaceId = job.workspaceId ?? job.workspace ?? this.workspaceId;
        const now = job.updatedAt ?? new Date().toISOString();
        const createdAt = job.createdAt ?? now;
        const resumeSupported = job.resumeSupported !== false;
        this.db
            .prepare(`INSERT INTO jobs (
           id,
           type,
           command_name,
           command,
           job_state,
           status,
           workspace_id,
           workspace,
           project_id,
           epic_id,
           user_story_id,
           task_id,
           agent_id,
           job_state_detail,
           total_units,
           completed_units,
           payload_json,
           result_json,
           error_code,
           error_message,
           resume_supported,
           checkpoint_path,
           notes,
           started_at,
           last_checkpoint_at,
           completed_at,
           row_version,
           created_at,
           updated_at
         )
         VALUES (
           @id,
           @type,
           @commandName,
           @command,
           @jobState,
           @status,
           @workspaceId,
           @workspace,
           @projectId,
           @epicId,
           @userStoryId,
           @taskId,
           @agentId,
           @jobStateDetail,
           @totalUnits,
           @completedUnits,
           @payloadJson,
           @resultJson,
           @errorCode,
           @errorMessage,
           @resumeSupported,
           @checkpointPath,
           @notes,
           @startedAt,
           @lastCheckpointAt,
           @completedAt,
           @rowVersion,
           @createdAt,
           @updatedAt
         )
         ON CONFLICT(id) DO UPDATE SET
           type=excluded.type,
           command_name=excluded.command_name,
           command=excluded.command,
           job_state=excluded.job_state,
           status=excluded.status,
           workspace_id=excluded.workspace_id,
           workspace=excluded.workspace,
           project_id=excluded.project_id,
           epic_id=excluded.epic_id,
           user_story_id=excluded.user_story_id,
           task_id=excluded.task_id,
           agent_id=excluded.agent_id,
           job_state_detail=excluded.job_state_detail,
           total_units=excluded.total_units,
           completed_units=excluded.completed_units,
           payload_json=excluded.payload_json,
           result_json=excluded.result_json,
           error_code=excluded.error_code,
           error_message=excluded.error_message,
           resume_supported=excluded.resume_supported,
           checkpoint_path=excluded.checkpoint_path,
           notes=excluded.notes,
           started_at=COALESCE(jobs.started_at, excluded.started_at),
           last_checkpoint_at=excluded.last_checkpoint_at,
           completed_at=excluded.completed_at,
           row_version=COALESCE(jobs.row_version, 0) + 1,
           updated_at=excluded.updated_at`)
            .run({
            id: job.id,
            type: job.type ?? null,
            commandName,
            command: job.command ?? commandName,
            jobState,
            status: job.status ?? jobState,
            workspaceId,
            workspace: job.workspace ?? workspaceId ?? null,
            projectId: job.projectId ?? null,
            epicId: job.epicId ?? null,
            userStoryId: job.userStoryId ?? null,
            taskId: job.taskId ?? null,
            agentId: job.agentId ?? null,
            jobStateDetail: job.jobStateDetail ?? null,
            totalUnits: typeof job.totalUnits === "number" ? job.totalUnits : null,
            completedUnits: typeof job.completedUnits === "number" ? job.completedUnits : null,
            payloadJson: job.payloadJson ?? null,
            resultJson: job.resultJson ?? null,
            errorCode: job.errorCode ?? null,
            errorMessage: job.errorMessage ?? null,
            resumeSupported: resumeSupported ? 1 : 0,
            checkpointPath: job.checkpointPath ?? null,
            notes: job.notes ?? null,
            startedAt: job.startedAt ?? null,
            lastCheckpointAt: job.lastCheckpointAt ?? null,
            completedAt: job.completedAt ?? null,
            rowVersion: job.rowVersion ?? 0,
            createdAt,
            updatedAt: now,
        });
    }
}
export const openGlobalStore = async (options = {}) => {
    const homeDir = options.homeDir ?? os.homedir();
    const layout = getGlobalLayout(homeDir);
    const dbPath = options.dbPath ?? (process.env.MCODA_DB_PATH ? path.resolve(process.env.MCODA_DB_PATH) : layout.dbPath);
    const keyRoot = options.keyRoot ?? layout.root;
    await ensureDir(keyRoot);
    await ensureDir(path.dirname(dbPath));
    const key = await loadOrCreateKey(keyRoot);
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    runGlobalMigrations(db);
    return new GlobalStore(db, key);
};
export const openWorkspaceStore = async (options = {}) => {
    const context = options.workspace ??
        (await resolveWorkspaceContext({
            cwd: options.workspaceRoot ?? process.cwd(),
            explicitWorkspace: options.workspaceRoot,
        }));
    const dbPath = options.dbPath ? path.resolve(options.dbPath) : context.workspaceDbPath;
    await ensureDir(path.dirname(dbPath));
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    runWorkspaceMigrations(db);
    return new WorkspaceStore(db, context.rootDir, context.id);
};
