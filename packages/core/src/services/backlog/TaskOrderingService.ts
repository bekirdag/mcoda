import fs from "node:fs/promises";
import { AgentService } from "@mcoda/agents";
import { DocdexClient } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository, Connection, type Database } from "@mcoda/db";
import { PathHelper, READY_TO_CODE_REVIEW, normalizeReviewStatuses } from "@mcoda/shared";
import type { Agent } from "@mcoda/shared";
import YAML from "yaml";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { RoutingService } from "../agents/RoutingService.js";
import { classifyTask, TaskStage } from "./TaskOrderingHeuristics.js";

type StatusRank = Record<string, number>;

const DEFAULT_STATUSES = ["not_started", "in_progress", "changes_requested", READY_TO_CODE_REVIEW, "ready_to_qa"];
const DONE_STATUSES = new Set(["completed", "cancelled"]);
const DEFAULT_STAGE_ORDER: TaskStage[] = ["foundation", "backend", "frontend", "other"];
const PLANNING_DOC_HINT_PATTERN = /(sds|pdr|rfp|requirements|architecture|openapi|swagger|design)/i;
const OPENAPI_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const OPENAPI_HINTS_LIMIT = 20;
const STATUS_RANK: StatusRank = {
  in_progress: 0,
  changes_requested: 0,
  not_started: 1,
  [READY_TO_CODE_REVIEW]: 2,
  ready_to_qa: 3,
  completed: 4,
  cancelled: 5,
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
  const normalized = Array.from(new Set(statuses.map((s) => s.toLowerCase().trim()).filter(Boolean))).filter(
    (status) => status !== "blocked",
  );
  return normalizeReviewStatuses(normalized);
};

const estimateTokens = (text: string): number => Math.max(1, Math.ceil((text ?? "").length / 4));
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
    // ignore invalid parse
  }
  return undefined;
};

const SDS_DEPENDENCY_GUIDE = [
  "SDS hints for dependency-aware ordering:",
  "- Enforce topological ordering: never place a task before any of its dependencies.",
  "- Prioritize tasks that unlock the most downstream work (direct + indirect dependents).",
  "- Tie-break by existing priority, then lower story points, then older tasks, then status (in_progress before not_started).",
].join("\n");

interface DocContext {
  content: string;
  source: string;
  kind: DocContextKind;
}

type DocContextKind = "sds" | "openapi" | "fallback";
type PlanningContextPolicy = "best_effort" | "require_any" | "require_sds_or_openapi";

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
  epic_priority: number | null;
  story_id: string;
  story_key: string;
  story_title: string;
  story_priority: number | null;
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
  dependencyKeys: string[];
  dependencyImpact: DependencyImpact;
  cycleDetected?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface TaskOrderingResult {
  project: ProjectRow;
  epic?: EpicRow;
  ordered: TaskOrderItem[];
  warnings: string[];
  jobId?: string;
  commandRunId?: string;
}

export interface InferredDependency {
  taskKey: string;
  dependsOnKeys: string[];
}

export interface TaskOrderingRequest {
  projectKey: string;
  epicKey?: string;
  storyKey?: string;
  assignee?: string;
  statusFilter?: string[];
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  stageOrder?: TaskStage[];
  injectFoundationDeps?: boolean;
  inferDependencies?: boolean;
  enrichMetadata?: boolean;
  apply?: boolean;
  planningContextPolicy?: PlanningContextPolicy;
}

type TaskNode = TaskRow & {
  dependencies: DependencyRow[];
  missingDependencies: string[];
};

type AgentRanking = Map<string, number>;
type ComplexityByTask = Map<string, number>;

const extractJson = (raw: string): any | undefined => {
  if (!raw) return undefined;
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
  const blocks = extractJsonBlocks(value).reverse();
  for (const block of blocks) {
    try {
      return JSON.parse(block);
    } catch {
      // continue
    }
  }
  return undefined;
};

const extractJsonBlocks = (value: string): string[] => {
  const results: string[] = [];
  const stack: string[] = [];
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
      if (stack.length === 0) start = i;
      stack.push("}");
      continue;
    }
    if (ch === "[") {
      if (stack.length === 0) start = i;
      stack.push("]");
      continue;
    }
    if (stack.length > 0 && ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0 && start >= 0) {
        results.push(value.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
};

export const parseDependencyInferenceOutput = (
  output: string,
  validTaskKeys: Set<string>,
  warnings: string[],
): InferredDependency[] => {
  const parsed = extractJson(output);
  if (!parsed) {
    warnings.push("Agent dependency inference output could not be parsed; skipping.");
    return [];
  }
  const dependencyEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.dependencies)
      ? parsed.dependencies
      : Array.isArray(parsed?.deps)
        ? parsed.deps
        : undefined;
  if (!Array.isArray(dependencyEntries)) {
    warnings.push("Agent dependency inference missing dependencies list; skipping.");
    return [];
  }
  const dependenciesByTask = new Map<string, Set<string>>();
  let invalidTasks = 0;
  let invalidDeps = 0;
  let selfDeps = 0;
  for (const entry of dependencyEntries) {
    const taskKey =
      typeof entry?.task_key === "string"
        ? entry.task_key
        : typeof entry?.taskKey === "string"
          ? entry.taskKey
          : undefined;
    if (!taskKey || !validTaskKeys.has(taskKey)) {
      invalidTasks += 1;
      continue;
    }
    const rawDepends = entry?.depends_on ?? entry?.dependsOn;
    if (rawDepends === undefined) {
      continue;
    }
    if (!Array.isArray(rawDepends)) {
      invalidDeps += 1;
      continue;
    }
    const dependsRaw = rawDepends as unknown[];
    const deps = dependenciesByTask.get(taskKey) ?? new Set<string>();
    for (const dep of dependsRaw) {
      if (typeof dep !== "string") {
        invalidDeps += 1;
        continue;
      }
      if (dep === taskKey) {
        selfDeps += 1;
        continue;
      }
      if (!validTaskKeys.has(dep)) {
        invalidDeps += 1;
        continue;
      }
      deps.add(dep);
    }
    if (deps.size > 0) {
      dependenciesByTask.set(taskKey, deps);
    }
  }
  if (invalidTasks > 0) {
    warnings.push(`Agent dependency inference ignored ${invalidTasks} invalid task keys.`);
  }
  if (invalidDeps > 0) {
    warnings.push(`Agent dependency inference ignored ${invalidDeps} invalid dependency keys.`);
  }
  if (selfDeps > 0) {
    warnings.push(`Agent dependency inference ignored ${selfDeps} self-dependencies.`);
  }
  const inferred: InferredDependency[] = [];
  for (const [taskKey, deps] of dependenciesByTask.entries()) {
    inferred.push({ taskKey, dependsOnKeys: Array.from(deps) });
  }
  return inferred;
};

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

  private classifyDocContextKind(doc: {
    docType?: string | null;
    path?: string | null;
    title?: string | null;
  }): DocContextKind {
    const type = (doc.docType ?? "").toLowerCase();
    const label = `${doc.path ?? ""} ${doc.title ?? ""}`.toLowerCase();
    if (type.includes("sds") || /\bsds\b/.test(label)) return "sds";
    if (type.includes("openapi") || type.includes("swagger") || /(openapi|swagger)/.test(label)) return "openapi";
    return "fallback";
  }

  private buildOpenApiHintSummary(
    docs: Array<{
      docType?: string | null;
      path?: string | null;
      title?: string | null;
      content?: string | null;
      segments?: Array<{ content: string }>;
    }>,
  ): string {
    const lines: string[] = [];
    const countEntries = (value: unknown): number =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").length : 0;
    for (const doc of docs) {
      if (this.classifyDocContextKind(doc) !== "openapi") continue;
      const rawContent =
        doc.content && doc.content.trim().length > 0 ? doc.content : (doc.segments ?? []).map((segment) => segment.content).join("\n\n");
      const parsed = parseStructuredDoc(rawContent);
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
            typeof hints.complexity === "number" && Number.isFinite(hints.complexity) ? hints.complexity.toFixed(1) : "-";
          const dependsOn = Array.isArray(hints.depends_on_operations)
            ? hints.depends_on_operations.filter((entry): entry is string => typeof entry === "string").length
            : 0;
          const tests = isPlainObject(hints.test_requirements) ? hints.test_requirements : undefined;
          const unitCount = countEntries(tests?.unit);
          const componentCount = countEntries(tests?.component);
          const integrationCount = countEntries(tests?.integration);
          const apiCount = countEntries(tests?.api);
          lines.push(
            `- ${normalizedMethod.toUpperCase()} ${apiPath} :: service=${service}; capability=${capability}; stage=${stage}; complexity=${complexity}; deps=${dependsOn}; tests(u/c/i/a)=${unitCount}/${componentCount}/${integrationCount}/${apiCount}`,
          );
          if (lines.length >= OPENAPI_HINTS_LIMIT) {
            return lines.join("\n");
          }
        }
      }
    }
    return lines.join("\n");
  }

  private enforcePlanningContextPolicy(
    policy: PlanningContextPolicy,
    context: DocContext | undefined,
  ): void {
    if (policy === "best_effort") return;
    if (policy === "require_any") {
      if (!context) {
        throw new Error("Planning context is required but no planning documents were resolved (policy=require_any).");
      }
      return;
    }
    if (!context) {
      throw new Error(
        "Planning context is required from SDS/OpenAPI sources, but none were resolved (policy=require_sds_or_openapi).",
      );
    }
    if (context.kind !== "sds" && context.kind !== "openapi") {
      throw new Error(
        `Planning context policy require_sds_or_openapi rejected source '${context.source}' (kind=${context.kind}).`,
      );
    }
  }

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
      let docs = await this.docdex.search({ docType: "SDS", projectKey });
      if (!docs.length) {
        docs = await this.docdex.search({ docType: "OPENAPI", projectKey });
      }
      if (!docs.length) {
        docs = await this.docdex.search({
          projectKey,
          profile: "workspace-code",
          query: "sds requirements architecture openapi swagger",
        });
      }
      if (!docs.length) return undefined;
      const doc =
        docs.find((entry) => {
          const type = (entry.docType ?? "").toLowerCase();
          const label = `${entry.path ?? ""} ${entry.title ?? ""}`.toLowerCase();
          return type.includes("sds") || type.includes("pdr") || type.includes("rfp") || PLANNING_DOC_HINT_PATTERN.test(label);
        }) ?? docs[0];
      const kind = this.classifyDocContextKind(doc);
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
      const openApiHints = this.buildOpenApiHintSummary([doc]);
      const contextBlocks = ["[Planning context]", doc.title ?? doc.path ?? doc.id, body];
      if (openApiHints) {
        contextBlocks.push(`[OPENAPI_HINTS]\n${openApiHints}`);
      }
      return {
        content: contextBlocks.filter(Boolean).join("\n\n"),
        source: doc.id ?? doc.path ?? "sds",
        kind,
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
          e.priority as epic_priority,
          t.user_story_id as story_id,
          us.key as story_key,
          us.title as story_title,
          us.priority as story_priority,
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
      epic_priority: row.epic_priority ?? null,
      story_priority: row.story_priority ?? null,
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

  private async loadMissingContext(taskIds: string[]): Promise<Set<string>> {
    if (!taskIds.length) return new Set();
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = await this.db.all<{ task_id: string }[]>(
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

  private resolveClassification(
    task: Pick<TaskRow, "metadata" | "title" | "description" | "type">,
  ): { stage: TaskStage; foundation: boolean } {
    const metadata = task.metadata ?? {};
    const stage = typeof metadata.stage === "string" ? metadata.stage.toLowerCase() : undefined;
    const foundation = typeof metadata.foundation === "boolean" ? metadata.foundation : undefined;
    if (stage && ["foundation", "backend", "frontend", "other"].includes(stage)) {
      return {
        stage: stage as TaskStage,
        foundation: foundation ?? stage === "foundation",
      };
    }
    const inferred = classifyTask({ title: task.title, description: task.description, type: task.type ?? undefined });
    return { stage: inferred.stage, foundation: inferred.foundation };
  }

  private complexityBand(score: number): "low" | "medium" | "high" | "very_high" {
    if (score < 12) return "low";
    if (score < 24) return "medium";
    if (score < 40) return "high";
    return "very_high";
  }

  private buildOrderingMetadata(
    tasks: TaskNode[],
    impact: Map<string, DependencyImpact>,
    missingContext: Set<string>,
    docContext?: DocContext,
  ): { metadataByTask: Map<string, Record<string, unknown> | null>; complexityByTask: ComplexityByTask } {
    const metadataByTask = new Map<string, Record<string, unknown> | null>();
    const complexityByTask: ComplexityByTask = new Map();
    for (const task of tasks) {
      const classification = this.resolveClassification(task);
      const inferred = classifyTask({ title: task.title, description: task.description, type: task.type ?? undefined });
      const impactEntry = impact.get(task.id) ?? { direct: 0, total: 0 };
      const dependencyCount = task.dependencies.length;
      const missingContextOpen = missingContext.has(task.id);
      const textLength = `${task.title ?? ""} ${task.description ?? ""}`.trim().length;
      const textWeight = Math.min(6, Math.ceil(textLength / 200));
      const stageWeight =
        classification.stage === "backend" ? 2 : classification.stage === "frontend" ? 1.5 : classification.stage === "foundation" ? 1.2 : 1;
      let complexityScore =
        (task.story_points ?? 0) * 5 +
        impactEntry.total * 3 +
        dependencyCount * 2 +
        textWeight * stageWeight +
        (classification.foundation ? 2 : 0) +
        (missingContextOpen ? 4 : 0);
      complexityScore = Number(Math.max(1, complexityScore).toFixed(2));
      complexityByTask.set(task.id, complexityScore);

      const existingMetadata = task.metadata ?? {};
      const existingOrdering =
        existingMetadata && typeof existingMetadata.ordering === "object" && !Array.isArray(existingMetadata.ordering)
          ? (existingMetadata.ordering as Record<string, unknown>)
          : {};
      const reasons = [...inferred.reasons];
      if (typeof existingMetadata.stage === "string") {
        reasons.unshift(`metadata:stage:${String(existingMetadata.stage).toLowerCase()}`);
      }
      if (typeof existingMetadata.foundation === "boolean") {
        reasons.unshift(`metadata:foundation:${existingMetadata.foundation ? "true" : "false"}`);
      }
      const mergedMetadata: Record<string, unknown> = {
        ...existingMetadata,
        stage: classification.stage,
        foundation: classification.foundation,
        ordering: {
          ...existingOrdering,
          stage: classification.stage,
          foundation: classification.foundation,
          dependencyImpact: impactEntry,
          dependencyCount,
          complexityScore,
          complexityBand: this.complexityBand(complexityScore),
          missingContextOpen,
          classificationReasons: reasons,
          docContextSource: docContext?.source,
        },
      };
      metadataByTask.set(task.id, mergedMetadata);
    }
    return { metadataByTask, complexityByTask };
  }

  private buildDependencyGraph(tasks: TaskRow[], deps: Map<string, DependencyRow[]>): Map<string, Set<string>> {
    const taskIds = new Set(tasks.map((task) => task.id));
    const graph = new Map<string, Set<string>>();
    for (const task of tasks) {
      const rows = deps.get(task.id) ?? [];
      const edges = new Set<string>();
      for (const dep of rows) {
        if (!dep.depends_on_task_id) continue;
        if (!taskIds.has(dep.depends_on_task_id)) continue;
        edges.add(dep.depends_on_task_id);
      }
      if (edges.size > 0) {
        graph.set(task.id, edges);
      }
    }
    return graph;
  }

  private hasDependencyPath(graph: Map<string, Set<string>>, fromId: string, toId: string): boolean {
    if (fromId === toId) return true;
    const visited = new Set<string>();
    const stack = [fromId];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === toId) return true;
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

  private async injectFoundationDependencies(
    tasks: TaskRow[],
    deps: Map<string, DependencyRow[]>,
    warnings: string[],
    persist: boolean,
  ): Promise<void> {
    const classification = new Map<string, { foundation: boolean }>();
    for (const task of tasks) {
      classification.set(task.id, this.resolveClassification(task));
    }
    const foundationTasks = tasks.filter((task) => classification.get(task.id)?.foundation);
    const nonFoundationTasks = tasks.filter((task) => !classification.get(task.id)?.foundation);
    if (foundationTasks.length === 0 || nonFoundationTasks.length === 0) return;

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const dependencyGraph = this.buildDependencyGraph(tasks, deps);
    const inserts: { taskId: string; dependsOnTaskId: string; relationType: string }[] = [];
    let skippedCycles = 0;
    const skippedEdges: string[] = [];

    for (const task of nonFoundationTasks) {
      const existing = new Set(
        (deps.get(task.id) ?? [])
          .map((dep) => dep.depends_on_task_id ?? "")
          .filter(Boolean),
      );
      for (const foundation of foundationTasks) {
        if (task.id === foundation.id) continue;
        if (existing.has(foundation.id)) continue;
        if (this.hasDependencyPath(dependencyGraph, foundation.id, task.id)) {
          skippedCycles += 1;
          if (skippedEdges.length < 5) {
            skippedEdges.push(`${task.key}->${foundation.key}`);
          }
          continue;
        }
        inserts.push({
          taskId: task.id,
          dependsOnTaskId: foundation.id,
          relationType: "inferred_foundation",
        });
        existing.add(foundation.id);
        const edges = dependencyGraph.get(task.id) ?? new Set<string>();
        edges.add(foundation.id);
        dependencyGraph.set(task.id, edges);
      }
    }

    if (inserts.length === 0) {
      if (skippedCycles > 0) {
        warnings.push(`Skipped ${skippedCycles} inferred foundation deps due to cycles.`);
        if (skippedEdges.length > 0) {
          warnings.push(`Skipped inferred foundation deps (cycle sample): ${skippedEdges.join(", ")}`);
        }
      }
      return;
    }

    if (persist) {
      await this.repo.insertTaskDependencies(inserts, true);
    }
    for (const insert of inserts) {
      const depList = deps.get(insert.taskId) ?? [];
      const dependsOn = taskById.get(insert.dependsOnTaskId);
      depList.push({
        task_id: insert.taskId,
        depends_on_task_id: insert.dependsOnTaskId,
        depends_on_key: dependsOn?.key,
        depends_on_status: dependsOn?.status,
      });
      deps.set(insert.taskId, depList);
    }
    if (persist) {
      warnings.push(`Injected ${inserts.length} inferred foundation deps.`);
    } else {
      warnings.push(`Dry run: inferred ${inserts.length} foundation deps (not persisted).`);
    }
    if (skippedCycles > 0) {
      warnings.push(`Skipped ${skippedCycles} inferred foundation deps due to cycles.`);
      if (skippedEdges.length > 0) {
        warnings.push(`Skipped inferred foundation deps (cycle sample): ${skippedEdges.join(", ")}`);
      }
    }
  }

  private async applyInferredDependencies(
    tasks: TaskRow[],
    deps: Map<string, DependencyRow[]>,
    inferred: InferredDependency[],
    warnings: string[],
    persist: boolean,
  ): Promise<void> {
    if (inferred.length === 0) return;
    const taskByKey = new Map(tasks.map((task) => [task.key, task]));
    const dependencyGraph = this.buildDependencyGraph(tasks, deps);
    const inserts: { taskId: string; dependsOnTaskId: string; relationType: string }[] = [];
    let skippedCycles = 0;
    const skippedEdges: string[] = [];

    for (const entry of inferred) {
      const task = taskByKey.get(entry.taskKey);
      if (!task) continue;
      const existing = new Set(
        (deps.get(task.id) ?? [])
          .map((dep) => dep.depends_on_task_id ?? "")
          .filter(Boolean),
      );
      for (const depKey of entry.dependsOnKeys) {
        const dependsOn = taskByKey.get(depKey);
        if (!dependsOn) continue;
        if (dependsOn.id === task.id) continue;
        if (existing.has(dependsOn.id)) continue;
        if (this.hasDependencyPath(dependencyGraph, dependsOn.id, task.id)) {
          skippedCycles += 1;
          if (skippedEdges.length < 5) {
            skippedEdges.push(`${task.key}->${dependsOn.key}`);
          }
          continue;
        }
        inserts.push({
          taskId: task.id,
          dependsOnTaskId: dependsOn.id,
          relationType: "inferred_agent",
        });
        existing.add(dependsOn.id);
        const edges = dependencyGraph.get(task.id) ?? new Set<string>();
        edges.add(dependsOn.id);
        dependencyGraph.set(task.id, edges);
      }
    }

    if (inserts.length === 0) {
      if (skippedCycles > 0) {
        warnings.push(`Skipped ${skippedCycles} inferred agent deps due to cycles.`);
        if (skippedEdges.length > 0) {
          warnings.push(`Skipped inferred agent deps (cycle sample): ${skippedEdges.join(", ")}`);
        }
      }
      return;
    }

    if (persist) {
      await this.repo.insertTaskDependencies(inserts, true);
    }
    const taskById = new Map(tasks.map((task) => [task.id, task]));
    for (const insert of inserts) {
      const depList = deps.get(insert.taskId) ?? [];
      const dependsOn = taskById.get(insert.dependsOnTaskId);
      depList.push({
        task_id: insert.taskId,
        depends_on_task_id: insert.dependsOnTaskId,
        depends_on_key: dependsOn?.key,
        depends_on_status: dependsOn?.status,
      });
      deps.set(insert.taskId, depList);
    }
    if (persist) {
      warnings.push(`Applied ${inserts.length} inferred agent deps.`);
    } else {
      warnings.push(`Dry run: inferred ${inserts.length} agent deps (not persisted).`);
    }
    if (skippedCycles > 0) {
      warnings.push(`Skipped ${skippedCycles} inferred agent deps due to cycles.`);
      if (skippedEdges.length > 0) {
        warnings.push(`Skipped inferred agent deps (cycle sample): ${skippedEdges.join(", ")}`);
      }
    }
  }

  private compareTasks(
    a: TaskNode,
    b: TaskNode,
    impact: Map<string, DependencyImpact>,
    complexityByTask: ComplexityByTask,
    missingContext: Set<string>,
    agentRank?: AgentRanking,
    stageOrderMap?: Map<TaskStage, number>,
  ): number {
    const epicPriorityA = a.epic_priority ?? Number.MAX_SAFE_INTEGER;
    const epicPriorityB = b.epic_priority ?? Number.MAX_SAFE_INTEGER;
    if (epicPriorityA !== epicPriorityB) return epicPriorityA - epicPriorityB;
    const storyPriorityA = a.story_priority ?? Number.MAX_SAFE_INTEGER;
    const storyPriorityB = b.story_priority ?? Number.MAX_SAFE_INTEGER;
    if (storyPriorityA !== storyPriorityB) return storyPriorityA - storyPriorityB;
    const missingA = missingContext.has(a.id);
    const missingB = missingContext.has(b.id);
    if (missingA !== missingB) return missingA ? 1 : -1;
    const classA = this.resolveClassification(a);
    const classB = this.resolveClassification(b);
    if (classA.foundation !== classB.foundation) {
      return classA.foundation ? -1 : 1;
    }
    if (stageOrderMap) {
      const stageA = stageOrderMap.get(classA.stage) ?? stageOrderMap.get("other") ?? Number.MAX_SAFE_INTEGER;
      const stageB = stageOrderMap.get(classB.stage) ?? stageOrderMap.get("other") ?? Number.MAX_SAFE_INTEGER;
      if (stageA !== stageB) return stageA - stageB;
    }
    const impactA = impact.get(a.id)?.total ?? 0;
    const impactB = impact.get(b.id)?.total ?? 0;
    if (impactA !== impactB) return impactB - impactA;
    const complexityA = complexityByTask.get(a.id) ?? 0;
    const complexityB = complexityByTask.get(b.id) ?? 0;
    if (complexityA !== complexityB) return complexityB - complexityA;
    const rankA = agentRank?.get(a.id);
    const rankB = agentRank?.get(b.id);
    if (rankA !== undefined || rankB !== undefined) {
      if (rankA === undefined) return 1;
      if (rankB === undefined) return -1;
      if (rankA !== rankB) return rankA - rankB;
    }
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
    complexityByTask: ComplexityByTask,
    missingContext: Set<string>,
    agentRank?: AgentRanking,
    stageOrderMap?: Map<TaskStage, number>,
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
    const sortQueue = () =>
      queue.sort((a, b) => this.compareTasks(a, b, impact, complexityByTask, missingContext, agentRank, stageOrderMap));
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
      remaining.sort((a, b) =>
        this.compareTasks(a, b, impact, complexityByTask, missingContext, agentRank, stageOrderMap),
      );
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
      const missing: string[] = [];
      for (const dep of taskDeps) {
        const status = dep.depends_on_status?.toLowerCase();
        if (!dep.depends_on_task_id) {
          missing.push(dep.depends_on_key ?? "unknown");
          missingRefs.add(dep.depends_on_key ?? "unknown");
          continue;
        }
        const inScope = taskIds.has(dep.depends_on_task_id);
        const isDone = DONE_STATUSES.has(status ?? "");
        if (!inScope) {
          if (!isDone) {
            missing.push(dep.depends_on_key ?? dep.depends_on_task_id);
            missingRefs.add(dep.depends_on_key ?? dep.depends_on_task_id);
          }
          continue;
        }
        const list = dependents.get(dep.depends_on_task_id) ?? [];
        list.push(task.id);
        dependents.set(dep.depends_on_task_id, list);
      }
      return {
        ...task,
        dependencies: taskDeps,
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
    const parsed = extractJson(agentOutput) as
      | { order?: Array<{ task_key?: string } | string> }
      | Array<{ task_key?: string } | string>
      | undefined;
    if (!parsed) {
      warnings.push("Agent output could not be parsed; using dependency-only ordering.");
      return undefined;
    }
    const order = Array.isArray(parsed) ? parsed : parsed.order;
    if (!Array.isArray(order)) {
      warnings.push("Agent output missing order list; using dependency-only ordering.");
      return undefined;
    }
    try {
      const ranking = new Map<string, number>();
      order.forEach((entry, idx) => {
        const key =
          typeof entry === "string" ? entry : (entry as any).task_key ?? (entry as any).taskKey ?? (entry as any).key;
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

  private async inferDependenciesWithAgent(
    agent: Agent,
    tasks: TaskNode[],
    context: {
      project: ProjectRow;
      epic?: EpicRow;
      story?: StoryRow;
      docContext?: DocContext;
      stream: boolean;
      warnings: string[];
    },
  ): Promise<InferredDependency[]> {
    const summary = {
      project: context.project.key,
      epic: context.epic?.key,
      story: context.story?.key,
      tasks: tasks.map((task) => ({
        task_key: task.key,
        epic_key: task.epic_key,
        story_key: task.story_key,
        title: task.title,
        description: task.description,
        type: task.type,
        depends_on: (task.dependencies ?? [])
          .map((dep) => dep.depends_on_key ?? dep.depends_on_task_id)
          .filter(Boolean),
      })),
    };
    const prompt = [
      "You are inferring dependencies across epics, stories, and tasks.",
      "Return ONLY JSON matching:",
      `{"dependencies":[{"task_key":"<key>","depends_on":["<key>"]}]}`,
      "Only include task_key values from the input.",
      "Do not add self-dependencies. Omit empty depends_on arrays.",
      context.docContext ? `Doc context:\n${context.docContext.content}` : undefined,
      "Task summary:",
      JSON.stringify(summary, null, 2),
    ]
      .filter(Boolean)
      .join("\n\n");
    const { output } = await this.invokeAgent(agent, prompt, context.stream, {
      command: "order-tasks",
      phase: "infer_dependencies",
      project: context.project.key,
      epic: context.epic?.key,
      story: context.story?.key,
    });
    const taskKeys = new Set(tasks.map((task) => task.key));
    return parseDependencyInferenceOutput(output, taskKeys, context.warnings);
  }

  private async persistPriorities(
    ordered: TaskNode[],
    epicMap: Map<string, TaskNode[]>,
    storyMap: Map<string, TaskNode[]>,
    metadataByTask?: Map<string, Record<string, unknown> | null>,
  ): Promise<void> {
    await this.repo.withTransaction(async () => {
      for (let i = 0; i < ordered.length; i += 1) {
        const task = ordered[i];
        const nextMetadata = metadataByTask?.get(task.id);
        await this.repo.updateTask(task.id, {
          priority: i + 1,
          metadata: nextMetadata !== undefined ? nextMetadata : undefined,
        });
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
    impact: Map<string, DependencyImpact>,
    cycleMembers: Set<string>,
  ): { ordered: TaskOrderItem[] } {
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
      dependencyKeys: (task.dependencies ?? []).map((d) => d.depends_on_key ?? d.depends_on_task_id ?? "").filter(Boolean),
      dependencyImpact: impact.get(task.id) ?? { direct: 0, total: 0 },
      cycleDetected: cycleMembers.has(task.id) || undefined,
      metadata: task.metadata,
    }));
    return { ordered: result };
  }

  async orderTasks(request: TaskOrderingRequest): Promise<TaskOrderingResult> {
    if (!request.projectKey) {
      throw new Error("order-tasks requires --project <PROJECT_KEY>");
    }
    const statuses = normalizeStatuses(request.statusFilter);
    const warnings: string[] = [];
    if (request.statusFilter?.some((status) => status.toLowerCase().trim() === "blocked")) {
      warnings.push("Status 'blocked' is no longer supported; ignoring it in order-tasks.");
    }
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
      const applyChanges = request.apply !== false;
      const enrichMetadata = request.enrichMetadata !== false;
      const planningContextPolicy: PlanningContextPolicy = request.planningContextPolicy ?? "best_effort";
      const tasks = await this.fetchTasks(project.id, epic?.id, statuses, story?.id, request.assignee);
      const deps = await this.fetchDependencies(tasks.map((t) => t.id));
      if (request.injectFoundationDeps !== false) {
        await this.injectFoundationDependencies(tasks, deps, warnings, applyChanges);
      }
      let { nodes, dependents, missingRefs } = this.buildNodes(tasks, deps);
      const enableAgentRanking = Boolean(request.agentName);
      const enableInference = request.inferDependencies === true;
      const useAgent = enableAgentRanking || enableInference;
      const agentStream = request.agentStream !== false;
      let docContext: DocContext | undefined;
      if (useAgent || enrichMetadata) {
        docContext = await this.buildDocContext(project.key, warnings);
        this.enforcePlanningContextPolicy(planningContextPolicy, docContext);
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
      let resolvedAgent: Agent | undefined;
      if (useAgent) {
        try {
          resolvedAgent = await this.resolveAgent(request.agentName);
        } catch (error) {
          warnings.push(`Agent resolution failed: ${(error as Error).message}`);
        }
      }
      if (enableInference && resolvedAgent) {
        try {
          const inferred = await this.inferDependenciesWithAgent(resolvedAgent, nodes, {
            project,
            epic,
            story,
            docContext,
            stream: agentStream,
            warnings,
          });
          await this.applyInferredDependencies(tasks, deps, inferred, warnings, applyChanges);
          ({ nodes, dependents, missingRefs } = this.buildNodes(tasks, deps));
        } catch (error) {
          warnings.push(`Dependency inference skipped: ${(error as Error).message}`);
        }
      } else if (enableInference && !resolvedAgent) {
        warnings.push("Dependency inference skipped: no agent resolved.");
      }

      if (missingRefs.size > 0) {
        warnings.push(`Missing dependencies referenced: ${Array.from(missingRefs).join(", ")}`);
      }
      const missingContext = await this.loadMissingContext(nodes.map((node) => node.id));
      if (missingContext.size > 0) {
        warnings.push(
          `Tasks with open missing_context comments: ${Array.from(missingContext).length}`,
        );
      }
      if (enrichMetadata && !docContext) {
        warnings.push("Planning context unavailable: ordering metadata enrichment used task/dependency heuristics only.");
      }
      const stageOrder = (request.stageOrder && request.stageOrder.length > 0
        ? request.stageOrder
        : DEFAULT_STAGE_ORDER) as TaskStage[];
      const stageOrderMap = new Map<TaskStage, number>();
      for (const [idx, stage] of stageOrder.entries()) {
        if (["foundation", "backend", "frontend", "other"].includes(stage)) {
          stageOrderMap.set(stage, idx);
        }
      }
      if (stageOrderMap.size === 0) {
        DEFAULT_STAGE_ORDER.forEach((stage, idx) => stageOrderMap.set(stage, idx));
      }
      const impact = this.dependencyImpactMap(dependents);
      const { metadataByTask, complexityByTask } = enrichMetadata
        ? this.buildOrderingMetadata(nodes, impact, missingContext, docContext)
        : { metadataByTask: new Map<string, Record<string, unknown> | null>(), complexityByTask: new Map<string, number>() };
      const { ordered: initialOrder, cycle, cycleMembers } = this.topologicalSort(
        nodes,
        dependents,
        impact,
        complexityByTask,
        missingContext,
        undefined,
        stageOrderMap,
      );
      if (cycle) {
        warnings.push("Dependency cycle detected; ordering may be partial.");
      }

      let agentRank: AgentRanking | undefined;
      if (enableAgentRanking && resolvedAgent) {
        try {
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
          const { output } = await this.invokeAgent(resolvedAgent, prompt, agentStream, {
            command: "order-tasks",
            project: project.key,
            epic: epic?.key,
            story: story?.key,
            statuses,
          });
          const promptTokens = estimateTokens(prompt);
          const completionTokens = estimateTokens(output);
          if (commandRun && this.recordTelemetry) {
            await this.jobService.recordTokenUsage({
              workspaceId: this.workspace.workspaceId,
              projectId: project.id,
              commandRunId: commandRun.id,
              jobId: job?.id,
              agentId: resolvedAgent.id,
              modelName: resolvedAgent.defaultModel,
              timestamp: new Date().toISOString(),
              commandName: "order-tasks",
              action: "ordering_tasks",
              promptTokens,
              completionTokens,
              tokensPrompt: promptTokens,
              tokensCompletion: completionTokens,
              tokensTotal: promptTokens + completionTokens,
              metadata: {
                adapter: resolvedAgent.adapter,
                epicKey: epic?.key,
                storyKey: story?.key,
                statusFilter: statuses,
                agentSlug: resolvedAgent.slug,
                modelName: resolvedAgent.defaultModel,
                phase: "agent_ordering",
                attempt: 1,
              },
            });
          }
          agentRank = this.applyAgentRanking(initialOrder, output, warnings);
        } catch (error) {
          warnings.push(`Agent refinement skipped: ${(error as Error).message}`);
        }
      } else if (enableAgentRanking && !resolvedAgent) {
        warnings.push("Agent refinement skipped: no agent resolved.");
      }

      const { ordered, cycle: cycleAfterAgent, cycleMembers: agentCycleMembers } = this.topologicalSort(
        nodes,
        dependents,
        impact,
        complexityByTask,
        missingContext,
        agentRank,
        stageOrderMap,
      );
      const finalCycleMembers = new Set<string>([...cycleMembers, ...agentCycleMembers]);
      if (cycleAfterAgent && !cycle) {
        warnings.push("Agent-influenced ordering encountered a cycle; used partial order.");
      }

      const prioritized = ordered;
      if (enrichMetadata) {
        for (const task of prioritized) {
          const metadata = metadataByTask.get(task.id);
          if (metadata) {
            task.metadata = metadata;
          }
        }
      }

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

      if (applyChanges) {
        await this.persistPriorities(prioritized, epicMap, storyMap, enrichMetadata ? metadataByTask : undefined);
      } else {
        warnings.push("Dry run: priorities and dependency inferences were not persisted.");
      }

      const mapped = this.mapResult(prioritized, impact, finalCycleMembers);

      if (job) {
        await this.jobService.updateJobStatus(job.id, "completed", {
          processedItems: mapped.ordered.length,
          payload: {
            warnings,
            statuses,
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
        ordered: mapped.ordered,
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
