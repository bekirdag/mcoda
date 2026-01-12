import path from "node:path";
import fs from "node:fs/promises";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, VcsClient } from "@mcoda/integrations";
import {
  GlobalRepository,
  WorkspaceRepository,
  type EpicRow,
  type StoryRow,
  type TaskCommentRow,
  type TaskInsert,
  type TaskRow,
} from "@mcoda/db";
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
import { createTaskCommentSlug, formatTaskCommentBody } from "../tasks/TaskCommentFormatter.js";

const DEFAULT_BASE_BRANCH = "mcoda-dev";
const REVIEW_DIR = (workspaceRoot: string, jobId: string) => path.join(workspaceRoot, ".mcoda", "jobs", jobId, "review");
const STATE_PATH = (workspaceRoot: string, jobId: string) => path.join(REVIEW_DIR(workspaceRoot, jobId), "state.json");
const REVIEW_PROMPT_LIMITS = {
  diff: 12000,
  history: 3000,
  docContext: 4000,
  openapi: 8000,
  checklist: 3000,
};
const DOCDEX_TIMEOUT_MS = 8000;
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
  abortSignal?: AbortSignal;
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
  resolvedSlugs?: string[];
  unresolvedSlugs?: string[];
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

const extractJsonSlice = (candidate: string): string | undefined => {
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
};

const sanitizeJsonCandidate = (value: string): string => {
  const cleanedLines = value
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (
        trimmed.startsWith("{") ||
        trimmed.startsWith("}") ||
        trimmed.startsWith("[") ||
        trimmed.startsWith("]") ||
        trimmed.startsWith("\"")
      ) {
        return true;
      }
      return false;
    })
    .join("\n");
  return cleanedLines.replace(/,\s*([}\]])/g, "$1");
};

const parseJsonOutput = (raw: string): ReviewAgentResult | undefined => {
  const trimmed = raw.trim();
  const fenced = trimmed.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const candidates = [trimmed, fenced];
  for (const candidate of candidates) {
    const slice = extractJsonSlice(candidate);
    if (!slice) continue;
    try {
      const parsed = JSON.parse(slice) as ReviewAgentResult;
      return { ...parsed, raw: raw };
    } catch {
      const sanitized = sanitizeJsonCandidate(slice);
      try {
        const parsed = JSON.parse(sanitized) as ReviewAgentResult;
        return { ...parsed, raw: raw };
      } catch {
        /* ignore */
      }
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

const truncateSection = (label: string, text: string, limit: number): string => {
  if (!text) return text;
  if (text.length <= limit) return text;
  const trimmed = text.slice(0, limit);
  const remaining = text.length - limit;
  return `${trimmed}\n...[truncated ${remaining} chars from ${label}]`;
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
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
  "testRecommendations": ["Optional test or QA recommendations per task"],
  "resolvedSlugs": ["Optional list of comment slugs that are confirmed fixed"],
  "unresolvedSlugs": ["Optional list of comment slugs still open or reintroduced"]
}`;

const normalizeSingleLine = (value: string | undefined, fallback: string): string => {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  return trimmed || fallback;
};

const normalizeSlugList = (input?: string[] | null): string[] => {
  if (!Array.isArray(input)) return [];
  const cleaned = new Set<string>();
  for (const slug of input) {
    if (typeof slug !== "string") continue;
    const trimmed = slug.trim();
    if (trimmed) cleaned.add(trimmed);
  }
  return Array.from(cleaned);
};

const normalizePath = (value: string): string =>
  value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

const parseCommentBody = (body: string): { message: string; suggestedFix?: string } => {
  const trimmed = (body ?? "").trim();
  if (!trimmed) return { message: "(no details provided)" };
  const lines = trimmed.split(/\r?\n/);
  const normalize = (value: string) => value.trim().toLowerCase();
  const messageIndex = lines.findIndex((line) => normalize(line) === "message:");
  const suggestedIndex = lines.findIndex((line) => {
    const normalized = normalize(line);
    return normalized === "suggested_fix:" || normalized === "suggested fix:";
  });
  if (messageIndex >= 0) {
    const messageLines = lines.slice(messageIndex + 1, suggestedIndex >= 0 ? suggestedIndex : undefined);
    const message = messageLines.join("\n").trim();
    const suggestedLines = suggestedIndex >= 0 ? lines.slice(suggestedIndex + 1) : [];
    const suggestedFix = suggestedLines.join("\n").trim();
    return { message: message || trimmed, suggestedFix: suggestedFix || undefined };
  }
  if (suggestedIndex >= 0) {
    const message = lines.slice(0, suggestedIndex).join("\n").trim() || trimmed;
    const inlineFix = lines[suggestedIndex]?.split(/suggested fix:/i)[1]?.trim();
    const suggestedTail = lines.slice(suggestedIndex + 1).join("\n").trim();
    const suggestedFix = inlineFix || suggestedTail || undefined;
    return { message, suggestedFix };
  }
  return { message: trimmed };
};

const buildCommentBacklog = (comments: TaskCommentRow[]): string => {
  if (!comments.length) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  const toSingleLine = (value: string) => value.replace(/\s+/g, " ").trim();
  for (const comment of comments) {
    const slug = comment.slug?.trim() || undefined;
    const details = parseCommentBody(comment.body);
    const key =
      slug ??
      `${comment.sourceCommand}:${comment.file ?? ""}:${comment.line ?? ""}:${details.message || comment.body}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const location = comment.file
      ? `${comment.file}${typeof comment.line === "number" ? `:${comment.line}` : ""}`
      : "(location not specified)";
    const message = toSingleLine(details.message || comment.body || "(no details provided)");
    lines.push(`- [${slug ?? "untracked"}] ${location} ${message}`);
    const suggestedFix =
      (comment.metadata?.suggestedFix as string | undefined) ?? details.suggestedFix ?? undefined;
    if (suggestedFix) {
      lines.push(`  Suggested fix: ${toSingleLine(suggestedFix)}`);
    }
  }
  return lines.join("\n");
};

const formatSlugList = (slugs: string[], limit = 12): string => {
  if (!slugs.length) return "none";
  if (slugs.length <= limit) return slugs.join(", ");
  return `${slugs.slice(0, limit).join(", ")} (+${slugs.length - limit} more)`;
};

const buildStandardReviewComment = (params: {
  decision?: string;
  statusBefore: string;
  statusAfter?: string;
  findingsCount: number;
  summary?: string;
  followupTaskKeys?: string[];
  error?: string;
  resolvedCount?: number;
  reopenedCount?: number;
  openCount?: number;
}): string => {
  const decision = params.decision ?? (params.error ? "error" : "info_only");
  const statusAfter = params.statusAfter ?? params.statusBefore;
  const summary = normalizeSingleLine(params.summary, params.error ? "Review failed." : "No summary provided.");
  const error = normalizeSingleLine(params.error, "none");
  const followups = params.followupTaskKeys && params.followupTaskKeys.length ? params.followupTaskKeys.join(", ") : "none";
  const lines = [
    "[code-review]",
    `decision: ${decision}`,
    `status_before: ${params.statusBefore}`,
    `status_after: ${statusAfter}`,
    `findings: ${params.findingsCount}`,
    `summary: ${summary}`,
  ];
  if (typeof params.resolvedCount === "number") {
    lines.push(`resolved_slugs: ${params.resolvedCount}`);
  }
  if (typeof params.reopenedCount === "number") {
    lines.push(`reopened_slugs: ${params.reopenedCount}`);
  }
  if (typeof params.openCount === "number") {
    lines.push(`open_slugs: ${params.openCount}`);
  }
  lines.push(
    `followups: ${followups}`,
    `error: ${error}`,
  );
  return lines.join("\n");
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
    let reindexed = false;
    for (const query of queries) {
      try {
        const docs = await withTimeout(
          this.deps.docdex.search({
            query,
            profile: "workspace-code",
          }),
          DOCDEX_TIMEOUT_MS,
          `docdex search for "${query}"`,
        );
        snippets.push(
          ...docs.slice(0, 2).map((doc) => {
            const content = (doc.segments?.[0]?.content ?? doc.content ?? "").slice(0, 400);
            const ref = doc.path ?? doc.id ?? doc.title ?? query;
            return `- [${doc.docType ?? "doc"}] ${ref}: ${content}`;
          }),
        );
      } catch (error) {
        if (!reindexed && typeof (this.deps.docdex as any).reindex === "function") {
          reindexed = true;
          try {
            await (this.deps.docdex as any).reindex();
            const docs = await withTimeout(
              this.deps.docdex.search({
                query,
                profile: "workspace-code",
              }),
              DOCDEX_TIMEOUT_MS,
              `docdex search for "${query}" after reindex`,
            );
            snippets.push(
              ...docs.slice(0, 2).map((doc) => {
                const content = (doc.segments?.[0]?.content ?? doc.content ?? "").slice(0, 400);
                const ref = doc.path ?? doc.id ?? doc.title ?? query;
                return `- [${doc.docType ?? "doc"}] ${ref}: ${content}`;
              }),
            );
            continue;
          } catch (retryError) {
            warnings.push(`docdex search failed after reindex for ${query}: ${(retryError as Error).message}`);
            continue;
          }
        }
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
    commentBacklog: string;
    baseRef: string;
    branch?: string;
  }): string {
    const parts: string[] = [];
    if (params.systemPrompts.length) {
      parts.push(params.systemPrompts.join("\n\n"));
    }
    const acceptance = params.task.acceptanceCriteria && params.task.acceptanceCriteria.length ? params.task.acceptanceCriteria.join(" | ") : "none provided";
    const historySummary = truncateSection("history", params.historySummary, REVIEW_PROMPT_LIMITS.history);
    const commentBacklog = params.commentBacklog
      ? truncateSection("comment backlog", params.commentBacklog, REVIEW_PROMPT_LIMITS.history)
      : "";
    const docContextText = params.docContext.length ? truncateSection("doc context", params.docContext.join("\n"), REVIEW_PROMPT_LIMITS.docContext) : "";
    const openapiSnippet = params.openapiSnippet ? truncateSection("openapi", params.openapiSnippet, REVIEW_PROMPT_LIMITS.openapi) : undefined;
    const checklistsText = params.checklists?.length
      ? truncateSection("checklists", params.checklists.join("\n\n"), REVIEW_PROMPT_LIMITS.checklist)
      : "";
    const diffText = truncateSection("diff", params.diff || "(no diff)", REVIEW_PROMPT_LIMITS.diff);
    parts.push(
      [
        `Task ${params.task.key}: ${params.task.title}`,
        `Epic: ${params.task.epicKey ?? ""} ${params.task.epicTitle ?? ""}`.trim(),
        `Epic description: ${params.task.epicDescription ? params.task.epicDescription : "none"}`,
        `Story: ${params.task.storyKey ?? ""} ${params.task.storyTitle ?? ""}`.trim(),
        `Story description: ${params.task.storyDescription ? params.task.storyDescription : "none"}`,
        `Status: ${params.task.status}, Branch: ${params.branch ?? params.task.vcsBranch ?? "n/a"} (base ${params.baseRef})`,
        `Task description: ${params.task.description ? params.task.description : "none"}`,
        `History:\n${historySummary}`,
        commentBacklog ? `Comment backlog (unresolved slugs):\n${commentBacklog}` : "Comment backlog: none",
        `Acceptance criteria: ${acceptance}`,
        docContextText ? `Doc context (docdex excerpts):\n${docContextText}` : "Doc context: none",
        openapiSnippet
          ? `OpenAPI (authoritative contract; do not invent endpoints outside this):\n${openapiSnippet}`
          : "OpenAPI: not provided; avoid inventing endpoints.",
        checklistsText ? `Review checklists/runbook:\n${checklistsText}` : "Checklists: none",
        "Diff:\n" + diffText,
        "Respond with STRICT JSON only, matching:\n" + JSON_CONTRACT,
        "Rules: honor OpenAPI contracts; cite doc context where relevant; include resolvedSlugs/unresolvedSlugs for comment backlog items; do not add prose outside JSON.",
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

  private async loadCommentContext(taskId: string): Promise<{ comments: TaskCommentRow[]; unresolved: TaskCommentRow[] }> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["code-review", "qa-tasks"],
      limit: 50,
    });
    const unresolved = comments.filter((comment) => !comment.resolvedAt);
    return { comments, unresolved };
  }

  private commentSlugKey(file?: string | null, line?: number | null, category?: string | null): string | undefined {
    if (!file) return undefined;
    const normalizedFile = normalizePath(file);
    const linePart = typeof line === "number" ? String(line) : "";
    const categoryPart = category?.toLowerCase() ?? "";
    return `${normalizedFile}|${linePart}|${categoryPart}`;
  }

  private buildCommentSlugIndex(comments: TaskCommentRow[]): Map<string, string> {
    const index = new Map<string, string>();
    for (const comment of comments) {
      if (!comment.slug) continue;
      const key = this.commentSlugKey(comment.file, comment.line, comment.category);
      if (!key) continue;
      if (!index.has(key)) index.set(key, comment.slug);
    }
    return index;
  }

  private resolveFindingSlug(finding: ReviewFinding, slugIndex: Map<string, string>): string {
    const key = this.commentSlugKey(finding.file, finding.line, finding.type ?? null);
    const existing = key ? slugIndex.get(key) : undefined;
    if (existing) return existing;
    const message = (finding.message ?? "").trim() || "Review finding.";
    return createTaskCommentSlug({
      source: "code-review",
      message,
      file: finding.file,
      line: finding.line,
      category: finding.type ?? null,
    });
  }

  private async applyCommentResolutions(params: {
    task: TaskRow;
    taskRunId: string;
    jobId: string;
    agentId: string;
    findings: ReviewFinding[];
    resolvedSlugs?: string[] | null;
    unresolvedSlugs?: string[] | null;
    decision?: ReviewAgentResult["decision"];
    existingComments: TaskCommentRow[];
  }): Promise<{ resolved: string[]; reopened: string[]; open: string[] }> {
    const existingBySlug = new Map<string, TaskCommentRow>();
    const openBySlug = new Set<string>();
    const resolvedBySlug = new Set<string>();
    for (const comment of params.existingComments) {
      if (!comment.slug) continue;
      if (!existingBySlug.has(comment.slug)) {
        existingBySlug.set(comment.slug, comment);
      }
      if (comment.resolvedAt) {
        resolvedBySlug.add(comment.slug);
      } else {
        openBySlug.add(comment.slug);
      }
    }

    const reviewSlugIndex = this.buildCommentSlugIndex(
      params.existingComments.filter((comment) => comment.sourceCommand === "code-review"),
    );
    const resolvedSlugs = normalizeSlugList(params.resolvedSlugs ?? undefined);
    const resolvedSet = new Set(resolvedSlugs);
    const unresolvedSet = new Set(normalizeSlugList(params.unresolvedSlugs ?? undefined));

    const findingSlugs: string[] = [];
    for (const finding of params.findings ?? []) {
      const slug = this.resolveFindingSlug(finding, reviewSlugIndex);
      findingSlugs.push(slug);
      const severity = (finding.severity ?? "").toLowerCase();
      const autoResolve =
        (params.decision === "approve" || params.decision === "info_only") &&
        ["info", "low"].includes(severity);
      if (!resolvedSet.has(slug) && !autoResolve) {
        unresolvedSet.add(slug);
      }
    }
    for (const slug of resolvedSet) {
      unresolvedSet.delete(slug);
    }

    const toResolve = resolvedSlugs.filter((slug) => openBySlug.has(slug));
    const toReopen = Array.from(unresolvedSet).filter((slug) => resolvedBySlug.has(slug));

    for (const slug of toResolve) {
      await this.deps.workspaceRepo.resolveTaskComment({
        taskId: params.task.id,
        slug,
        resolvedAt: new Date().toISOString(),
        resolvedBy: params.agentId,
      });
    }
    for (const slug of toReopen) {
      await this.deps.workspaceRepo.reopenTaskComment({ taskId: params.task.id, slug });
    }

    const createdSlugs = new Set<string>();
    for (const finding of params.findings ?? []) {
      const slug = this.resolveFindingSlug(finding, reviewSlugIndex);
      if (existingBySlug.has(slug) || createdSlugs.has(slug)) continue;
      const severity = (finding.severity ?? "").toLowerCase();
      const autoResolve =
        (params.decision === "approve" || params.decision === "info_only") &&
        ["info", "low"].includes(severity);
      const message = (finding.message ?? "").trim() || "(no details provided)";
      const body = formatTaskCommentBody({
        slug,
        source: "code-review",
        message,
        status: autoResolve ? "resolved" : "open",
        category: finding.type ?? "other",
        file: finding.file ?? null,
        line: finding.line ?? null,
        suggestedFix: finding.suggestedFix ?? null,
      });
      const resolvedAt = autoResolve ? new Date().toISOString() : undefined;
      await this.deps.workspaceRepo.createTaskComment({
        taskId: params.task.id,
        taskRunId: params.taskRunId,
        jobId: params.jobId,
        sourceCommand: "code-review",
        authorType: "agent",
        authorAgentId: params.agentId,
        category: finding.type ?? "other",
        slug,
        status: autoResolve ? "resolved" : "open",
        file: finding.file ?? null,
        line: finding.line ?? null,
        pathHint: finding.file ?? null,
        body,
        resolvedAt,
        resolvedBy: autoResolve ? params.agentId : undefined,
        metadata: {
          severity: finding.severity,
          suggestedFix: finding.suggestedFix,
        },
        createdAt: new Date().toISOString(),
      });
      createdSlugs.add(slug);
    }

    const openSet = new Set(openBySlug);
    for (const slug of unresolvedSet) {
      openSet.add(slug);
    }
    for (const slug of resolvedSet) {
      openSet.delete(slug);
    }

    if (resolvedSlugs.length || toReopen.length || unresolvedSet.size) {
      const resolutionMessage = [
        `Resolved slugs: ${formatSlugList(toResolve)}`,
        `Reopened slugs: ${formatSlugList(toReopen)}`,
        `Open slugs: ${formatSlugList(Array.from(openSet))}`,
      ].join("\n");
      const resolutionSlug = createTaskCommentSlug({
        source: "code-review",
        message: resolutionMessage,
        category: "comment_resolution",
      });
      const resolutionBody = formatTaskCommentBody({
        slug: resolutionSlug,
        source: "code-review",
        message: resolutionMessage,
        status: "resolved",
        category: "comment_resolution",
      });
      const createdAt = new Date().toISOString();
      await this.deps.workspaceRepo.createTaskComment({
        taskId: params.task.id,
        taskRunId: params.taskRunId,
        jobId: params.jobId,
        sourceCommand: "code-review",
        authorType: "agent",
        authorAgentId: params.agentId,
        category: "comment_resolution",
        slug: resolutionSlug,
        status: "resolved",
        body: resolutionBody,
        createdAt,
        resolvedAt: createdAt,
        resolvedBy: params.agentId,
        metadata: {
          resolvedSlugs: toResolve,
          reopenedSlugs: toReopen,
          openSlugs: Array.from(openSet),
        },
      });
    }

    return { resolved: toResolve, reopened: toReopen, open: Array.from(openSet) };
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
    resolvedCount?: number;
    reopenedCount?: number;
    openCount?: number;
  }): Promise<void> {
    const body = buildStandardReviewComment({
      decision: params.decision,
      statusBefore: params.statusBefore,
      statusAfter: params.statusAfter,
      findingsCount: params.findingsCount,
      summary: params.summary,
      followupTaskKeys: params.followupTaskKeys,
      error: params.error,
      resolvedCount: params.resolvedCount,
      reopenedCount: params.reopenedCount,
      openCount: params.openCount,
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
      selectedTasks = await this.deps.workspaceRepo.getTasksWithRelations(selectedTaskIds);
      const terminalStatuses = new Set(["completed", "cancelled"]);
      const terminalTasks = selectedTasks.filter((task) => terminalStatuses.has((task.status ?? "").toLowerCase()));
      if (terminalTasks.length) {
        const terminalIds = new Set(terminalTasks.map((task) => task.id));
        const terminalKeys = terminalTasks.map((task) => task.key);
        warnings.push(`Skipping terminal tasks on resume: ${terminalKeys.join(", ")}`);
        selectedTasks = selectedTasks.filter((task) => !terminalIds.has(task.id));
        selectedTaskIds = selectedTaskIds.filter((id) => !terminalIds.has(id));
        if (state) {
          state.selectedTaskIds = selectedTaskIds;
          await this.persistState(job.id, state);
        }
        await this.writeCheckpoint(job.id, "resume_filtered", {
          skippedTaskKeys: terminalKeys,
          selectedTaskIds,
          schema_version: 1,
        });
      }
      await this.deps.jobService.updateJobStatus(job.id, "running", {
        totalItems: selectedTaskIds.length,
        processedItems: state?.reviewed.length ?? 0,
      });
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
    const abortSignal = request.abortSignal;
    const resolveAbortReason = () => {
      const reason = abortSignal?.reason;
      if (typeof reason === "string" && reason.trim().length > 0) return reason;
      if (reason instanceof Error && reason.message) return reason.message;
      return "code_review_aborted";
    };
    const abortIfSignaled = () => {
      if (abortSignal?.aborted) {
        throw new Error(resolveAbortReason());
      }
    };
    const withAbort = async <T>(promise: Promise<T>): Promise<T> => {
      if (!abortSignal) return promise;
      if (abortSignal.aborted) {
        throw new Error(resolveAbortReason());
      }
      return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error(resolveAbortReason()));
        abortSignal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => {
          abortSignal.removeEventListener("abort", onAbort);
        });
      });
    };

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
      abortIfSignaled();
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
      let commentResolution: { resolved: string[]; reopened: string[]; open: string[] } | undefined;

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

        if (!diff.trim()) {
          const message = "Review diff is empty; blocking review until changes are produced.";
          warnings.push(`Empty diff for ${task.key}; blocking review.`);
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_warning",
            message,
          });
          if (!request.dryRun) {
            await this.stateService.markBlocked(task, "review_empty_diff");
            statusAfter = "blocked";
          }
          await this.writeReviewSummaryComment({
            task,
            taskRunId: taskRun.id,
            jobId,
            agentId: agent.id,
            statusBefore,
            statusAfter: statusAfter ?? statusBefore,
            decision: "block",
            summary: message,
            findingsCount: 0,
          });
          await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            runContext: { decision: "block", reason: "empty_diff" },
          });
          state?.reviewed.push({ taskId: task.id, decision: "block" });
          await this.persistState(jobId, state!);
          await this.writeCheckpoint(jobId, "review_applied", { reviewed: state?.reviewed ?? [], schema_version: 1 });
          results.push({
            taskId: task.id,
            taskKey: task.key,
            statusBefore,
            statusAfter: statusAfter ?? statusBefore,
            decision: "block",
            findings,
            followupTasks: followupCreated,
          });
          await this.deps.jobService.updateJobStatus(jobId, "running", {
            processedItems: state?.reviewed.length ?? 0,
          });
          await maybeRateTask(task, taskRun.id, tokensTotal);
          continue;
        }

        const historySummary = await this.buildHistorySummary(task.id);
        const commentContext = await this.loadCommentContext(task.id);
        const commentBacklog = buildCommentBacklog(commentContext.unresolved);
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
          commentBacklog,
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
          commentBacklog,
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
          const stream = await withAbort(
            this.deps.agentService.invokeStream(agent.id, { input: prompt, metadata: { taskKey: task.key } }),
          );
          while (true) {
            abortIfSignaled();
            const { value, done } = await withAbort(stream.next());
            if (done) break;
            const chunk = value;
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
          const response = await withAbort(
            this.deps.agentService.invoke(agent.id, { input: prompt, metadata: { taskKey: task.key } }),
          );
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
        let invalidJson = false;
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
          const retryResp = await withAbort(
            this.deps.agentService.invoke(agent.id, { input: retryPrompt, metadata: { taskKey: task.key, retry: true } }),
          );
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
          invalidJson = true;
          const fallbackSummary =
            "Review agent returned non-JSON output after retry; block review and re-run with a stricter JSON-only model.";
          warnings.push(`Review agent returned non-JSON output for ${task.key}; blocking review.`);
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_warning",
            message: fallbackSummary,
          });
          parsed = {
            decision: "block",
            summary: fallbackSummary,
            findings: [],
            testRecommendations: [],
            raw: agentOutput,
          };
        }
        parsed.raw = agentOutput;
        const originalDecision = parsed.decision;
        decision = parsed.decision;
        findings.push(...(parsed.findings ?? []));

        commentResolution = await this.applyCommentResolutions({
          task,
          taskRunId: taskRun.id,
          jobId,
          agentId: agent.id,
          findings: parsed.findings ?? [],
          resolvedSlugs: parsed.resolvedSlugs ?? undefined,
          unresolvedSlugs: parsed.unresolvedSlugs ?? undefined,
          decision: parsed.decision,
          existingComments: commentContext.comments,
        });

        let finalDecision = parsed.decision;
        if (
          commentResolution?.open?.length &&
          (finalDecision === "approve" || finalDecision === "info_only")
        ) {
          const openSlugs = commentResolution.open;
          finalDecision = "changes_requested";
          const message = `Unresolved comment slugs remain: ${formatSlugList(openSlugs)}. Review approval requires resolving these items.`;
          const backlogSlug = createTaskCommentSlug({
            source: "code-review",
            message,
            category: "comment_backlog",
          });
          const backlogBody = formatTaskCommentBody({
            slug: backlogSlug,
            source: "code-review",
            message,
            status: "open",
            category: "comment_backlog",
          });
          await this.deps.workspaceRepo.createTaskComment({
            taskId: task.id,
            taskRunId: taskRun.id,
            jobId,
            sourceCommand: "code-review",
            authorType: "agent",
            authorAgentId: agent.id,
            category: "comment_backlog",
            slug: backlogSlug,
            status: "open",
            body: backlogBody,
            metadata: { openSlugs },
            createdAt: new Date().toISOString(),
          });
        }
        parsed.decision = finalDecision;
        decision = finalDecision;

        const followups = await this.createFollowupTasksForFindings({
          task,
          findings: parsed.findings ?? [],
          decision: originalDecision,
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
          if (invalidJson) {
            await this.stateService.markBlocked(task, "review_invalid_output");
            taskStatusUpdate = "blocked";
          } else {
            const approveDecision = parsed.decision === "approve" || parsed.decision === "info_only";
            if (approveDecision) {
              await this.stateService.markReadyToQa(task);
              taskStatusUpdate = "ready_to_qa";
            } else if (parsed.decision === "changes_requested") {
              await this.stateService.returnToInProgress(task);
              taskStatusUpdate = "in_progress";
            } else if (parsed.decision === "block") {
              await this.stateService.markBlocked(task, "review_blocked");
              taskStatusUpdate = "blocked";
            }
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
          resolvedCount: commentResolution?.resolved.length,
          reopenedCount: commentResolution?.reopened.length,
          openCount: commentResolution?.open.length,
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
