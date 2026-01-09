import path from "node:path";
import fs from "node:fs/promises";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, VcsClient } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository, type EpicRow, type StoryRow, type TaskInsert, type TaskRow } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { TaskSelectionFilters, TaskSelectionService } from "../execution/TaskSelectionService.js";
import { TaskStateService } from "../execution/TaskStateService.js";
import { BacklogService } from "../backlog/BacklogService.js";
import yaml from "yaml";
import { createTaskKeyGenerator } from "../planning/KeyHelpers.js";
import { RoutingService } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { loadProjectGuidance } from "../shared/ProjectGuidance.js";

const DEFAULT_BASE_BRANCH = "mcoda-dev";
const REVIEW_DIR = (workspaceRoot: string, jobId: string) => path.join(workspaceRoot, ".mcoda", "jobs", jobId, "review");
const STATE_PATH = (workspaceRoot: string, jobId: string) => path.join(REVIEW_DIR(workspaceRoot, jobId), "state.json");
const DEFAULT_CODE_REVIEW_PROMPT = [
  "You are the code-review agent. Before reviewing, query docdex with the task key and feature keywords (MCP `docdex_search` limit 4–8 or CLI `docdexd query --repo <repo> --query \"<term>\" --limit 6 --snippets=false`). If results look stale, reindex (`docdex_index` or `docdexd index --repo <repo>`) then re-run. Fetch snippets via `docdex_open` or `/snippet/:doc_id?text_only=true` only for specific hits.",
  "Use docdex snippets to verify contracts (data shapes, offline scope, accessibility/perf guardrails, acceptance criteria). Call out mismatches, missing tests, and undocumented changes.",
].join("\n");
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";

export interface CodeReviewRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  baseRef?: string;
  dryRun?: boolean;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  resumeJobId?: string;
}

export interface ReviewFinding {
  type?: string;
  severity?: string;
  file?: string;
  line?: number;
  message: string;
  suggestedFix?: string;
}

export interface ReviewAgentResult {
  decision: "approve" | "changes_requested" | "block" | "info_only";
  summary?: string;
  findings: ReviewFinding[];
  testRecommendations?: string[];
  raw?: string;
}

export interface TaskReviewResult {
  taskId: string;
  taskKey: string;
  statusBefore: string;
  statusAfter?: string;
  decision?: ReviewAgentResult["decision"];
  findings: ReviewFinding[];
  error?: string;
  followupTasks?: { taskId: string; taskKey: string; epicId: string; userStoryId: string; generic?: boolean }[];
}

export interface CodeReviewResult {
  jobId: string;
  commandRunId: string;
  tasks: TaskReviewResult[];
  warnings: string[];
}

interface ReviewJobState {
  baseRef: string;
  statusFilter: string[];
  selectedTaskIds: string[];
  contextBuilt: string[];
  reviewed: { taskId: string; decision?: string; error?: string }[];
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil((text ?? "").length / 4));

const parseJsonOutput = (raw: string): ReviewAgentResult | undefined => {
  const trimmed = raw.trim();
  const fenced = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const candidates = [trimmed, fenced];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) continue;
    const slice = candidate.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice) as ReviewAgentResult;
      return { ...parsed, raw: raw };
    } catch {
      /* ignore */
    }
  }
  return undefined;
};

const summarizeComments = (comments: { category?: string; body: string; file?: string; line?: number }[]): string => {
  if (!comments.length) return "No prior comments.";
  return comments
    .map((c) => {
      const loc = c.file ? `${c.file}${c.line ? `:${c.line}` : ""}` : "";
      return `- [${c.category ?? "general"}] ${loc ? `${loc} ` : ""}${c.body}`;
    })
    .join("\n");
};

const JSON_CONTRACT = `{
  "decision": "approve | changes_requested | block | info_only",
  "summary": "short textual summary",
  "findings": [
    {
      "type": "bug | style | test | docs | contract | security | other",
      "severity": "info | low | medium | high | critical",
      "file": "relative/path/to/file.ext",
      "line": 123,
      "message": "Clear reviewer message",
      "suggestedFix": "Optional suggested change"
    }
  ],
  "testRecommendations": ["Optional test or QA recommendations per task"]
}`;

const normalizeSingleLine = (value: string | undefined, fallback: string): string => {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed || fallback;
};

const buildStandardReviewComment = (params: {
  decision?: string;
  statusBefore: string;
  statusAfter?: string;
  findingsCount: number;
  summary?: string;
  followupTaskKeys?: string[];
  error?: string;
}): string => {
  const decision = params.decision ?? (params.error ? "error" : "info_only");
  const statusAfter = params.statusAfter ?? params.statusBefore;
  const summary = normalizeSingleLine(params.summary, params.error ? "Review failed." : "No summary provided.");
  const error = normalizeSingleLine(params.error, "none");
  const followups = params.followupTaskKeys && params.followupTaskKeys.length ? params.followupTaskKeys.join(", ") : "none";
  return [
    "[code-review]",
    `decision: ${decision}`,
    `status_before: ${params.statusBefore}`,
    `status_after: ${statusAfter}`,
    `findings: ${params.findingsCount}`,
    `summary: ${summary}`,
    `followups: ${followups}`,
    `error: ${error}`,
  ].join("\n");
};

export class CodeReviewService {
  private selectionService: TaskSelectionService;
  private stateService: TaskStateService;
  private vcs: VcsClient;
  private taskLogSeq = new Map<string, number>();
  private routingService: RoutingService;
  private ratingService?: AgentRatingService;

  constructor(
    private workspace: WorkspaceResolution,
    private deps: {
      agentService: AgentService;
      docdex: DocdexClient;
      jobService: JobService;
      workspaceRepo: WorkspaceRepository;
      selectionService?: TaskSelectionService;
      stateService?: TaskStateService;
      repo: GlobalRepository;
      vcsClient?: VcsClient;
      routingService: RoutingService;
      ratingService?: AgentRatingService;
    },
  ) {
    this.selectionService = deps.selectionService ?? new TaskSelectionService(workspace, deps.workspaceRepo);
    this.stateService = deps.stateService ?? new TaskStateService(deps.workspaceRepo);
    this.vcs = deps.vcsClient ?? new VcsClient();
    this.routingService = deps.routingService;
    this.ratingService = deps.ratingService;
  }

  static async create(workspace: WorkspaceResolution): Promise<CodeReviewService> {
    const repo = await GlobalRepository.create();
    const agentService = new AgentService(repo);
    const routingService = await RoutingService.create();
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
    });
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo);
    const selectionService = new TaskSelectionService(workspace, workspaceRepo);
    const stateService = new TaskStateService(workspaceRepo);
    const vcsClient = new VcsClient();
    return new CodeReviewService(workspace, {
      agentService,
      docdex,
      jobService,
      workspaceRepo,
      selectionService,
      stateService,
      repo,
      vcsClient,
      routingService,
    });
  }

  async close(): Promise<void> {
    const maybeClose = async (target: unknown) => {
      try {
        if ((target as any)?.close) await (target as any).close();
      } catch {
        /* ignore */
      }
    };
    await maybeClose(this.deps.selectionService);
    await maybeClose(this.deps.stateService);
    await maybeClose(this.deps.agentService);
    await maybeClose(this.deps.jobService);
    await maybeClose(this.deps.repo);
    await maybeClose(this.deps.workspaceRepo);
    await maybeClose(this.deps.routingService);
    await maybeClose(this.deps.docdex);
  }

  private async readPromptFiles(paths: string[]): Promise<string[]> {
    const contents: string[] = [];
    const seen = new Set<string>();
    for (const promptPath of paths) {
      try {
        const content = await fs.readFile(promptPath, "utf8");
        const trimmed = content.trim();
        if (trimmed && !seen.has(trimmed)) {
          contents.push(trimmed);
          seen.add(trimmed);
        }
      } catch {
        /* optional prompt */
      }
    }
    return contents;
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.workspace.mcodaDir);
    const gitignorePath = path.join(this.workspace.workspaceRoot, ".gitignore");
    const entry = ".mcoda/\n";
    try {
      const content = await fs.readFile(gitignorePath, "utf8");
      if (!content.includes(".mcoda/")) {
        await fs.writeFile(gitignorePath, `${content.trimEnd()}\n${entry}`, "utf8");
      }
    } catch {
      await fs.writeFile(gitignorePath, entry, "utf8");
    }
  }

  private async loadPrompts(agentId: string): Promise<{ jobPrompt?: string; characterPrompt?: string; commandPrompt?: string }> {
    const mcodaPromptPath = path.join(this.workspace.workspaceRoot, ".mcoda", "prompts", "code-reviewer.md");
    const workspacePromptPath = path.join(this.workspace.workspaceRoot, "prompts", "code-reviewer.md");
    try {
      await fs.mkdir(path.dirname(mcodaPromptPath), { recursive: true });
      await fs.access(mcodaPromptPath);
      console.info(`[code-review] using existing code-reviewer prompt at ${mcodaPromptPath}`);
    } catch {
      try {
        await fs.access(workspacePromptPath);
        await fs.copyFile(workspacePromptPath, mcodaPromptPath);
        console.info(`[code-review] copied code-reviewer prompt to ${mcodaPromptPath}`);
      } catch {
        console.info(`[code-review] no code-reviewer prompt found at ${workspacePromptPath}; writing default prompt to ${mcodaPromptPath}`);
        await fs.writeFile(mcodaPromptPath, DEFAULT_CODE_REVIEW_PROMPT, 'utf8');
      }
    }
    const filePrompts = await this.readPromptFiles([mcodaPromptPath, workspacePromptPath]);
    const agentPrompts =
      "getPrompts" in this.deps.agentService ? await (this.deps.agentService as any).getPrompts(agentId) : undefined;
    const mergedCommandPrompt = (() => {
      const parts = [...filePrompts];
      if (agentPrompts?.commandPrompts?.["code-review"]) {
        parts.push(agentPrompts.commandPrompts["code-review"]);
      }
      if (!parts.length) parts.push(DEFAULT_CODE_REVIEW_PROMPT);
      return parts.filter(Boolean).join("\n\n");
    })();
    return {
      jobPrompt: agentPrompts?.jobPrompt ?? DEFAULT_JOB_PROMPT,
      characterPrompt: agentPrompts?.characterPrompt ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: mergedCommandPrompt || undefined,
    };
  }

  private async loadRunbookAndChecklists(): Promise<string[]> {
    const extras: string[] = [];
    const runbookPath = path.join(this.workspace.workspaceRoot, ".mcoda", "prompts", "commands", "code-review.md");
    try {
      const content = await fs.readFile(runbookPath, "utf8");
      extras.push(content);
    } catch {
      /* optional */
    }
    const checklistDir = path.join(this.workspace.workspaceRoot, ".mcoda", "checklists");
    try {
      const entries = await fs.readdir(checklistDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const content = await fs.readFile(path.join(checklistDir, entry), "utf8");
        extras.push(content);
      }
    } catch {
      /* optional */
    }
    return extras;
  }

  private async resolveAgent(agentName?: string) {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "code-review",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private ensureRatingService(): AgentRatingService {
    if (!this.ratingService) {
      this.ratingService = new AgentRatingService(this.workspace, {
        workspaceRepo: this.deps.workspaceRepo,
        globalRepo: this.deps.repo,
        agentService: this.deps.agentService,
        routingService: this.routingService,
      });
    }
    return this.ratingService;
  }

  private resolveTaskComplexity(task: TaskRow): number | undefined {
    const metadata = (task.metadata as Record<string, unknown> | null | undefined) ?? {};
    const metaComplexity =
      typeof metadata.complexity === "number" && Number.isFinite(metadata.complexity) ? metadata.complexity : undefined;
    const storyPoints = typeof task.storyPoints === "number" && Number.isFinite(task.storyPoints) ? task.storyPoints : undefined;
    const candidate = metaComplexity ?? storyPoints;
    if (!Number.isFinite(candidate ?? NaN)) return undefined;
    return Math.min(10, Math.max(1, Math.round(candidate as number)));
  }

  private async selectTasksViaApi(filters: {
    projectKey?: string;
    epicKey?: string;
    storyKey?: string;
    taskKeys?: string[];
    statusFilter: string[];
    limit?: number;
  }): Promise<(TaskRow & { epicKey: string; storyKey: string; epicTitle?: string; epicDescription?: string; storyTitle?: string; storyDescription?: string; acceptanceCriteria?: string[] })[]> {
    // Prefer the backlog/task OpenAPI surface (via BacklogService) to mirror API filtering semantics.
    const backlog = await BacklogService.create(this.workspace);
    try {
      const result = await backlog.getBacklog({
        projectKey: filters.projectKey,
        epicKey: filters.epicKey,
        storyKey: filters.storyKey,
        statuses: filters.statusFilter,
        verbose: true,
      });
      let tasks = result.summary.tasks;
      if (filters.taskKeys?.length) {
        const allowed = new Set(filters.taskKeys);
        tasks = tasks.filter((t) => allowed.has(t.task_key));
      }
      if (filters.limit && filters.limit > 0) {
        tasks = tasks.slice(0, filters.limit);
      }
      const ids = tasks.map((t) => t.task_id);
      const detailed = await this.deps.workspaceRepo.getTasksWithRelations(ids);
      // Preserve ordering from backlog
      const order = new Map(ids.map((id, idx) => [id, idx]));
      return detailed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } finally {
      await backlog.close();
    }
  }

  private async persistState(jobId: string, state: ReviewJobState): Promise<void> {
    const dir = REVIEW_DIR(this.workspace.workspaceRoot, jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      STATE_PATH(this.workspace.workspaceRoot, jobId),
      JSON.stringify({ schema_version: 1, job_id: jobId, updated_at: new Date().toISOString(), ...state }, null, 2),
      "utf8",
    );
  }

  private async loadState(jobId: string): Promise<ReviewJobState | undefined> {
    try {
      const raw = await fs.readFile(STATE_PATH(this.workspace.workspaceRoot, jobId), "utf8");
      return JSON.parse(raw) as ReviewJobState;
    } catch {
      return undefined;
    }
  }

  private async writeCheckpoint(jobId: string, stage: string, details?: Record<string, unknown>): Promise<void> {
    await this.deps.jobService.writeCheckpoint(jobId, { stage, timestamp: new Date().toISOString(), details });
  }

  private componentHintsFromPaths(paths: string[]): string[] {
    const hints = new Set<string>();
    for (const p of paths) {
      const segments = p.split("/").filter(Boolean);
      if (segments.length) {
        hints.add(segments[0]);
        if (segments.length > 1) hints.add(`${segments[0]}/${segments[1]}`);
      }
      const file = p.split("/").pop();
      if (file) {
        const base = file.split(".")[0];
        hints.add(base);
      }
    }
    return Array.from(hints).slice(0, 8);
  }

  private async gatherDocContext(taskTitle: string, paths: string[], acceptance?: string[]): Promise<{ snippets: string[]; warnings: string[] }> {
    const snippets: string[] = [];
    const warnings: string[] = [];
    const queries = [...new Set([...(paths.length ? this.componentHintsFromPaths(paths) : []), taskTitle, ...(acceptance ?? [])])].slice(0, 8);
    for (const query of queries) {
      try {
        const docs = await this.deps.docdex.search({
          query,
          profile: "workspace-code",
        });
        snippets.push(
          ...docs.slice(0, 2).map((doc) => {
            const content = (doc.segments?.[0]?.content ?? doc.content ?? "").slice(0, 400);
            const ref = doc.path ?? doc.id ?? doc.title ?? query;
            return `- [${doc.docType ?? "doc"}] ${ref}: ${content}`;
          }),
        );
      } catch (error) {
        warnings.push(`docdex search failed for ${query}: ${(error as Error).message}`);
      }
    }
    return { snippets: Array.from(new Set(snippets)), warnings };
  }

  private buildReviewPrompt(params: {
    systemPrompts: string[];
    task: TaskRow & { epicKey?: string; storyKey?: string; epicTitle?: string; epicDescription?: string; storyTitle?: string; storyDescription?: string; acceptanceCriteria?: string[] };
    diff: string;
    docContext: string[];
    openapiSnippet?: string;
    checklists?: string[];
    historySummary: string;
    baseRef: string;
    branch?: string;
  }): string {
    const parts: string[] = [];
    if (params.systemPrompts.length) {
      parts.push(params.systemPrompts.join("\n\n"));
    }
    const acceptance = params.task.acceptanceCriteria && params.task.acceptanceCriteria.length ? params.task.acceptanceCriteria.join(" | ") : "none provided";
    parts.push(
      [
        `Task ${params.task.key}: ${params.task.title}`,
        `Epic: ${params.task.epicKey ?? ""} ${params.task.epicTitle ?? ""}`.trim(),
        `Epic description: ${params.task.epicDescription ? params.task.epicDescription : "none"}`,
        `Story: ${params.task.storyKey ?? ""} ${params.task.storyTitle ?? ""}`.trim(),
        `Story description: ${params.task.storyDescription ? params.task.storyDescription : "none"}`,
        `Status: ${params.task.status}, Branch: ${params.branch ?? params.task.vcsBranch ?? "n/a"} (base ${params.baseRef})`,
        `Task description: ${params.task.description ? params.task.description : "none"}`,
        `History:\n${params.historySummary}`,
        `Acceptance criteria: ${acceptance}`,
        params.docContext.length ? `Doc context (docdex excerpts):\n${params.docContext.join("\n")}` : "Doc context: none",
        params.openapiSnippet
          ? `OpenAPI (authoritative contract; do not invent endpoints outside this):\n${params.openapiSnippet}`
          : "OpenAPI: not provided; avoid inventing endpoints.",
        params.checklists && params.checklists.length ? `Review checklists/runbook:\n${params.checklists.join("\n\n")}` : "Checklists: none",
        "Diff:\n" + (params.diff || "(no diff)"),
        "Respond with STRICT JSON only, matching:\n" + JSON_CONTRACT,
        "Rules: honor OpenAPI contracts; cite doc context where relevant; do not add prose outside JSON.",
      ].join("\n"),
    );
    return parts.join("\n\n");
  }

  private async buildHistorySummary(taskId: string): Promise<string> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["work-on-tasks", "code-review", "qa-tasks"],
      limit: 10,
    });
    const lastReview = await this.deps.workspaceRepo.getLatestTaskReview(taskId);
    const parts: string[] = [];
    if (lastReview) {
      parts.push(`Last review decision: ${lastReview.decision}${lastReview.summary ? ` — ${lastReview.summary}` : ""}`);
    }
    if (comments.length) {
      parts.push("Recent comments:");
      parts.push(
        summarizeComments(
          comments.map((c) => ({
            category: c.category ?? undefined,
            body: c.body,
            file: c.file ?? undefined,
            line: c.line ?? undefined,
          })),
        ),
      );
      const unresolved = comments.filter((c) => !c.resolvedAt);
      if (unresolved.length) {
        parts.push(`Unresolved items: ${unresolved.length}`);
      }
    }
    if (!parts.length) return "No prior review or QA history.";
    return parts.join("\n");
  }

  private extractPathsFromDiff(diff: string): string[] {
    const regex = /^(?:\+\+\+ b\/|\-\-\- a\/)([^\s]+)$/gm;
    const paths = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = regex.exec(diff)) !== null) {
      const raw = match[1]?.trim();
      if (raw && raw !== "/dev/null") paths.add(raw.replace(/^a\//, "").replace(/^b\//, ""));
    }
    return Array.from(paths);
  }

  private async buildOpenApiSlice(changedPaths: string[], acceptance?: string[]): Promise<string | undefined> {
    const openapiPath = path.join(this.workspace.workspaceRoot, "openapi", "mcoda.yaml");
    try {
      const content = await fs.readFile(openapiPath, "utf8");
      const parsed = yaml.parse(content) as any;
      const pathHints = this.componentHintsFromPaths(changedPaths);
      const criteriaHints = (acceptance ?? []).map((c) => c.toLowerCase()).slice(0, 5);
      const matches: Record<string, any> = {};
      if (parsed?.paths) {
        for (const [apiPath, ops] of Object.entries(parsed.paths as Record<string, any>)) {
          const lowerPath = apiPath.toLowerCase();
          const hit =
            pathHints.some((h) => lowerPath.includes(h.toLowerCase())) ||
            criteriaHints.some((h) => lowerPath.includes(h)) ||
            (!pathHints.length && !criteriaHints.length);
          if (hit) {
            matches[apiPath] = ops;
          }
        }
      }
      const schemaMatches: Record<string, any> = {};
      if (parsed?.components?.schemas) {
        for (const [name, schema] of Object.entries(parsed.components.schemas as Record<string, any>)) {
          const lower = name.toLowerCase();
          if (pathHints.some((h) => lower.includes(h.toLowerCase()))) {
            schemaMatches[name] = schema;
          }
        }
      }
      if (!Object.keys(matches).length && !Object.keys(schemaMatches).length) {
        return content.slice(0, 4000);
      }
      const slice = {
        openapi: parsed.openapi ?? "3.0.0",
        info: parsed.info,
        paths: matches,
        components: Object.keys(schemaMatches).length ? { schemas: schemaMatches } : undefined,
      };
      const rendered = yaml.stringify(slice);
      return rendered.slice(0, 8000);
    } catch {
      return undefined;
    }
  }

  private async buildDiff(
    task: TaskRow,
    baseRef: string,
    fileScope: string[],
  ): Promise<{ diff: string; source: "commit" | "branch"; commitSha?: string; warning?: string }> {
    const branch = task.vcsBranch;
    await this.vcs.ensureRepo(this.workspace.workspaceRoot);
    const paths = fileScope.length ? fileScope : undefined;
    const commitSha = task.vcsLastCommitSha;
    if (commitSha) {
      try {
        const diff = await this.vcs.diff(this.workspace.workspaceRoot, `${commitSha}^`, commitSha, paths);
        return { diff, source: "commit", commitSha };
      } catch (error) {
        if (!branch) {
          throw new Error(`Task branch missing and commit diff failed: ${(error as Error).message}`);
        }
        const fallback = await this.vcs.diff(this.workspace.workspaceRoot, baseRef, branch, paths);
        return {
          diff: fallback,
          source: "branch",
          commitSha,
          warning: `Failed to diff commit ${commitSha}; fell back to branch ${branch}.`,
        };
      }
    }
    if (!branch) throw new Error("Task branch missing");
    const diff = await this.vcs.diff(this.workspace.workspaceRoot, baseRef, branch, paths);
    return { diff, source: "branch" };
  }

  private async writeReviewSummaryComment(params: {
    task: TaskRow;
    taskRunId: string;
    jobId: string;
    agentId: string;
    statusBefore: string;
    statusAfter?: string;
    decision?: string;
    summary?: string;
    findingsCount: number;
    followupTaskKeys?: string[];
    error?: string;
  }): Promise<void> {
    const body = buildStandardReviewComment({
      decision: params.decision,
      statusBefore: params.statusBefore,
      statusAfter: params.statusAfter,
      findingsCount: params.findingsCount,
      summary: params.summary,
      followupTaskKeys: params.followupTaskKeys,
      error: params.error,
    });
    await this.deps.workspaceRepo.createTaskComment({
      taskId: params.task.id,
      taskRunId: params.taskRunId,
      jobId: params.jobId,
      sourceCommand: "code-review",
      authorType: "agent",
      authorAgentId: params.agentId,
      category: "review_summary",
      body,
      createdAt: new Date().toISOString(),
    });
  }

  private async persistContext(jobId: string, taskId: string, context: Record<string, unknown>): Promise<void> {
    const dir = path.join(REVIEW_DIR(this.workspace.workspaceRoot, jobId), "context");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${taskId}.json`),
      JSON.stringify({ schema_version: 1, task_id: taskId, created_at: new Date().toISOString(), ...context }, null, 2),
      "utf8",
    );
  }

  private async persistDiff(jobId: string, taskId: string, diff: string): Promise<void> {
    const dir = path.join(REVIEW_DIR(this.workspace.workspaceRoot, jobId), "diffs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${taskId}.diff`), diff, "utf8");
    // structured review diff snapshot
    const files: { path: string; hunks: string[] }[] = [];
    let current: { path: string; hunks: string[] } | null = null;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith("diff --git")) {
        if (current) {
          files.push(current);
          current = null;
        }
        continue;
      }
      const fileHeader = line.match(/^(\+\+\+|---)\s+[ab]\/(.+)$/);
      if (fileHeader) {
        if (current) files.push(current);
        current = { path: fileHeader[2], hunks: [] };
        continue;
      }
      if (line.startsWith("@@")) {
        if (current) current.hunks.push(line);
        continue;
      }
      if (current) current.hunks.push(line);
    }
    if (current) files.push(current);
    await fs.writeFile(path.join(dir, `${taskId}.json`), JSON.stringify({ schema_version: 1, task_id: taskId, files }, null, 2), "utf8");
  }

  private severityToPriority(severity?: string): number | null {
    if (!severity) return null;
    const normalized = severity.toLowerCase();
    const order: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4, info: 5 };
    return order[normalized] ?? null;
  }

  private shouldCreateFollowupTask(decision: ReviewAgentResult["decision"] | undefined, finding: ReviewFinding): boolean {
    // SDS rule: create follow-ups for blocking/changes_requested decisions or critical/high issues,
    // and for contract/security/bug types at medium+ severity. Do not create for approve+low/info.
    const sev = (finding.severity ?? "").toLowerCase();
    const type = (finding.type ?? "").toLowerCase();
    const decisionRequestsChange = decision === "changes_requested" || decision === "block";
    if (decisionRequestsChange && sev !== "info") return true;
    if (["critical", "high"].includes(sev)) return true;
    if (["bug", "security", "contract"].includes(type) && !["info", "low"].includes(sev)) return true;
    return false;
  }

  private buildFollowupTitle(task: TaskRow & { storyKey?: string }, finding: ReviewFinding, generatedKey: string): string {
    const base = (finding.message ?? "Review follow-up").split("\n")[0]?.trim() ?? "Review follow-up";
    const prefix = finding.file ? `${finding.file}: ` : "";
    const raw = `${prefix}${base}`;
    const truncated = raw.length > 140 ? `${raw.slice(0, 137)}...` : raw;
    return truncated || `Follow-up ${generatedKey} for ${task.key}`;
  }

  private buildFollowupDescription(task: TaskRow & { storyKey?: string; epicKey?: string }, finding: ReviewFinding, decision?: ReviewAgentResult["decision"]): string {
    const lines = [
      `Auto-created from code review of ${task.key}. Decision: ${decision ?? "n/a"}.`,
      finding.message ? `Finding: ${finding.message}` : undefined,
      finding.file ? `Location: ${finding.file}${finding.line ? `:${finding.line}` : ""}` : undefined,
      finding.severity ? `Severity: ${finding.severity}` : undefined,
      finding.type ? `Category: ${finding.type}` : undefined,
      finding.suggestedFix ? `Suggested fix: ${finding.suggestedFix}` : undefined,
      `Story: ${task.storyKey ?? task.userStoryId}, Epic: ${task.epicKey ?? task.epicId}`,
    ].filter(Boolean);
    return lines.join("\n");
  }

  private async ensureGenericContainers(projectId: string): Promise<{ epic: EpicRow; story: StoryRow }> {
    const epicCandidates = ["epic-bugs", "epic-issues"];
    let epic: EpicRow | undefined;
    for (const key of epicCandidates) {
      epic = await this.deps.workspaceRepo.getEpicByKey(projectId, key);
      if (epic) break;
    }
    if (!epic) {
      const [createdEpic] = await this.deps.workspaceRepo.insertEpics(
        [
          {
            projectId,
            key: epicCandidates[0],
            title: "Bug Backlog",
            description: "Generic epic for code review follow-up issues",
            metadata: { source: "code-review", autoGenerated: true },
          },
        ],
        true,
      );
      epic = createdEpic;
    }

    const storyCandidates = ["us-bugs", "us-issues"];
    let story: StoryRow | undefined;
    for (const key of storyCandidates) {
      story = await this.deps.workspaceRepo.getStoryByKey(epic.id, key);
      if (story) break;
    }
    if (!story) {
      const [createdStory] = await this.deps.workspaceRepo.insertStories(
        [
          {
            projectId,
            epicId: epic.id,
            key: storyCandidates[0],
            title: "Review issues",
            description: "Auto-created story for code review findings",
            acceptanceCriteria: "Track, fix, and verify issues found during reviews.",
            metadata: { source: "code-review", autoGenerated: true },
          },
        ],
        true,
      );
      story = createdStory;
    }

    return { epic, story };
  }

  private async createFollowupTasksForFindings(params: {
    task: TaskRow & { storyKey?: string; epicKey?: string };
    findings: ReviewFinding[];
    decision?: ReviewAgentResult["decision"];
    jobId: string;
    commandRunId: string;
    taskRunId: string;
  }): Promise<TaskRow[]> {
    const actionable = params.findings.filter((f) => this.shouldCreateFollowupTask(params.decision, f));
    if (!actionable.length) return [];

    const useGeneric = actionable.some((f) => !f.file && !f.line);
    const genericContainers = useGeneric ? await this.ensureGenericContainers(params.task.projectId) : undefined;

    const inserts: TaskInsert[] = [];
    const generators = new Map<
      string,
      {
        gen: () => string;
        keys: Set<string>;
        storyKey: string;
      }
    >();
    const ensureKey = async (storyId: string, storyKey: string): Promise<string> => {
      let entry = generators.get(storyId);
      if (!entry) {
        const existing = new Set(await this.deps.workspaceRepo.listTaskKeys(storyId));
        entry = { gen: createTaskKeyGenerator(storyKey, existing), keys: existing, storyKey };
        generators.set(storyId, entry);
      }
      const key = entry.gen();
      entry.keys.add(key);
      return key;
    };

    for (const finding of actionable) {
      const genericTarget = !finding.file && !finding.line && genericContainers;
      const storyId = genericTarget ? genericContainers.story.id : params.task.userStoryId;
      const storyKey = genericTarget ? genericContainers!.story.key : params.task.storyKey ?? genericContainers?.story.key ?? "US-AUTO";
      const epicId = genericTarget ? genericContainers!.epic.id : params.task.epicId;
      const taskKey = await ensureKey(storyId, storyKey);
      inserts.push({
        projectId: params.task.projectId,
        epicId,
        userStoryId: storyId,
        key: taskKey,
        title: this.buildFollowupTitle(params.task, finding, taskKey),
        description: this.buildFollowupDescription(params.task, finding, params.decision),
        type: finding.type ?? (params.decision === "changes_requested" || params.decision === "block" ? "bug" : "issue"),
        status: "not_started",
        storyPoints: null,
        priority: this.severityToPriority(finding.severity),
        metadata: {
          source: "code-review",
          source_task_id: params.task.id,
          source_task_key: params.task.key,
          source_job_id: params.jobId,
          source_command_run_id: params.commandRunId,
          source_task_run_id: params.taskRunId,
          severity: finding.severity,
          type: finding.type,
          file: finding.file,
          line: finding.line,
          suggestedFix: finding.suggestedFix,
          generic: genericTarget ? true : false,
          decision: params.decision,
        },
      });
    }

    const created = await this.deps.workspaceRepo.insertTasks(inserts, true);
    for (let i = 0; i < created.length; i += 1) {
      const createdTask = created[i];
      const sourceFinding = actionable[i];
      await this.deps.workspaceRepo.insertTaskLog({
        taskRunId: params.taskRunId,
        sequence: this.sequenceForTask(params.taskRunId),
        timestamp: new Date().toISOString(),
        source: "followup_task",
        message: `Created follow-up task ${createdTask.key}`,
        details: { targetTaskId: createdTask.id, sourceFinding },
      });
    }

    return created;
  }

  async reviewTasks(request: CodeReviewRequest): Promise<CodeReviewResult> {
    await this.ensureMcoda();
    const agentStream = request.agentStream !== false;
    const baseRef = request.baseRef ?? this.workspace.config?.branch ?? DEFAULT_BASE_BRANCH;
    const statusFilter = request.statusFilter && request.statusFilter.length ? request.statusFilter : ["ready_to_review"];
    let state: ReviewJobState | undefined;

    const commandRun = await this.deps.jobService.startCommandRun("code-review", request.projectKey, {
      taskIds: request.taskKeys,
      gitBaseBranch: baseRef,
      jobId: request.resumeJobId,
    });

    let jobId = request.resumeJobId;
    let selectedTaskIds: string[] = [];
    let warnings: string[] = [];
    let selectedTasks: Array<TaskRow & { epicKey: string; storyKey: string; epicTitle?: string; epicDescription?: string; storyTitle?: string; storyDescription?: string; acceptanceCriteria?: string[] }> =
      [];

    if (request.resumeJobId) {
      const job = await this.deps.jobService.getJob(request.resumeJobId);
      if (!job) throw new Error(`Job not found: ${request.resumeJobId}`);
      if ((job.commandName ?? job.type) !== "code-review" && job.type !== "review") {
        throw new Error(`Job ${request.resumeJobId} is not a code-review job`);
      }
      state = await this.loadState(request.resumeJobId);
      selectedTaskIds = state?.selectedTaskIds ?? (Array.isArray((job.payload as any)?.selection) ? ((job.payload as any).selection as string[]) : []);
      if (!selectedTaskIds.length) {
        throw new Error("Resume requested but no task selection found in job payload");
      }
      await this.deps.jobService.updateJobStatus(job.id, "running", {
        totalItems: job.totalItems ?? selectedTaskIds.length,
        processedItems: state?.reviewed.length ?? 0,
      });
      selectedTasks = await this.deps.workspaceRepo.getTasksWithRelations(selectedTaskIds);
    } else {
      try {
        selectedTasks = await this.selectTasksViaApi({
          projectKey: request.projectKey,
          epicKey: request.epicKey,
          storyKey: request.storyKey,
          taskKeys: request.taskKeys,
          statusFilter,
          limit: request.limit,
        });
      } catch {
        const selection = await this.selectionService.selectTasks({
          projectKey: request.projectKey,
          epicKey: request.epicKey,
          storyKey: request.storyKey,
          taskKeys: request.taskKeys,
          statusFilter,
          limit: request.limit,
        });
        warnings = [...selection.warnings];
        selectedTasks = selection.ordered.map((t) => t.task);
      }

      selectedTaskIds = selectedTasks.map((t) => t.id);
      const job = await this.deps.jobService.startJob("review", commandRun.id, request.projectKey, {
        commandName: "code-review",
        payload: {
          projectKey: request.projectKey,
          epicKey: request.epicKey,
          storyKey: request.storyKey,
          tasks: request.taskKeys,
          statusFilter,
          baseRef,
          selection: selectedTaskIds,
          dryRun: request.dryRun ?? false,
          agent: request.agentName,
          agentStream,
        },
        totalItems: selectedTaskIds.length,
        processedItems: 0,
      });
      jobId = job.id;
      state = {
        baseRef,
        statusFilter,
        selectedTaskIds,
        contextBuilt: [],
        reviewed: [],
      };
      await this.persistState(jobId, state);
      await this.writeCheckpoint(jobId, "tasks_selected", { tasks: selectedTaskIds, baseRef, statusFilter });
    }

    if (!jobId) {
      throw new Error("Failed to resolve job id for code-review");
    }

    if (!state) {
      state = {
        baseRef,
        statusFilter,
        selectedTaskIds,
        contextBuilt: [],
        reviewed: [],
      };
      await this.persistState(jobId, state);
    }

    if (selectedTaskIds.length === 0) {
      await this.deps.jobService.updateJobStatus(jobId, "completed", { totalItems: 0, processedItems: 0 });
      await this.deps.jobService.finishCommandRun(commandRun.id, "succeeded");
      return { jobId, commandRunId: commandRun.id, tasks: [], warnings };
    }

    const tasks =
      selectedTasks.length && selectedTaskIds.length === selectedTasks.length
        ? selectedTasks
        : await this.deps.workspaceRepo.getTasksWithRelations(selectedTaskIds);
    const agent = await this.resolveAgent(request.agentName);
    const prompts = await this.loadPrompts(agent.id);
    const extras = await this.loadRunbookAndChecklists();
    const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot);
    if (projectGuidance) {
      console.info(`[code-review] loaded project guidance from ${projectGuidance.source}`);
    }
    const guidanceBlock = projectGuidance?.content ? `Project Guidance (read first):\n${projectGuidance.content}` : undefined;
    const systemPrompts = [guidanceBlock, prompts.jobPrompt, prompts.characterPrompt, prompts.commandPrompt, ...extras].filter(Boolean) as string[];

    const results: TaskReviewResult[] = [];
    const maybeRateTask = async (task: TaskRow, taskRunId: string, tokensTotal: number): Promise<void> => {
      if (!request.rateAgents || tokensTotal <= 0) return;
      try {
        const ratingService = this.ensureRatingService();
        await ratingService.rate({
          workspace: this.workspace,
          agentId: agent.id,
          commandName: "code-review",
          jobId,
          commandRunId: commandRun.id,
          taskId: task.id,
          taskKey: task.key,
          discipline: task.type ?? undefined,
          complexity: this.resolveTaskComplexity(task),
        });
      } catch (error) {
        const message = `Agent rating failed for ${task.key}: ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        try {
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId,
            sequence: this.sequenceForTask(taskRunId),
            timestamp: new Date().toISOString(),
            source: "rating",
            message,
          });
        } catch {
          /* ignore rating log failures */
        }
      }
    };

    for (const task of tasks) {
      const statusBefore = task.status;
      const taskRun = await this.deps.workspaceRepo.createTaskRun({
        taskId: task.id,
        command: "code-review",
        jobId,
        commandRunId: commandRun.id,
        agentId: agent.id,
        status: "running",
        startedAt: new Date().toISOString(),
        storyPointsAtRun: task.storyPoints ?? null,
        gitBranch: task.vcsBranch ?? null,
        gitBaseBranch: task.vcsBaseBranch ?? null,
        gitCommitSha: task.vcsLastCommitSha ?? null,
      });

      const findings: ReviewFinding[] = [];
      let decision: ReviewAgentResult["decision"] | undefined;
      let statusAfter: string | undefined;
      const followupCreated: { taskId: string; taskKey: string; epicId: string; userStoryId: string; generic?: boolean }[] = [];

      // Debug visibility: show prompts/task details for this run
      const systemPrompt = systemPrompts.join("\n\n");
      let tokensTotal = 0;

      try {
        const metadata = (task.metadata as any) ?? {};
        const allowedFiles: string[] = Array.isArray(metadata.files) ? metadata.files : [];
        const diffResult = await this.buildDiff(task, state?.baseRef ?? baseRef, allowedFiles);
        const diff = diffResult.diff;
        if (diffResult.warning) warnings.push(diffResult.warning);
        await this.persistDiff(jobId, task.id, diff);
        await this.deps.workspaceRepo.insertTaskLog({
          taskRunId: taskRun.id,
          sequence: this.sequenceForTask(taskRun.id),
          timestamp: new Date().toISOString(),
          source: "context_git_diff",
          message: "Git diff computed",
          details: {
            baseRef: state?.baseRef ?? baseRef,
            branch: task.vcsBranch,
            commitSha: diffResult.commitSha,
            diffSource: diffResult.source,
            allowedFiles,
          },
        });

        const historySummary = await this.buildHistorySummary(task.id);
        await this.deps.workspaceRepo.insertTaskLog({
          taskRunId: taskRun.id,
          sequence: this.sequenceForTask(taskRun.id),
          timestamp: new Date().toISOString(),
          source: "context_history",
          message: "Loaded task history",
        });

        const changedPaths = this.extractPathsFromDiff(diff);
        const docLinks = await this.gatherDocContext(task.title, changedPaths.length ? changedPaths : allowedFiles, task.acceptanceCriteria);
        if (docLinks.warnings.length) warnings.push(...docLinks.warnings);
        await this.deps.workspaceRepo.insertTaskLog({
          taskRunId: taskRun.id,
          sequence: this.sequenceForTask(taskRun.id),
          timestamp: new Date().toISOString(),
          source: "context_docdex",
          message: "Docdex context gathered",
          details: { snippets: docLinks.snippets },
        });

        const openapiSnippet = await this.buildOpenApiSlice(changedPaths, task.acceptanceCriteria);
        if (!openapiSnippet) {
          warnings.push("OpenAPI spec not found; proceeding without snippet");
        }
        await this.deps.workspaceRepo.insertTaskLog({
          taskRunId: taskRun.id,
          sequence: this.sequenceForTask(taskRun.id),
          timestamp: new Date().toISOString(),
          source: "context_openapi",
          message: "OpenAPI snippet loaded",
        });

        const prompt = this.buildReviewPrompt({
          systemPrompts,
          task,
          diff,
          docContext: docLinks.snippets,
          openapiSnippet,
          historySummary,
          baseRef: state?.baseRef ?? baseRef,
          branch: task.vcsBranch ?? undefined,
        });

        const separator = "============================================================";
        const deps =
          Array.isArray((task as any).dependencyKeys) && (task as any).dependencyKeys.length
            ? (task as any).dependencyKeys
            : Array.isArray((task.metadata as any)?.depends_on)
              ? ((task.metadata as any).depends_on as string[])
              : [];
        console.info(separator);
        console.info("[code-review] START OF TASK");
        console.info(`[code-review] Task key: ${task.key}`);
        console.info(`[code-review] Title: ${task.title ?? "(none)"}`);
        console.info(`[code-review] Description: ${task.description ?? "(none)"}`);
        console.info(
          `[code-review] Story points: ${typeof task.storyPoints === "number" ? task.storyPoints : "(none)"}`,
        );
        console.info(`[code-review] Dependencies: ${deps.length ? deps.join(", ") : "(none available)"}`);
        if (Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length) {
          console.info(`[code-review] Acceptance criteria:\n- ${task.acceptanceCriteria.join("\n- ")}`);
        }
        console.info(`[code-review] System prompt used:\n${systemPrompt || "(none)"}`);
        console.info(`[code-review] Task prompt used:\n${prompt}`);
        console.info(separator);

        await this.persistContext(jobId, task.id, {
          historySummary,
          docdex: docLinks.snippets,
          openapiSnippet,
          changedPaths,
        });
        state?.contextBuilt.push(task.id);
        await this.persistState(jobId, state!);
        await this.writeCheckpoint(jobId, "context_built", { contextBuilt: state?.contextBuilt ?? [], schema_version: 1 });

        const recordUsage = async (
          phase: string,
          promptText: string,
          outputText: string,
          durationSeconds: number,
          tokenMeta?: { tokensPrompt?: number; tokensCompletion?: number; tokensTotal?: number; model?: string | null },
        ) => {
          const tokensPrompt = tokenMeta?.tokensPrompt ?? estimateTokens(promptText);
          const tokensCompletion = tokenMeta?.tokensCompletion ?? estimateTokens(outputText);
          const entryTotal = tokenMeta?.tokensTotal ?? tokensPrompt + tokensCompletion;
          tokensTotal += entryTotal;
          await this.deps.jobService.recordTokenUsage({
            workspaceId: this.workspace.workspaceId,
            agentId: agent.id,
            modelName: tokenMeta?.model ?? (agent as any).defaultModel ?? undefined,
            jobId,
            commandRunId: commandRun.id,
            taskRunId: taskRun.id,
            taskId: task.id,
            projectId: task.projectId,
            tokensPrompt,
            tokensCompletion,
            tokensTotal: entryTotal,
            durationSeconds,
            timestamp: new Date().toISOString(),
            metadata: { commandName: "code-review", phase, action: phase },
          });
        };

        let agentOutput = "";
        let durationSeconds = 0;
        const started = Date.now();
        let lastStreamMeta: any;
        if (agentStream && this.deps.agentService.invokeStream) {
          const stream = await this.deps.agentService.invokeStream(agent.id, { input: prompt, metadata: { taskKey: task.key } });
          for await (const chunk of stream) {
            agentOutput += chunk.output ?? "";
            lastStreamMeta = chunk.metadata ?? lastStreamMeta;
            await this.deps.workspaceRepo.insertTaskLog({
              taskRunId: taskRun.id,
              sequence: this.sequenceForTask(taskRun.id),
              timestamp: new Date().toISOString(),
              source: "agent",
              message: chunk.output ?? "",
            });
          }
          durationSeconds = Math.round(((Date.now() - started) / 1000) * 1000) / 1000;
        } else {
          const response = await this.deps.agentService.invoke(agent.id, { input: prompt, metadata: { taskKey: task.key } });
          agentOutput = response.output ?? "";
          durationSeconds = Math.round(((Date.now() - started) / 1000) * 1000) / 1000;
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "agent",
            message: agentOutput,
          });
          lastStreamMeta = response.metadata;
        }
        const tokenMetaMain = lastStreamMeta
          ? {
              tokensPrompt: typeof lastStreamMeta.tokensPrompt === "number" ? lastStreamMeta.tokensPrompt : (lastStreamMeta.tokens_prompt as number | undefined),
              tokensCompletion:
                typeof lastStreamMeta.tokensCompletion === "number"
                  ? lastStreamMeta.tokensCompletion
                  : (lastStreamMeta.tokens_completion as number | undefined),
              tokensTotal: typeof lastStreamMeta.tokensTotal === "number" ? lastStreamMeta.tokensTotal : (lastStreamMeta.tokens_total as number | undefined),
              model: (lastStreamMeta.model ?? lastStreamMeta.model_name ?? null) as string | null,
            }
          : undefined;
        await recordUsage("review_main", prompt, agentOutput, durationSeconds, tokenMetaMain);

        let parsed = parseJsonOutput(agentOutput);
        if (!parsed) {
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "agent",
            message: "Invalid JSON from agent; retrying once with stricter instructions.",
          });
          const retryPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching the schema above. Do not include prose or fences.`;
          const retryStarted = Date.now();
          const retryResp = await this.deps.agentService.invoke(agent.id, { input: retryPrompt, metadata: { taskKey: task.key, retry: true } });
          const retryOutput = retryResp.output ?? "";
          const retryDuration = Math.round(((Date.now() - retryStarted) / 1000) * 1000) / 1000;
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "agent_retry",
            message: retryOutput,
          });
          const retryTokenMeta = retryResp.metadata
            ? {
                tokensPrompt:
                  typeof retryResp.metadata.tokensPrompt === "number"
                    ? retryResp.metadata.tokensPrompt
                    : (retryResp.metadata.tokens_prompt as number | undefined),
                tokensCompletion:
                  typeof retryResp.metadata.tokensCompletion === "number"
                    ? retryResp.metadata.tokensCompletion
                    : (retryResp.metadata.tokens_completion as number | undefined),
                tokensTotal:
                  typeof retryResp.metadata.tokensTotal === "number"
                    ? retryResp.metadata.tokensTotal
                    : (retryResp.metadata.tokens_total as number | undefined),
                model: (retryResp.metadata.model ?? retryResp.metadata.model_name ?? null) as string | null,
              }
            : undefined;
          await recordUsage("review_retry", retryPrompt, retryOutput, retryDuration, retryTokenMeta);
          parsed = parseJsonOutput(retryOutput);
          agentOutput = retryOutput;
        }
        if (!parsed) {
          throw new Error("Agent output did not contain valid JSON review result after retry");
        }
        parsed.raw = agentOutput;
        decision = parsed.decision;
        findings.push(...(parsed.findings ?? []));

        const followups = await this.createFollowupTasksForFindings({
          task,
          findings: parsed.findings ?? [],
          decision: parsed.decision,
          jobId,
          commandRunId: commandRun.id,
          taskRunId: taskRun.id,
        });
        if (followups.length) {
          followupCreated.push(
            ...followups.map((t) => ({
              taskId: t.id,
              taskKey: t.key,
              epicId: t.epicId,
              userStoryId: t.userStoryId,
              generic: (t as any)?.metadata?.generic ? true : undefined,
            })),
          );
          warnings.push(`Created follow-up tasks for ${task.key}: ${followups.map((t) => t.key).join(", ")}`);
        }

        let taskStatusUpdate = statusBefore;
        if (!request.dryRun) {
          if (parsed.decision === "approve") {
            await this.stateService.markReadyToQa(task);
            taskStatusUpdate = "ready_to_qa";
          } else if (parsed.decision === "changes_requested") {
            await this.stateService.returnToInProgress(task);
            taskStatusUpdate = "in_progress";
          } else if (parsed.decision === "block") {
            await this.stateService.markBlocked(task, "review_blocked");
            taskStatusUpdate = "blocked";
          }
        } else {
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "state",
            message: "Dry-run enabled; skipping status transition.",
            details: { requestedDecision: parsed.decision },
          });
        }
        statusAfter = taskStatusUpdate;

        for (const finding of parsed.findings ?? []) {
          await this.deps.workspaceRepo.createTaskComment({
            taskId: task.id,
            taskRunId: taskRun.id,
            jobId,
            sourceCommand: "code-review",
            authorType: "agent",
            authorAgentId: agent.id,
            category: finding.type ?? "other",
            file: finding.file,
            line: finding.line,
            pathHint: finding.file,
            body: finding.message + (finding.suggestedFix ? `\n\nSuggested fix: ${finding.suggestedFix}` : ""),
            metadata: {
              severity: finding.severity,
              suggestedFix: finding.suggestedFix,
            },
            createdAt: new Date().toISOString(),
          });
        }

        await this.writeReviewSummaryComment({
          task,
          taskRunId: taskRun.id,
          jobId,
          agentId: agent.id,
          statusBefore,
          statusAfter: statusAfter ?? statusBefore,
          decision: parsed.decision,
          summary: parsed.summary,
          findingsCount: parsed.findings?.length ?? 0,
          followupTaskKeys: followupCreated.map((t) => t.taskKey),
        });

        await this.deps.workspaceRepo.createTaskReview({
          taskId: task.id,
          jobId,
          agentId: agent.id,
          modelName: (agent as any).defaultModel ?? undefined,
          decision: parsed.decision,
          summary: parsed.summary ?? undefined,
          findingsJson: parsed.findings ?? [],
          testRecommendationsJson: parsed.testRecommendations ?? [],
          createdAt: new Date().toISOString(),
        });
        await this.stateService.recordReviewMetadata(task, {
          decision: parsed.decision,
          agentId: agent.id,
          modelName: (agent as any).defaultModel ?? null,
          jobId,
        });

        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          runContext: { decision: parsed.decision },
        });

        state?.reviewed.push({ taskId: task.id, decision: parsed.decision });
        await this.persistState(jobId, state!);
        await this.writeCheckpoint(jobId, "review_applied", { reviewed: state?.reviewed ?? [], schema_version: 1 });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({ taskId: task.id, taskKey: task.key, statusBefore, findings, error: message, followupTasks: followupCreated });
        await this.deps.workspaceRepo.insertTaskLog({
          taskRunId: taskRun.id,
          sequence: this.sequenceForTask(taskRun.id),
          timestamp: new Date().toISOString(),
          source: "review_error",
          message,
        });
        try {
          await this.writeReviewSummaryComment({
            task,
            taskRunId: taskRun.id,
            jobId,
            agentId: agent.id,
            statusBefore,
            statusAfter: statusBefore,
            findingsCount: findings.length,
            error: message,
          });
        } catch {
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_error",
            message: "Failed to write review summary comment.",
          });
        }
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
        state?.reviewed.push({ taskId: task.id, error: message });
        await this.persistState(jobId, state!);
        await this.writeCheckpoint(jobId, "review_applied", { reviewed: state?.reviewed ?? [], schema_version: 1 });
        await this.deps.jobService.updateJobStatus(jobId, "running", {
          processedItems: state?.reviewed.length ?? 0,
        });
        await maybeRateTask(task, taskRun.id, tokensTotal);
        continue;
      }

      results.push({
        taskId: task.id,
        taskKey: task.key,
        statusBefore,
        statusAfter,
        decision,
        findings,
        followupTasks: followupCreated,
      });

      await this.deps.jobService.updateJobStatus(jobId, "running", {
        processedItems: state?.reviewed.length ?? 0,
      });
      await maybeRateTask(task, taskRun.id, tokensTotal);
    }

    await this.deps.jobService.updateJobStatus(jobId, "completed", {
      processedItems: state?.reviewed.length ?? selectedTaskIds.length,
      totalItems: selectedTaskIds.length,
    });
    await this.deps.jobService.finishCommandRun(commandRun.id, "succeeded");

    return {
      jobId,
      commandRunId: commandRun.id,
      tasks: results,
      warnings,
    };
  }

  private sequenceForTask(taskRunId: string): number {
    const current = this.taskLogSeq.get(taskRunId) ?? 0;
    const next = current + 1;
    this.taskLogSeq.set(taskRunId, next);
    return next;
  }
}
