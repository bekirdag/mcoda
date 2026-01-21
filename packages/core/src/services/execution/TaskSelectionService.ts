import { WorkspaceRepository, TaskRow, ProjectRow } from "@mcoda/db";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

export interface TaskSelectionFilters {
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  taskKeys?: string[];
  statusFilter?: string[];
  limit?: number;
  parallel?: number;
}

export interface SelectedTask {
  task: TaskRow & {
    epicKey: string;
    storyKey: string;
    epicTitle?: string;
    storyTitle?: string;
    storyDescription?: string;
    acceptanceCriteria?: string[];
  };
  dependencies: {
    ids: string[];
    keys: string[];
    blocking: string[];
  };
  blockedReason?: string;
}

export interface TaskSelectionPlan {
  project?: ProjectRow;
  filters: TaskSelectionFilters & { effectiveStatuses: string[] };
  ordered: SelectedTask[];
  blocked: SelectedTask[];
  warnings: string[];
}

const DEFAULT_IMPLEMENTATION_STATUSES = ["not_started", "in_progress"];
const DONE_DEPENDENCY_STATUSES = new Set(["completed", "cancelled"]);

const normalizeStatusList = (statuses?: string[]): string[] => {
  if (!statuses || statuses.length === 0) return DEFAULT_IMPLEMENTATION_STATUSES;
  return Array.from(new Set(statuses.map((s) => s.toLowerCase().trim()).filter(Boolean)));
};

const parseAcceptanceCriteria = (raw?: string | null): string[] | undefined => {
  if (!raw) return undefined;
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
};

type RawTaskRow = {
  task_id: string;
  task_key: string;
  task_status: string;
  task_priority: number | null;
  task_story_points: number | null;
  task_created_at: string;
  task_updated_at: string;
  project_id: string;
  task_description: string | null;
  task_title: string;
  task_type: string | null;
  task_metadata: string | null;
  task_assigned_agent_id: string | null;
  task_assignee_human: string | null;
  task_vcs_branch: string | null;
  task_vcs_base_branch: string | null;
  task_vcs_last_commit_sha: string | null;
  epic_id: string;
  epic_key: string;
  epic_title: string;
  epic_description: string | null;
  story_id: string;
  story_key: string;
  story_title: string;
  story_description: string | null;
  story_acceptance: string | null;
};

type DependencyRow = {
  taskId: string;
  dependsOnTaskId: string;
  relationType: string;
  createdAt: string;
  updatedAt: string;
  dependsOnKey?: string | null;
  dependsOnStatus?: string | null;
};

export class TaskSelectionService {
  constructor(private workspace: WorkspaceResolution, private workspaceRepo: WorkspaceRepository) {}

  static async create(workspace: WorkspaceResolution): Promise<TaskSelectionService> {
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    return new TaskSelectionService(workspace, workspaceRepo);
  }

  async close(): Promise<void> {
    await this.workspaceRepo.close();
  }

  private async fetchProject(projectKey?: string): Promise<ProjectRow | undefined> {
    if (!projectKey) return undefined;
    return this.workspaceRepo.getProjectByKey(projectKey);
  }

  private buildTaskFromRow(row: RawTaskRow): SelectedTask["task"] {
    return {
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
      storyTitle: row.story_title ?? undefined,
      storyDescription: row.story_description ?? undefined,
      acceptanceCriteria: parseAcceptanceCriteria(row.story_acceptance),
    };
  }

  private async loadTasks(filters: TaskSelectionFilters & { project?: ProjectRow }): Promise<RawTaskRow[]> {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filters.project?.id) {
      clauses.push("t.project_id = ?");
      params.push(filters.project.id);
    }
    if (filters.epicKey) {
      clauses.push("e.key = ?");
      params.push(filters.epicKey);
    }
    if (filters.storyKey) {
      clauses.push("us.key = ?");
      params.push(filters.storyKey);
    }
    if (filters.taskKeys && filters.taskKeys.length > 0) {
      clauses.push(`t.key IN (${filters.taskKeys.map(() => "?").join(", ")})`);
      params.push(...filters.taskKeys);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const db = this.workspaceRepo.getDb();
    return db.all<RawTaskRow[]>(
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
        ${where}
      `,
      ...params,
    );
  }

  private async loadDependencies(taskIds: string[]): Promise<Map<string, DependencyRow[]>> {
    if (taskIds.length === 0) return new Map();
    const placeholders = taskIds.map(() => "?").join(", ");
    const db = this.workspaceRepo.getDb();
    const rows = await db.all<any[]>(
      `
        SELECT td.id, td.task_id, td.depends_on_task_id, td.relation_type, td.created_at, td.updated_at,
               dep.key as depends_on_key, dep.status as depends_on_status
        FROM task_dependencies td
        LEFT JOIN tasks dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id IN (${placeholders})
      `,
      ...taskIds,
    );
    const grouped = new Map<string, DependencyRow[]>();
    for (const row of rows) {
      const normalized: DependencyRow = {
        taskId: row.task_id,
        dependsOnTaskId: row.depends_on_task_id,
        relationType: row.relation_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dependsOnKey: row.depends_on_key,
        dependsOnStatus: row.depends_on_status,
      };
      const arr = grouped.get(normalized.taskId) ?? [];
      arr.push(normalized);
      grouped.set(normalized.taskId, arr);
    }
    return grouped;
  }

  private async loadMissingContext(taskIds: string[]): Promise<Set<string>> {
    if (!taskIds.length) return new Set();
    const placeholders = taskIds.map(() => "?").join(", ");
    const db = this.workspaceRepo.getDb();
    const rows = await db.all<{ task_id: string }[]>(
      `
        SELECT DISTINCT task_id
        FROM task_comments
        WHERE task_id IN (${placeholders})
          AND LOWER(category) = 'missing_context'
          AND (status IS NULL OR LOWER(status) = 'open')
      `,
      ...taskIds,
    );
    return new Set(rows.map((row) => row.task_id));
  }

  private topologicalOrder(
    tasks: SelectedTask[],
    deps: Map<string, DependencyRow[]>,
  ): { ordered: SelectedTask[]; warnings: string[] } {
    const warnings: string[] = [];
    const taskMap = new Map<string, SelectedTask>(tasks.map((t) => [t.task.id, t]));
    const indegree = new Map<string, number>();
    const edges = new Map<string, string[]>();
    for (const task of tasks) {
      indegree.set(task.task.id, 0);
    }
    for (const task of tasks) {
      const rels = deps.get(task.task.id) ?? [];
      for (const dep of rels) {
        if (!dep.dependsOnTaskId) continue;
        if (!taskMap.has(dep.dependsOnTaskId)) continue;
        indegree.set(task.task.id, (indegree.get(task.task.id) ?? 0) + 1);
        const list = edges.get(dep.dependsOnTaskId) ?? [];
        list.push(task.task.id);
        edges.set(dep.dependsOnTaskId, list);
      }
    }
    const queue: SelectedTask[] = [];
    for (const task of tasks) {
      if ((indegree.get(task.task.id) ?? 0) === 0) {
        queue.push(task);
      }
    }
    const ordered: SelectedTask[] = [];
    while (queue.length) {
      queue.sort((a, b) => {
        const pa = a.task.priority ?? Number.POSITIVE_INFINITY;
        const pb = b.task.priority ?? Number.POSITIVE_INFINITY;
        if (pa !== pb) return pa - pb;
        const spa = a.task.storyPoints ?? Number.POSITIVE_INFINITY;
        const spb = b.task.storyPoints ?? Number.POSITIVE_INFINITY;
        if (spa !== spb) return spa - spb;
        const ca = Date.parse(a.task.createdAt) || 0;
        const cb = Date.parse(b.task.createdAt) || 0;
        if (ca !== cb) return ca - cb;
        const sa = a.task.status === "in_progress" ? 0 : 1;
        const sb = b.task.status === "in_progress" ? 0 : 1;
        return sa - sb;
      });
      const current = queue.shift()!;
      ordered.push(current);
      const targets = edges.get(current.task.id) ?? [];
      for (const tId of targets) {
        indegree.set(tId, (indegree.get(tId) ?? 0) - 1);
        if ((indegree.get(tId) ?? 0) === 0) {
          const node = taskMap.get(tId);
          if (node) queue.push(node);
        }
      }
    }
    if (ordered.length !== tasks.length) {
      warnings.push("Cycle detected in task dependencies; falling back to partial order.");
      for (const task of tasks) {
        if (!ordered.includes(task)) ordered.push(task);
      }
    }
    return { ordered, warnings };
  }

  async selectTasks(filters: TaskSelectionFilters): Promise<TaskSelectionPlan> {
    const project = await this.fetchProject(filters.projectKey);
    if (filters.projectKey && !project) {
      throw new Error(`Unknown project key: ${filters.projectKey}`);
    }
    const dedupedTaskKeys = filters.taskKeys?.length
      ? Array.from(new Set(filters.taskKeys.map((key) => key.trim()).filter(Boolean)))
      : undefined;
    const effectiveStatuses = normalizeStatusList(filters.statusFilter);
    const allowBlocked = effectiveStatuses.includes("blocked");
    const tasks = await this.loadTasks({ ...filters, project, taskKeys: dedupedTaskKeys });
    const filteredTasks = tasks.filter((task) => effectiveStatuses.includes(task.task_status.toLowerCase()));
    const dedupeWarnings: string[] = [];
    const seenKeys = new Set<string>();
    const dedupedTasks: RawTaskRow[] = [];
    for (const row of filteredTasks) {
      const key = row.task_key;
      if (seenKeys.has(key)) {
        dedupeWarnings.push(`Duplicate task key detected in selection: ${key}.`);
        continue;
      }
      seenKeys.add(key);
      dedupedTasks.push(row);
    }
    const candidateIds = dedupedTasks.map((t) => t.task_id);
    const deps = await this.loadDependencies(candidateIds);
    const missingContext = await this.loadMissingContext(candidateIds);
    const taskMap = new Map<string, SelectedTask>();
    for (const row of dedupedTasks) {
      const task = this.buildTaskFromRow(row);
      taskMap.set(task.id, {
        task,
        dependencies: { ids: [], keys: [], blocking: [] },
      });
    }

    const blocked: SelectedTask[] = [];
    const eligible: SelectedTask[] = [];
    for (const [taskId, entry] of taskMap.entries()) {
      const explicit = (filters.taskKeys ?? []).includes(entry.task.key);
      const hasMissingContext = missingContext.has(taskId);
      const depRows = deps.get(taskId) ?? [];
      const ids: string[] = [];
      const keys: string[] = [];
      const blocking: string[] = [];
      let blockedReason: string | undefined;
      for (const dep of depRows) {
        ids.push(dep.dependsOnTaskId);
        if (dep.dependsOnKey) keys.push(dep.dependsOnKey);
        const status = dep.dependsOnStatus?.toLowerCase();
        const depInSelection = taskMap.has(dep.dependsOnTaskId);
        const clear = dep.dependsOnTaskId
          ? DONE_DEPENDENCY_STATUSES.has(status ?? "")
          : true;
        if (!clear) {
          blockedReason = "dependency_not_ready";
          blocking.push(dep.dependsOnTaskId);
        } else if (!status && !depInSelection) {
          // unknown status but dependency referenced; treat as blocked unless explicitly ignored
          blockedReason = "dependency_not_ready";
          blocking.push(dep.dependsOnTaskId);
        }
      }
      if (hasMissingContext) {
        blockedReason = "missing_context";
      }
      entry.dependencies = { ids, keys, blocking };
      if (hasMissingContext && !explicit) {
        entry.blockedReason = blockedReason;
        blocked.push(entry);
      } else if (blockedReason && !(allowBlocked || explicit)) {
        entry.blockedReason = blockedReason;
        blocked.push(entry);
      } else {
        entry.blockedReason = blockedReason;
        eligible.push(entry);
      }
    }

    const { ordered, warnings } = this.topologicalOrder(eligible, deps);
    const combinedWarnings = [...dedupeWarnings, ...warnings];
    const limited = typeof filters.limit === "number" && filters.limit > 0 ? ordered.slice(0, filters.limit) : ordered;
    return {
      project: project ?? undefined,
      filters: { ...filters, taskKeys: dedupedTaskKeys ?? filters.taskKeys, effectiveStatuses },
      ordered: limited,
      blocked,
      warnings: combinedWarnings,
    };
  }
}
