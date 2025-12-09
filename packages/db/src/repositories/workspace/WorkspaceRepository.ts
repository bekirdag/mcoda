import { randomUUID } from "node:crypto";
import { Database } from "sqlite";
import { Connection } from "../../sqlite/connection.js";
import { WorkspaceMigrations } from "../../migrations/workspace/WorkspaceMigrations.js";

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type CommandStatus = "running" | "succeeded" | "failed";
export type TaskRunStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface ProjectRow {
  id: string;
  key: string;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EpicInsert {
  projectId: string;
  key: string;
  title: string;
  description: string;
  storyPointsTotal?: number | null;
  priority?: number | null;
  metadata?: Record<string, unknown>;
}

export interface EpicRow extends EpicInsert {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryInsert {
  projectId: string;
  epicId: string;
  key: string;
  title: string;
  description: string;
  acceptanceCriteria?: string | null;
  storyPointsTotal?: number | null;
  priority?: number | null;
  metadata?: Record<string, unknown>;
}

export interface StoryRow extends StoryInsert {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskInsert {
  projectId: string;
  epicId: string;
  userStoryId: string;
  key: string;
  title: string;
  description: string;
  type?: string | null;
  status: string;
  storyPoints?: number | null;
  priority?: number | null;
  assignedAgentId?: string | null;
  assigneeHuman?: string | null;
  vcsBranch?: string | null;
  vcsBaseBranch?: string | null;
  vcsLastCommitSha?: string | null;
  metadata?: Record<string, unknown>;
  openapiVersionAtCreation?: string | null;
}

export interface TaskRow extends TaskInsert {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDependencyInsert {
  taskId: string;
  dependsOnTaskId: string;
  relationType: string;
}

export interface TaskDependencyRow extends TaskDependencyInsert {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobInsert {
  workspaceId: string;
  type: string;
  state: JobStatus;
  commandName?: string;
  payload?: Record<string, unknown>;
  totalItems?: number | null;
  processedItems?: number | null;
  lastCheckpoint?: string | null;
}

export interface JobRow extends JobInsert {
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  errorSummary?: string | null;
}

export interface CommandRunInsert {
  workspaceId: string;
  commandName: string;
  jobId?: string | null;
  taskIds?: string[];
  gitBranch?: string | null;
  gitBaseBranch?: string | null;
  startedAt: string;
  status: CommandStatus;
}

export interface CommandRunRow extends CommandRunInsert {
  id: string;
  completedAt?: string | null;
  errorSummary?: string | null;
  durationSeconds?: number | null;
}

export interface TaskRunInsert {
  taskId: string;
  command: string;
  status: TaskRunStatus;
  jobId?: string | null;
  commandRunId?: string | null;
  agentId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  storyPointsAtRun?: number | null;
  spPerHourEffective?: number | null;
  gitBranch?: string | null;
  gitBaseBranch?: string | null;
  gitCommitSha?: string | null;
  runContext?: Record<string, unknown>;
}

export interface TaskRunRow extends TaskRunInsert {
  id: string;
}

export interface TokenUsageInsert {
  workspaceId: string;
  agentId?: string | null;
  modelName?: string | null;
  jobId?: string | null;
  commandRunId?: string | null;
  taskRunId?: string | null;
  taskId?: string | null;
  projectId?: string | null;
  epicId?: string | null;
  userStoryId?: string | null;
  tokensPrompt?: number | null;
  tokensCompletion?: number | null;
  tokensTotal?: number | null;
  costEstimate?: number | null;
  durationSeconds?: number | null;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export class WorkspaceRepository {
  constructor(private db: Database, private connection?: Connection) {}

  static async create(cwd?: string): Promise<WorkspaceRepository> {
    const connection = await Connection.openWorkspace(cwd);
    await WorkspaceMigrations.run(connection.db);
    return new WorkspaceRepository(connection.db, connection);
  }

  async close(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
    }
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn();
      await this.db.exec("COMMIT");
      return result;
    } catch (error) {
      await this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getProjectByKey(key: string): Promise<ProjectRow | undefined> {
    const row = await this.db.get(
      `SELECT id, key, name, description, metadata_json, created_at, updated_at FROM projects WHERE key = ?`,
      key,
    );
    if (!row) return undefined;
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

  async createProjectIfMissing(input: { key: string; name?: string; description?: string }): Promise<ProjectRow> {
    const existing = await this.getProjectByKey(input.key);
    if (existing) return existing;
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO projects (id, key, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.key,
      input.name ?? null,
      input.description ?? null,
      now,
      now,
    );
    return {
      id,
      key: input.key,
      name: input.name,
      description: input.description,
      createdAt: now,
      updatedAt: now,
    };
  }

  async insertEpics(epics: EpicInsert[], useTransaction = true): Promise<EpicRow[]> {
    const now = new Date().toISOString();
    const rows: EpicRow[] = [];
    const run = async () => {
      for (const epic of epics) {
        const id = randomUUID();
        await this.db.run(
          `INSERT INTO epics (id, project_id, key, title, description, story_points_total, priority, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          epic.projectId,
          epic.key,
          epic.title,
          epic.description,
          epic.storyPointsTotal ?? null,
          epic.priority ?? null,
          epic.metadata ? JSON.stringify(epic.metadata) : null,
          now,
          now,
        );
        rows.push({ ...epic, id, createdAt: now, updatedAt: now });
      }
    };
    if (useTransaction) {
      await this.withTransaction(run);
    } else {
      await run();
    }
    return rows;
  }

  async insertStories(stories: StoryInsert[], useTransaction = true): Promise<StoryRow[]> {
    const now = new Date().toISOString();
    const rows: StoryRow[] = [];
    const run = async () => {
      for (const story of stories) {
        const id = randomUUID();
        await this.db.run(
          `INSERT INTO user_stories (id, project_id, epic_id, key, title, description, acceptance_criteria, story_points_total, priority, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          story.projectId,
          story.epicId,
          story.key,
          story.title,
          story.description,
          story.acceptanceCriteria ?? null,
          story.storyPointsTotal ?? null,
          story.priority ?? null,
          story.metadata ? JSON.stringify(story.metadata) : null,
          now,
          now,
        );
        rows.push({ ...story, id, createdAt: now, updatedAt: now });
      }
    };
    if (useTransaction) {
      await this.withTransaction(run);
    } else {
      await run();
    }
    return rows;
  }

  async insertTasks(tasks: TaskInsert[], useTransaction = true): Promise<TaskRow[]> {
    const now = new Date().toISOString();
    const rows: TaskRow[] = [];
    const run = async () => {
      for (const task of tasks) {
        const id = randomUUID();
        await this.db.run(
          `INSERT INTO tasks (id, project_id, epic_id, user_story_id, key, title, description, type, status, story_points, priority, assigned_agent_id, assignee_human, vcs_branch, vcs_base_branch, vcs_last_commit_sha, metadata_json, openapi_version_at_creation, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          task.projectId,
          task.epicId,
          task.userStoryId,
          task.key,
          task.title,
          task.description,
          task.type ?? null,
          task.status,
          task.storyPoints ?? null,
          task.priority ?? null,
          task.assignedAgentId ?? null,
          task.assigneeHuman ?? null,
          task.vcsBranch ?? null,
          task.vcsBaseBranch ?? null,
          task.vcsLastCommitSha ?? null,
          task.metadata ? JSON.stringify(task.metadata) : null,
          task.openapiVersionAtCreation ?? null,
          now,
          now,
        );
        rows.push({ ...task, id, createdAt: now, updatedAt: now });
      }
    };
    if (useTransaction) {
      await this.withTransaction(run);
    } else {
      await run();
    }
    return rows;
  }

  async updateStoryPointsTotal(storyId: string, total: number | null): Promise<void> {
    await this.db.run(`UPDATE user_stories SET story_points_total = ?, updated_at = ? WHERE id = ?`, total, new Date().toISOString(), storyId);
  }

  async updateEpicStoryPointsTotal(epicId: string, total: number | null): Promise<void> {
    await this.db.run(`UPDATE epics SET story_points_total = ?, updated_at = ? WHERE id = ?`, total, new Date().toISOString(), epicId);
  }

  async insertTaskDependencies(deps: TaskDependencyInsert[], useTransaction = true): Promise<TaskDependencyRow[]> {
    const now = new Date().toISOString();
    const rows: TaskDependencyRow[] = [];
    const run = async () => {
      for (const dep of deps) {
        const id = randomUUID();
        await this.db.run(
          `INSERT INTO task_dependencies (id, task_id, depends_on_task_id, relation_type, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          id,
          dep.taskId,
          dep.dependsOnTaskId,
          dep.relationType,
          now,
          now,
        );
        rows.push({ ...dep, id, createdAt: now, updatedAt: now });
      }
    };
    if (useTransaction) {
      await this.withTransaction(run);
    } else {
      await run();
    }
    return rows;
  }

  async listEpicKeys(projectId: string): Promise<string[]> {
    const rows = await this.db.all(`SELECT key FROM epics WHERE project_id = ? ORDER BY key`, projectId);
    return rows.map((r: any) => r.key as string);
  }

  async listStoryKeys(epicId: string): Promise<string[]> {
    const rows = await this.db.all(`SELECT key FROM user_stories WHERE epic_id = ? ORDER BY key`, epicId);
    return rows.map((r: any) => r.key as string);
  }

  async listTaskKeys(userStoryId: string): Promise<string[]> {
    const rows = await this.db.all(`SELECT key FROM tasks WHERE user_story_id = ? ORDER BY key`, userStoryId);
    return rows.map((r: any) => r.key as string);
  }

  async createJob(record: JobInsert): Promise<JobRow> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO jobs (id, workspace_id, type, state, command_name, payload_json, total_items, processed_items, last_checkpoint, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.workspaceId,
      record.type,
      record.state,
      record.commandName ?? null,
      record.payload ? JSON.stringify(record.payload) : null,
      record.totalItems ?? null,
      record.processedItems ?? null,
      record.lastCheckpoint ?? null,
      now,
      now,
    );
    return {
      id,
      ...record,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      errorSummary: null,
    };
  }

  async listJobs(): Promise<JobRow[]> {
    const rows = await this.db.all(
      `SELECT id, workspace_id, type, state, command_name, payload_json, total_items, processed_items, last_checkpoint, created_at, updated_at, completed_at, error_summary
       FROM jobs ORDER BY updated_at DESC`,
    );
    return rows.map((row: any) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.type,
      state: row.state,
      commandName: row.command_name ?? undefined,
      payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
      totalItems: row.total_items ?? undefined,
      processedItems: row.processed_items ?? undefined,
      lastCheckpoint: row.last_checkpoint ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      errorSummary: row.error_summary ?? undefined,
    }));
  }

  async getJob(id: string): Promise<JobRow | undefined> {
    const row = await this.db.get(
      `SELECT id, workspace_id, type, state, command_name, payload_json, total_items, processed_items, last_checkpoint, created_at, updated_at, completed_at, error_summary
       FROM jobs WHERE id = ?`,
      id,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      type: row.type,
      state: row.state,
      commandName: row.command_name ?? undefined,
      payload: row.payload_json ? JSON.parse(row.payload_json) : undefined,
      totalItems: row.total_items ?? undefined,
      processedItems: row.processed_items ?? undefined,
      lastCheckpoint: row.last_checkpoint ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
      errorSummary: row.error_summary ?? undefined,
    };
  }

  async updateJobState(id: string, update: Partial<JobInsert> & { state?: JobStatus; errorSummary?: string | null; completedAt?: string | null }): Promise<void> {
    const existing = await this.db.get(`SELECT payload_json FROM jobs WHERE id = ?`, id);
    const payload = existing?.payload_json ? JSON.parse(existing.payload_json) : undefined;
    const mergedPayload =
      update.payload !== undefined ? { ...(payload ?? {}), ...(update.payload ?? {}) } : payload;
    const fields: string[] = [];
    const params: any[] = [];
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

  async createCommandRun(record: CommandRunInsert): Promise<CommandRunRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO command_runs (id, workspace_id, command_name, job_id, task_ids_json, git_branch, git_base_branch, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.workspaceId,
      record.commandName,
      record.jobId ?? null,
      record.taskIds ? JSON.stringify(record.taskIds) : null,
      record.gitBranch ?? null,
      record.gitBaseBranch ?? null,
      record.startedAt,
      record.status,
    );
    return { id, ...record, completedAt: null, errorSummary: null, durationSeconds: null };
  }

  async completeCommandRun(
    id: string,
    update: { status: CommandStatus; completedAt: string; errorSummary?: string | null; durationSeconds?: number | null },
  ): Promise<void> {
    await this.db.run(
      `UPDATE command_runs
       SET status = ?, completed_at = ?, error_summary = ?, duration_seconds = ?
       WHERE id = ?`,
      update.status,
      update.completedAt,
      update.errorSummary ?? null,
      update.durationSeconds ?? null,
      id,
    );
  }

  async createTaskRun(record: TaskRunInsert): Promise<TaskRunRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO task_runs (id, task_id, command, job_id, command_run_id, agent_id, status, started_at, finished_at, story_points_at_run, sp_per_hour_effective, git_branch, git_base_branch, git_commit_sha, run_context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.taskId,
      record.command,
      record.jobId ?? null,
      record.commandRunId ?? null,
      record.agentId ?? null,
      record.status,
      record.startedAt,
      record.finishedAt ?? null,
      record.storyPointsAtRun ?? null,
      record.spPerHourEffective ?? null,
      record.gitBranch ?? null,
      record.gitBaseBranch ?? null,
      record.gitCommitSha ?? null,
      record.runContext ? JSON.stringify(record.runContext) : null,
    );
    return { id, ...record };
  }

  async recordTokenUsage(entry: TokenUsageInsert): Promise<void> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO token_usage (id, workspace_id, agent_id, model_name, job_id, command_run_id, task_run_id, task_id, project_id, epic_id, user_story_id, tokens_prompt, tokens_completion, tokens_total, cost_estimate, duration_seconds, timestamp, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.workspaceId,
      entry.agentId ?? null,
      entry.modelName ?? null,
      entry.jobId ?? null,
      entry.commandRunId ?? null,
      entry.taskRunId ?? null,
      entry.taskId ?? null,
      entry.projectId ?? null,
      entry.epicId ?? null,
      entry.userStoryId ?? null,
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
