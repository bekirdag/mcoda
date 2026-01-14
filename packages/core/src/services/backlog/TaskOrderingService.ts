import fs from "node:fs/promises";
import { AgentService } from "@mcoda/agents";
import { DocdexClient } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository, Connection, type Database } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import type { Agent } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";

type StatusRank = Record<string, number>;

const DEFAULT_STATUSES = ["not_started", "in_progress", "blocked", "ready_to_review", "ready_to_qa"];
const DONE_STATUSES = new Set(["completed", "cancelled"]);
const STATUS_RANK: StatusRank = {
  in_progress: 0,
  not_started: 1,
  ready_to_review: 2,
  ready_to_qa: 3,
  blocked: 4,
  completed: 5,
  cancelled: 6,
};

const hasTables = async (db: Database, required: string[]): Promise<boolean> => {
  const placeholders = required.map(() => "?").join(", ");
  const rows = await db.all<{ name: string }[]>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    required,
  );
  return rows.length === required.length;
};

const normalizeStatuses = (statuses?: string[]): string[] => {
  if (!statuses || statuses.length === 0) return DEFAULT_STATUSES;
  return Array.from(new Set(statuses.map((s) => s.toLowerCase().trim()).filter(Boolean)));
};

const estimateTokens = (text: string): number => Math.max(1, Math.ceil((text ?? "").length / 4));

const SDS_DEPENDENCY_GUIDE = [
  "SDS hints for dependency-aware ordering:",
  "- Enforce topological ordering: never place a task before any of its dependencies.",
  "- Prioritize tasks that unlock the most downstream work (direct + indirect dependents).",
  "- Tie-break by existing priority, then lower story points, then older tasks, then status (in_progress before not_started).",
  "- Blocked tasks should remain after unblocked tasks unless explicitly requested.",
].join("\n");

interface DocContext {
  content: string;
  source: string;
}

interface ProjectRow {
  id: string;
  key: string;
  name?: string | null;
}

interface EpicRow {
  id: string;
  key: string;
  project_id: string;
  title: string;
}

interface StoryRow {
  id: string;
  key: string;
  epic_id: string;
  project_id: string;
}

interface TaskRow {
  id: string;
  key: string;
  title: string;
  description: string;
  type?: string | null;
  status: string;
  story_points: number | null;
  priority: number | null;
  assignee_human?: string | null;
  epic_id: string;
  epic_key: string;
  story_id: string;
  story_key: string;
  story_title: string;
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown> | null;
}

interface DependencyRow {
  task_id: string;
  depends_on_task_id: string | null;
  depends_on_key?: string | null;
  depends_on_status?: string | null;
}

interface DependencyImpact {
  direct: number;
  total: number;
}

export interface TaskOrderItem {
  taskId: string;
  taskKey: string;
  title: string;
  status: string;
  storyPoints: number | null;
  priority: number;
  epicId: string;
  epicKey: string;
  storyId: string;
  storyKey: string;
  storyTitle: string;
  blocked: boolean;
  blockedBy: string[];
  dependencyKeys: string[];
  dependencyImpact: DependencyImpact;
  cycleDetected?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface TaskOrderingResult {
  project: ProjectRow;
  epic?: EpicRow;
  ordered: TaskOrderItem[];
  blocked: TaskOrderItem[];
  warnings: string[];
  jobId?: string;
  commandRunId?: string;
}

export interface TaskOrderingRequest {
  projectKey: string;
  epicKey?: string;
  storyKey?: string;
  assignee?: string;
  statusFilter?: string[];
  includeBlocked?: boolean;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
}

type TaskNode = TaskRow & {
  dependencies: DependencyRow[];
  blockedBy: string[];
  missingDependencies: string[];
};

type AgentRanking = Map<string, number>;

export class TaskOrderingService {
  private constructor(
    private workspace: WorkspaceResolution,
    private db: Database,
    private repo: WorkspaceRepository,
    private jobService: JobService,
    private agentService: AgentService,
    private globalRepo: GlobalRepository,
    private routingService: RoutingService,
    private docdex: DocdexClient,
    private recordTelemetry: boolean,
  ) {}

  static async create(
    workspace: WorkspaceResolution,
    options: { recordTelemetry?: boolean } = {},
  ): Promise<TaskOrderingService> {
    const dbPath = PathHelper.getWorkspaceDbPath(workspace.workspaceRoot);
    try {
      await fs.access(dbPath);
    } catch {
      throw new Error(`No workspace DB found at ${dbPath}. Run mcoda create-tasks first.`);
    }
    const connection = await Connection.open(dbPath);
    const ok = await hasTables(connection.db, ["projects", "epics", "user_stories", "tasks", "task_dependencies"]);
    if (!ok) {
      await connection.close();
      throw new Error(`Workspace DB at ${dbPath} is missing required tables. Re-run create-tasks to seed it.`);
    }
    const repo = new WorkspaceRepository(connection.db, connection);
    const jobService = new JobService(workspace, repo);
    const globalRepo = await GlobalRepository.create();
    const agentService = new AgentService(globalRepo);
    const routingService = await RoutingService.create();
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
      repoId: docdexRepoId,
    });
    return new TaskOrderingService(
      workspace,
      connection.db,
      repo,
      jobService,
      agentService,
      globalRepo,
      routingService,
      docdex,
      options.recordTelemetry !== false,
    );
  }

  private async buildDocContext(projectKey: string, warnings: string[]): Promise<DocContext | undefined> {
    try {
      const docs = await this.docdex.search({ docType: "SDS", projectKey });
      if (!docs.length) return undefined;
      const doc = docs[0];
      const segments = (doc.segments ?? []).slice(0, 3);
      const body =
        segments.length > 0
          ? segments
              .map((seg, idx) => {
                const head = seg.heading || `Segment ${idx + 1}`;
                const trimmed = seg.content.length > 800 ? `${seg.content.slice(0, 800)}...` : seg.content;
                return `### ${head}\n${trimmed}`;
              })
              .join("\n\n")
          : doc.content ?? "";
      return {
        content: ["[SDS context]", doc.title ?? doc.path ?? doc.id, body].filter(Boolean).join("\n\n"),
        source: doc.id ?? doc.path ?? "sds",
      };
    } catch (error) {
      warnings.push(`Docdex context unavailable: ${(error as Error).message}`);
      return undefined;
    }
  }

  async close(): Promise<void> {
    const maybeClose = async (target: unknown) => {
      try {
        if ((target as any)?.close) await (target as any).close();
      } catch {
        /* ignore */
      }
    };
    await maybeClose(this.repo);
    await maybeClose(this.jobService);
    await maybeClose(this.agentService);
    await maybeClose(this.globalRepo);
    await maybeClose(this.docdex);
    await maybeClose(this.routingService);
  }

  private async getProject(projectKey: string): Promise<ProjectRow | undefined> {
    const row = await this.db.get<ProjectRow | undefined>(
      `SELECT id, key, name FROM projects WHERE key = ?`,
      projectKey,
    );
    return row ?? undefined;
  }

  private async getEpic(epicKey: string, projectId: string): Promise<EpicRow | undefined> {
    const row = await this.db.get<EpicRow | undefined>(
      `SELECT id, key, project_id, title FROM epics WHERE key = ? AND project_id = ?`,
      epicKey,
      projectId,
    );
    return row ?? undefined;
  }

  private async getStory(storyKey: string, projectId: string, epicId?: string): Promise<StoryRow | undefined> {
    const clauses = ["key = ?", "project_id = ?"];
    const params: any[] = [storyKey, projectId];
    if (epicId) {
      clauses.push("epic_id = ?");
      params.push(epicId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const row = await this.db.get<StoryRow | undefined>(
      `SELECT id, key, epic_id, project_id FROM user_stories ${where}`,
      ...params,
    );
    return row ?? undefined;
  }

  private async fetchTasks(
    projectId: string,
    epicId?: string,
    statuses?: string[],
    storyId?: string,
    assignee?: string,
  ): Promise<TaskRow[]> {
    const clauses = ["t.project_id = ?"];
    const params: any[] = [projectId];
    if (epicId) {
      clauses.push("t.epic_id = ?");
      params.push(epicId);
    }
    if (storyId) {
      clauses.push("t.user_story_id = ?");
      params.push(storyId);
    }
    if (assignee) {
      clauses.push("LOWER(t.assignee_human) = LOWER(?)");
      params.push(assignee);
    }
    if (statuses && statuses.length > 0) {
      clauses.push(`LOWER(t.status) IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses.map((s) => s.toLowerCase()));
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.db.all<TaskRow[]>(
      `
        SELECT
          t.id,
          t.key,
          t.title,
          t.description,
          t.type,
          t.status,
          t.story_points,
          t.priority,
          t.assignee_human,
          t.epic_id,
          e.key as epic_key,
          t.user_story_id as story_id,
          us.key as story_key,
          us.title as story_title,
          t.created_at,
          t.updated_at,
          t.metadata_json
        FROM tasks t
        JOIN epics e ON e.id = t.epic_id
        JOIN user_stories us ON us.id = t.user_story_id
        ${where}
        ORDER BY t.created_at ASC, t.key ASC
      `,
      ...params,
    );
    return rows.map((row: any) => ({
      ...row,
      story_points: row.story_points ?? null,
      priority: row.priority ?? null,
      metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    }));
  }

  private async fetchDependencies(taskIds: string[]): Promise<Map<string, DependencyRow[]>> {
    if (taskIds.length === 0) return new Map();
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = await this.db.all<DependencyRow[]>(
      `
        SELECT
          td.task_id,
          td.depends_on_task_id,
          dep.key as depends_on_key,
          dep.status as depends_on_status
        FROM task_dependencies td
        LEFT JOIN tasks dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id IN (${placeholders})
      `,
      ...taskIds,
    );
    const grouped = new Map<string, DependencyRow[]>();
    for (const row of rows) {
      const existing = grouped.get(row.task_id) ?? [];
      existing.push(row);
      grouped.set(row.task_id, existing);
    }
    return grouped;
  }

  private dependencyImpactMap(dependents: Map<string, string[]>): Map<string, DependencyImpact> {
    const memo = new Map<string, DependencyImpact>();
    const visit = (taskId: string, stack: Set<string>): DependencyImpact => {
      if (memo.has(taskId)) return memo.get(taskId)!;
      if (stack.has(taskId)) return { direct: dependents.get(taskId)?.length ?? 0, total: dependents.get(taskId)?.length ?? 0 };
      stack.add(taskId);
      const children = dependents.get(taskId) ?? [];
      const seen = new Set<string>();
      let total = 0;
      for (const child of children) {
        if (seen.has(child)) continue;
        seen.add(child);
        total += 1;
        const nested = visit(child, stack);
        total += nested.total;
      }
      const impact = { direct: children.length, total };
      memo.set(taskId, impact);
      stack.delete(taskId);
      return impact;
    };

    for (const key of dependents.keys()) {
      if (!memo.has(key)) {
        visit(key, new Set());
      }
    }
    return memo;
  }

  private compareTasks(
    a: TaskNode,
    b: TaskNode,
    impact: Map<string, DependencyImpact>,
    agentRank?: AgentRanking,
  ): number {
    const rankA = agentRank?.get(a.id);
    const rankB = agentRank?.get(b.id);
    if (rankA !== undefined || rankB !== undefined) {
      if (rankA === undefined) return 1;
      if (rankB === undefined) return -1;
      if (rankA !== rankB) return rankA - rankB;
    }
    const impactA = impact.get(a.id)?.total ?? 0;
    const impactB = impact.get(b.id)?.total ?? 0;
    if (impactA !== impactB) return impactB - impactA;
    const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
    const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const spA = a.story_points ?? Number.POSITIVE_INFINITY;
    const spB = b.story_points ?? Number.POSITIVE_INFINITY;
    if (spA !== spB) return spA - spB;
    const createdA = Date.parse(a.created_at) || 0;
    const createdB = Date.parse(b.created_at) || 0;
    if (createdA !== createdB) return createdA - createdB;
    const statusA = STATUS_RANK[a.status.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
    const statusB = STATUS_RANK[b.status.toLowerCase()] ?? Number.MAX_SAFE_INTEGER;
    if (statusA !== statusB) return statusA - statusB;
    return a.key.localeCompare(b.key);
  }

  private topologicalSort(
    tasks: TaskNode[],
    edges: Map<string, string[]>,
    impact: Map<string, DependencyImpact>,
    agentRank?: AgentRanking,
  ): { ordered: TaskNode[]; cycle: boolean; cycleMembers: Set<string> } {
    const indegree = new Map<string, number>();
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    for (const task of tasks) {
      indegree.set(task.id, 0);
    }
    for (const [from, toList] of edges.entries()) {
      for (const to of toList) {
        if (!indegree.has(to)) continue;
        indegree.set(to, (indegree.get(to) ?? 0) + 1);
      }
    }
    const queue = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0);
    const sortQueue = () => queue.sort((a, b) => this.compareTasks(a, b, impact, agentRank));
    sortQueue();
    const ordered: TaskNode[] = [];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift() as TaskNode;
      ordered.push(current);
      visited.add(current.id);
      const neighbors = edges.get(current.id) ?? [];
      for (const neighbor of neighbors) {
        indegree.set(neighbor, (indegree.get(neighbor) ?? 0) - 1);
        if ((indegree.get(neighbor) ?? 0) === 0) {
          const node = taskMap.get(neighbor);
          if (node) queue.push(node);
        }
      }
      sortQueue();
    }
    const cycle = ordered.length !== tasks.length;
    const cycleMembers = new Set<string>();
    if (cycle) {
      for (const task of tasks) {
        if (!visited.has(task.id)) {
          cycleMembers.add(task.id);
        }
      }
      const remaining = tasks.filter((t) => !visited.has(t.id));
      remaining.sort((a, b) => this.compareTasks(a, b, impact, agentRank));
      ordered.push(...remaining);
    }
    return { ordered, cycle, cycleMembers };
  }

  private buildNodes(
    tasks: TaskRow[],
    deps: Map<string, DependencyRow[]>,
  ): { nodes: TaskNode[]; dependents: Map<string, string[]>; missingRefs: Set<string> } {
    const taskIds = new Set(tasks.map((t) => t.id));
    const dependents = new Map<string, string[]>();
    const missingRefs = new Set<string>();
    const nodes: TaskNode[] = tasks.map((task) => {
      const taskDeps = deps.get(task.id) ?? [];
      const blockedBy: string[] = [];
      const missing: string[] = [];
      for (const dep of taskDeps) {
        const status = dep.depends_on_status?.toLowerCase();
        if (!dep.depends_on_task_id) {
          missing.push(dep.depends_on_key ?? "unknown");
          missingRefs.add(dep.depends_on_key ?? "unknown");
          blockedBy.push(dep.depends_on_key ?? "unknown");
          continue;
        }
        const inScope = taskIds.has(dep.depends_on_task_id);
        const isDone = DONE_STATUSES.has(status ?? "");
        if (!inScope) {
          if (!isDone) {
            blockedBy.push(dep.depends_on_key ?? dep.depends_on_task_id);
            missing.push(dep.depends_on_key ?? dep.depends_on_task_id);
            missingRefs.add(dep.depends_on_key ?? dep.depends_on_task_id);
          }
          continue;
        }
        if (!isDone) {
          blockedBy.push(dep.depends_on_key ?? dep.depends_on_task_id);
        }
        const list = dependents.get(dep.depends_on_task_id) ?? [];
        list.push(task.id);
        dependents.set(dep.depends_on_task_id, list);
      }
      return {
        ...task,
        dependencies: taskDeps,
        blockedBy,
        missingDependencies: missing,
      };
    });
    return { nodes, dependents, missingRefs };
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "order-tasks",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private async invokeAgent(
    agent: Agent,
    prompt: string,
    stream: boolean,
    metadata: Record<string, unknown>,
  ): Promise<{ output: string; adapter: string }> {
    if (stream) {
      try {
        const generator = await this.agentService.invokeStream(agent.id, { input: prompt, metadata });
        const collected: string[] = [];
        for await (const chunk of generator) {
          collected.push(chunk.output);
          // eslint-disable-next-line no-console
          console.log(chunk.output);
        }
        return { output: collected.join(""), adapter: agent.adapter };
      } catch {
        // fall back to non-streaming
      }
    }
    const result = await this.agentService.invoke(agent.id, { input: prompt, metadata });
    return { output: result.output, adapter: result.adapter };
  }

  private applyAgentRanking(ordered: TaskNode[], agentOutput: string, warnings: string[]): AgentRanking | undefined {
    try {
      const parsed = JSON.parse(agentOutput) as { order?: Array<{ task_key?: string }> };
      const order = parsed.order ?? [];
      const ranking = new Map<string, number>();
      order.forEach((entry, idx) => {
        const key = entry.task_key ?? (entry as any).key;
        if (typeof key === "string") {
          ranking.set(key, idx);
        }
      });
      if (ranking.size === 0) return undefined;
      const byId = new Map(ordered.map((t) => [t.key, t.id]));
      const mapped = new Map<string, number>();
      for (const [taskKey, idx] of ranking.entries()) {
        const taskId = byId.get(taskKey);
        if (taskId) mapped.set(taskId, idx);
      }
      return mapped.size > 0 ? mapped : undefined;
    } catch {
      warnings.push("Agent output could not be parsed; using dependency-only ordering.");
      return undefined;
    }
  }

  private async persistPriorities(
    ordered: TaskNode[],
    epicMap: Map<string, TaskNode[]>,
    storyMap: Map<string, TaskNode[]>,
  ): Promise<void> {
    await this.repo.withTransaction(async () => {
      for (let i = 0; i < ordered.length; i += 1) {
        const task = ordered[i];
        await this.repo.updateTask(task.id, { priority: i + 1 });
      }
      const epicEntries = Array.from(epicMap.entries()).map(([epicId, tasks]) => ({
        epicId,
        minPriority: Math.min(...tasks.map((t) => t.priority ?? Number.MAX_SAFE_INTEGER)),
      }));
      epicEntries.sort((a, b) => a.minPriority - b.minPriority);
      for (let i = 0; i < epicEntries.length; i += 1) {
        const entry = epicEntries[i];
        await this.db.run(`UPDATE epics SET priority = ?, updated_at = ? WHERE id = ?`, i + 1, new Date().toISOString(), entry.epicId);
      }

      const storyEntries = Array.from(storyMap.entries()).map(([storyId, tasks]) => ({
        storyId,
        minPriority: Math.min(...tasks.map((t) => t.priority ?? Number.MAX_SAFE_INTEGER)),
      }));
      storyEntries.sort((a, b) => a.minPriority - b.minPriority);
      for (let i = 0; i < storyEntries.length; i += 1) {
        const entry = storyEntries[i];
        await this.db.run(
          `UPDATE user_stories SET priority = ?, updated_at = ? WHERE id = ?`,
          i + 1,
          new Date().toISOString(),
          entry.storyId,
        );
      }
    });
  }

  private mapResult(
    ordered: TaskNode[],
    blockedSet: Set<string>,
    impact: Map<string, DependencyImpact>,
    cycleMembers: Set<string>,
  ): { ordered: TaskOrderItem[]; blocked: TaskOrderItem[] } {
    const result: TaskOrderItem[] = ordered.map((task, idx) => ({
      taskId: task.id,
      taskKey: task.key,
      title: task.title,
      status: task.status,
      storyPoints: task.story_points,
      priority: idx + 1,
      epicId: task.epic_id,
      epicKey: task.epic_key,
      storyId: task.story_id,
      storyKey: task.story_key,
      storyTitle: task.story_title,
      blocked: blockedSet.has(task.id),
      blockedBy: task.blockedBy,
      dependencyKeys: (task.dependencies ?? []).map((d) => d.depends_on_key ?? d.depends_on_task_id ?? "").filter(Boolean),
      dependencyImpact: impact.get(task.id) ?? { direct: 0, total: 0 },
      cycleDetected: cycleMembers.has(task.id) || undefined,
      metadata: task.metadata,
    }));
    const blocked = result.filter((t) => t.blocked);
    return { ordered: result, blocked };
  }

  async orderTasks(request: TaskOrderingRequest): Promise<TaskOrderingResult> {
    if (!request.projectKey) {
      throw new Error("order-tasks requires --project <PROJECT_KEY>");
    }
    const statuses = normalizeStatuses(request.statusFilter);
    const warnings: string[] = [];
    const commandRun = this.recordTelemetry
      ? await this.jobService.startCommandRun("order-tasks", request.projectKey, {
          taskIds: undefined,
          jobId: undefined,
          gitBranch: undefined,
          gitBaseBranch: undefined,
        })
      : undefined;
    const job = this.recordTelemetry
      ? await this.jobService.startJob("task_ordering", commandRun?.id, request.projectKey, {
          commandName: "order-tasks",
          payload: {
            projectKey: request.projectKey,
            epicKey: request.epicKey,
            storyKey: request.storyKey,
            assignee: request.assignee,
            statuses,
            includeBlocked: request.includeBlocked === true,
            agent: request.agentName,
          },
        })
      : undefined;
    try {
      const project = await this.getProject(request.projectKey);
      if (!project) {
        throw new Error(`Unknown project key: ${request.projectKey}`);
      }
      const epic = request.epicKey ? await this.getEpic(request.epicKey, project.id) : undefined;
      if (request.epicKey && !epic) {
        throw new Error(`Unknown epic key: ${request.epicKey} for project ${request.projectKey}`);
      }
      const story = request.storyKey ? await this.getStory(request.storyKey, project.id, epic?.id) : undefined;
      if (request.storyKey && !story) {
        throw new Error(`Unknown user story key: ${request.storyKey} for project ${request.projectKey}`);
      }
      const tasks = await this.fetchTasks(project.id, epic?.id, statuses, story?.id, request.assignee);
      const deps = await this.fetchDependencies(tasks.map((t) => t.id));
      const { nodes, dependents, missingRefs } = this.buildNodes(tasks, deps);
      if (missingRefs.size > 0) {
        warnings.push(`Missing dependencies referenced: ${Array.from(missingRefs).join(", ")}`);
      }
      const blockedSet = new Set<string>();
      for (const node of nodes) {
        if (node.blockedBy.length > 0 || node.status.toLowerCase() === "blocked") {
          blockedSet.add(node.id);
        }
      }
      const impact = this.dependencyImpactMap(dependents);
      const { ordered: initialOrder, cycle, cycleMembers } = this.topologicalSort(nodes, dependents, impact);
      if (cycle) {
        warnings.push("Dependency cycle detected; ordering may be partial.");
      }

      let agentRank: AgentRanking | undefined;
      const enableAgent = Boolean(request.agentName);
      let docContext: DocContext | undefined;
      if (enableAgent) {
        docContext = await this.buildDocContext(project.key, warnings);
        if (docContext && commandRun && this.recordTelemetry) {
          const contextTokens = estimateTokens(docContext.content);
          await this.jobService.recordTokenUsage({
            workspaceId: this.workspace.workspaceId,
            projectId: project.id,
            commandRunId: commandRun.id,
            jobId: job?.id,
            timestamp: new Date().toISOString(),
            commandName: "order-tasks",
            action: "docdex_context",
            tokensPrompt: contextTokens,
            tokensTotal: contextTokens,
            metadata: { source: docContext.source },
          });
        }
      }
      if (enableAgent) {
        try {
          const agent = await this.resolveAgent(request.agentName);
          const summary = {
            project: project.key,
            epic: epic?.key,
            statuses,
            tasks: initialOrder.map((t) => ({
              task_key: t.key,
              title: t.title,
              status: t.status,
              story_points: t.story_points,
              priority: t.priority,
              depends_on: (t.dependencies ?? []).map((d) => d.depends_on_key ?? d.depends_on_task_id).filter(Boolean),
              dependency_impact: impact.get(t.id),
            })),
          };
          const prompt = [
            "You are assisting with dependency-aware task ordering.",
            "Dependencies must NEVER be violated: a task cannot appear before any of its dependencies.",
            SDS_DEPENDENCY_GUIDE,
            docContext ? `Doc context:\n${docContext.content}` : undefined,
            "Given the current order, suggest a refined tie-break ordering (most depended-on first) and return JSON:",
            `{"order":[{"task_key":"<key>","note":"optional rationale"}]}`,
            "Only include task_keys from the input. Do not invent tasks.",
            "If the current order is fine, return the same order.",
            "Task summary:",
            JSON.stringify(summary, null, 2),
          ]
            .filter(Boolean)
            .join("\n\n");
          const { output } = await this.invokeAgent(agent, prompt, request.agentStream !== false, {
            command: "order-tasks",
            project: project.key,
            epic: epic?.key,
            story: story?.key,
            statuses,
            includeBlocked: request.includeBlocked === true,
          });
          const promptTokens = estimateTokens(prompt);
          const completionTokens = estimateTokens(output);
          if (commandRun && this.recordTelemetry) {
            await this.jobService.recordTokenUsage({
              workspaceId: this.workspace.workspaceId,
              projectId: project.id,
              commandRunId: commandRun.id,
              jobId: job?.id,
              agentId: agent.id,
              modelName: agent.defaultModel,
              timestamp: new Date().toISOString(),
              commandName: "order-tasks",
              action: "ordering_tasks",
              promptTokens,
              completionTokens,
              tokensPrompt: promptTokens,
              tokensCompletion: completionTokens,
              tokensTotal: promptTokens + completionTokens,
              metadata: {
                adapter: agent.adapter,
                epicKey: epic?.key,
                storyKey: story?.key,
                includeBlocked: request.includeBlocked === true,
                statusFilter: statuses,
                agentSlug: agent.slug,
                modelName: agent.defaultModel,
              },
            });
          }
          agentRank = this.applyAgentRanking(initialOrder, output, warnings);
        } catch (error) {
          warnings.push(`Agent refinement skipped: ${(error as Error).message}`);
        }
      }

      const { ordered, cycle: cycleAfterAgent, cycleMembers: agentCycleMembers } = this.topologicalSort(
        nodes,
        dependents,
        impact,
        agentRank,
      );
      const finalCycleMembers = new Set<string>([...cycleMembers, ...agentCycleMembers]);
      if (cycleAfterAgent && !cycle) {
        warnings.push("Agent-influenced ordering encountered a cycle; used partial order.");
      }

      const blockedTasks = ordered.filter((t) => blockedSet.has(t.id));
      const unblockedTasks = ordered.filter((t) => !blockedSet.has(t.id));
      const prioritized = [...unblockedTasks, ...blockedTasks];

      const epicMap = new Map<string, TaskNode[]>();
      const storyMap = new Map<string, TaskNode[]>();
      prioritized.forEach((task, idx) => {
        task.priority = idx + 1;
        const epicTasks = epicMap.get(task.epic_id) ?? [];
        epicTasks.push(task);
        epicMap.set(task.epic_id, epicTasks);
        const storyTasks = storyMap.get(task.story_id) ?? [];
        storyTasks.push(task);
        storyMap.set(task.story_id, storyTasks);
      });

      await this.persistPriorities(prioritized, epicMap, storyMap);

      const mapped = this.mapResult(prioritized, blockedSet, impact, finalCycleMembers);
      const visibleOrdered = request.includeBlocked ? mapped.ordered : mapped.ordered.filter((t) => !t.blocked);
      const visibleBlocked = request.includeBlocked ? [] : mapped.blocked;

      if (job) {
        await this.jobService.updateJobStatus(job.id, "completed", {
          processedItems: mapped.ordered.length,
          payload: {
            warnings,
            statuses,
            includeBlocked: request.includeBlocked === true,
            epicKey: epic?.key,
            storyKey: story?.key,
          },
        });
      }
      if (commandRun) {
        await this.jobService.finishCommandRun(commandRun.id, "succeeded", undefined, mapped.ordered.length);
      }
      return {
        project,
        epic,
        ordered: visibleOrdered,
        blocked: visibleBlocked,
        warnings,
        jobId: job?.id,
        commandRunId: commandRun?.id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job) {
        await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      }
      if (commandRun) {
        await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      }
      throw error;
    }
  }
}
