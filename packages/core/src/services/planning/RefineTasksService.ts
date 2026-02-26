import path from "node:path";
import { promises as fs } from "node:fs";
import YAML from "yaml";
import { AgentService } from "@mcoda/agents";
import { DocdexClient } from "@mcoda/integrations";
import { READY_TO_CODE_REVIEW } from "@mcoda/shared";
import { GlobalRepository, TaskDependencyInsert, TaskInsert, TaskRow, WorkspaceRepository } from "@mcoda/db";
import {
  RefineOperation,
  RefineStrategy,
  RefineTasksPlan,
  RefineTasksRequest,
  RefineTasksResult,
  SplitTaskOp,
  UpdateTaskOp,
  getCommandRequiredCapabilities,
  type Agent,
} from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { classifyTask } from "../backlog/TaskOrderingHeuristics.js";
import { TaskOrderingService } from "../backlog/TaskOrderingService.js";
import { createTaskKeyGenerator } from "./KeyHelpers.js";

interface RefineTasksOptions extends RefineTasksRequest {
  workspace: WorkspaceResolution;
  storyKey?: string;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  fromDb?: boolean;
  planInPath?: string;
  planOutPath?: string;
  jobId?: string;
  apply?: boolean;
  excludeAlreadyRefined?: boolean;
  allowEmptySelection?: boolean;
  outputJson?: boolean;
}

interface CandidateTask extends TaskRow {
  storyKey: string;
  epicKey: string;
  dependencies: string[];
}

interface StoryGroup {
  epic: {
    id: string;
    key: string;
    title: string;
    description?: string;
  };
  story: {
    id: string;
    key: string;
    title: string;
    description?: string;
    acceptance?: string[];
  };
  tasks: CandidateTask[];
  docSummary?: string;
  historySummary?: string;
}

const DEFAULT_STRATEGY: RefineStrategy = "auto";
const FORBIDDEN_TARGET_STATUSES = new Set([READY_TO_CODE_REVIEW, "ready_to_qa", "completed"]);
const normalizeCreateStatus = (status?: string): string => {
  if (!status) return "not_started";
  return status.toLowerCase();
};
const DEFAULT_MAX_TASKS = 250;
const MAX_AGENT_OUTPUT_CHARS = 10_000_000;
const PLANNING_DOC_HINT_PATTERN = /(sds|pdr|rfp|requirements|architecture|openapi|swagger|design)/i;
const OPENAPI_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const OPENAPI_HINTS_LIMIT = 20;

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const parseStructuredDoc = (raw: string): Record<string, unknown> | undefined => {
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = YAML.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // continue
  }
  try {
    const parsed = JSON.parse(raw);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // ignore
  }
  return undefined;
};

const extractJson = (raw: string): any | undefined => {
  const fencedMatches = [...raw.matchAll(/```json([\s\S]*?)```/g)].map((match) => match[1]);
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const candidates = [...fencedMatches, stripped, raw].filter((candidate) => candidate.trim().length > 0);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const tryParseJson = (value: string): any | undefined => {
  try {
    return JSON.parse(value);
  } catch {
    // continue
  }
  const objects = extractJsonObjects(value).reverse();
  for (const obj of objects) {
    try {
      return JSON.parse(obj);
    } catch {
      // continue
    }
  }
  return undefined;
};

const extractJsonObjects = (value: string): string[] => {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(value.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
};

const normalizePlanJson = (parsed: any): RefineTasksPlan | undefined => {
  if (!parsed) return undefined;
  if (Array.isArray(parsed)) {
    return { operations: parsed };
  }
  if (Array.isArray(parsed.operations)) return parsed as RefineTasksPlan;
  if (parsed.op) {
    return { operations: [parsed] };
  }
  return undefined;
};

const normalizeOperation = (op: any): RefineOperation => {
  if (!op || typeof op !== "object") return op as RefineOperation;
  const opType = (op as any).op;
  const taskKey = (op as any).taskKey ?? (op as any).key ?? (op as any).task ?? (op as any).targetTaskKey ?? null;
  if (opType === "update_task") {
    const updates = { ...(op as any).updates };
    const inlineFields = [
      "title",
      "description",
      "acceptanceCriteria",
      "type",
      "status",
      "storyPoints",
      "priority",
      "dependsOn",
      "metadata",
    ];
    for (const field of inlineFields) {
      if (op[field] !== undefined && updates[field] === undefined) {
        updates[field] = op[field];
      }
    }
    return {
      ...(op as any),
      taskKey,
      updates,
    } as RefineOperation;
  }
  if (opType === "split_task") {
    const children =
      Array.isArray((op as any).children)
        ? (op as any).children
        : Array.isArray((op as any).subtasks)
          ? (op as any).subtasks
          : Array.isArray((op as any).newTasks)
            ? (op as any).newTasks
            : Array.isArray((op as any).tasks)
              ? (op as any).tasks
              : undefined;
    return {
      ...(op as any),
      taskKey,
      children,
    } as RefineOperation;
  }
  return {
    ...(op as any),
    taskKey,
  } as RefineOperation;
};

const safeParsePlan = (content: string): RefineTasksPlan | undefined => {
  const parsed = extractJson(content);
  return normalizePlanJson(parsed);
};

const formatTaskSummary = (task: CandidateTask): string => {
  return [
    `- ${task.key}: ${task.title} [${task.status}${task.type ? `/${task.type}` : ""}]`,
    task.storyPoints !== null && task.storyPoints !== undefined ? `  SP: ${task.storyPoints}` : "",
    task.dependencies.length ? `  Depends on: ${task.dependencies.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

const splitChildReferenceFields = ["taskKey", "key", "localId", "id", "slug", "alias", "ref"] as const;

const normalizeSplitDependencyRef = (value: string): string => value.trim().toLowerCase();

const collectSplitChildReferences = (child: SplitTaskOp["children"][number]): string[] => {
  const references: string[] = [];
  const childRecord = child as unknown as Record<string, unknown>;
  for (const field of splitChildReferenceFields) {
    const candidate = childRecord[field];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      references.push(candidate.trim());
    }
  }
  if (typeof child.title === "string" && child.title.trim().length > 0) {
    references.push(child.title.trim());
  }
  return Array.from(new Set(references));
};

export class RefineTasksService {
  private docdex: DocdexClient;
  private jobService: JobService;
  private agentService: AgentService;
  private repo: GlobalRepository;
  private workspaceRepo: WorkspaceRepository;
  private routingService: RoutingService;
  private workspace: WorkspaceResolution;
  private ratingService?: AgentRatingService;

  constructor(
    workspace: WorkspaceResolution,
    deps: {
      docdex: DocdexClient;
      jobService: JobService;
      agentService: AgentService;
      repo: GlobalRepository;
      workspaceRepo: WorkspaceRepository;
      routingService: RoutingService;
      ratingService?: AgentRatingService;
    },
  ) {
    this.workspace = workspace;
    this.docdex = deps.docdex;
    this.jobService = deps.jobService;
    this.agentService = deps.agentService;
    this.repo = deps.repo;
    this.workspaceRepo = deps.workspaceRepo;
    this.routingService = deps.routingService;
    this.ratingService = deps.ratingService;
  }

  static async create(workspace: WorkspaceResolution): Promise<RefineTasksService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
      repoId: docdexRepoId,
    });
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo);
    return new RefineTasksService(workspace, {
      docdex,
      jobService,
      agentService,
      repo,
      workspaceRepo,
      routingService,
    });
  }

  async close(): Promise<void> {
    const tryClose = async (target: unknown) => {
      try {
        if ((target as any)?.close) {
          await (target as any).close();
        }
      } catch {
        // ignore close errors
      }
    };
    await tryClose(this.agentService);
    await tryClose(this.repo);
    await tryClose(this.jobService);
    await tryClose(this.workspaceRepo);
    await tryClose(this.routingService);
    await tryClose(this.docdex);
  }

  private async seedPriorities(projectKey: string): Promise<void> {
    const ordering = await TaskOrderingService.create(this.workspace, { recordTelemetry: false });
    try {
      await ordering.orderTasks({
        projectKey,
        apply: true,
      });
    } finally {
      await ordering.close();
    }
  }

  private async resolveAgent(agentName?: string): Promise<Agent> {
    try {
      const resolved = await this.routingService.resolveAgentForCommand({
        workspace: this.workspace,
        commandName: "refine-tasks",
        overrideAgentSlug: agentName,
      });
      return resolved.agent;
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (!/No routing defaults/i.test(message)) {
        throw error;
      }
      const requiredCaps = getCommandRequiredCapabilities("refine-tasks");
      const fallback = await this.selectFallbackAgent(requiredCaps);
      if (fallback) return fallback;
      throw new Error(
        `No routing defaults found for command refine-tasks. ` +
          `Set a default agent (mcoda agent set-default <NAME> --workspace <PATH>) ` +
          `or pass --agent <NAME> with ${requiredCaps.length ? `capabilities: ${requiredCaps.join(", ")}` : "required capabilities"}.`,
      );
    }
  }

  private async selectFallbackAgent(requiredCaps: string[]): Promise<Agent | undefined> {
    const agents = await this.repo.listAgents();
    if (!agents.length) return undefined;
    let healthRows: { agentId: string; status?: string }[] = [];
    try {
      healthRows = await this.repo.listAgentHealthSummary();
    } catch {
      healthRows = [];
    }
    const healthById = new Map(healthRows.map((row) => [row.agentId, row]));
    const candidates: Array<{
      agent: Agent;
      rating: number;
      reasoning: number;
      cost: number;
      hasCaps: boolean;
      slug: string;
    }> = [];
    for (const agent of agents) {
      const health = healthById.get(agent.id);
      if (health?.status === "unreachable") continue;
      const caps = await this.repo.getAgentCapabilities(agent.id);
      const hasCaps = requiredCaps.every((cap) => caps.includes(cap));
      candidates.push({
        agent,
        rating: Number(agent.rating ?? 0),
        reasoning: Number(agent.reasoningRating ?? 0),
        cost: Number(agent.costPerMillion ?? 0),
        hasCaps,
        slug: agent.slug ?? agent.id,
      });
    }
    if (!candidates.length) return undefined;
    const eligible = candidates.filter((c) => c.hasCaps);
    const pool = eligible.length ? eligible : candidates;
    pool.sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      if (b.reasoning !== a.reasoning) return b.reasoning - a.reasoning;
      if (a.cost !== b.cost) return a.cost - b.cost;
      return a.slug.localeCompare(b.slug);
    });
    return pool[0]?.agent;
  }

  private ensureRatingService(): AgentRatingService {
    if (!this.ratingService) {
      this.ratingService = new AgentRatingService(this.workspace, {
        workspaceRepo: this.workspaceRepo,
        globalRepo: this.repo,
        agentService: this.agentService,
        routingService: this.routingService,
      });
    }
    return this.ratingService;
  }

  private async selectTasks(
    projectKey: string,
    filters: {
      epicKey?: string;
      storyKey?: string;
      taskKeys?: string[];
      statusFilter?: string[];
      maxTasks?: number;
      excludeAlreadyRefined?: boolean;
    },
  ): Promise<{ projectId: string; groups: StoryGroup[]; warnings: string[] }> {
    const db = this.workspaceRepo.getDb();
    const warnings: string[] = [];
    const project = await this.workspaceRepo.getProjectByKey(projectKey);
    if (!project) {
      throw new Error(`Unknown project key: ${projectKey}`);
    }

    const epicRow = filters.epicKey
      ? await db.get<{ id: string; key: string; title: string; description?: string }>(
          `SELECT id, key, title, description FROM epics WHERE key = ? AND project_id = ?`,
          filters.epicKey,
          project.id,
        )
      : undefined;
    if (filters.epicKey && !epicRow) {
      throw new Error(`Unknown epic key ${filters.epicKey} under project ${projectKey}`);
    }

    const storyRow = filters.storyKey
      ? await db.get<{ id: string; key: string; epic_id: string; title: string; description?: string; acceptance_criteria?: string | null }>(
          `SELECT id, key, epic_id, title, description, acceptance_criteria FROM user_stories WHERE key = ?`,
          filters.storyKey,
        )
      : undefined;
    if (filters.storyKey && !storyRow) {
      throw new Error(`Unknown user story key ${filters.storyKey}`);
    }
    if (filters.storyKey && epicRow && storyRow && storyRow.epic_id !== epicRow.id) {
      throw new Error(`Story ${filters.storyKey} is not under epic ${filters.epicKey}`);
    }

    const clauses: string[] = ["t.project_id = ?"];
    const params: any[] = [project.id];
    if (epicRow) {
      clauses.push("t.epic_id = ?");
      params.push(epicRow.id);
    }
    if (storyRow) {
      clauses.push("t.user_story_id = ?");
      params.push(storyRow.id);
    }
    if (filters.taskKeys && filters.taskKeys.length > 0) {
      clauses.push(`t.key IN (${filters.taskKeys.map(() => "?").join(", ")})`);
      params.push(...filters.taskKeys);
    }
    if (filters.statusFilter && filters.statusFilter.length > 0) {
      clauses.push(`LOWER(t.status) IN (${filters.statusFilter.map(() => "?").join(", ")})`);
      params.push(...filters.statusFilter.map((s) => s.toLowerCase()));
    }
    if (filters.excludeAlreadyRefined) {
      clauses.push(
        `NOT EXISTS (
          SELECT 1
          FROM task_runs tr
          WHERE tr.task_id = t.id
            AND tr.command = ?
            AND LOWER(tr.status) = 'succeeded'
        )`,
      );
      params.push("refine-tasks");
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.maxTasks ? `LIMIT ${filters.maxTasks}` : "";
    const rows = await db.all<any[]>(
      `
      SELECT
        t.id AS task_id,
        t.key AS task_key,
        t.project_id AS project_id,
        t.epic_id AS epic_id,
        t.user_story_id AS story_id,
        t.title AS task_title,
        t.description AS task_description,
        t.type AS task_type,
        t.status AS task_status,
        t.story_points AS task_story_points,
        t.priority AS task_priority,
        t.metadata_json AS task_metadata,
        e.key AS epic_key,
        e.title AS epic_title,
        e.description AS epic_description,
        s.key AS story_key,
        s.title AS story_title,
        s.description AS story_description,
        s.acceptance_criteria AS story_acceptance
      FROM tasks t
      INNER JOIN epics e ON e.id = t.epic_id
      INNER JOIN user_stories s ON s.id = t.user_story_id
      ${where}
      ORDER BY s.priority IS NULL, s.priority, t.priority IS NULL, t.priority, t.created_at
      ${limit}
    `,
      params,
    );

    const taskIds = rows.map((r) => r.task_id);
    const depMap = new Map<string, string[]>();
    if (taskIds.length > 0) {
      const depRows = await db.all<{ task_id: string; dep_key: string }[]>(
        `
        SELECT td.task_id, dep.key AS dep_key
        FROM task_dependencies td
        INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
        WHERE td.task_id IN (${taskIds.map(() => "?").join(", ")})
      `,
        taskIds,
      );
      for (const dep of depRows) {
        const list = depMap.get(dep.task_id) ?? [];
        list.push(dep.dep_key);
        depMap.set(dep.task_id, list);
      }
    }

    const groups = new Map<string, StoryGroup>();
    for (const row of rows) {
      const acceptance = row.story_acceptance ? String(row.story_acceptance).split(/\r?\n/).filter(Boolean) : [];
      const groupKey = row.story_id;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          epic: { id: row.epic_id, key: row.epic_key, title: row.epic_title, description: row.epic_description ?? undefined },
          story: { id: row.story_id, key: row.story_key, title: row.story_title, description: row.story_description ?? undefined, acceptance },
          tasks: [],
        });
      }
      const group = groups.get(groupKey)!;
      const task: CandidateTask = {
        id: row.task_id,
        projectId: row.project_id,
        epicId: row.epic_id,
        userStoryId: row.story_id,
        key: row.task_key,
        title: row.task_title,
        description: row.task_description ?? undefined,
        type: row.task_type ?? undefined,
        status: row.task_status,
        storyPoints: row.task_story_points ?? null,
        priority: row.task_priority ?? null,
        assignedAgentId: null,
        assigneeHuman: null,
        vcsBranch: null,
        vcsBaseBranch: null,
        vcsLastCommitSha: null,
        metadata: row.task_metadata ? JSON.parse(row.task_metadata) : undefined,
        openapiVersionAtCreation: null,
        createdAt: "",
        updatedAt: "",
        storyKey: row.story_key,
        epicKey: row.epic_key,
        dependencies: depMap.get(row.task_id) ?? [],
      };
      group.tasks.push(task);
    }

    if (filters.maxTasks && rows.length > filters.maxTasks) {
      warnings.push(`max-tasks=${filters.maxTasks} truncated selection to ${filters.maxTasks} tasks.`);
    }

    return { projectId: project.id, groups: Array.from(groups.values()), warnings };
  }

  private parseTaskKeyParts(taskKey: string): { storyKey: string; epicKey: string } | null {
    const match = taskKey.match(/^(.*-us-\d+)-t\d+$/);
    if (!match) return null;
    const storyKey = match[1];
    const epicMatch = storyKey.match(/^(.*)-us-\d+$/);
    const epicKey = epicMatch ? epicMatch[1] : storyKey.split("-us-")[0];
    return { storyKey, epicKey };
  }

  private async ensureTaskExists(
    projectId: string,
    projectKey: string,
    taskKey: string,
    createIfMissing: boolean,
    seed?: { fields?: Record<string, unknown>; updates?: Record<string, unknown> },
  ): Promise<{ task: CandidateTask; epic: StoryGroup["epic"]; story: StoryGroup["story"] } | undefined> {
    const parts = this.parseTaskKeyParts(taskKey);
    if (!parts) return undefined;
    const db = this.workspaceRepo.getDb();
    const existing = await this.workspaceRepo.getTaskByKey(taskKey);
    const loadDeps = async (taskId: string): Promise<string[]> => {
      const depRows = await db.all<{ dep_key: string }[]>(
        `SELECT dep.key AS dep_key
         FROM task_dependencies td
         INNER JOIN tasks dep ON dep.id = td.depends_on_task_id
         WHERE td.task_id = ?`,
        taskId,
      );
      return depRows.map((d) => d.dep_key);
    };

    const ensureEpic = async (): Promise<StoryGroup["epic"]> => {
      const row = await db.get<{ id: string; key: string; title: string; description?: string }>(
        `SELECT id, key, title, description FROM epics WHERE key = ? AND project_id = ?`,
        parts.epicKey,
        projectId,
      );
      if (row) return { id: row.id, key: row.key, title: row.title, description: row.description ?? undefined };
      const [inserted] = await this.workspaceRepo.insertEpics(
        [
          {
            projectId,
            key: parts.epicKey,
            title: `Epic ${parts.epicKey}`,
            description: `Auto-created while applying refine plan for ${projectKey}`,
            storyPointsTotal: null,
            priority: null,
          },
        ],
        false,
      );
      return { id: inserted.id, key: inserted.key, title: inserted.title, description: inserted.description ?? undefined };
    };

    const ensureStory = async (epicId: string): Promise<StoryGroup["story"]> => {
      const row = await db.get<{
        id: string;
        key: string;
        title: string;
        description?: string;
        acceptance_criteria?: string | null;
      }>(`SELECT id, key, title, description, acceptance_criteria FROM user_stories WHERE key = ?`, parts.storyKey);
      if (row) {
        const acceptance = row.acceptance_criteria ? String(row.acceptance_criteria).split(/\r?\n/).filter(Boolean) : [];
        return {
          id: row.id,
          key: row.key,
          title: row.title,
          description: row.description ?? undefined,
          acceptance,
        };
      }
      const [inserted] = await this.workspaceRepo.insertStories(
        [
          {
            projectId,
            epicId,
            key: parts.storyKey,
            title: `Story ${parts.storyKey}`,
            description: `Auto-created while applying refine plan for ${projectKey}`,
            acceptanceCriteria: undefined,
            storyPointsTotal: null,
            priority: null,
          },
        ],
        false,
      );
      return {
        id: inserted.id,
        key: inserted.key,
        title: inserted.title,
        description: inserted.description ?? undefined,
        acceptance: [],
      };
    };

    if (existing) {
      const epicRow = await db.get<{ id: string; key: string; title: string; description?: string }>(
        `SELECT id, key, title, description FROM epics WHERE id = ?`,
        existing.epicId,
      );
      const storyRow = await db.get<{
        id: string;
        key: string;
        title: string;
        description?: string;
        acceptance_criteria?: string | null;
      }>(`SELECT id, key, title, description, acceptance_criteria FROM user_stories WHERE id = ?`, existing.userStoryId);
      const acceptance = storyRow?.acceptance_criteria
        ? String(storyRow.acceptance_criteria).split(/\r?\n/).filter(Boolean)
        : [];
      return {
        task: {
          ...existing,
          storyKey: storyRow?.key ?? parts.storyKey,
          epicKey: epicRow?.key ?? parts.epicKey,
          dependencies: await loadDeps(existing.id),
        },
        epic: {
          id: epicRow?.id ?? existing.epicId,
          key: epicRow?.key ?? parts.epicKey,
          title: epicRow?.title ?? `Epic ${parts.epicKey}`,
          description: epicRow?.description ?? undefined,
        },
        story: {
          id: storyRow?.id ?? existing.userStoryId,
          key: storyRow?.key ?? parts.storyKey,
          title: storyRow?.title ?? `Story ${parts.storyKey}`,
          description: storyRow?.description ?? undefined,
          acceptance,
        },
      };
    }

    if (!createIfMissing) return undefined;

    const updates = (seed?.updates as Record<string, unknown>) ?? (seed?.fields as Record<string, unknown>) ?? {};
    const epic = await ensureEpic();
    const story = await ensureStory(epic.id);
    const status = normalizeCreateStatus(updates.status as string | undefined);

    const [task] = await this.workspaceRepo.insertTasks(
      [
        {
          projectId,
          epicId: epic.id,
          userStoryId: story.id,
          key: taskKey,
          title: (updates.title as string | undefined) ?? `Task ${taskKey}`,
          description: (updates.description as string | undefined) ?? "",
          type: (updates.type as string | undefined) ?? "feature",
          status,
          storyPoints: (updates.storyPoints as number | undefined) ?? null,
          priority: (updates.priority as number | undefined) ?? null,
          metadata: (updates.metadata as Record<string, unknown> | undefined) ?? undefined,
        },
      ],
      false,
    );

    return {
      task: {
        ...task,
        storyKey: story.key,
        epicKey: epic.key,
        dependencies: [],
      },
      epic,
      story,
    };
  }

  private buildStoryPrompt(group: StoryGroup, strategy: RefineStrategy, docSummary?: string): string {
    const taskList = group.tasks.map((t) => formatTaskSummary(t)).join("\n");
    const constraints = [
      "- Immutable: project_id, epic_id, user_story_id, task keys.",
      "- Allowed edits: title, description, acceptanceCriteria, metadata/labels, type, priority, storyPoints, status (but NOT ready_to_code_review/qa/completed).",
      "- Splits: children stay under same story; keep parent unless keepParent=false; child dependsOn must reference existing tasks or siblings.",
      "- Merges: target and sources must be in same story; prefer cancelling redundant sources (status=cancelled) and preserve useful details in target updates.",
      "- Dependencies: maintain DAG; do not introduce cycles or cross-story edges.",
      "- Enrichment focus: strengthen task descriptions with concrete implementation scope, expected files/modules, and actionable validation details.",
      "- Story points: non-negative, keep within typical agile range (0-13).",
      "- Do not invent new epics/stories or change parentage.",
    ].join("\n");
    return [
      `You are refining tasks for epic ${group.epic.key} "${group.epic.title}" and story ${group.story.key} "${group.story.title}".`,
      `Strategy: ${strategy}`,
      "Story acceptance criteria:",
      group.story.acceptance?.length ? group.story.acceptance.map((c) => `- ${c}`).join("\n") : "- (none provided)",
      "Current tasks:",
      taskList || "- (no tasks selected)",
      "Doc context (summaries only):",
      docSummary || "(none)",
      "Recent task history (logs/comments):",
      group.historySummary || "(none)",
      "Constraints:",
      constraints,
      "Example JSON:",
      "{\"operations\":[{\"op\":\"update_task\",\"taskKey\":\"web-01-us-01-t01\",\"updates\":{\"title\":\"Refined title\",\"storyPoints\":3}}]}",
      "Return JSON ONLY matching: { \"operations\": [UpdateTaskOp | SplitTaskOp | MergeTasksOp | UpdateEstimateOp] } where each item has an `op` discriminator (update_task|split_task|merge_tasks|update_estimate).",
    ].join("\n\n");
  }

  private buildOpenApiHintSummary(docs: any[]): string {
    const lines: string[] = [];
    for (const doc of docs ?? []) {
      const raw =
        typeof doc?.content === "string" && doc.content.trim().length > 0
          ? doc.content
          : Array.isArray(doc?.segments)
            ? doc.segments
                .map((segment: any) => (typeof segment?.content === "string" ? segment.content : ""))
                .filter(Boolean)
                .join("\n\n")
            : "";
      const parsed = parseStructuredDoc(raw);
      if (!parsed) continue;
      const paths = parsed.paths;
      if (!isPlainObject(paths)) continue;
      for (const [apiPath, pathItem] of Object.entries(paths)) {
        if (!isPlainObject(pathItem)) continue;
        for (const [method, operation] of Object.entries(pathItem)) {
          const normalizedMethod = method.toLowerCase();
          if (!OPENAPI_METHODS.has(normalizedMethod)) continue;
          if (!isPlainObject(operation)) continue;
          const hints = operation["x-mcoda-task-hints"];
          if (!isPlainObject(hints)) continue;
          const service = typeof hints.service === "string" ? hints.service : "-";
          const capability = typeof hints.capability === "string" ? hints.capability : "-";
          const stage = typeof hints.stage === "string" ? hints.stage : "-";
          const complexity =
            typeof hints.complexity === "number" && Number.isFinite(hints.complexity)
              ? hints.complexity.toFixed(1)
              : "-";
          const countItems = (value: unknown): number =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").length : 0;
          const dependsOn = countItems(hints.depends_on_operations);
          const testRequirements = isPlainObject(hints.test_requirements) ? hints.test_requirements : undefined;
          lines.push(
            `- ${normalizedMethod.toUpperCase()} ${apiPath} :: service=${service}; capability=${capability}; stage=${stage}; complexity=${complexity}; deps=${dependsOn}; tests(u/c/i/a)=${countItems(testRequirements?.unit)}/${countItems(testRequirements?.component)}/${countItems(testRequirements?.integration)}/${countItems(testRequirements?.api)}`,
          );
          if (lines.length >= OPENAPI_HINTS_LIMIT) {
            return lines.join("\n");
          }
        }
      }
    }
    return lines.join("\n");
  }

  private async summarizeDocs(projectKey: string, epicKey?: string, storyKey?: string): Promise<{ summary: string; warnings: string[] }> {
    const warnings: string[] = [];
    const startedAt = Date.now();
    try {
      const query = [epicKey, storyKey, "sds requirements architecture openapi swagger api contracts endpoints"]
        .filter(Boolean)
        .join(" ");
      let docs = await this.docdex.search({
        projectKey,
        profile: "sds",
        query,
      });
      if (!docs || docs.length === 0) {
        docs = await this.docdex.search({
          projectKey,
          profile: "openapi",
          query,
        });
      }
      if (!docs || docs.length === 0) {
        docs = await this.docdex.search({
          projectKey,
          profile: "workspace-code",
          query,
        });
      }
      if (!docs || docs.length === 0) {
        return { summary: "(no relevant docdex entries)", warnings: [] };
      }
      const top = docs
        .filter((doc) => {
          const type = (doc.docType ?? "").toLowerCase();
          const pathTitle = `${doc.path ?? ""} ${doc.title ?? ""}`.toLowerCase();
          return type.includes("sds") || type.includes("pdr") || type.includes("rfp") || PLANNING_DOC_HINT_PATTERN.test(pathTitle);
        })
        .slice(0, 5);
      const selected = top.length > 0 ? top : docs.slice(0, 5);
      const summary = top
        .map((doc) => {
          const segments = (doc.segments ?? []).slice(0, 3);
          const segText = segments
            .map((seg, idx) => {
              const snippet = seg.content.length > 180 ? `${seg.content.slice(0, 180)}...` : seg.content;
              return `    (${idx + 1}) ${seg.heading ? `${seg.heading}: ` : ""}${snippet}`;
            })
            .join("\n");
          const head = doc.content ? doc.content.split(/\r?\n/).slice(0, 2).join(" ").slice(0, 160) : "";
          return [`- [${doc.docType}] ${doc.title ?? doc.path ?? doc.id}${head ? ` — ${head}` : ""}`, segText].filter(Boolean).join("\n");
        })
        .join("\n");
      const finalSummary = (summary || (selected.length ? selected.map((doc) => `- ${doc.title ?? doc.path ?? doc.id}`).join("\n") : "")).trim();
      const openApiHintSummary = this.buildOpenApiHintSummary(selected);
      const composedSummary = [finalSummary || "(no doc segments found)", openApiHintSummary ? `[OPENAPI_HINTS]\n${openApiHintSummary}` : ""]
        .filter(Boolean)
        .join("\n\n");
      const durationSeconds = (Date.now() - startedAt) / 1000;
      await this.jobService.recordTokenUsage({
        workspaceId: this.workspace.workspaceId,
        jobId: undefined,
        commandRunId: undefined,
        agentId: undefined,
        modelName: "docdex",
        tokensPrompt: null,
        tokensCompletion: null,
        tokensTotal: null,
        durationSeconds,
        timestamp: new Date().toISOString(),
        metadata: { command: "refine-tasks", action: "docdex_search", projectKey, epicKey, storyKey },
      });
      return { summary: composedSummary, warnings };
    } catch (error) {
      warnings.push(`Docdex lookup failed: ${(error as Error).message}`);
      return { summary: "(docdex unavailable)", warnings };
    }
  }

  private async summarizeHistory(taskIds: string[]): Promise<string> {
    if (taskIds.length === 0) return "(none)";
    const db = this.workspaceRepo.getDb();
    const placeholders = taskIds.map(() => "?").join(", ");
    try {
      const rows = await db.all<
        { task_id: string; timestamp: string; level: string | null; message: string | null; source: string | null }[]
      >(
        `
        SELECT r.task_id, l.timestamp, l.level, l.message, l.source
        FROM task_logs l
        INNER JOIN task_runs r ON r.id = l.task_run_id
        WHERE r.task_id IN (${placeholders})
        ORDER BY l.timestamp DESC
        LIMIT 15
      `,
        taskIds,
      );
      if (!rows || rows.length === 0) return "(none)";
      return rows
        .map((row) => {
          const level = row.level ? row.level.toUpperCase() : "INFO";
          const msg = row.message ?? "";
          return `- ${row.task_id}: [${level}] ${msg} (${row.source ?? "run"})`;
        })
        .join("\n");
    } catch {
      return "(unavailable)";
    }
  }

  private async logWarningsToTasks(
    taskIds: string[],
    jobId: string,
    commandRunId: string,
    message: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    for (const taskId of taskIds) {
      try {
        const run = await this.workspaceRepo.createTaskRun({
          taskId,
          command: "refine-tasks",
          status: "succeeded",
          jobId,
          commandRunId,
          startedAt: now,
          finishedAt: now,
          runContext: { warning: true },
        });
        await this.workspaceRepo.insertTaskLog({
          taskRunId: run.id,
          sequence: 0,
          timestamp: now,
          level: "warn",
          source: "refine-tasks",
          message,
          details: { warning: true },
        });
      } catch {
        // Best-effort logging only.
      }
    }
  }

  private mergeMetadata(existing: Record<string, unknown> | undefined, updates?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!updates) return existing;
    return { ...(existing ?? {}), ...updates };
  }

  private applyStageMetadata(
    metadata: Record<string, unknown> | undefined,
    content: { title: string; description?: string | null; type?: string | null },
    shouldUpdate: boolean,
  ): Record<string, unknown> | undefined {
    if (!shouldUpdate) return metadata;
    const classification = classifyTask({
      title: content.title,
      description: content.description ?? undefined,
      type: content.type ?? undefined,
    });
    return {
      ...(metadata ?? {}),
      stage: classification.stage,
      foundation: classification.foundation,
    };
  }

  private validateOperation(group: StoryGroup, op: RefineOperation): { valid: boolean; reason?: string } {
    const allowedOps = new Set(["update_task", "split_task", "merge_tasks", "update_estimate"]);
    if (!op || typeof (op as any).op !== "string" || !allowedOps.has((op as any).op)) {
      return { valid: false, reason: "Unknown op type" };
    }
    if (op.op === "update_task") {
      if (!op.taskKey || typeof op.updates !== "object") {
        return { valid: false, reason: "update_task missing taskKey or updates" };
      }
    }
    if (op.op === "split_task") {
      const split = op as SplitTaskOp;
      if (!split.taskKey || !Array.isArray(split.children) || split.children.length === 0) {
        return { valid: false, reason: "split_task missing taskKey or children" };
      }
    }
    if (op.op === "merge_tasks") {
      if (!op.targetTaskKey || !Array.isArray(op.sourceTaskKeys) || op.sourceTaskKeys.length === 0) {
        return { valid: false, reason: "merge_tasks missing targets" };
      }
    }
    if (op.op === "update_estimate") {
      if (!op.taskKey) return { valid: false, reason: "update_estimate missing taskKey" };
    }
    const keySet = new Set(group.tasks.map((t) => t.key));
    if ((op as any).taskKey && !keySet.has((op as any).taskKey)) {
      return { valid: false, reason: `Unknown task key ${(op as any).taskKey} for story ${group.story.key}` };
    }
    if ((op as any).targetTaskKey && !keySet.has((op as any).targetTaskKey)) {
      return { valid: false, reason: `Unknown merge target ${(op as any).targetTaskKey}` };
    }
    if ((op as any).sourceTaskKeys) {
      const missing = (op as any).sourceTaskKeys.filter((k: string) => !keySet.has(k));
      if (missing.length) {
        return { valid: false, reason: `Merge sources not in story ${group.story.key}: ${missing.join(", ")}` };
      }
    }
    if (op.op === "update_task" && op.updates.status && FORBIDDEN_TARGET_STATUSES.has(op.updates.status.toLowerCase())) {
      return { valid: false, reason: `Status ${op.updates.status} not allowed in refine-tasks` };
    }
    if (op.op === "update_task" && op.updates.storyPoints !== undefined) {
      const sp = op.updates.storyPoints;
      if (sp !== null && (typeof sp !== "number" || sp < 0 || sp > 13)) {
        return { valid: false, reason: `Story points out of bounds for ${op.taskKey}` };
      }
    }
    if (op.op === "split_task") {
      const split = op as SplitTaskOp;
      const taskKeysByNormalized = new Map<string, string>();
      for (const key of keySet) {
        taskKeysByNormalized.set(normalizeSplitDependencyRef(key), key);
      }
      const siblingReferences = new Set<string>();
      const selfReferencesByChild = split.children.map((child) => {
        const selfReferences = new Set<string>();
        for (const reference of collectSplitChildReferences(child)) {
          const normalized = normalizeSplitDependencyRef(reference);
          if (!normalized) continue;
          selfReferences.add(normalized);
          siblingReferences.add(normalized);
        }
        return selfReferences;
      });
      const invalidDep = split.children.some((child) =>
        child.dependsOn?.some((dep) => {
          const normalized = normalizeSplitDependencyRef(dep);
          if (!normalized) return false;
          if (taskKeysByNormalized.has(normalized)) return false;
          if (siblingReferences.has(normalized)) return false;
          return true;
        }),
      );
      if (invalidDep) {
        return { valid: false, reason: "Split child references unknown dependency" };
      }
      const selfDependency = split.children.some((child, index) =>
        child.dependsOn?.some((dep) => selfReferencesByChild[index]?.has(normalizeSplitDependencyRef(dep))),
      );
      if (selfDependency) {
        return { valid: false, reason: "Split child cannot depend on itself" };
      }
      if (split.children.some((child) => child.storyPoints !== undefined && child.storyPoints !== null && (child.storyPoints < 0 || child.storyPoints > 13))) {
        return { valid: false, reason: "Child story points out of bounds" };
      }
      const crossStory = split.children.some((child) => (child as any).storyKey && (child as any).storyKey !== group.story.key);
      if (crossStory) {
        return { valid: false, reason: "Split children must stay within the same story" };
      }
    }
    if (op.op === "merge_tasks") {
      const crossStory =
        op.sourceTaskKeys.some((k) => !keySet.has(k)) ||
        (op.targetTaskKey && !keySet.has(op.targetTaskKey));
      if (crossStory) {
        return { valid: false, reason: "Merge must stay within the same story" };
      }
      const uniqueSources = new Set(op.sourceTaskKeys.filter(Boolean));
      if (uniqueSources.size !== op.sourceTaskKeys.length) {
        return { valid: false, reason: "Duplicate source task keys in merge" };
      }
      if (uniqueSources.has(op.targetTaskKey)) {
        return { valid: false, reason: "Merge sources cannot include target" };
      }
    }
    return { valid: true };
  }

  private detectCycle(edges: Array<{ from: string; to: string }>): boolean {
    const adj = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adj.get(edge.from) ?? [];
      list.push(edge.to);
      adj.set(edge.from, list);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (node: string): boolean => {
      if (visiting.has(node)) return true;
      if (visited.has(node)) return false;
      visiting.add(node);
      for (const nxt of adj.get(node) ?? []) {
        if (dfs(nxt)) return true;
      }
      visiting.delete(node);
      visited.add(node);
      return false;
    };
    for (const node of adj.keys()) {
      if (dfs(node)) return true;
    }
    return false;
  }

  private hasDependencyPath(graph: Map<string, Set<string>>, fromKey: string, toKey: string): boolean {
    if (fromKey === toKey) return true;
    const visited = new Set<string>();
    const stack = [fromKey];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === toKey) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = graph.get(current);
      if (!neighbors) continue;
      for (const next of neighbors) {
        if (!visited.has(next)) stack.push(next);
      }
    }
    return false;
  }

  private async applyOperations(
    projectId: string,
    jobId: string,
    commandRunId: string,
    group: StoryGroup,
    operations: RefineOperation[],
  ): Promise<{ created: string[]; updated: string[]; cancelled: string[]; storyPointsDelta: number; warnings: string[] }> {
    const created: string[] = [];
    const updated: string[] = [];
    const cancelled: string[] = [];
    let storyPointsDelta = 0;
    const warnings: string[] = [];
    const taskByKey = new Map(group.tasks.map((t) => [t.key, t]));

    await this.workspaceRepo.withTransaction(async () => {
      let stage = "start";
      const newTasks: TaskInsert[] = [];
      const pendingDeps: { childKey: string; dependsOnKey: string; relationType: string }[] = [];

      try {
        stage = "load:storyKeys";
        const storyKeyRows = await this.workspaceRepo.getDb().all<{ key: string }[]>(
          `SELECT key FROM tasks WHERE user_story_id = ?`,
          group.story.id,
        );
        const existingKeys = storyKeyRows.map((r) => r.key);
        const keyGen = createTaskKeyGenerator(group.story.key, existingKeys);

        for (const op of operations) {
          stage = `op:${op.op}`;
          if (op.op === "update_task") {
            const target = taskByKey.get(op.taskKey);
            if (!target) continue;
            const before = { ...target };
            const mergedMetadata = this.mergeMetadata(target.metadata, op.updates.metadata);
            const contentUpdated =
              op.updates.title !== undefined || op.updates.description !== undefined || op.updates.type !== undefined;
            const metadata = this.applyStageMetadata(
              mergedMetadata,
              {
                title: op.updates.title ?? target.title,
                description: op.updates.description ?? target.description ?? null,
                type: op.updates.type ?? target.type ?? null,
              },
              contentUpdated,
            );
            const beforeSp = target.storyPoints ?? 0;
            const afterSp = op.updates.storyPoints ?? target.storyPoints ?? null;
            storyPointsDelta += (afterSp ?? 0) - (beforeSp ?? 0);
            await this.workspaceRepo.updateTask(target.id, {
              title: op.updates.title ?? target.title,
              description: op.updates.description ?? target.description ?? null,
              type: op.updates.type ?? target.type ?? null,
              storyPoints: afterSp,
              priority: op.updates.priority ?? target.priority ?? null,
              status: op.updates.status ?? target.status,
              metadata,
            });
            updated.push(target.key);
            await this.workspaceRepo.insertTaskRevision({
              taskId: target.id,
              jobId,
              commandRunId,
              snapshotBefore: before,
              snapshotAfter: { ...before, ...op.updates, storyPoints: afterSp, metadata },
              createdAt: new Date().toISOString(),
            });
          } else if (op.op === "split_task") {
            const target = taskByKey.get(op.taskKey);
            if (!target) continue;
            if (op.parentUpdates) {
              const before = { ...target };
              const mergedMetadata = this.mergeMetadata(target.metadata, op.parentUpdates.metadata);
              const contentUpdated =
                op.parentUpdates.title !== undefined ||
                op.parentUpdates.description !== undefined ||
                op.parentUpdates.type !== undefined;
              const metadata = this.applyStageMetadata(
                mergedMetadata,
                {
                  title: op.parentUpdates.title ?? target.title,
                  description: op.parentUpdates.description ?? target.description ?? null,
                  type: op.parentUpdates.type ?? target.type ?? null,
                },
                contentUpdated,
              );
              await this.workspaceRepo.updateTask(target.id, {
                title: op.parentUpdates.title ?? target.title,
                description: op.parentUpdates.description ?? target.description ?? null,
                type: op.parentUpdates.type ?? target.type ?? null,
                storyPoints: op.parentUpdates.storyPoints ?? target.storyPoints ?? null,
                priority: op.parentUpdates.priority ?? target.priority ?? null,
                metadata,
              });
              updated.push(target.key);
              await this.workspaceRepo.insertTaskRevision({
                taskId: target.id,
                jobId,
                commandRunId,
                snapshotBefore: before,
                snapshotAfter: {
                  ...before,
                  ...op.parentUpdates,
                  storyPoints: op.parentUpdates.storyPoints ?? before.storyPoints,
                  metadata,
                },
                createdAt: new Date().toISOString(),
              });
            }
            const existingTaskKeyByNormalized = new Map<string, string>();
            for (const key of taskByKey.keys()) {
              existingTaskKeyByNormalized.set(normalizeSplitDependencyRef(key), key);
            }
            const childKeys = op.children.map(() => keyGen());
            const childRefToKey = new Map<string, string>();
            op.children.forEach((child, index) => {
              const childKey = childKeys[index];
              childRefToKey.set(normalizeSplitDependencyRef(childKey), childKey);
              for (const reference of collectSplitChildReferences(child)) {
                const normalized = normalizeSplitDependencyRef(reference);
                if (!normalized || childRefToKey.has(normalized)) continue;
                childRefToKey.set(normalized, childKey);
              }
            });

            for (let index = 0; index < op.children.length; index += 1) {
              const child = op.children[index];
              const childKey = childKeys[index];
              const childSp = child.storyPoints ?? null;
              if (childSp) {
                storyPointsDelta += childSp;
              }
              const childMetadata = this.mergeMetadata({}, child.metadata);
              const childContent = {
                title: child.title,
                description: child.description ?? target.description ?? "",
                type: child.type ?? target.type ?? "feature",
              };
              const resolvedChildMetadata = this.applyStageMetadata(childMetadata, childContent, true);
              const childInsert: TaskInsert = {
                projectId,
                epicId: target.epicId,
                userStoryId: target.userStoryId,
                key: childKey,
                title: child.title,
                description: child.description ?? target.description ?? "",
                type: child.type ?? target.type ?? "feature",
                status: "not_started",
                storyPoints: childSp,
                priority: child.priority ?? target.priority ?? null,
                metadata: resolvedChildMetadata,
                assignedAgentId: target.assignedAgentId ?? null,
                assigneeHuman: target.assigneeHuman ?? null,
                vcsBranch: null,
                vcsBaseBranch: null,
                vcsLastCommitSha: null,
                openapiVersionAtCreation: target.openapiVersionAtCreation ?? null,
              };
              newTasks.push(childInsert);
              for (const dependencyReference of child.dependsOn ?? []) {
                const normalizedReference = normalizeSplitDependencyRef(dependencyReference);
                if (!normalizedReference) continue;
                const dependencyKey =
                  existingTaskKeyByNormalized.get(normalizedReference) ?? childRefToKey.get(normalizedReference);
                if (!dependencyKey) {
                  warnings.push(
                    `Skipped split dependency ${childKey}->${dependencyReference}: unresolved sibling or task reference.`,
                  );
                  continue;
                }
                if (dependencyKey === childKey) {
                  warnings.push(`Skipped split dependency ${childKey}->${dependencyReference}: self dependency.`);
                  continue;
                }
                pendingDeps.push({
                  childKey,
                  dependsOnKey: dependencyKey,
                  relationType: "blocks",
                });
              }
              taskByKey.set(childKey, {
                ...childInsert,
                id: "",
                createdAt: "",
                updatedAt: "",
                storyKey: group.story.key,
                epicKey: group.epic.key,
                dependencies: child.dependsOn ?? [],
              });
              created.push(childKey);
            }
          } else if (op.op === "merge_tasks") {
            const target = taskByKey.get(op.targetTaskKey);
            if (!target) continue;
            if (op.updates) {
              const before = { ...target };
              const mergedMetadata = this.mergeMetadata(target.metadata, op.updates.metadata);
              const contentUpdated =
                op.updates.title !== undefined || op.updates.description !== undefined || op.updates.type !== undefined;
              const metadata = this.applyStageMetadata(
                mergedMetadata,
                {
                  title: op.updates.title ?? target.title,
                  description: op.updates.description ?? target.description ?? null,
                  type: op.updates.type ?? target.type ?? null,
                },
                contentUpdated,
              );
              await this.workspaceRepo.updateTask(target.id, {
                title: op.updates.title ?? target.title,
                description: op.updates.description ?? target.description ?? null,
                type: op.updates.type ?? target.type ?? null,
                storyPoints: op.updates.storyPoints ?? target.storyPoints ?? null,
                priority: op.updates.priority ?? target.priority ?? null,
                metadata,
              });
              updated.push(target.key);
              await this.workspaceRepo.insertTaskRevision({
                taskId: target.id,
                jobId,
                commandRunId,
                snapshotBefore: before,
                snapshotAfter: {
                  ...before,
                  ...op.updates,
                  storyPoints: op.updates.storyPoints ?? before.storyPoints,
                  metadata,
                },
                createdAt: new Date().toISOString(),
              });
            }
            for (const sourceKey of op.sourceTaskKeys) {
              const source = taskByKey.get(sourceKey);
              if (!source || source.key === target.key) continue;
              const before = { ...source };
              const mergedMetadata = this.mergeMetadata(source.metadata, { merged_into: target.key });
              await this.workspaceRepo.updateTask(source.id, {
                status: source.status, // do not cancel; requirement: no deletes/cancels
                metadata: mergedMetadata,
              });
              updated.push(source.key);
              await this.workspaceRepo.insertTaskRevision({
                taskId: source.id,
                jobId,
                commandRunId,
                snapshotBefore: before,
                snapshotAfter: { ...before, metadata: mergedMetadata },
                createdAt: new Date().toISOString(),
              });
            }
          } else if (op.op === "update_estimate") {
            const target = taskByKey.get(op.taskKey);
            if (!target) continue;
            const beforeSp = target.storyPoints ?? 0;
            const afterSp = op.storyPoints ?? target.storyPoints ?? null;
            storyPointsDelta += (afterSp ?? 0) - (beforeSp ?? 0);
            const contentUpdated = op.type !== undefined;
            const metadata = this.applyStageMetadata(
              target.metadata,
              {
                title: target.title,
                description: target.description ?? null,
                type: op.type ?? target.type ?? null,
              },
              contentUpdated,
            );
            await this.workspaceRepo.updateTask(target.id, {
              storyPoints: afterSp,
              type: op.type ?? target.type ?? null,
              priority: op.priority ?? target.priority ?? null,
              metadata: contentUpdated ? metadata : undefined,
            });
            updated.push(target.key);
            await this.workspaceRepo.insertTaskRevision({
              taskId: target.id,
              jobId,
              commandRunId,
              snapshotBefore: { ...target },
              snapshotAfter: {
                ...target,
                storyPoints: afterSp,
                type: op.type ?? target.type ?? null,
                priority: op.priority ?? target.priority ?? null,
                metadata: contentUpdated ? metadata : target.metadata,
              },
              createdAt: new Date().toISOString(),
            });
          }
        }

        const dependencyGraph = new Map<string, Set<string>>();
        const addEdge = (from: string, to: string) => {
          if (!from || !to) return;
          const edges = dependencyGraph.get(from) ?? new Set<string>();
          edges.add(to);
          dependencyGraph.set(from, edges);
        };
        for (const task of group.tasks) {
          for (const dep of task.dependencies) {
            addEdge(task.key, dep);
          }
        }

        if (newTasks.length > 0) {
          stage = "insert:newTasks";
          const inserted = await this.workspaceRepo.insertTasks(newTasks, false);
          const idByKey = new Map(inserted.map((t) => [t.key, t.id]));
          for (const row of inserted) {
            const current = taskByKey.get(row.key);
            if (current) {
              current.id = row.id;
              current.createdAt = row.createdAt;
              current.updatedAt = row.updatedAt;
            }
          }
          const deps: TaskDependencyInsert[] = [];
          const allowedDeps: typeof pendingDeps = [];
          const skippedDeps: Array<{ childKey: string; dependsOnKey: string }> = [];
          for (const dep of pendingDeps) {
            if (!dep.dependsOnKey) continue;
            if (this.hasDependencyPath(dependencyGraph, dep.dependsOnKey, dep.childKey)) {
              skippedDeps.push({ childKey: dep.childKey, dependsOnKey: dep.dependsOnKey });
              continue;
            }
            addEdge(dep.childKey, dep.dependsOnKey);
            allowedDeps.push(dep);
          }
          if (skippedDeps.length > 0) {
            const sample = skippedDeps
              .slice(0, 5)
              .map((dep) => `${dep.childKey}->${dep.dependsOnKey}`)
              .join(", ");
            warnings.push(
              `Skipped ${skippedDeps.length} refine dependencies that would create cycles.` +
                (sample ? ` Sample: ${sample}` : ""),
            );
          }
          for (const dep of allowedDeps) {
            const childId = idByKey.get(dep.childKey);
            if (!childId) continue;
            const dependsOnId = idByKey.get(dep.dependsOnKey) ?? taskByKey.get(dep.dependsOnKey)?.id;
            if (!dependsOnId) {
              warnings.push(`Skipped refine dependency ${dep.childKey}->${dep.dependsOnKey}: dependency task not found.`);
              continue;
            }
            deps.push({ taskId: childId, dependsOnTaskId: dependsOnId, relationType: dep.relationType });
          }
          if (deps.length > 0) {
            stage = "insert:deps";
            await this.workspaceRepo.insertTaskDependencies(deps, false);
          }
        }

        // cycle detection on current + new dependencies (by key)
        const edgeSet: Array<{ from: string; to: string }> = [];
        for (const [from, deps] of dependencyGraph.entries()) {
          for (const dep of deps) {
            edgeSet.push({ from, to: dep });
          }
        }
        const hasCycle = this.detectCycle(edgeSet);
        if (hasCycle) {
          throw new Error("Dependency cycle detected after refinement; aborting apply.");
        }

        stage = "rollup:story";
        const storyTotalRow = await this.workspaceRepo.getDb().get<{ total: number }>(
          `SELECT SUM(story_points) AS total FROM tasks WHERE user_story_id = ?`,
          group.story.id,
        );
        await this.workspaceRepo.updateStoryPointsTotal(group.story.id, storyTotalRow?.total ?? null);
        stage = "rollup:epic";
        const epicTotalRow = await this.workspaceRepo.getDb().get<{ total: number }>(
          `SELECT SUM(story_points_total) AS total FROM user_stories WHERE epic_id = ?`,
          group.epic.id,
        );
        await this.workspaceRepo.updateEpicStoryPointsTotal(group.epic.id, epicTotalRow?.total ?? null);

        stage = "task-runs";
        const allTouched = [...new Set([...created, ...updated, ...cancelled])];
        const now = new Date().toISOString();
        for (const key of allTouched) {
          try {
            const task =
              group.tasks.find((t) => t.key === key) ??
              (await this.workspaceRepo.getDb().get<{ id: string }>(`SELECT id FROM tasks WHERE key = ?`, key));
            if (task && task.id) {
              const run = await this.workspaceRepo.createTaskRun({
                taskId: task.id,
                command: "refine-tasks",
                status: "succeeded",
                jobId,
                commandRunId,
                startedAt: now,
                finishedAt: now,
                runContext: { key },
              });
              await this.workspaceRepo.insertTaskLog({
                taskRunId: run.id,
                sequence: 0,
                timestamp: now,
                level: "info",
                source: "refine-tasks",
                message: `Applied refine operation for ${key}`,
                details: { opCount: operations.length },
              });
            }
          } catch (error) {
            warnings.push(`Logging failed for ${key}: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        throw new Error(`refine apply failed at ${stage}: ${(error as Error).message}`);
      }
    });

    return { created, updated, cancelled, storyPointsDelta, warnings };
  }

  private async invokeAgent(
    agentName: string | undefined,
    prompt: string,
    stream: boolean,
    jobId: string,
    commandRunId: string,
    metadata?: Record<string, unknown>,
  ): Promise<{ raw: string; promptTokens: number; completionTokens: number; agentId: string }> {
    const startedAt = Date.now();
    const agent = await this.resolveAgent(agentName);
    const parts: string[] = [];
    let capturedChars = 0;
    let truncated = false;

    const logChunk = async (chunk?: string) => {
      if (!chunk) return;
      await this.jobService.appendLog(jobId, chunk);
      if (stream) process.stdout.write(chunk);
    };

    const capture = (chunk?: string) => {
      if (!chunk || truncated) return;
      const next = capturedChars + chunk.length;
      if (next > MAX_AGENT_OUTPUT_CHARS) {
        truncated = true;
        return;
      }
      parts.push(chunk);
      capturedChars = next;
    };

    const formatContext = (): string => {
      const meta = metadata as Record<string, unknown> | undefined;
      const epic = typeof meta?.epicKey === "string" && meta.epicKey ? ` epic=${meta.epicKey}` : "";
      const story = typeof meta?.storyKey === "string" && meta.storyKey ? ` story=${meta.storyKey}` : "";
      return `${epic}${story}`;
    };

    try {
      if (stream) {
        const gen = await this.agentService.invokeStream(agent.id, { input: prompt, metadata: { jobId, commandRunId } });
        for await (const chunk of gen) {
          const text = chunk.output ?? "";
          capture(text);
          await logChunk(text);
        }
      } else {
        const result = await this.agentService.invoke(agent.id, { input: prompt, metadata: { jobId, commandRunId } });
        const text = result.output ?? "";
        capture(text);
        await logChunk(text);
      }
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      if (message.includes("Invalid string length")) {
        throw new Error(
          `Agent output exceeded runtime limits (Invalid string length) while refining tasks.${formatContext()} ` +
            `Try rerunning with a smaller scope (e.g. --max-tasks 200, or filter by --epic/--story/--status), or disable streaming (--agent-stream false).`,
        );
      }
      throw error;
    }

    if (truncated) {
      throw new Error(
        `Agent output exceeded ${MAX_AGENT_OUTPUT_CHARS.toLocaleString()} characters while refining tasks.${formatContext()} ` +
          `Rerun with a smaller scope (e.g. --max-tasks 200, or filter by --epic/--story/--status), or disable streaming (--agent-stream false).`,
      );
    }

    const output = parts.join("");
    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(output);
    const durationSeconds = (Date.now() - startedAt) / 1000;
    await this.jobService.recordTokenUsage({
      workspaceId: this.workspace.workspaceId,
      agentId: agent.id,
      modelName: agent.defaultModel,
      jobId,
      commandRunId,
      projectId: undefined,
      epicId: undefined,
      userStoryId: undefined,
      tokensPrompt: promptTokens,
      tokensCompletion: completionTokens,
      tokensTotal: promptTokens + completionTokens,
      durationSeconds,
      timestamp: new Date().toISOString(),
      metadata: {
        command: "refine-tasks",
        action: "agent_refine",
        phase: "agent_refine",
        attempt: 1,
        ...(metadata ?? {}),
      },
    });
    return { raw: output, promptTokens, completionTokens, agentId: agent.id };
  }

  async refineTasks(options: RefineTasksOptions): Promise<RefineTasksResult> {
    const strategy = options.strategy ?? DEFAULT_STRATEGY;
    const agentStream = options.agentStream !== false;
    const applyChanges = options.apply === true; // default to no DB writes unless explicitly requested
    const shouldDefaultMaxTasks =
      options.planInPath == null &&
      options.maxTasks == null &&
      !options.epicKey &&
      !(options.userStoryKey ?? options.storyKey) &&
      !(options.taskKeys && options.taskKeys.length) &&
      !(options.statusFilter && options.statusFilter.length);
    await this.workspaceRepo.createProjectIfMissing({
      key: options.projectKey,
      name: options.projectKey,
      description: `Workspace project ${options.projectKey}`,
    });
    const commandRun = await this.jobService.startCommandRun("refine-tasks", options.projectKey, {
      taskIds: options.taskKeys,
    });
    const job = await this.jobService.startJob("task_refinement", commandRun.id, options.projectKey, {
      commandName: "refine-tasks",
      payload: {
        projectKey: options.projectKey,
        epicKey: options.epicKey,
        storyKey: options.userStoryKey ?? options.storyKey,
        taskKeys: options.taskKeys,
        statusFilter: options.statusFilter,
        strategy,
        maxTasks: options.maxTasks,
        dryRun: options.dryRun,
        fromDb: options.fromDb !== false,
        planIn: options.planInPath,
        planOut: options.planOutPath,
      },
    });
    let ratingAgentId: string | undefined;
    const maybeRateAgent = async () => {
      if (!options.rateAgents || !ratingAgentId) return;
      try {
        const ratingService = this.ensureRatingService();
        await ratingService.rate({
          workspace: this.workspace,
          agentId: ratingAgentId,
          commandName: "refine-tasks",
          jobId: job.id,
          commandRunId: commandRun.id,
        });
      } catch (error) {
        const message = `Agent rating failed: ${(error as Error).message ?? String(error)}`;
        try {
          await this.jobService.appendLog(job.id, `${message}\n`);
        } catch {
          /* ignore rating log failures */
        }
      }
    };

    try {
      if (options.fromDb === false) {
        throw new Error("refine-tasks currently only supports DB-backed selection; set --from-db true");
      }
      const selection = await this.selectTasks(options.projectKey, {
        epicKey: options.epicKey,
        storyKey: options.userStoryKey ?? options.storyKey,
        taskKeys: options.taskKeys,
        statusFilter: options.statusFilter,
        maxTasks: shouldDefaultMaxTasks ? DEFAULT_MAX_TASKS : options.maxTasks,
        excludeAlreadyRefined: options.excludeAlreadyRefined === true,
      });

      const plan: RefineTasksPlan = {
        strategy,
        operations: [],
        warnings: [...selection.warnings],
        metadata: {
          generatedAt: new Date().toISOString(),
          projectKey: options.projectKey,
          epicKeys: selection.groups.map((g) => g.epic.key),
          storyKeys: selection.groups.map((g) => g.story.key),
          strategy,
          jobId: job.id,
          commandRunId: commandRun.id,
        },
      };

      if (selection.groups.length === 0 && !options.planInPath) {
        if (!options.allowEmptySelection) {
          throw new Error("No tasks matched the provided filters.");
        }
        plan.warnings?.push("No tasks matched the provided filters.");
        await this.jobService.updateJobStatus(job.id, "completed", {
          payload: {
            dryRun: options.dryRun ?? true,
            operations: 0,
            applied: false,
            emptySelection: true,
          },
          processedItems: 0,
          totalItems: 0,
          lastCheckpoint: "empty_selection",
        });
        await this.jobService.finishCommandRun(commandRun.id, "succeeded");
        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          plan,
          applied: false,
          createdTasks: [],
          updatedTasks: [],
          cancelledTasks: [],
          summary: { tasksProcessed: 0, tasksAffected: 0, storyPointsDelta: 0 },
        };
      }

      let planInput: RefineTasksPlan | undefined;
      if (options.planInPath) {
        const raw = await fs.readFile(options.planInPath, "utf8");
        planInput = safeParsePlan(raw);
        if (!planInput) {
          throw new Error(`Failed to parse plan from ${options.planInPath}`);
        }
        if (planInput.metadata?.projectKey && planInput.metadata.projectKey !== options.projectKey) {
          throw new Error(`Plan project mismatch: ${planInput.metadata.projectKey} !== ${options.projectKey}`);
        }
        if (planInput.metadata?.jobId && options.jobId && planInput.metadata.jobId !== options.jobId) {
          throw new Error(`Plan was generated for job ${planInput.metadata.jobId}, mismatch with --job-id ${options.jobId}`);
        }
        const mergedMeta = {
          generatedAt: planInput.metadata?.generatedAt ?? plan.metadata?.generatedAt ?? new Date().toISOString(),
          projectKey: planInput.metadata?.projectKey ?? plan.metadata?.projectKey ?? options.projectKey,
          epicKeys: planInput.metadata?.epicKeys ?? plan.metadata?.epicKeys,
          storyKeys: planInput.metadata?.storyKeys ?? plan.metadata?.storyKeys,
          jobId: planInput.metadata?.jobId ?? plan.metadata?.jobId,
          commandRunId: planInput.metadata?.commandRunId ?? plan.metadata?.commandRunId,
          strategy: planInput.metadata?.strategy ?? plan.metadata?.strategy ?? strategy,
        };
        plan.metadata = mergedMeta;
        if (planInput.warnings) plan.warnings?.push(...planInput.warnings);
        // Validate ops against current selection and group membership.
        const taskToGroup = new Map<string, StoryGroup>();
        selection.groups.forEach((g) => g.tasks.forEach((t) => taskToGroup.set(t.key, g)));
        const allowCreateMissingPlanIn = false;
        for (const rawOp of planInput.operations) {
          const op = normalizeOperation(rawOp);
          const keyCandidate = (op as any).taskKey ?? (op as any).targetTaskKey ?? null;
          let group = keyCandidate ? taskToGroup.get(keyCandidate) : undefined;
          if (!group && allowCreateMissingPlanIn && keyCandidate) {
            const ensured = await this.ensureTaskExists(selection.projectId, options.projectKey, keyCandidate, true, op as any);
            if (ensured) {
              group =
                selection.groups.find((g) => g.story.key === ensured.story.key) ??
                (() => {
                  const newGroup: StoryGroup = {
                    epic: ensured.epic,
                    story: ensured.story,
                    tasks: [],
                  };
                  selection.groups.push(newGroup);
                  return newGroup;
                })();
              group.tasks.push(ensured.task);
              taskToGroup.set(keyCandidate, group);
            }
          }
          if (!group) {
            plan.warnings?.push(`Skipped plan-in op because task key not in selection: ${keyCandidate ?? op.op}`);
            continue;
          }
          const { valid, reason } = this.validateOperation(group, op);
          if (!valid) {
            if (reason) plan.warnings?.push(`Skipped plan-in op: ${reason}`);
            continue;
          }
          plan.operations.push(op as RefineOperation);
        }
      }

      if (!planInput) {
        if (shouldDefaultMaxTasks) {
          plan.warnings?.push(
            `No filters were provided; defaulted --max-tasks to ${DEFAULT_MAX_TASKS} to keep refinement tractable. Pass --max-tasks explicitly to override.`,
          );
        }
        for (const group of selection.groups) {
          try {
            const { summary: docSummary, warnings: docWarnings } = await this.summarizeDocs(
              options.projectKey,
              group.epic.key,
              group.story.key,
            );
            group.docSummary = docSummary;
            const historySummary = await this.summarizeHistory(group.tasks.map((t) => t.id));
            group.historySummary = historySummary;
            await this.jobService.writeCheckpoint(job.id, {
              stage: "context_built",
              timestamp: new Date().toISOString(),
              details: { epic: group.epic.key, story: group.story.key, tasks: group.tasks.length },
            });
            if (docWarnings.length) {
              plan.warnings?.push(...docWarnings);
              // eslint-disable-next-line no-console
              console.warn(docWarnings.join("; "));
              await this.jobService.appendLog(job.id, docWarnings.join("\n"));
              await this.logWarningsToTasks(
                group.tasks.map((t) => t.id),
                job.id,
                commandRun.id,
                docWarnings.join("; "),
              );
            }
            const prompt = this.buildStoryPrompt(group, strategy, docSummary);
            const parseOps = (raw: string): RefineOperation[] => {
              const parsed = normalizePlanJson(extractJson(raw));
              const ops = parsed?.operations && Array.isArray(parsed.operations) ? (parsed.operations as RefineOperation[]) : [];
              const normalized = ops.map(normalizeOperation);
              return normalized.filter((op) => {
                const { valid, reason } = this.validateOperation(group, op);
                if (!valid && reason) {
                  plan.warnings?.push(`Skipped op for story ${group.story.key}: ${reason}`);
                }
                return valid;
              });
            };
            const { raw, agentId } = await this.invokeAgent(
              options.agentName,
              prompt,
              agentStream,
              job.id,
              commandRun.id,
              { epicKey: group.epic.key, storyKey: group.story.key },
            );
            ratingAgentId = agentId;
            let filtered = parseOps(raw);
            if (filtered.length === 0) {
              const retryPrompt = `${prompt}\n\nRETRY: Your previous response did not match the JSON schema. Return only a JSON object with an operations array (no prose, no markdown, no <think> tags).`;
              const retry = await this.invokeAgent(
                options.agentName,
                retryPrompt,
                agentStream,
                job.id,
                commandRun.id,
                { epicKey: group.epic.key, storyKey: group.story.key, retry: true },
              );
              ratingAgentId = retry.agentId;
              filtered = parseOps(retry.raw);
              if (filtered.length === 0) {
                plan.warnings?.push(`No valid operations returned for story ${group.story.key}.`);
              }
            }
            plan.operations.push(...filtered);
          } catch (error) {
            throw new Error(
              `Failed while refining epic ${group.epic.key} story ${group.story.key}: ${(error as Error).message}`,
            );
          }
        }
      }

      // Always persist the plan to disk in a unique folder (similar to create-tasks)
      const ensureUniquePath = async (candidate: string): Promise<string> => {
        try {
          await fs.access(candidate);
          const dir = path.dirname(candidate);
          const base = path.basename(candidate, path.extname(candidate));
          const ext = path.extname(candidate) || ".json";
          const suffix = new Date().toISOString().replace(/[:.]/g, "-");
          return path.join(dir, `${base}-${suffix}${ext}`);
        } catch {
          return candidate;
        }
      };

      const defaultPlanPath = path.join(
        this.workspace.mcodaDir,
        "tasks",
        options.projectKey,
        "refinements",
        job.id,
        "plan.json",
      );
      const requestedOutPath = options.planOutPath ? path.resolve(options.planOutPath) : defaultPlanPath;
      const outPath = await ensureUniquePath(requestedOutPath);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(plan, null, 2), "utf8");
      await this.jobService.writeCheckpoint(job.id, {
        stage: "plan_written",
        timestamp: new Date().toISOString(),
        details: { path: outPath, ops: plan.operations.length },
      });

      if (plan.operations.length === 0) {
        await this.jobService.updateJobStatus(job.id, "completed", {
          payload: {
            dryRun: options.dryRun ?? !applyChanges,
            operations: 0,
            planPath: outPath,
            applied: false,
            reason: "no_operations",
          },
          processedItems: 0,
          totalItems: 0,
          lastCheckpoint: "no_operations",
        });
        await this.jobService.finishCommandRun(commandRun.id, "succeeded");
        await maybeRateAgent();
        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          plan,
          applied: false,
          createdTasks: [],
          updatedTasks: [],
          cancelledTasks: [],
          summary: { tasksProcessed: selection.groups.reduce((acc, g) => acc + g.tasks.length, 0), tasksAffected: 0, storyPointsDelta: 0 },
        };
      }

      if (options.dryRun || !applyChanges) {
        await this.jobService.updateJobStatus(job.id, "completed", {
          payload: {
            dryRun: options.dryRun ?? true,
            operations: plan.operations.length,
            planPath: outPath,
            applied: false,
          },
          processedItems: plan.operations.length,
          totalItems: plan.operations.length,
          lastCheckpoint: "dry_run",
        });
        await this.jobService.finishCommandRun(commandRun.id, "succeeded");
        await maybeRateAgent();
        return {
          jobId: job.id,
          commandRunId: commandRun.id,
          plan,
          applied: false,
          createdTasks: [],
          updatedTasks: [],
          cancelledTasks: [],
          summary: { tasksProcessed: selection.groups.reduce((acc, g) => acc + g.tasks.length, 0), tasksAffected: 0 },
        };
      }

      const created: string[] = [];
      const updated: string[] = [];
      const cancelled: string[] = [];
      let storyPointsDelta = 0;
      const operationsByStory = new Map<string, RefineOperation[]>();
      for (const op of plan.operations) {
        const key = (op as any).taskKey ?? (op as any).targetTaskKey ?? null;
        if (!key) continue;
        const group = selection.groups.find((g) => g.tasks.some((t) => t.key === key));
        if (!group) continue;
        const list = operationsByStory.get(group.story.id) ?? [];
        list.push(op);
        operationsByStory.set(group.story.id, list);
      }

      for (const group of selection.groups) {
        const ops = operationsByStory.get(group.story.id) ?? [];
        if (ops.length === 0) continue;
        const { created: c, updated: u, cancelled: x, storyPointsDelta: delta, warnings: opWarnings } = await this.applyOperations(
          selection.projectId,
          job.id,
          commandRun.id,
          group,
          ops,
        );
        await this.jobService.writeCheckpoint(job.id, {
          stage: "story_applied",
          timestamp: new Date().toISOString(),
          details: { epic: group.epic.key, story: group.story.key, ops: ops.length, created: c.length, updated: u.length, cancelled: x.length },
        });
        if (opWarnings.length) {
          plan.warnings?.push(...opWarnings);
        }
        created.push(...c);
        updated.push(...u);
        cancelled.push(...x);
        storyPointsDelta += delta;
      }

      await this.seedPriorities(options.projectKey);

      await this.jobService.updateJobStatus(job.id, "completed", {
        payload: {
          created: created.length,
          updated: updated.length,
          cancelled: cancelled.length,
          storyPointsDelta,
        },
        processedItems: created.length + updated.length + cancelled.length,
        totalItems: plan.operations.length,
        lastCheckpoint: "completed",
      });
      await this.jobService.finishCommandRun(commandRun.id, "succeeded");
      await maybeRateAgent();

      return {
        jobId: job.id,
        commandRunId: commandRun.id,
        plan,
        applied: true,
        createdTasks: created,
        updatedTasks: updated,
        cancelledTasks: cancelled,
        summary: {
          tasksProcessed: selection.groups.reduce((acc, g) => acc + g.tasks.length, 0),
          tasksAffected: created.length + updated.length + cancelled.length,
          storyPointsDelta,
        },
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.jobService.updateJobStatus(job.id, "failed", { errorSummary: message });
      await this.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
