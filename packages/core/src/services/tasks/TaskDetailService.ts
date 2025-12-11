import fs from "node:fs/promises";
import { Connection, WorkspaceRepository, GlobalRepository, type TaskCommentRow, type Database } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import type { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { TaskApiResolver } from "./TaskApiResolver.js";

const hasTables = async (db: Database, required: string[]): Promise<boolean> => {
  const placeholders = required.map(() => "?").join(", ");
  const rows = await db.all<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    required,
  );
  return rows.length === required.length;
};

export interface DependencySummary {
  taskId: string;
  key: string;
  status: string;
  relationType: string;
}

export interface TaskLogSummary {
  taskRunId: string;
  timestamp: string;
  level?: string | null;
  source?: string | null;
  message?: string | null;
  command?: string;
  status?: string;
  details?: Record<string, unknown> | null;
}

export interface TaskRevisionSummary {
  id: string;
  jobId?: string | null;
  commandRunId?: string | null;
  changedAt: string;
  statusBefore?: string;
  statusAfter?: string;
  storyPointsBefore?: number | null;
  storyPointsAfter?: number | null;
  changedFields?: string[];
  snapshotBefore?: Record<string, unknown> | null;
  snapshotAfter?: Record<string, unknown> | null;
}

export interface TaskDetailRecord {
  id: string;
  key: string;
  title: string;
  description?: string | null;
  type?: string | null;
  status: string;
  storyPoints?: number | null;
  priority?: number | null;
  assignedAgentId?: string | null;
  assignedAgentSlug?: string | null;
  assigneeHuman?: string | null;
  vcsBranch?: string | null;
  vcsBaseBranch?: string | null;
  vcsLastCommitSha?: string | null;
  metadata?: Record<string, unknown> | null;
  project: { id: string; key: string; name?: string | null };
  epic: { id: string; key: string; title: string };
  story: { id: string; key: string; title: string };
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetailResult {
  task: TaskDetailRecord;
  dependencies: { upstream: DependencySummary[]; downstream: DependencySummary[] };
  comments: TaskCommentRow[];
  logs?: TaskLogSummary[];
  history?: TaskRevisionSummary[];
}

export interface TaskDetailOptions {
  taskKey: string;
  projectKey?: string;
  includeLogs?: boolean;
  includeHistory?: boolean;
  commentsLimit?: number;
  logsLimit?: number;
  historyLimit?: number;
}

interface TaskRowWithRelations {
  task_id: string;
  task_key: string;
  task_title: string;
  task_description: string | null;
  task_type: string | null;
  task_status: string;
  task_story_points: number | null;
  task_priority: number | null;
  assigned_agent_id: string | null;
  assignee_human: string | null;
  vcs_branch: string | null;
  vcs_base_branch: string | null;
  vcs_last_commit_sha: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  project_id: string;
  project_key: string;
  project_name: string | null;
  epic_id: string;
  epic_key: string;
  epic_title: string;
  story_id: string;
  story_key: string;
  story_title: string;
}

export class TaskDetailService {
  private constructor(
    private workspace: WorkspaceResolution,
    private db: Database,
    private repo: WorkspaceRepository,
    private globalRepo?: GlobalRepository,
    private apiResolver: TaskApiResolver = new TaskApiResolver(),
  ) {}

  static async create(workspace: WorkspaceResolution): Promise<TaskDetailService> {
    const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
    try {
      await fs.access(dbPath);
    } catch {
      throw new Error(`No workspace DB found at ${dbPath}. Run mcoda create-tasks first or ensure it exists.`);
    }
    const connection = await Connection.open(dbPath);
    const ok = await hasTables(connection.db, ["projects", "epics", "user_stories", "tasks"]);
    if (!ok) {
      await connection.close();
      throw new Error(`Workspace DB at ${dbPath} is missing required tables. Re-run create-tasks to seed it.`);
    }
    const repo = new WorkspaceRepository(connection.db, connection);
    return new TaskDetailService(workspace, connection.db, repo, undefined, new TaskApiResolver());
  }

  async close(): Promise<void> {
    await this.repo.close();
    if (this.globalRepo) {
      await this.globalRepo.close();
    }
  }

  getRepository(): WorkspaceRepository {
    return this.repo;
  }

  async getTaskDetail(options: TaskDetailOptions): Promise<TaskDetailResult> {
    if (!options.taskKey) {
      throw new Error("taskKey is required");
    }
    const task = await this.resolveTask(options.taskKey, options.projectKey);
    const dependencies = await this.getDependencies(task.id);
    const comments = await this.repo.listTaskComments(task.id, { limit: options.commentsLimit ?? 20 });
    const logs = options.includeLogs ? await this.getLogs(task.id, options.logsLimit ?? 20) : undefined;
    const history = options.includeHistory ? await this.getHistory(task.id, options.historyLimit ?? 20) : undefined;

    return {
      task,
      dependencies,
      comments,
      logs,
      history,
    };
  }

  private async resolveTask(taskKey: string, projectKey?: string): Promise<TaskDetailRecord> {
    const openApiTaskId = await this.apiResolver.resolveTaskId(taskKey, projectKey);
    if (openApiTaskId) {
      return this.resolveTaskById(openApiTaskId);
    }

    const clauses = ["t.key = ?"];
    const params: any[] = [taskKey];
    if (projectKey) {
      clauses.push("p.key = ?");
      params.push(projectKey);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = await this.db.all<TaskRowWithRelations[]>(
      `
      SELECT
        t.id AS task_id,
        t.key AS task_key,
        t.title AS task_title,
        t.description AS task_description,
        t.type AS task_type,
        t.status AS task_status,
        t.story_points AS task_story_points,
        t.priority AS task_priority,
        t.assigned_agent_id AS assigned_agent_id,
        t.assignee_human AS assignee_human,
        t.vcs_branch AS vcs_branch,
        t.vcs_base_branch AS vcs_base_branch,
        t.vcs_last_commit_sha AS vcs_last_commit_sha,
        t.metadata_json AS metadata_json,
        t.created_at AS created_at,
        t.updated_at AS updated_at,
        p.id AS project_id,
        p.key AS project_key,
        p.name AS project_name,
        e.id AS epic_id,
        e.key AS epic_key,
        e.title AS epic_title,
        us.id AS story_id,
        us.key AS story_key,
        us.title AS story_title
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      INNER JOIN epics e ON e.id = t.epic_id
      INNER JOIN user_stories us ON us.id = t.user_story_id
      ${where}
    `,
      params,
    );

    if (!rows || rows.length === 0) {
      const suffix = projectKey ? ` in project "${projectKey}"` : "";
      throw new Error(`No task with key "${taskKey}"${suffix}.`);
    }
    if (rows.length > 1 && !projectKey) {
      throw new Error(`Multiple tasks found with key "${taskKey}"; please specify --project.`);
    }
    const row = rows[0];
    const assignedAgentSlug = await this.resolveAgentSlug(row.assigned_agent_id);
    return {
      id: row.task_id,
      key: row.task_key,
      title: row.task_title,
      description: row.task_description,
      type: row.task_type,
      status: row.task_status,
      storyPoints: row.task_story_points,
      priority: row.task_priority,
      assignedAgentId: row.assigned_agent_id,
      assignedAgentSlug: assignedAgentSlug ?? null,
      assigneeHuman: row.assignee_human,
      vcsBranch: row.vcs_branch,
      vcsBaseBranch: row.vcs_base_branch,
      vcsLastCommitSha: row.vcs_last_commit_sha,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      project: {
        id: row.project_id,
        key: row.project_key,
        name: row.project_name,
      },
      epic: {
        id: row.epic_id,
        key: row.epic_key,
        title: row.epic_title,
      },
      story: {
        id: row.story_id,
        key: row.story_key,
        title: row.story_title,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async getDependencies(taskId: string): Promise<{ upstream: DependencySummary[]; downstream: DependencySummary[] }> {
    const upstream = await this.db.all<DependencySummary[]>(
      `
      SELECT td.depends_on_task_id AS taskId, dep.key AS key, dep.status AS status, td.relation_type AS relationType
      FROM task_dependencies td
      INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
      WHERE td.task_id = ?
      ORDER BY dep.key
    `,
      taskId,
    );
    const downstream = await this.db.all<DependencySummary[]>(
      `
      SELECT td.task_id AS taskId, t.key AS key, t.status AS status, td.relation_type AS relationType
      FROM task_dependencies td
      INNER JOIN tasks t ON t.id = td.task_id
      WHERE td.depends_on_task_id = ?
      ORDER BY t.key
    `,
      taskId,
    );
    return { upstream: upstream ?? [], downstream: downstream ?? [] };
  }

  private async resolveTaskById(taskId: string): Promise<TaskDetailRecord> {
    const rows = await this.db.all<TaskRowWithRelations[]>(
      `
      SELECT
        t.id AS task_id,
        t.key AS task_key,
        t.title AS task_title,
        t.description AS task_description,
        t.type AS task_type,
        t.status AS task_status,
        t.story_points AS task_story_points,
        t.priority AS task_priority,
        t.assigned_agent_id AS assigned_agent_id,
        t.assignee_human AS assignee_human,
        t.vcs_branch AS vcs_branch,
        t.vcs_base_branch AS vcs_base_branch,
        t.vcs_last_commit_sha AS vcs_last_commit_sha,
        t.metadata_json AS metadata_json,
        t.created_at AS created_at,
        t.updated_at AS updated_at,
        p.id AS project_id,
        p.key AS project_key,
        p.name AS project_name,
        e.id AS epic_id,
        e.key AS epic_key,
        e.title AS epic_title,
        us.id AS story_id,
        us.key AS story_key,
        us.title AS story_title
      FROM tasks t
      INNER JOIN projects p ON p.id = t.project_id
      INNER JOIN epics e ON e.id = t.epic_id
      INNER JOIN user_stories us ON us.id = t.user_story_id
      WHERE t.id = ?
    `,
      [taskId],
    );
    if (!rows || rows.length === 0) {
      throw new Error(`Task with id "${taskId}" not found in local DB.`);
    }
    const row = rows[0];
    const assignedAgentSlug = await this.resolveAgentSlug(row.assigned_agent_id);
    return {
      id: row.task_id,
      key: row.task_key,
      title: row.task_title,
      description: row.task_description,
      type: row.task_type,
      status: row.task_status,
      storyPoints: row.task_story_points,
      priority: row.task_priority,
      assignedAgentId: row.assigned_agent_id,
      assignedAgentSlug: assignedAgentSlug ?? null,
      assigneeHuman: row.assignee_human,
      vcsBranch: row.vcs_branch,
      vcsBaseBranch: row.vcs_base_branch,
      vcsLastCommitSha: row.vcs_last_commit_sha,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      project: {
        id: row.project_id,
        key: row.project_key,
        name: row.project_name,
      },
      epic: {
        id: row.epic_id,
        key: row.epic_key,
        title: row.epic_title,
      },
      story: {
        id: row.story_id,
        key: row.story_key,
        title: row.story_title,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async getLogs(taskId: string, limit: number): Promise<TaskLogSummary[]> {
    const rows = await this.db.all<
      {
        task_run_id: string;
        timestamp: string;
        level: string | null;
        source: string | null;
        message: string | null;
        details_json: string | null;
        command: string;
        status: string;
      }[]
    >(
      `
      SELECT l.task_run_id, l.timestamp, l.level, l.source, l.message, l.details_json, r.command, r.status
      FROM task_logs l
      INNER JOIN task_runs r ON r.id = l.task_run_id
      WHERE r.task_id = ?
      ORDER BY datetime(l.timestamp) DESC
      LIMIT ?
    `,
      taskId,
      limit,
    );
    return (rows ?? []).map((row) => ({
      taskRunId: row.task_run_id,
      timestamp: row.timestamp,
      level: row.level,
      source: row.source,
      message: row.message,
      command: row.command,
      status: row.status,
      details: row.details_json ? (JSON.parse(row.details_json) as Record<string, unknown>) : null,
    }));
  }

  private async resolveAgentSlug(agentId: string | null): Promise<string | undefined> {
    if (!agentId) return undefined;
    if (!this.globalRepo) {
      this.globalRepo = await GlobalRepository.create();
    }
    const agent = await this.globalRepo.getAgentById(agentId);
    return agent?.slug ?? undefined;
  }

  private async getHistory(taskId: string, limit: number): Promise<TaskRevisionSummary[]> {
    const rows = await this.db.all<
      {
        id: string;
        job_id: string | null;
        command_run_id: string | null;
        snapshot_before_json: string | null;
        snapshot_after_json: string | null;
        created_at: string;
      }[]
    >(
      `
      SELECT id, job_id, command_run_id, snapshot_before_json, snapshot_after_json, created_at
      FROM task_revisions
      WHERE task_id = ?
      ORDER BY datetime(created_at) DESC
      LIMIT ?
    `,
      taskId,
      limit,
    );

    return (rows ?? []).map((row) => {
      const before = row.snapshot_before_json ? this.safeParse(row.snapshot_before_json) : null;
      const after = row.snapshot_after_json ? this.safeParse(row.snapshot_after_json) : null;
      const statusBefore = this.pickField<string>(before, ["status", "task_status"]);
      const statusAfter = this.pickField<string>(after, ["status", "task_status"]);
      const spBefore = this.pickField<number | null>(before, ["story_points", "storyPoints", "task_story_points"]);
      const spAfter = this.pickField<number | null>(after, ["story_points", "storyPoints", "task_story_points"]);
      const changedFields = this.diffFields(before, after);

      return {
        id: row.id,
        jobId: row.job_id,
        commandRunId: row.command_run_id,
        changedAt: row.created_at,
        statusBefore: statusBefore ?? undefined,
        statusAfter: statusAfter ?? undefined,
        storyPointsBefore: spBefore ?? null,
        storyPointsAfter: spAfter ?? null,
        changedFields,
        snapshotBefore: before,
        snapshotAfter: after,
      };
    });
  }

  private safeParse(raw: string): Record<string, unknown> | null {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private pickField<T>(obj: Record<string, unknown> | null, keys: string[]): T | null | undefined {
    if (!obj) return undefined;
    for (const key of keys) {
      if (obj[key] !== undefined) return obj[key] as T;
    }
    return undefined;
  }

  private diffFields(
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
  ): string[] | undefined {
    if (!before || !after) return undefined;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    const changed: string[] = [];
    for (const key of keys) {
      const lhs = before[key];
      const rhs = after[key];
      const same = JSON.stringify(lhs) === JSON.stringify(rhs);
      if (!same) changed.push(key);
    }
    return changed.length ? changed : undefined;
  }

}
