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
  spProcessed?: number | null;
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

export interface TaskRevisionInsert {
  taskId: string;
  jobId?: string | null;
  commandRunId?: string | null;
  snapshotBefore?: Record<string, unknown> | null;
  snapshotAfter?: Record<string, unknown> | null;
  createdAt: string;
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

  getDb(): Database {
    return this.db;
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

  async deleteTaskDependenciesForTask(taskId: string): Promise<void> {
    await this.db.run(
      `DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_task_id = ?`,
      taskId,
      taskId,
    );
  }

  async updateTask(
    taskId: string,
    updates: {
      title?: string;
      description?: string | null;
      type?: string | null;
      status?: string;
      storyPoints?: number | null;
      priority?: number | null;
      metadata?: Record<string, unknown> | null;
      assignedAgentId?: string | null;
      assigneeHuman?: string | null;
      vcsBranch?: string | null;
      vcsBaseBranch?: string | null;
      vcsLastCommitSha?: string | null;
    },
  ): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [];
    if (updates.title !== undefined) {
      fields.push("title = ?");
      params.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push("description = ?");
      params.push(updates.description);
    }
    if (updates.type !== undefined) {
      fields.push("type = ?");
      params.push(updates.type);
    }
    if (updates.status !== undefined) {
      fields.push("status = ?");
      params.push(updates.status);
    }
    if (updates.storyPoints !== undefined) {
      fields.push("story_points = ?");
      params.push(updates.storyPoints);
    }
    if (updates.priority !== undefined) {
      fields.push("priority = ?");
      params.push(updates.priority);
    }
    if (updates.metadata !== undefined) {
      fields.push("metadata_json = ?");
      params.push(updates.metadata ? JSON.stringify(updates.metadata) : null);
    }
    if (updates.assignedAgentId !== undefined) {
      fields.push("assigned_agent_id = ?");
      params.push(updates.assignedAgentId);
    }
    if (updates.assigneeHuman !== undefined) {
      fields.push("assignee_human = ?");
      params.push(updates.assigneeHuman);
    }
    if (updates.vcsBranch !== undefined) {
      fields.push("vcs_branch = ?");
      params.push(updates.vcsBranch);
    }
    if (updates.vcsBaseBranch !== undefined) {
      fields.push("vcs_base_branch = ?");
      params.push(updates.vcsBaseBranch);
    }
    if (updates.vcsLastCommitSha !== undefined) {
      fields.push("vcs_last_commit_sha = ?");
      params.push(updates.vcsLastCommitSha);
    }
    if (fields.length === 0) return;
    fields.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(taskId);
    await this.db.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, ...params);
  }

  async getTaskById(taskId: string): Promise<TaskRow | undefined> {
    const row = await this.db.get(
      `SELECT id, project_id, epic_id, user_story_id, key, title, description, type, status, story_points, priority, assigned_agent_id, assignee_human, vcs_branch, vcs_base_branch, vcs_last_commit_sha, metadata_json, openapi_version_at_creation, created_at, updated_at
       FROM tasks WHERE id = ?`,
      taskId,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      userStoryId: row.user_story_id,
      key: row.key,
      title: row.title,
      description: row.description ?? undefined,
      type: row.type ?? undefined,
      status: row.status,
      storyPoints: row.story_points ?? undefined,
      priority: row.priority ?? undefined,
      assignedAgentId: row.assigned_agent_id ?? undefined,
      assigneeHuman: row.assignee_human ?? undefined,
      vcsBranch: row.vcs_branch ?? undefined,
      vcsBaseBranch: row.vcs_base_branch ?? undefined,
      vcsLastCommitSha: row.vcs_last_commit_sha ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      openapiVersionAtCreation: row.openapi_version_at_creation ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getTaskByKey(taskKey: string): Promise<TaskRow | undefined> {
    const row = await this.db.get(
      `SELECT id, project_id, epic_id, user_story_id, key, title, description, type, status, story_points, priority, assigned_agent_id, assignee_human, vcs_branch, vcs_base_branch, vcs_last_commit_sha, metadata_json, openapi_version_at_creation, created_at, updated_at
       FROM tasks WHERE key = ?`,
      taskKey,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      userStoryId: row.user_story_id,
      key: row.key,
      title: row.title,
      description: row.description ?? undefined,
      type: row.type ?? undefined,
      status: row.status,
      storyPoints: row.story_points ?? undefined,
      priority: row.priority ?? undefined,
      assignedAgentId: row.assigned_agent_id ?? undefined,
      assigneeHuman: row.assignee_human ?? undefined,
      vcsBranch: row.vcs_branch ?? undefined,
      vcsBaseBranch: row.vcs_base_branch ?? undefined,
      vcsLastCommitSha: row.vcs_last_commit_sha ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      openapiVersionAtCreation: row.openapi_version_at_creation ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getTasksByIds(taskIds: string[]): Promise<TaskRow[]> {
    if (!taskIds.length) return [];
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = await this.db.all(
      `SELECT id, project_id, epic_id, user_story_id, key, title, description, type, status, story_points, priority, assigned_agent_id, assignee_human, vcs_branch, vcs_base_branch, vcs_last_commit_sha, metadata_json, openapi_version_at_creation, created_at, updated_at
       FROM tasks WHERE id IN (${placeholders})`,
      ...taskIds,
    );
    return rows.map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      userStoryId: row.user_story_id,
      key: row.key,
      title: row.title,
      description: row.description ?? undefined,
      type: row.type ?? undefined,
      status: row.status,
      storyPoints: row.story_points ?? undefined,
      priority: row.priority ?? undefined,
      assignedAgentId: row.assigned_agent_id ?? undefined,
      assigneeHuman: row.assignee_human ?? undefined,
      vcsBranch: row.vcs_branch ?? undefined,
      vcsBaseBranch: row.vcs_base_branch ?? undefined,
      vcsLastCommitSha: row.vcs_last_commit_sha ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      openapiVersionAtCreation: row.openapi_version_at_creation ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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
      `INSERT INTO command_runs (id, workspace_id, command_name, job_id, task_ids_json, git_branch, git_base_branch, started_at, status, sp_processed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.workspaceId,
      record.commandName,
      record.jobId ?? null,
      record.taskIds ? JSON.stringify(record.taskIds) : null,
      record.gitBranch ?? null,
      record.gitBaseBranch ?? null,
      record.startedAt,
      record.status,
      record.spProcessed ?? null,
    );
    return { id, ...record, completedAt: null, errorSummary: null, durationSeconds: null };
  }

  async completeCommandRun(
    id: string,
    update: {
      status: CommandStatus;
      completedAt: string;
      errorSummary?: string | null;
      durationSeconds?: number | null;
      spProcessed?: number | null;
    },
  ): Promise<void> {
    await this.db.run(
      `UPDATE command_runs
       SET status = ?, completed_at = ?, error_summary = ?, duration_seconds = ?, sp_processed = ?
       WHERE id = ?`,
      update.status,
      update.completedAt,
      update.errorSummary ?? null,
      update.durationSeconds ?? null,
      update.spProcessed ?? null,
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

  async insertTaskLog(entry: {
    taskRunId: string;
    sequence: number;
    timestamp: string;
    level?: string | null;
    source?: string | null;
    message?: string | null;
    details?: Record<string, unknown> | null;
  }): Promise<void> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO task_logs (id, task_run_id, sequence, timestamp, level, source, message, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      entry.taskRunId,
      entry.sequence,
      entry.timestamp,
      entry.level ?? null,
      entry.source ?? null,
      entry.message ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    );
  }

  async updateTaskRun(
    id: string,
    update: {
      status?: TaskRunStatus;
      finishedAt?: string | null;
      gitBranch?: string | null;
      gitBaseBranch?: string | null;
      gitCommitSha?: string | null;
      storyPointsAtRun?: number | null;
      spPerHourEffective?: number | null;
      runContext?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const fields: string[] = [];
    const params: any[] = [];
    if (update.status !== undefined) {
      fields.push("status = ?");
      params.push(update.status);
    }
    if (update.finishedAt !== undefined) {
      fields.push("finished_at = ?");
      params.push(update.finishedAt);
    }
    if (update.gitBranch !== undefined) {
      fields.push("git_branch = ?");
      params.push(update.gitBranch);
    }
    if (update.gitBaseBranch !== undefined) {
      fields.push("git_base_branch = ?");
      params.push(update.gitBaseBranch);
    }
    if (update.gitCommitSha !== undefined) {
      fields.push("git_commit_sha = ?");
      params.push(update.gitCommitSha);
    }
    if (update.storyPointsAtRun !== undefined) {
      fields.push("story_points_at_run = ?");
      params.push(update.storyPointsAtRun);
    }
    if (update.spPerHourEffective !== undefined) {
      fields.push("sp_per_hour_effective = ?");
      params.push(update.spPerHourEffective);
    }
    if (update.runContext !== undefined) {
      fields.push("run_context_json = ?");
      params.push(update.runContext ? JSON.stringify(update.runContext) : null);
    }
    if (!fields.length) return;
    const clauses = fields.join(", ");
    params.push(id);
    await this.db.run(`UPDATE task_runs SET ${clauses} WHERE id = ?`, ...params);
  }

  async getTaskDependencies(taskIds: string[]): Promise<TaskDependencyRow[]> {
    if (!taskIds.length) return [];
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = await this.db.all(
      `SELECT id, task_id, depends_on_task_id, relation_type, created_at, updated_at
       FROM task_dependencies
       WHERE task_id IN (${placeholders})`,
      ...taskIds,
    );
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      dependsOnTaskId: row.depends_on_task_id,
      relationType: row.relation_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
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

  async insertTaskRevision(record: TaskRevisionInsert): Promise<void> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO task_revisions (id, task_id, job_id, command_run_id, snapshot_before_json, snapshot_after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.taskId,
      record.jobId ?? null,
      record.commandRunId ?? null,
      record.snapshotBefore ? JSON.stringify(record.snapshotBefore) : null,
      record.snapshotAfter ? JSON.stringify(record.snapshotAfter) : null,
      record.createdAt,
    );
  }
}
