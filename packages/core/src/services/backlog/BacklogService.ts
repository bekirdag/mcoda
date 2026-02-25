import fs from "node:fs/promises";
import { Connection, type Database } from "@mcoda/db";
import { PathHelper, READY_TO_CODE_REVIEW, isReadyToReviewStatus } from "@mcoda/shared";
import { TaskOrderingService } from "./TaskOrderingService.js";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

type BacklogLane = "implementation" | "review" | "qa" | "done";

const IMPLEMENTATION_STATUSES = new Set(["not_started", "in_progress"]);
const QA_STATUSES = new Set(["ready_to_qa"]);
const DONE_STATUSES = new Set(["completed", "cancelled"]);

export interface BacklogTotals {
  implementation: { tasks: number; story_points: number };
  review: { tasks: number; story_points: number };
  qa: { tasks: number; story_points: number };
  done: { tasks: number; story_points: number };
}

export interface BacklogOrderingMeta {
  requested: boolean;
  applied: boolean;
  reason: string;
}

export interface BacklogCrossLaneDependency {
  task_key: string;
  depends_on_key: string;
  task_lane: BacklogLane;
  dependency_lane: BacklogLane;
}

export interface BacklogCrossLaneMeta {
  count: number;
  dependencies: BacklogCrossLaneDependency[];
}

export interface BacklogMeta {
  ordering: BacklogOrderingMeta;
  crossLaneDependencies: BacklogCrossLaneMeta;
}

export interface EpicBacklogSummary {
  epic_id: string;
  epic_key: string;
  title: string;
  priority: number | null;
  description?: string;
  totals: BacklogTotals;
  stories: StoryBacklogSummary[];
}

export interface StoryBacklogSummary {
  user_story_id: string;
  user_story_key: string;
  epic_key: string;
  title: string;
  description?: string;
  priority: number | null;
  status?: string;
  totals: BacklogTotals;
}

export interface TaskBacklogRow {
  task_id: string;
  task_key: string;
  epic_key: string;
  user_story_key: string;
  title: string;
  description: string;
  status: string;
  story_points: number | null;
  priority: number | null;
  assignee: string | null;
  dependency_keys: string[];
}

export interface BacklogSummary {
  scope: {
    project_id: string | null;
    project_key: string | null;
    epic_key?: string;
    user_story_key?: string;
    assignee?: string;
  };
  totals: BacklogTotals;
  epics: EpicBacklogSummary[];
  tasks: TaskBacklogRow[];
}

export interface BacklogQueryOptions {
  projectKey?: string;
  epicKey?: string;
  storyKey?: string;
  assignee?: string;
  statuses?: string[];
  orderByDependencies?: boolean;
  verbose?: boolean;
}

export interface BacklogResult {
  summary: BacklogSummary;
  warnings: string[];
  meta: BacklogMeta;
}

interface RawTaskRow {
  task_id: string;
  task_key: string;
  task_title: string;
  task_description: string | null;
  task_status: string;
  task_story_points: number | null;
  task_priority: number | null;
  assignee_human: string | null;
  epic_id: string;
  epic_key: string;
  epic_title: string;
  epic_priority: number | null;
  epic_description: string | null;
  story_id: string;
  story_key: string;
  story_title: string;
  story_priority: number | null;
  story_description: string | null;
}

const emptyTotals = (): BacklogTotals => ({
  implementation: { tasks: 0, story_points: 0 },
  review: { tasks: 0, story_points: 0 },
  qa: { tasks: 0, story_points: 0 },
  done: { tasks: 0, story_points: 0 },
});

const bucketForStatus = (status: string): BacklogLane => {
  const normalized = status?.toLowerCase() ?? "";
  if (IMPLEMENTATION_STATUSES.has(normalized)) return "implementation";
  if (isReadyToReviewStatus(normalized)) return "review";
  if (QA_STATUSES.has(normalized)) return "qa";
  if (DONE_STATUSES.has(normalized)) return "done";
  return "implementation";
};

const addToTotals = (totals: BacklogTotals, lane: BacklogLane, storyPoints: number | null): void => {
  totals[lane].tasks += 1;
  if (typeof storyPoints === "number" && Number.isFinite(storyPoints)) {
    totals[lane].story_points += storyPoints;
  }
};

const truncate = (value: string | null | undefined, max = 100): string => {
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
};

const hasTables = async (db: Database, required: string[]): Promise<boolean> => {
  const placeholders = required.map(() => "?").join(", ");
  const rows = await db.all<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    required,
  );
  return rows.length === required.length;
};

const deriveStoryStatus = (statuses: Set<string>): string | undefined => {
  const order = ["completed", "cancelled", "ready_to_qa", READY_TO_CODE_REVIEW, "changes_requested", "in_progress", "not_started"];
  for (const status of order) {
    if (statuses.has(status)) return status;
  }
  return undefined;
};

export class BacklogService {
  private warnings: string[] = [];
  private epicPriority = new Map<string, number | null>();
  private storyPriority = new Map<string, number | null>();

  private constructor(
    private workspace: WorkspaceResolution,
    private db: Database,
    private connection: Connection,
  ) {}

  static async create(workspace: WorkspaceResolution): Promise<BacklogService> {
    const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
    try {
      await fs.access(dbPath);
    } catch {
      throw new Error(`No workspace DB found at ${dbPath}. Run mcoda init or create-tasks first.`);
    }
    const connection = await Connection.open(dbPath);
    const ok = await hasTables(connection.db, ["projects", "epics", "user_stories", "tasks"]);
    if (!ok) {
      await connection.close();
      throw new Error(`Workspace DB at ${dbPath} is missing required tables. Re-run create-tasks to seed it.`);
    }
    return new BacklogService(workspace, connection.db, connection);
  }

  async close(): Promise<void> {
    await this.connection.close();
  }

  async getBacklog(options: BacklogQueryOptions = {}): Promise<BacklogResult> {
    this.warnings = [];
    this.epicPriority.clear();
    this.storyPriority.clear();
    const project = options.projectKey ? await this.getProject(options.projectKey) : undefined;
    if (options.projectKey && !project) {
      throw new Error(`Unknown project key: ${options.projectKey}`);
    }
    const epic = options.epicKey ? await this.getEpic(options.epicKey, project?.id) : undefined;
    if (options.epicKey && !epic) {
      throw new Error(`Unknown epic key: ${options.epicKey}`);
    }
    const story = options.storyKey ? await this.getStory(options.storyKey, epic?.id ?? project?.id) : undefined;
    if (options.storyKey && !story) {
      throw new Error(`Unknown user story key: ${options.storyKey}`);
    }

    const tasks = await this.fetchTasks({
      projectId: project?.id,
      epicId: epic?.id,
      storyId: story?.id,
      assignee: options.assignee,
      statuses: options.statuses,
    });
    const dependencyMap = await this.fetchDependencies(tasks.map((t) => t.task_id));

    const totals = emptyTotals();
    const epics = new Map<string, EpicBacklogSummary & { storiesMap: Map<string, StoryBacklogSummary & { statuses: Set<string> }> }>();
    const tasksRows: TaskBacklogRow[] = [];

    for (const row of tasks) {
      const lane = bucketForStatus(row.task_status);
      addToTotals(totals, lane, row.task_story_points);

      let epicSummary = epics.get(row.epic_id);
      if (!epicSummary) {
        epicSummary = {
          epic_id: row.epic_id,
          epic_key: row.epic_key,
          title: row.epic_title,
          priority: row.epic_priority ?? null,
          description: row.epic_description ?? undefined,
          totals: emptyTotals(),
          stories: [],
          storiesMap: new Map(),
        };
        epics.set(row.epic_id, epicSummary);
      }
      this.epicPriority.set(row.epic_key, row.epic_priority ?? null);
      addToTotals(epicSummary.totals, lane, row.task_story_points);

      let storySummary = epicSummary.storiesMap.get(row.story_id);
      if (!storySummary) {
        storySummary = {
          user_story_id: row.story_id,
          user_story_key: row.story_key,
          epic_key: row.epic_key,
          title: row.story_title,
          description: row.story_description ?? undefined,
          priority: row.story_priority ?? null,
          status: undefined,
          totals: emptyTotals(),
          statuses: new Set<string>(),
        };
        epicSummary.storiesMap.set(row.story_id, storySummary);
      }
      this.storyPriority.set(row.story_key, row.story_priority ?? null);
      addToTotals(storySummary.totals, lane, row.task_story_points);
      storySummary.statuses.add(row.task_status.toLowerCase());

      const dependencies = dependencyMap.get(row.task_id) ?? [];
      tasksRows.push({
        task_id: row.task_id,
        task_key: row.task_key,
        epic_key: row.epic_key,
        user_story_key: row.story_key,
        title: row.task_title,
        description: row.task_description ?? "",
        status: row.task_status,
        story_points: row.task_story_points ?? null,
        priority: row.task_priority ?? null,
        assignee: row.assignee_human ?? null,
        dependency_keys: dependencies,
      });
    }

    const crossLaneDependencies = this.findCrossLaneDependencies(tasksRows);
    if (crossLaneDependencies.length > 0) {
      this.warnings.push(
        `Cross-lane dependencies detected (${crossLaneDependencies.length}). Ordering by lane may be misleading.`,
      );
    }

    let orderedTasks: TaskBacklogRow[];
    const orderingMeta: BacklogOrderingMeta = {
      requested: options.orderByDependencies === true,
      applied: false,
      reason: options.orderByDependencies ? "requested" : "default_order",
    };
    if (options.orderByDependencies) {
      if (!project) {
        this.warnings.push("Dependency ordering requires a project scope; using default ordering.");
        orderingMeta.reason = "missing_project_scope";
        orderedTasks = this.orderTasks(tasksRows, options.verbose === true);
      } else {
        const orderingService = await TaskOrderingService.create(this.workspace, { recordTelemetry: false });
        try {
          const ordering = await orderingService.orderTasks({
            projectKey: project.key,
            epicKey: epic?.key,
            storyKey: story?.key,
            assignee: options.assignee,
            statusFilter: options.statuses,
            injectFoundationDeps: false,
            enrichMetadata: false,
            apply: false,
          });
          orderingMeta.applied = true;
          orderingMeta.reason = "dependency_graph";
          const orderMap = new Map<string, number>(ordering.ordered.map((t, idx) => [t.taskId, idx]));
          orderedTasks = tasksRows
            .slice()
            .sort((a, b) => {
              const ai = orderMap.get(a.task_id) ?? Number.MAX_SAFE_INTEGER;
              const bi = orderMap.get(b.task_id) ?? Number.MAX_SAFE_INTEGER;
              if (ai !== bi) return ai - bi;
              return a.task_key.localeCompare(b.task_key);
            });
          this.warnings.push(...ordering.warnings);
        } catch (error) {
          const prefix = "Dependency ordering failed; falling back to heuristic ordering.";
          if (options.verbose) {
            this.warnings.push(`${prefix} ${(error as Error).message}`);
          } else {
            this.warnings.push(prefix);
          }
          orderingMeta.applied = false;
          orderingMeta.reason = "heuristic_fallback";
          orderedTasks = this.orderTasks(tasksRows, options.verbose === true);
        } finally {
          await orderingService.close();
        }
      }
    } else {
      orderingMeta.reason = "default_order";
      orderedTasks = this.defaultOrder(tasksRows);
    }

    const epicSummaries = Array.from(epics.values()).map((e) => {
      const stories = Array.from(e.storiesMap.values()).map((s) => ({
        user_story_id: s.user_story_id,
        user_story_key: s.user_story_key,
        epic_key: s.epic_key,
        title: s.title,
        description: s.description,
        priority: s.priority,
        status: deriveStoryStatus(s.statuses),
        totals: s.totals,
      }));
      return {
        epic_id: e.epic_id,
        epic_key: e.epic_key,
        title: e.title,
        priority: e.priority,
        description: e.description,
        totals: e.totals,
        stories,
      };
    });

    return {
      summary: {
        scope: {
          project_id: project?.id ?? null,
          project_key: project?.key ?? null,
          epic_key: epic?.key,
          user_story_key: story?.key,
          assignee: options.assignee,
        },
        totals,
        epics: this.sortEpics(epicSummaries),
        tasks: orderedTasks,
      },
      warnings: this.warnings,
      meta: {
        ordering: orderingMeta,
        crossLaneDependencies: {
          count: crossLaneDependencies.length,
          dependencies: crossLaneDependencies,
        },
      },
    };
  }

  private async getProject(projectKey: string): Promise<{ id: string; key: string } | undefined> {
    const row = await this.db.get(`SELECT id, key FROM projects WHERE key = ?`, projectKey);
    if (!row) return undefined;
    return { id: row.id, key: row.key };
  }

  private async getEpic(epicKey: string, projectId?: string): Promise<{ id: string; key: string; project_id: string } | undefined> {
    const row = await this.db.get(
      `SELECT id, key, project_id FROM epics WHERE key = ? ${projectId ? "AND project_id = ?" : ""}`,
      projectId ? [epicKey, projectId] : [epicKey],
    );
    if (!row) return undefined;
    return { id: row.id, key: row.key, project_id: row.project_id };
  }

  private async getStory(storyKey: string, scopeId?: string): Promise<{ id: string; key: string; epic_id: string } | undefined> {
    const row = await this.db.get(
      `SELECT id, key, epic_id FROM user_stories WHERE key = ? ${scopeId ? "AND (epic_id = ? OR project_id = ?)" : ""}`,
      scopeId ? [storyKey, scopeId, scopeId] : [storyKey],
    );
    if (!row) return undefined;
    return { id: row.id, key: row.key, epic_id: row.epic_id };
  }

  private async fetchTasks(filters: {
    projectId?: string;
    epicId?: string;
    storyId?: string;
    assignee?: string;
    statuses?: string[];
  }): Promise<RawTaskRow[]> {
    const clauses: string[] = [];
    const params: any[] = [];
    if (filters.projectId) {
      clauses.push("t.project_id = ?");
      params.push(filters.projectId);
    }
    if (filters.epicId) {
      clauses.push("t.epic_id = ?");
      params.push(filters.epicId);
    }
    if (filters.storyId) {
      clauses.push("t.user_story_id = ?");
      params.push(filters.storyId);
    }
    if (filters.assignee) {
      clauses.push("LOWER(t.assignee_human) = LOWER(?)");
      params.push(filters.assignee);
    }
    if (filters.statuses && filters.statuses.length > 0) {
      const placeholders = filters.statuses.map(() => "?").join(", ");
      clauses.push(`LOWER(t.status) IN (${placeholders})`);
      params.push(...filters.statuses.map((s) => s.toLowerCase()));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.db.all<RawTaskRow[]>(
      `
      SELECT
        t.id AS task_id,
        t.key AS task_key,
        t.title AS task_title,
        t.description AS task_description,
        t.status AS task_status,
        t.story_points AS task_story_points,
        t.priority AS task_priority,
        t.assignee_human AS assignee_human,
        e.id AS epic_id,
        e.key AS epic_key,
        e.title AS epic_title,
        e.priority AS epic_priority,
        e.description AS epic_description,
        s.id AS story_id,
        s.key AS story_key,
        s.title AS story_title,
        s.priority AS story_priority,
        s.description AS story_description
      FROM tasks t
      INNER JOIN epics e ON t.epic_id = e.id
      INNER JOIN user_stories s ON t.user_story_id = s.id
      ${where}
    `,
      params,
    );
    return rows;
  }

  private async fetchDependencies(taskIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (taskIds.length === 0) return map;
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = await this.db.all<{ task_id: string; dependency_key: string }[]>(
      `
      SELECT td.task_id, dep.key AS dependency_key
      FROM task_dependencies td
      INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
      WHERE td.task_id IN (${placeholders})
    `,
      taskIds,
    );
    for (const row of rows) {
      const list = map.get(row.task_id) ?? [];
      list.push(row.dependency_key);
      map.set(row.task_id, list);
    }
    return map;
  }

  private defaultOrder(tasks: TaskBacklogRow[]): TaskBacklogRow[] {
    const bucketOrder: Record<BacklogLane, number> = {
      implementation: 0,
      review: 1,
      qa: 2,
      done: 3,
    };
    const toNum = (value: number | null) => (value === null || value === undefined ? Number.MAX_SAFE_INTEGER : value);
    return tasks
      .slice()
      .sort((a, b) => {
        const laneA = bucketOrder[bucketForStatus(a.status)];
        const laneB = bucketOrder[bucketForStatus(b.status)];
        if (laneA !== laneB) return laneA - laneB;
        const epicPriorityA = toNum(this.epicPriority.get(a.epic_key) ?? null);
        const epicPriorityB = toNum(this.epicPriority.get(b.epic_key) ?? null);
        if (epicPriorityA !== epicPriorityB) return epicPriorityA - epicPriorityB;
        const storyPriorityA = toNum(this.storyPriority.get(a.user_story_key) ?? null);
        const storyPriorityB = toNum(this.storyPriority.get(b.user_story_key) ?? null);
        if (storyPriorityA !== storyPriorityB) return storyPriorityA - storyPriorityB;
        const taskPriorityA = toNum(a.priority);
        const taskPriorityB = toNum(b.priority);
        if (taskPriorityA !== taskPriorityB) return taskPriorityA - taskPriorityB;
        return a.task_key.localeCompare(b.task_key);
      });
  }

  private orderTasks(tasks: TaskBacklogRow[], verbose: boolean): TaskBacklogRow[] {
    const bucketOrder: BacklogLane[] = ["implementation", "review", "qa", "done"];
    const allKeys = new Set(tasks.map((t) => t.task_key));
    const ordered: TaskBacklogRow[] = [];
    for (const bucket of bucketOrder) {
      const bucketTasks = tasks.filter((t) => bucketForStatus(t.status) === bucket);
      const { sorted, hadCycle, missingReference } = this.topologicalSort(bucketTasks, allKeys);
      if (hadCycle && verbose) {
        this.warnings.push(`Dependency cycle detected in ${bucket} bucket. Falling back to priority order.`);
      }
      if (missingReference && verbose) {
        this.warnings.push(`Missing dependency reference in ${bucket} bucket. Ordering may be partial.`);
      }
      ordered.push(...sorted);
    }
    return ordered;
  }

  private topologicalSort(tasks: TaskBacklogRow[], allKeys: Set<string>): { sorted: TaskBacklogRow[]; hadCycle: boolean; missingReference: boolean } {
    if (tasks.length === 0) return { sorted: [], hadCycle: false, missingReference: false };
    const idByKey = new Map(tasks.map((t, idx) => [t.task_key, idx]));
    const indegree = new Array<number>(tasks.length).fill(0);
    const edges: Map<number, number[]> = new Map();
    const fallback = this.defaultOrder(tasks);
    const indexByTask = new Map<string, number>();
    fallback.forEach((task, idx) => indexByTask.set(task.task_id, idx));
    let missingReference = false;

    tasks.forEach((task, idx) => {
      for (const depKey of task.dependency_keys) {
        if (!allKeys.has(depKey)) {
          missingReference = true;
          continue;
        }
        const depIdx = idByKey.get(depKey);
        if (depIdx === undefined) {
          continue;
        }
        indegree[idx] += 1;
        const list = edges.get(depIdx) ?? [];
        list.push(idx);
        edges.set(depIdx, list);
      }
    });

    const queue: number[] = [];
    indegree.forEach((value, idx) => {
      if (value === 0) queue.push(idx);
    });

    const stableSort = (arr: number[]) =>
      arr.sort((a, b) => {
        const fallbackA = indexByTask.get(tasks[a].task_id) ?? 0;
        const fallbackB = indexByTask.get(tasks[b].task_id) ?? 0;
        return fallbackA - fallbackB;
      });

    stableSort(queue);

    const result: TaskBacklogRow[] = [];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      result.push(tasks[current]);
      const neighbors = edges.get(current) ?? [];
      for (const next of neighbors) {
        indegree[next] -= 1;
        if (indegree[next] === 0) {
          queue.push(next);
        }
      }
      stableSort(queue);
    }

    const hadCycle = result.length !== tasks.length;
    if (hadCycle) {
      return { sorted: fallback, hadCycle: true, missingReference };
    }
    return { sorted: result, hadCycle: false, missingReference };
  }

  private sortEpics(epics: EpicBacklogSummary[]): EpicBacklogSummary[] {
    const toNum = (value: number | null | undefined) => (value === null || value === undefined ? Number.MAX_SAFE_INTEGER : value);
    return epics
      .slice()
      .sort((a, b) => {
        const priority = toNum(a.priority) - toNum(b.priority);
        if (priority !== 0) return priority;
        return a.epic_key.localeCompare(b.epic_key);
      })
      .map((epic) => ({
        ...epic,
        stories: epic.stories
          .slice()
          .sort((a, b) => {
            const priority = toNum(a.priority) - toNum(b.priority);
            if (priority !== 0) return priority;
            return a.user_story_key.localeCompare(b.user_story_key);
          }),
      }));
  }

  private findCrossLaneDependencies(tasks: TaskBacklogRow[]): BacklogCrossLaneDependency[] {
    if (tasks.length === 0) return [];
    const laneByKey = new Map<string, BacklogLane>();
    for (const task of tasks) {
      laneByKey.set(task.task_key, bucketForStatus(task.status));
    }
    const results: BacklogCrossLaneDependency[] = [];
    for (const task of tasks) {
      const taskLane = laneByKey.get(task.task_key);
      if (!taskLane || task.dependency_keys.length === 0) continue;
      for (const depKey of task.dependency_keys) {
        const dependencyLane = laneByKey.get(depKey);
        if (!dependencyLane || dependencyLane === taskLane) continue;
        results.push({
          task_key: task.task_key,
          depends_on_key: depKey,
          task_lane: taskLane,
          dependency_lane: dependencyLane,
        });
      }
    }
    return results.sort((a, b) => {
      const taskCompare = a.task_key.localeCompare(b.task_key);
      if (taskCompare !== 0) return taskCompare;
      return a.depends_on_key.localeCompare(b.depends_on_key);
    });
  }
}
