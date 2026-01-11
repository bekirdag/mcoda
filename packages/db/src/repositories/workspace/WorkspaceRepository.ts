import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "sqlite";
import { Connection } from "../../sqlite/connection.js";
import { WorkspaceMigrations } from "../../migrations/workspace/WorkspaceMigrations.js";

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "partial";
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

export interface TaskLockRow {
  taskId: string;
  taskRunId: string;
  jobId?: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface TaskQaRunInsert {
  taskId: string;
  taskRunId?: string | null;
  jobId?: string | null;
  commandRunId?: string | null;
  agentId?: string | null;
  modelName?: string | null;
  source: string;
  mode?: string | null;
  profileName?: string | null;
  runner?: string | null;
  rawOutcome?: string | null;
  recommendation?: string | null;
  evidenceUrl?: string | null;
  artifacts?: string[] | null;
  rawResult?: Record<string, unknown> | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface TaskQaRunRow extends TaskQaRunInsert {
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

export interface TaskCommentInsert {
  taskId: string;
  taskRunId?: string | null;
  jobId?: string | null;
  sourceCommand: string;
  authorType: "agent" | "human";
  authorAgentId?: string | null;
  category?: string | null;
  slug?: string | null;
  status?: string | null;
  file?: string | null;
  line?: number | null;
  pathHint?: string | null;
  body: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
}

export interface TaskCommentRow extends TaskCommentInsert {
  id: string;
}

export interface TaskReviewInsert {
  taskId: string;
  jobId?: string | null;
  agentId?: string | null;
  modelName?: string | null;
  decision: string;
  summary?: string | null;
  findingsJson?: Record<string, unknown> | unknown[] | null;
  testRecommendationsJson?: string[] | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  createdBy?: string | null;
}

export interface TaskReviewRow extends TaskReviewInsert {
  id: string;
}

export class WorkspaceRepository {
  private static txLocks = new Map<string, Promise<void>>();
  private workspaceKey: string;

  constructor(private db: Database, private connection?: Connection) {
    this.workspaceKey = connection?.dbPath ?? "workspace";
  }

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

  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.workspaceKey;
    const prev = WorkspaceRepository.txLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    WorkspaceRepository.txLocks.set(
      key,
      prev
        .catch(() => {
          /* ignore */
        })
        .then(() => next),
    );
    try {
      const result = await fn();
      return result;
    } finally {
      release();
    }
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    const MAX_RETRIES = 5;
    const BASE_BACKOFF_MS = 200;
    const run = async () => {
      await this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        await this.db.exec("COMMIT");
        return result;
      } catch (error) {
        await this.db.exec("ROLLBACK");
        throw error;
      }
    };
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.serialize(run);
      } catch (error) {
        const message = (error as Error).message ?? "";
        const isBusy = message.includes("SQLITE_BUSY") || message.includes("database is locked") || message.includes("busy");
        if (!isBusy || attempt === MAX_RETRIES) {
          if (isBusy && attempt === MAX_RETRIES) {
            console.warn(
              `Workspace DB is busy/locked after ${MAX_RETRIES} attempts for ${this.workspaceKey}. ` +
                `If another mcoda command is running, please wait and retry.`,
            );
          }
          throw error;
        }
        const backoff = BASE_BACKOFF_MS * attempt;
        await delay(backoff);
      }
    }
    // Should never reach here
    return this.serialize(run);
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

  async getProjectById(id: string): Promise<ProjectRow | undefined> {
    const row = await this.db.get(
      `SELECT id, key, name, description, metadata_json, created_at, updated_at FROM projects WHERE id = ?`,
      id,
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

  async deleteProjectBacklog(projectId: string, useTransaction = true): Promise<void> {
    const run = async () => {
      // Remove task-related rows first to satisfy foreign keys.
      await this.db.run(
        `DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)
           OR depends_on_task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        projectId,
        projectId,
      );
      await this.db.run(
        `DELETE FROM task_runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        projectId,
      );
      await this.db.run(
        `DELETE FROM task_qa_runs WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        projectId,
      );
      await this.db.run(
        `DELETE FROM task_revisions WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        projectId,
      );
      await this.db.run(
        `DELETE FROM task_comments WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        projectId,
      );
      await this.db.run(
        `DELETE FROM task_reviews WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)`,
        projectId,
      );
      await this.db.run(`DELETE FROM tasks WHERE project_id = ?`, projectId);
      await this.db.run(`DELETE FROM user_stories WHERE project_id = ?`, projectId);
      await this.db.run(`DELETE FROM epics WHERE project_id = ?`, projectId);
    };
    if (useTransaction) {
      await this.withTransaction(run);
    } else {
      await run();
    }
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

  async setCommandRunJobId(id: string, jobId: string): Promise<void> {
    await this.db.run(`UPDATE command_runs SET job_id = ? WHERE id = ?`, jobId, id);
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

  async getTasksWithRelations(taskIds: string[]): Promise<
    Array<
      TaskRow & {
        epicKey: string;
        storyKey: string;
        epicTitle?: string;
        epicDescription?: string;
        storyTitle?: string;
        storyDescription?: string;
        acceptanceCriteria?: string[];
      }
    >
  > {
    if (!taskIds.length) return [];
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = await this.db.all<any[]>(
      `
        SELECT
          t.id as task_id,
          t.project_id as project_id,
          t.key as task_key,
          t.status as task_status,
          t.priority as task_priority,
          t.story_points as task_story_points,
          t.created_at as task_created_at,
          t.updated_at as task_updated_at,
          t.description as task_description,
          t.title as task_title,
          t.type as task_type,
          t.metadata_json as task_metadata,
          t.assigned_agent_id as task_assigned_agent_id,
          t.assignee_human as task_assignee_human,
          t.vcs_branch as task_vcs_branch,
          t.vcs_base_branch as task_vcs_base_branch,
          t.vcs_last_commit_sha as task_vcs_last_commit_sha,
          e.id as epic_id,
          e.key as epic_key,
          e.title as epic_title,
          e.description as epic_description,
          us.id as story_id,
          us.key as story_key,
          us.title as story_title,
          us.description as story_description,
          us.acceptance_criteria as story_acceptance
        FROM tasks t
        JOIN epics e ON e.id = t.epic_id
        JOIN user_stories us ON us.id = t.user_story_id
        WHERE t.id IN (${placeholders})
      `,
      ...taskIds,
    );

    return rows.map((row) => ({
      id: row.task_id,
      projectId: row.project_id,
      epicId: row.epic_id,
      userStoryId: row.story_id,
      key: row.task_key,
      title: row.task_title,
      description: row.task_description ?? "",
      type: row.task_type ?? undefined,
      status: row.task_status,
      storyPoints: row.task_story_points ?? undefined,
      priority: row.task_priority ?? undefined,
      assignedAgentId: row.task_assigned_agent_id ?? undefined,
      assigneeHuman: row.task_assignee_human ?? undefined,
      vcsBranch: row.task_vcs_branch ?? undefined,
      vcsBaseBranch: row.task_vcs_base_branch ?? undefined,
      vcsLastCommitSha: row.task_vcs_last_commit_sha ?? undefined,
      metadata: row.task_metadata ? JSON.parse(row.task_metadata) : undefined,
      openapiVersionAtCreation: undefined,
      createdAt: row.task_created_at,
      updatedAt: row.task_updated_at,
      epicKey: row.epic_key,
      storyKey: row.story_key,
      epicTitle: row.epic_title ?? undefined,
      epicDescription: row.epic_description ?? undefined,
      storyTitle: row.story_title ?? undefined,
      storyDescription: row.story_description ?? undefined,
      acceptanceCriteria: row.story_acceptance
        ? (row.story_acceptance as string)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    }));
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

  async getTaskLock(taskId: string): Promise<TaskLockRow | undefined> {
    const row = await this.db.get(
      `SELECT task_id, task_run_id, job_id, acquired_at, expires_at FROM task_locks WHERE task_id = ?`,
      taskId,
    );
    if (!row) return undefined;
    return {
      taskId: row.task_id,
      taskRunId: row.task_run_id,
      jobId: row.job_id ?? undefined,
      acquiredAt: row.acquired_at,
      expiresAt: row.expires_at,
    };
  }

  async tryAcquireTaskLock(
    taskId: string,
    taskRunId: string,
    jobId?: string | null,
    ttlSeconds = 3600,
  ): Promise<{ acquired: boolean; lock?: TaskLockRow }> {
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    return this.withTransaction(async () => {
      const result = await this.db.run(
        `INSERT INTO task_locks (task_id, task_run_id, job_id, acquired_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           task_run_id = excluded.task_run_id,
           job_id = excluded.job_id,
           acquired_at = excluded.acquired_at,
           expires_at = excluded.expires_at
         WHERE task_locks.expires_at < ?
           OR NOT EXISTS (
             SELECT 1
             FROM task_runs
             WHERE task_runs.id = task_locks.task_run_id
               AND task_runs.status = 'running'
           )`,
        taskId,
        taskRunId,
        jobId ?? null,
        nowIso,
        expiresAt,
        nowIso,
      );
      if (result?.changes && result.changes > 0) {
        return {
          acquired: true,
          lock: {
            taskId,
            taskRunId,
            jobId: jobId ?? undefined,
            acquiredAt: nowIso,
            expiresAt,
          },
        };
      }
      const existing = await this.getTaskLock(taskId);
      return { acquired: false, lock: existing };
    });
  }

  async releaseTaskLock(taskId: string, taskRunId: string): Promise<void> {
    await this.db.run(`DELETE FROM task_locks WHERE task_id = ? AND task_run_id = ?`, taskId, taskRunId);
  }

  async refreshTaskLock(taskId: string, taskRunId: string, ttlSeconds = 3600): Promise<boolean> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const result = await this.db.run(
      `UPDATE task_locks SET expires_at = ? WHERE task_id = ? AND task_run_id = ?`,
      expiresAt,
      taskId,
      taskRunId,
    );
    return Boolean(result?.changes && result.changes > 0);
  }

  async createTaskQaRun(record: TaskQaRunInsert): Promise<TaskQaRunRow> {
    const id = randomUUID();
    const createdAt = record.createdAt ?? new Date().toISOString();
    await this.db.run(
      `INSERT INTO task_qa_runs (id, task_id, task_run_id, job_id, command_run_id, agent_id, model_name, source, mode, profile_name, runner, raw_outcome, recommendation, evidence_url, artifacts_json, raw_result_json, started_at, finished_at, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.taskId,
      record.taskRunId ?? null,
      record.jobId ?? null,
      record.commandRunId ?? null,
      record.agentId ?? null,
      record.modelName ?? null,
      record.source,
      record.mode ?? null,
      record.profileName ?? null,
      record.runner ?? null,
      record.rawOutcome ?? null,
      record.recommendation ?? null,
      record.evidenceUrl ?? null,
      record.artifacts ? JSON.stringify(record.artifacts) : null,
      record.rawResult ? JSON.stringify(record.rawResult) : null,
      record.startedAt ?? null,
      record.finishedAt ?? null,
      record.metadata ? JSON.stringify(record.metadata) : null,
      createdAt,
    );
    return { id, ...record, createdAt };
  }

  async listTaskQaRuns(taskId: string): Promise<TaskQaRunRow[]> {
    const rows = await this.db.all(
      `SELECT id, task_id, task_run_id, job_id, command_run_id, agent_id, model_name, source, mode, profile_name, runner, raw_outcome, recommendation, evidence_url, artifacts_json, raw_result_json, started_at, finished_at, metadata_json, created_at
       FROM task_qa_runs
       WHERE task_id = ?
       ORDER BY created_at DESC`,
      taskId,
    );
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      taskRunId: row.task_run_id ?? undefined,
      jobId: row.job_id ?? undefined,
      commandRunId: row.command_run_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      modelName: row.model_name ?? undefined,
      source: row.source,
      mode: row.mode ?? undefined,
      profileName: row.profile_name ?? undefined,
      runner: row.runner ?? undefined,
      rawOutcome: row.raw_outcome ?? undefined,
      recommendation: row.recommendation ?? undefined,
      evidenceUrl: row.evidence_url ?? undefined,
      artifacts: row.artifacts_json ? JSON.parse(row.artifacts_json) : undefined,
      rawResult: row.raw_result_json ? JSON.parse(row.raw_result_json) : undefined,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
    }));
  }

  async listTaskQaRunsForJob(taskIds: string[], jobId: string): Promise<TaskQaRunRow[]> {
    if (!taskIds.length) return [];
    const placeholders = taskIds.map(() => '?').join(', ');
    const rows = await this.db.all(
      `SELECT id, task_id, task_run_id, job_id, command_run_id, agent_id, model_name, source, mode, profile_name, runner, raw_outcome, recommendation, evidence_url, artifacts_json, raw_result_json, started_at, finished_at, metadata_json, created_at
       FROM task_qa_runs
       WHERE job_id = ? AND task_id IN (${placeholders})
       ORDER BY created_at DESC`,
      jobId,
      ...taskIds,
    );
    return rows.map((row: any) => ({
      id: row.id,
      taskId: row.task_id,
      taskRunId: row.task_run_id ?? undefined,
      jobId: row.job_id ?? undefined,
      commandRunId: row.command_run_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      modelName: row.model_name ?? undefined,
      source: row.source,
      mode: row.mode ?? undefined,
      profileName: row.profile_name ?? undefined,
      runner: row.runner ?? undefined,
      rawOutcome: row.raw_outcome ?? undefined,
      recommendation: row.recommendation ?? undefined,
      evidenceUrl: row.evidence_url ?? undefined,
      artifacts: row.artifacts_json ? JSON.parse(row.artifacts_json) : undefined,
      rawResult: row.raw_result_json ? JSON.parse(row.raw_result_json) : undefined,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
    }));
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

  async createTaskComment(record: TaskCommentInsert): Promise<TaskCommentRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO task_comments (id, task_id, task_run_id, job_id, source_command, author_type, author_agent_id, category, slug, status, file, line, path_hint, body, metadata_json, created_at, resolved_at, resolved_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.taskId,
      record.taskRunId ?? null,
      record.jobId ?? null,
      record.sourceCommand,
      record.authorType,
      record.authorAgentId ?? null,
      record.category ?? null,
      record.slug ?? null,
      record.status ?? "open",
      record.file ?? null,
      record.line ?? null,
      record.pathHint ?? null,
      record.body,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.createdAt,
      record.resolvedAt ?? null,
      record.resolvedBy ?? null,
    );
    return { ...record, id, status: record.status ?? "open" };
  }

  async listTaskComments(
    taskId: string,
    options: { sourceCommands?: string[]; limit?: number; slug?: string | string[]; resolved?: boolean } = {},
  ): Promise<TaskCommentRow[]> {
    const clauses = ["task_id = ?"];
    const params: any[] = [taskId];
    if (options.sourceCommands && options.sourceCommands.length) {
      clauses.push(`source_command IN (${options.sourceCommands.map(() => "?").join(", ")})`);
      params.push(...options.sourceCommands);
    }
    if (options.slug) {
      const slugs = Array.isArray(options.slug) ? options.slug : [options.slug];
      if (slugs.length) {
        clauses.push(`slug IN (${slugs.map(() => "?").join(", ")})`);
        params.push(...slugs);
      }
    }
    if (options.resolved === true) {
      clauses.push("resolved_at IS NOT NULL");
    } else if (options.resolved === false) {
      clauses.push("resolved_at IS NULL");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT ${options.limit}` : "";
    const rows = await this.db.all<any[]>(
      `SELECT id, task_id, task_run_id, job_id, source_command, author_type, author_agent_id, category, slug, status, file, line, path_hint, body, metadata_json, created_at, resolved_at, resolved_by
       FROM task_comments
       ${where}
       ORDER BY datetime(created_at) DESC
       ${limitClause}`,
      ...params,
    );
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      taskRunId: row.task_run_id ?? undefined,
      jobId: row.job_id ?? undefined,
      sourceCommand: row.source_command,
      authorType: row.author_type,
      authorAgentId: row.author_agent_id ?? undefined,
      category: row.category ?? undefined,
      slug: row.slug ?? undefined,
      status: row.status ?? undefined,
      file: row.file ?? undefined,
      line: row.line ?? undefined,
      pathHint: row.path_hint ?? undefined,
      body: row.body,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at ?? undefined,
      resolvedBy: row.resolved_by ?? undefined,
    }));
  }

  async resolveTaskComment(params: { taskId: string; slug: string; resolvedAt: string; resolvedBy?: string | null }): Promise<void> {
    await this.db.run(
      `UPDATE task_comments
       SET resolved_at = ?, resolved_by = ?, status = ?
       WHERE task_id = ? AND slug = ?`,
      params.resolvedAt,
      params.resolvedBy ?? null,
      "resolved",
      params.taskId,
      params.slug,
    );
  }

  async reopenTaskComment(params: { taskId: string; slug: string }): Promise<void> {
    await this.db.run(
      `UPDATE task_comments
       SET resolved_at = NULL, resolved_by = NULL, status = ?
       WHERE task_id = ? AND slug = ?`,
      "open",
      params.taskId,
      params.slug,
    );
  }

  async createTaskReview(record: TaskReviewInsert): Promise<TaskReviewRow> {
    const id = randomUUID();
    await this.db.run(
      `INSERT INTO task_reviews (id, task_id, job_id, agent_id, model_name, decision, summary, findings_json, test_recommendations_json, metadata_json, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      record.taskId,
      record.jobId ?? null,
      record.agentId ?? null,
      record.modelName ?? null,
      record.decision,
      record.summary ?? null,
      record.findingsJson ? JSON.stringify(record.findingsJson) : null,
      record.testRecommendationsJson ? JSON.stringify(record.testRecommendationsJson) : null,
      record.metadata ? JSON.stringify(record.metadata) : null,
      record.createdAt,
      record.createdBy ?? null,
    );
    return { ...record, id };
  }

  async getLatestTaskReview(taskId: string): Promise<TaskReviewRow | undefined> {
    const row = await this.db.get<any>(
      `SELECT id, task_id, job_id, agent_id, model_name, decision, summary, findings_json, test_recommendations_json, metadata_json, created_at, created_by
       FROM task_reviews
       WHERE task_id = ?
       ORDER BY datetime(created_at) DESC
       LIMIT 1`,
      taskId,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      taskId: row.task_id,
      jobId: row.job_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      modelName: row.model_name ?? undefined,
      decision: row.decision,
      summary: row.summary ?? undefined,
      findingsJson: row.findings_json ? JSON.parse(row.findings_json) : undefined,
      testRecommendationsJson: row.test_recommendations_json ? JSON.parse(row.test_recommendations_json) : undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      createdBy: row.created_by ?? undefined,
    };
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

  async getEpicByKey(projectId: string, key: string): Promise<EpicRow | undefined> {
    const row = await this.db.get(
      `SELECT id, project_id, key, title, description, story_points_total, priority, metadata_json, created_at, updated_at FROM epics WHERE project_id = ? AND key = ?`,
      projectId,
      key,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      key: row.key,
      title: row.title,
      description: row.description ?? undefined,
      storyPointsTotal: row.story_points_total ?? undefined,
      priority: row.priority ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getStoryByKey(epicId: string, key: string): Promise<StoryRow | undefined> {
    const row = await this.db.get(
      `SELECT id, project_id, epic_id, key, title, description, acceptance_criteria, story_points_total, priority, metadata_json, created_at, updated_at FROM user_stories WHERE epic_id = ? AND key = ?`,
      epicId,
      key,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      key: row.key,
      title: row.title,
      description: row.description ?? undefined,
      acceptanceCriteria: row.acceptance_criteria ?? undefined,
      storyPointsTotal: row.story_points_total ?? undefined,
      priority: row.priority ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getStoryByProjectAndKey(projectId: string, key: string): Promise<StoryRow | undefined> {
    const row = await this.db.get(
      `SELECT id, project_id, epic_id, key, title, description, acceptance_criteria, story_points_total, priority, metadata_json, created_at, updated_at FROM user_stories WHERE project_id = ? AND key = ?`,
      projectId,
      key,
    );
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      epicId: row.epic_id,
      key: row.key,
      title: row.title,
      description: row.description ?? undefined,
      acceptanceCriteria: row.acceptance_criteria ?? undefined,
      storyPointsTotal: row.story_points_total ?? undefined,
      priority: row.priority ?? undefined,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

}
