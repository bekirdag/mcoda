import { randomUUID } from "node:crypto";
import { Connection } from "../../sqlite/connection.js";
import { WorkspaceMigrations } from "../../migrations/workspace/WorkspaceMigrations.js";
export class WorkspaceRepository {
    constructor(db, connection) {
        this.db = db;
        this.connection = connection;
    }
    static async create(cwd) {
        const connection = await Connection.openWorkspace(cwd);
        await WorkspaceMigrations.run(connection.db);
        return new WorkspaceRepository(connection.db, connection);
    }
    async close() {
        if (this.connection) {
            await this.connection.close();
        }
    }
    async withTransaction(fn) {
        await this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = await fn();
            await this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            await this.db.exec("ROLLBACK");
            throw error;
        }
    }
    async getProjectByKey(key) {
        const row = await this.db.get(`SELECT id, key, name, description, metadata_json, created_at, updated_at FROM projects WHERE key = ?`, key);
        if (!row)
            return undefined;
        return {
            id: row.id,
            key: row.key,
            name: row.name ?? undefined,
            description: row.description ?? undefined,
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    async createProjectIfMissing(input) {
        const existing = await this.getProjectByKey(input.key);
        if (existing)
            return existing;
        const now = new Date().toISOString();
        const id = randomUUID();
        await this.db.run(`INSERT INTO projects (id, key, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`, id, input.key, input.name ?? null, input.description ?? null, now, now);
        return {
            id,
            key: input.key,
            name: input.name,
            description: input.description,
            createdAt: now,
            updatedAt: now,
        };
    }
    async insertEpics(epics, useTransaction = true) {
        const now = new Date().toISOString();
        const rows = [];
        const run = async () => {
            for (const epic of epics) {
                const id = randomUUID();
                await this.db.run(`INSERT INTO epics (id, project_id, key, title, description, story_points_total, priority, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, epic.projectId, epic.key, epic.title, epic.description, epic.storyPointsTotal ?? null, epic.priority ?? null, epic.metadata ? JSON.stringify(epic.metadata) : null, now, now);
                rows.push({ ...epic, id, createdAt: now, updatedAt: now });
            }
        };
        if (useTransaction) {
            await this.withTransaction(run);
        }
        else {
            await run();
        }
        return rows;
    }
    async insertStories(stories, useTransaction = true) {
        const now = new Date().toISOString();
        const rows = [];
        const run = async () => {
            for (const story of stories) {
                const id = randomUUID();
                await this.db.run(`INSERT INTO user_stories (id, project_id, epic_id, key, title, description, acceptance_criteria, story_points_total, priority, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, story.projectId, story.epicId, story.key, story.title, story.description, story.acceptanceCriteria ?? null, story.storyPointsTotal ?? null, story.priority ?? null, story.metadata ? JSON.stringify(story.metadata) : null, now, now);
                rows.push({ ...story, id, createdAt: now, updatedAt: now });
            }
        };
        if (useTransaction) {
            await this.withTransaction(run);
        }
        else {
            await run();
        }
        return rows;
    }
    async insertTasks(tasks, useTransaction = true) {
        const now = new Date().toISOString();
        const rows = [];
        const run = async () => {
            for (const task of tasks) {
                const id = randomUUID();
                await this.db.run(`INSERT INTO tasks (id, project_id, epic_id, user_story_id, key, title, description, type, status, story_points, priority, assigned_agent_id, assignee_human, vcs_branch, vcs_base_branch, vcs_last_commit_sha, metadata_json, openapi_version_at_creation, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, task.projectId, task.epicId, task.userStoryId, task.key, task.title, task.description, task.type ?? null, task.status, task.storyPoints ?? null, task.priority ?? null, task.assignedAgentId ?? null, task.assigneeHuman ?? null, task.vcsBranch ?? null, task.vcsBaseBranch ?? null, task.vcsLastCommitSha ?? null, task.metadata ? JSON.stringify(task.metadata) : null, task.openapiVersionAtCreation ?? null, now, now);
                rows.push({ ...task, id, createdAt: now, updatedAt: now });
            }
        };
        if (useTransaction) {
            await this.withTransaction(run);
        }
        else {
            await run();
        }
        return rows;
    }
    async insertTaskDependencies(deps, useTransaction = true) {
        const now = new Date().toISOString();
        const rows = [];
        const run = async () => {
            for (const dep of deps) {
                const id = randomUUID();
                await this.db.run(`INSERT INTO task_dependencies (id, task_id, depends_on_task_id, relation_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`, id, dep.taskId, dep.dependsOnTaskId, dep.relationType, now, now);
                rows.push({ ...dep, id, createdAt: now, updatedAt: now });
            }
        };
        if (useTransaction) {
            await this.withTransaction(run);
        }
        else {
            await run();
        }
        return rows;
    }
    async listEpicKeys(projectId) {
        const rows = await this.db.all(`SELECT key FROM epics WHERE project_id = ? ORDER BY key`, projectId);
        return rows.map((r) => r.key);
    }
    async listStoryKeys(epicId) {
        const rows = await this.db.all(`SELECT key FROM user_stories WHERE epic_id = ? ORDER BY key`, epicId);
        return rows.map((r) => r.key);
    }
    async listTaskKeys(userStoryId) {
        const rows = await this.db.all(`SELECT key FROM tasks WHERE user_story_id = ? ORDER BY key`, userStoryId);
        return rows.map((r) => r.key);
    }
    async createJob(record) {
        const now = new Date().toISOString();
        const id = randomUUID();
        await this.db.run(`INSERT INTO jobs (id, workspace_id, type, state, command_name, payload_json, total_items, processed_items, last_checkpoint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, record.workspaceId, record.type, record.state, record.commandName ?? null, record.payload ? JSON.stringify(record.payload) : null, record.totalItems ?? null, record.processedItems ?? null, record.lastCheckpoint ?? null, now, now);
        return {
            id,
            ...record,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
            errorSummary: null,
        };
    }
    async updateJobState(id, update) {
        const existing = await this.db.get(`SELECT payload_json FROM jobs WHERE id = ?`, id);
        const payload = existing?.payload_json ? JSON.parse(existing.payload_json) : undefined;
        const mergedPayload = update.payload !== undefined ? { ...(payload ?? {}), ...(update.payload ?? {}) } : payload;
        const fields = [];
        const params = [];
        if (update.state !== undefined) {
            fields.push("state = ?");
            params.push(update.state);
        }
        if (update.commandName !== undefined) {
            fields.push("command_name = ?");
            params.push(update.commandName ?? null);
        }
        if (update.totalItems !== undefined) {
            fields.push("total_items = ?");
            params.push(update.totalItems ?? null);
        }
        if (update.processedItems !== undefined) {
            fields.push("processed_items = ?");
            params.push(update.processedItems ?? null);
        }
        if (update.lastCheckpoint !== undefined) {
            fields.push("last_checkpoint = ?");
            params.push(update.lastCheckpoint ?? null);
        }
        if (update.errorSummary !== undefined) {
            fields.push("error_summary = ?");
            params.push(update.errorSummary ?? null);
        }
        if (update.completedAt !== undefined) {
            fields.push("completed_at = ?");
            params.push(update.completedAt ?? null);
        }
        if (mergedPayload !== undefined) {
            fields.push("payload_json = ?");
            params.push(JSON.stringify(mergedPayload));
        }
        fields.push("updated_at = ?");
        params.push(new Date().toISOString());
        params.push(id);
        await this.db.run(`UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`, ...params);
    }
    async createCommandRun(record) {
        const id = randomUUID();
        await this.db.run(`INSERT INTO command_runs (id, workspace_id, command_name, job_id, task_ids_json, git_branch, git_base_branch, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, record.workspaceId, record.commandName, record.jobId ?? null, record.taskIds ? JSON.stringify(record.taskIds) : null, record.gitBranch ?? null, record.gitBaseBranch ?? null, record.startedAt, record.status);
        return { id, ...record, completedAt: null, errorSummary: null, durationSeconds: null };
    }
    async completeCommandRun(id, update) {
        await this.db.run(`UPDATE command_runs
       SET status = ?, completed_at = ?, error_summary = ?, duration_seconds = ?
       WHERE id = ?`, update.status, update.completedAt, update.errorSummary ?? null, update.durationSeconds ?? null, id);
    }
    async createTaskRun(record) {
        const id = randomUUID();
        await this.db.run(`INSERT INTO task_runs (id, task_id, command, job_id, command_run_id, agent_id, status, started_at, finished_at, story_points_at_run, sp_per_hour_effective, git_branch, git_base_branch, git_commit_sha, run_context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, record.taskId, record.command, record.jobId ?? null, record.commandRunId ?? null, record.agentId ?? null, record.status, record.startedAt, record.finishedAt ?? null, record.storyPointsAtRun ?? null, record.spPerHourEffective ?? null, record.gitBranch ?? null, record.gitBaseBranch ?? null, record.gitCommitSha ?? null, record.runContext ? JSON.stringify(record.runContext) : null);
        return { id, ...record };
    }
    async recordTokenUsage(entry) {
        const id = randomUUID();
        await this.db.run(`INSERT INTO token_usage (id, workspace_id, agent_id, model_name, job_id, command_run_id, task_run_id, task_id, project_id, epic_id, user_story_id, tokens_prompt, tokens_completion, tokens_total, cost_estimate, duration_seconds, timestamp, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, entry.workspaceId, entry.agentId ?? null, entry.modelName ?? null, entry.jobId ?? null, entry.commandRunId ?? null, entry.taskRunId ?? null, entry.taskId ?? null, entry.projectId ?? null, entry.epicId ?? null, entry.userStoryId ?? null, entry.tokensPrompt ?? null, entry.tokensCompletion ?? null, entry.tokensTotal ?? null, entry.costEstimate ?? null, entry.durationSeconds ?? null, entry.timestamp, entry.metadata ? JSON.stringify(entry.metadata) : null);
    }
}
