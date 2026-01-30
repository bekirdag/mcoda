import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import {
  PathHelper,
  READY_TO_CODE_REVIEW,
  REVIEW_ALLOWED_STATUSES,
  filterTaskStatuses,
  normalizeReviewStatuses,
  type Agent,
} from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { TaskSelectionFilters, TaskSelectionService } from "../execution/TaskSelectionService.js";
import { TaskStateService } from "../execution/TaskStateService.js";
import { BacklogService } from "../backlog/BacklogService.js";
import yaml from "yaml";
import { createTaskKeyGenerator } from "../planning/KeyHelpers.js";
import { RoutingService, type ResolvedAgent } from "../agents/RoutingService.js";
import { AgentRatingService } from "../agents/AgentRatingService.js";
import { isDocContextExcluded, loadProjectGuidance, normalizeDocType } from "../shared/ProjectGuidance.js";
import { buildDocdexUsageGuidance } from "../shared/DocdexGuidance.js";
import { createTaskCommentSlug, formatTaskCommentBody } from "../tasks/TaskCommentFormatter.js";
import { AUTH_ERROR_REASON, isAuthErrorMessage } from "../shared/AuthErrors.js";
import { normalizeReviewOutput } from "./ReviewNormalizer.js";

const DEFAULT_BASE_BRANCH = "mcoda-dev";
const REVIEW_DIR = (mcodaDir: string, jobId: string) => path.join(mcodaDir, "jobs", jobId, "review");
const STATE_PATH = (mcodaDir: string, jobId: string) => path.join(REVIEW_DIR(mcodaDir, jobId), "state.json");
const REVIEW_PROMPT_LIMITS = {
  diff: 12000,
  history: 3000,
  docContext: 4000,
  openapi: 8000,
  checklist: 3000,
};
const DOCDEX_TIMEOUT_MS = 8000;
const DEFAULT_CODE_REVIEW_PROMPT = [
  "You are the code-review agent.",
  buildDocdexUsageGuidance({ contextLabel: "the review", includeHeading: false, includeFallback: true }),
  "Use docdex snippets to verify contracts (data shapes, offline scope, accessibility/perf guardrails, acceptance criteria). Call out mismatches, missing tests, and undocumented changes.",
  "When recommending tests, prefer the repo's existing runner (tests/all.js or package manager scripts). Avoid suggesting new Jest configs unless the repo explicitly documents them.",
  "Do not require docs/qa/<task>.md reports unless the task explicitly asks for one. QA artifacts typically live in mcoda workspace outputs.",
  "Do not hardcode ports; if a port matters, call out that it must be discovered or configured dynamically.",
].join("\n");
const REPO_PROMPTS_DIR = fileURLToPath(new URL("../../../../../prompts/", import.meta.url));
const resolveRepoPromptPath = (filename: string): string => path.join(REPO_PROMPTS_DIR, filename);
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";
const GATEWAY_PROMPT_MARKERS = [
  "you are the gateway agent",
  "return json only",
  "output json only",
  "docdexnotes",
  "fileslikelytouched",
  "filestocreate",
  "do not include fields outside the schema",
];

const sanitizeNonGatewayPrompt = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  if (GATEWAY_PROMPT_MARKERS.some((marker) => lower.includes(marker))) return undefined;
  return trimmed;
};

const readPromptFile = async (promptPath: string, fallback: string): Promise<string> => {
  try {
    const content = await fs.readFile(promptPath, "utf8");
    const trimmed = content.trim();
    if (trimmed) return trimmed;
  } catch {
    // fall through to fallback
  }
  return fallback;
};

const filterOpenApiContext = (entries: string[], hasOpenApiSnippet: boolean): string[] => {
  let openApiIncluded = false;
  const filtered: string[] = [];
  for (const entry of entries) {
    const isOpenApi = /\[linked:openapi\]|\[openapi\]/i.test(entry);
    if (!isOpenApi) {
      filtered.push(entry);
      continue;
    }
    if (hasOpenApiSnippet) {
      continue;
    }
    if (openApiIncluded) {
      continue;
    }
    openApiIncluded = true;
    filtered.push(entry);
  }
  return filtered;
};

export interface CodeReviewRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  baseRef?: string;
  dryRun?: boolean;
  agentName?: string;
  agentStream?: boolean;
  rateAgents?: boolean;
  createFollowupTasks?: boolean;
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

const isNonBlockingFinding = (finding: ReviewFinding): boolean => {
  const severity = (finding.severity ?? "").toLowerCase();
  if (["info", "low"].includes(severity)) return true;
  return false;
};

const isNonBlockingOnly = (findings: ReviewFinding[] = []): boolean => {
  if (!findings.length) return false;
  return findings.every((finding) => isNonBlockingFinding(finding));
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

const JSON_RETRY_RULES = [
  "Return ONLY valid JSON. No markdown, no prose, no code fences.",
  "The response must start with '{' and end with '}'.",
  "Match the schema exactly; use empty arrays when no items apply.",
].join("\n");

const isRetryableAgentError = (message: string): boolean =>
  /unexpected eof|econnreset|etimedout|socket hang up|fetch failed|connection closed/i.test(
    message.toLowerCase(),
  );

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

const normalizeLineNumber = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return undefined;
};

const summaryIndicatesNoChanges = (summary: string | undefined): boolean => {
  const normalized = (summary ?? "").toLowerCase();
  if (!normalized) return false;
  const patterns = [
    "no changes required",
    "no changes needed",
    "no change required",
    "no change needed",
    "no code changes",
    "already complete",
    "already completed",
    "already satisfied",
  ];
  return patterns.some((pattern) => normalized.includes(pattern));
};

const validateReviewOutput = (
  result: ReviewAgentResult,
  options: { requireCommentSlugs?: boolean } = {},
): string | undefined => {
  if (!result.decision || !["approve", "changes_requested", "block", "info_only"].includes(result.decision)) {
    return "Review decision is required.";
  }
  if (!result.summary || !result.summary.trim()) {
    return "Review summary is required.";
  }
  if (options.requireCommentSlugs && result.resolvedSlugs === undefined && result.unresolvedSlugs === undefined) {
    return "resolvedSlugs/unresolvedSlugs required when comment backlog exists.";
  }
  for (const finding of result.findings ?? []) {
    const message = (finding.message ?? "").trim();
    const file = typeof finding.file === "string" ? finding.file.trim() : "";
    const line = normalizeLineNumber(finding.line);
    if (!message || !file || !line) {
      return "Each review finding must include file, line, and message.";
    }
    finding.file = normalizePath(file);
    finding.line = line;
    finding.message = message;
  }
  return undefined;
};

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
    const details = parseCommentBody(comment.body);
    const slug =
      comment.slug?.trim() ||
      createTaskCommentSlug({
        source: comment.sourceCommand ?? "comment",
        message: details.message || comment.body,
        file: comment.file,
        line: comment.line,
        category: comment.category ?? null,
      });
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
    const docdexRepoId =
      workspace.config?.docdexRepoId ?? process.env.MCODA_DOCDEX_REPO_ID ?? process.env.DOCDEX_REPO_ID;
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
      repoId: docdexRepoId,
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

  setDocdexAvailability(available: boolean, reason?: string): void {
    if (available) return;
    const docdex = this.deps.docdex as any;
    if (docdex && typeof docdex.disable === "function") {
      docdex.disable(reason);
    }
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
  }

  private async loadPrompts(agentId: string): Promise<{ jobPrompt?: string; characterPrompt?: string; commandPrompt?: string }> {
    const mcodaPromptPath = path.join(this.workspace.mcodaDir, "prompts", "code-reviewer.md");
    const workspacePromptPath = path.join(this.workspace.workspaceRoot, "prompts", "code-reviewer.md");
    const repoPromptPath = resolveRepoPromptPath("code-reviewer.md");
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
        try {
          await fs.access(repoPromptPath);
          await fs.copyFile(repoPromptPath, mcodaPromptPath);
          console.info(`[code-review] copied repo code-reviewer prompt to ${mcodaPromptPath}`);
        } catch {
          console.info(
            `[code-review] no code-reviewer prompt found at ${workspacePromptPath} or repo prompts; writing default prompt to ${mcodaPromptPath}`,
          );
          await fs.writeFile(mcodaPromptPath, DEFAULT_CODE_REVIEW_PROMPT, "utf8");
        }
      }
    }
    const agentPrompts =
      "getPrompts" in this.deps.agentService ? await (this.deps.agentService as any).getPrompts(agentId) : undefined;
    const filePrompt = await readPromptFile(mcodaPromptPath, DEFAULT_CODE_REVIEW_PROMPT);
    const commandPrompt = agentPrompts?.commandPrompts?.["code-review"]?.trim() || filePrompt;
    return {
      jobPrompt: sanitizeNonGatewayPrompt(agentPrompts?.jobPrompt) ?? DEFAULT_JOB_PROMPT,
      characterPrompt: sanitizeNonGatewayPrompt(agentPrompts?.characterPrompt) ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: commandPrompt || undefined,
    };
  }

  private async loadRunbookAndChecklists(): Promise<string[]> {
    const extras: string[] = [];
    const runbookPath = path.join(this.workspace.mcodaDir, "prompts", "commands", "code-review.md");
    try {
      const content = await fs.readFile(runbookPath, "utf8");
      extras.push(content);
    } catch {
      /* optional */
    }
    const checklistDir = path.join(this.workspace.mcodaDir, "checklists");
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

  private async resolveAgent(agentName?: string): Promise<ResolvedAgent> {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "code-review",
      overrideAgentSlug: agentName,
    });
    if (agentName) {
      const matches = agentName === resolved.agent.id || agentName === resolved.agent.slug;
      if (!matches) {
        throw new Error(
          `Review agent override "${agentName}" resolved to "${resolved.agent.slug}" (source: ${resolved.source}).`,
        );
      }
    }
    return resolved;
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
    statusFilter?: string[];
    limit?: number;
  }): Promise<(TaskRow & { epicKey: string; storyKey: string; epicTitle?: string; epicDescription?: string; storyTitle?: string; storyDescription?: string; acceptanceCriteria?: string[] })[]> {
    // Prefer the backlog/task OpenAPI surface (via BacklogService) to mirror API filtering semantics.
    const backlog = await BacklogService.create(this.workspace);
    try {
      const result = await backlog.getBacklog({
        projectKey: filters.projectKey,
        epicKey: filters.epicKey,
        storyKey: filters.storyKey,
        statuses: filters.statusFilter && filters.statusFilter.length ? filters.statusFilter : undefined,
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
    const dir = REVIEW_DIR(this.workspace.mcodaDir, jobId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      STATE_PATH(this.workspace.mcodaDir, jobId),
      JSON.stringify({ schema_version: 1, job_id: jobId, updated_at: new Date().toISOString(), ...state }, null, 2),
      "utf8",
    );
  }

  private async loadState(jobId: string): Promise<ReviewJobState | undefined> {
    try {
      const raw = await fs.readFile(STATE_PATH(this.workspace.mcodaDir, jobId), "utf8");
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

  private async gatherDocContext(
    taskTitle: string,
    paths: string[],
    acceptance?: string[],
    docLinks: string[] = [],
  ): Promise<{ snippets: string[]; warnings: string[] }> {
    const snippets: string[] = [];
    const warnings: string[] = [];
    if (typeof (this.deps.docdex as any)?.ensureRepoScope === "function") {
      try {
        await (this.deps.docdex as any).ensureRepoScope();
      } catch (error) {
        warnings.push(`docdex scope missing: ${(error as Error).message}`);
        return { snippets, warnings };
      }
    }
    const queries = [...new Set([...(paths.length ? this.componentHintsFromPaths(paths) : []), taskTitle, ...(acceptance ?? [])])].slice(0, 8);
    let reindexed = false;
    const resolveDocType = (
      doc: { docType?: string; path?: string; title?: string; content?: string; segments?: Array<{ content?: string }> },
      pathOverride?: string,
    ) => {
      const content = doc.segments?.[0]?.content ?? doc.content ?? "";
      const normalized = normalizeDocType({
        docType: doc.docType,
        path: doc.path ?? pathOverride,
        title: doc.title,
        content,
      });
      if (normalized.downgraded) {
        warnings.push(
          `Docdex docType downgraded from SDS to DOC for ${doc.path ?? doc.title ?? doc.docType ?? "unknown"}: ${normalized.reason ?? "not_sds"}`,
        );
      }
      return normalized.docType;
    };
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
        const filteredDocs = docs.filter((doc) => !isDocContextExcluded(doc.path ?? doc.title ?? doc.id, false));
        snippets.push(
          ...filteredDocs.slice(0, 2).map((doc) => {
            const content = (doc.segments?.[0]?.content ?? doc.content ?? "").slice(0, 400);
            const ref = doc.path ?? doc.id ?? doc.title ?? query;
            return `- [${resolveDocType(doc)}] ${ref}: ${content}`;
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
            const filteredDocs = docs.filter((doc) => !isDocContextExcluded(doc.path ?? doc.title ?? doc.id, false));
            snippets.push(
              ...filteredDocs.slice(0, 2).map((doc) => {
                const content = (doc.segments?.[0]?.content ?? doc.content ?? "").slice(0, 400);
                const ref = doc.path ?? doc.id ?? doc.title ?? query;
                return `- [${resolveDocType(doc)}] ${ref}: ${content}`;
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
    const normalizeDocLink = (value: string): { type: "id" | "path"; ref: string } => {
      const trimmed = value.trim();
      const stripped = trimmed.replace(/^docdex:/i, "").replace(/^doc:/i, "");
      const candidate = stripped || trimmed;
      const looksLikePath =
        candidate.includes("/") ||
        candidate.includes("\\") ||
        /\.(md|markdown|txt|rst|yaml|yml|json)$/i.test(candidate);
      return { type: looksLikePath ? "path" : "id", ref: candidate };
    };
    for (const link of docLinks) {
      try {
        const { type, ref } = normalizeDocLink(link);
        if (type === "path" && isDocContextExcluded(ref, false)) {
          snippets.push(`- [linked:filtered] ${link} — excluded from non-QA context`);
          continue;
        }
        let doc = undefined;
        if (type === "path" && "findDocumentByPath" in this.deps.docdex) {
          doc = await (this.deps.docdex as DocdexClient).findDocumentByPath(ref);
        }
        if (!doc) {
          doc = await this.deps.docdex.fetchDocumentById(ref);
        }
        if (!doc) {
          warnings.push(`docdex fetch returned no document for ${link}`);
          snippets.push(`- [linked:missing] ${link} — no docdex entry found`);
          continue;
        }
        const content = (doc.segments?.[0]?.content ?? doc.content ?? "").slice(0, 400);
        const refLabel = doc.path ?? doc.id ?? doc.title ?? link;
        snippets.push(`- [linked:${resolveDocType(doc, type === "path" ? ref : undefined)}] ${refLabel}: ${content}`);
      } catch (error) {
        const message = (error as Error).message;
        warnings.push(`docdex fetch failed for ${link}: ${message}`);
        snippets.push(`- [linked:missing] ${link} — ${message}`);
      }
    }
    return { snippets: Array.from(new Set(snippets)), warnings };
  }

  private buildReviewPrompt(params: {
    systemPrompts: string[];
    task: TaskRow & { epicKey?: string; storyKey?: string; epicTitle?: string; epicDescription?: string; storyTitle?: string; storyDescription?: string; acceptanceCriteria?: string[] };
    diff: string;
    diffEmpty: boolean;
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
    const filteredDocContext = filterOpenApiContext(params.docContext, Boolean(params.openapiSnippet));
    const docContextText = filteredDocContext.length
      ? truncateSection("doc context", filteredDocContext.join("\n"), REVIEW_PROMPT_LIMITS.docContext)
      : "";
    const openapiSnippet = params.openapiSnippet ? truncateSection("openapi", params.openapiSnippet, REVIEW_PROMPT_LIMITS.openapi) : undefined;
    const checklistsText = params.checklists?.length
      ? truncateSection("checklists", params.checklists.join("\n\n"), REVIEW_PROMPT_LIMITS.checklist)
      : "";
    const diffText = truncateSection("diff", params.diff || "(no diff)", REVIEW_PROMPT_LIMITS.diff);
    const reviewFocus = [
      "Review focus:",
      "- First validate the task requirements and the work-on-tasks actions (history/comments) rather than the diff.",
      "- If the diff is empty, decide whether no code changes are required to satisfy the task.",
      "- If no changes are required, use decision=approve or info_only and explicitly say no code changes are needed.",
      "- If changes are required, use decision=changes_requested and explain exactly what is missing and why.",
    ].join("\n");
    parts.push(
      [
        reviewFocus,
        `Task ${params.task.key}: ${params.task.title}`,
        `Epic: ${params.task.epicKey ?? ""} ${params.task.epicTitle ?? ""}`.trim(),
        `Epic description: ${params.task.epicDescription ? params.task.epicDescription : "none"}`,
        `Story: ${params.task.storyKey ?? ""} ${params.task.storyTitle ?? ""}`.trim(),
        `Story description: ${params.task.storyDescription ? params.task.storyDescription : "none"}`,
        `Status: ${params.task.status}, Branch: ${params.branch ?? params.task.vcsBranch ?? "n/a"} (base ${params.baseRef})`,
        `Task description: ${params.task.description ? params.task.description : "none"}`,
        `History:\n${historySummary}`,
        commentBacklog
          ? `Code-review comment backlog (unresolved slugs):\n${commentBacklog}`
          : "Code-review comment backlog: none",
        `Task DoD / acceptance criteria: ${acceptance}`,
        docContextText ? `Doc context (docdex excerpts):\n${docContextText}` : "Doc context: none",
        openapiSnippet
          ? `OpenAPI (authoritative contract; do not invent endpoints outside this):\n${openapiSnippet}`
          : "OpenAPI: not provided; avoid inventing endpoints.",
        checklistsText ? `Review checklists/runbook:\n${checklistsText}` : "Checklists: none",
        params.diffEmpty ? "Diff: (empty — no changes between base and branch)" : "Diff:\n" + diffText,
        "Respond with STRICT JSON only, matching:\n" + JSON_CONTRACT,
        "Rules: honor OpenAPI contracts; cite doc context where relevant; include resolvedSlugs/unresolvedSlugs for code-review comment backlog items only; do not require docs/qa/* reports; avoid hardcoded ports; do not add prose or markdown fences outside JSON.",
      ].join("\n"),
    );
    return parts.join("\n\n");
  }

  private async buildHistorySummary(taskId: string): Promise<string> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["work-on-tasks", "code-review"],
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
    if (!parts.length) return "No prior review history.";
    return parts.join("\n");
  }

  private async loadCommentContext(taskId: string): Promise<{ comments: TaskCommentRow[]; unresolved: TaskCommentRow[] }> {
    const comments = await this.deps.workspaceRepo.listTaskComments(taskId, {
      sourceCommands: ["code-review"],
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
    const allowedSlugs = new Set(existingBySlug.keys());
    const resolvedSlugs = normalizeSlugList(params.resolvedSlugs ?? undefined).filter((slug) => allowedSlugs.has(slug));
    const resolvedSet = new Set(resolvedSlugs);
    const unresolvedSet = new Set(
      normalizeSlugList(params.unresolvedSlugs ?? undefined).filter((slug) => allowedSlugs.has(slug)),
    );

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
    const dir = path.join(REVIEW_DIR(this.workspace.mcodaDir, jobId), "context");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${taskId}.json`),
      JSON.stringify({ schema_version: 1, task_id: taskId, created_at: new Date().toISOString(), ...context }, null, 2),
      "utf8",
    );
  }

  private async persistDiff(jobId: string, taskId: string, diff: string): Promise<void> {
    const dir = path.join(REVIEW_DIR(this.workspace.mcodaDir, jobId), "diffs");
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

  private async persistReviewOutput(jobId: string, taskId: string, payload: Record<string, unknown>): Promise<string> {
    const dir = path.join(REVIEW_DIR(this.workspace.mcodaDir, jobId), "outputs");
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${taskId}.json`);
    await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
    return path.relative(this.workspace.mcodaDir, target);
  }

  private severityToPriority(severity?: string): number | null {
    if (!severity) return null;
    const normalized = severity.toLowerCase();
    const order: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4, info: 5 };
    return order[normalized] ?? null;
  }

  private severityToStoryPoints(severity?: string): number | null {
    if (!severity) return null;
    const normalized = severity.toLowerCase();
    const points: Record<string, number> = { critical: 8, high: 5, medium: 3, low: 2, info: 1 };
    return points[normalized] ?? null;
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
      const fallbackPoints = this.resolveTaskComplexity(params.task) ?? params.task.storyPoints ?? 1;
      const storyPoints = this.severityToStoryPoints(finding.severity) ?? fallbackPoints;
      const boundedPoints = Number.isFinite(storyPoints) ? Math.min(10, Math.max(1, Math.round(storyPoints))) : 1;
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
        storyPoints: boundedPoints,
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
          complexity: boundedPoints,
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
    const ignoreStatusFilter = Boolean(request.taskKeys?.length) || request.ignoreStatusFilter === true;
    const rawStatusFilter = ignoreStatusFilter
      ? []
      : request.statusFilter && request.statusFilter.length
        ? request.statusFilter
        : [READY_TO_CODE_REVIEW];
    const { filtered: allowedStatusFilter, rejected } = filterTaskStatuses(
      rawStatusFilter,
      REVIEW_ALLOWED_STATUSES,
      REVIEW_ALLOWED_STATUSES,
    );
    const statusFilter = normalizeReviewStatuses(allowedStatusFilter);
    let state: ReviewJobState | undefined;

    const commandRun = await this.deps.jobService.startCommandRun("code-review", request.projectKey, {
      taskIds: request.taskKeys,
      gitBaseBranch: baseRef,
      jobId: request.resumeJobId,
    });

    let jobId = request.resumeJobId;
    let selectedTaskIds: string[] = [];
    let warnings: string[] = [];
    if (rejected.length > 0 && !ignoreStatusFilter) {
      warnings.push(
        `code-review ignores unsupported statuses: ${rejected.join(", ")}. Allowed: ${REVIEW_ALLOWED_STATUSES.join(
          ", ",
        )}.`,
      );
    }
    let allowFollowups = request.createFollowupTasks === true;
    let selectedTasks: Array<TaskRow & { epicKey: string; storyKey: string; epicTitle?: string; epicDescription?: string; storyTitle?: string; storyDescription?: string; acceptanceCriteria?: string[] }> =
      [];

    if (request.resumeJobId) {
      const job = await this.deps.jobService.getJob(request.resumeJobId);
      if (!job) throw new Error(`Job not found: ${request.resumeJobId}`);
      if ((job.commandName ?? job.type) !== "code-review" && job.type !== "review") {
        throw new Error(`Job ${request.resumeJobId} is not a code-review job`);
      }
      if (request.createFollowupTasks === undefined) {
        allowFollowups = Boolean((job.payload as any)?.createFollowupTasks);
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
          statusFilter: ignoreStatusFilter ? undefined : statusFilter,
          limit: request.limit,
        });
      } catch {
        const selection = await this.selectionService.selectTasks({
          projectKey: request.projectKey,
          epicKey: request.epicKey,
          storyKey: request.storyKey,
          taskKeys: request.taskKeys,
          statusFilter: ignoreStatusFilter ? undefined : statusFilter,
          limit: request.limit,
          ignoreStatusFilter,
        });
        warnings = [...warnings, ...selection.warnings];
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
          statusFilter: ignoreStatusFilter ? [] : statusFilter,
          baseRef,
          selection: selectedTaskIds,
          dryRun: request.dryRun ?? false,
          agent: request.agentName,
          agentStream,
          createFollowupTasks: allowFollowups,
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
    let resolvedAgent: ResolvedAgent;
    try {
      resolvedAgent = await this.resolveAgent(request.agentName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (request.agentName) {
        const warning = `Review agent override (${request.agentName}) failed: ${message}`;
        warnings.push(warning);
        console.warn(`[code-review] ${warning}`);
      }
      throw error;
    }
    const agent = resolvedAgent.agent;
    const reviewJsonAgentOverride =
      this.workspace.config?.reviewJsonAgent ??
      process.env.MCODA_REVIEW_JSON_AGENT ??
      process.env.MCODA_REVIEW_JSON_AGENT_NAME;
    let reviewJsonAgent: Agent | undefined;
    if (
      reviewJsonAgentOverride &&
      reviewJsonAgentOverride !== agent.id &&
      reviewJsonAgentOverride !== agent.slug
    ) {
      try {
        reviewJsonAgent = (await this.resolveAgent(reviewJsonAgentOverride)).agent;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Review JSON agent override (${reviewJsonAgentOverride}) failed: ${message}`);
      }
    }
    const prompts = await this.loadPrompts(agent.id);
    const extras = await this.loadRunbookAndChecklists();
    const projectGuidance = await loadProjectGuidance(this.workspace.workspaceRoot, this.workspace.mcodaDir);
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
    const formatSessionId = (iso: string): string => {
      const date = new Date(iso);
      const pad = (value: number) => String(value).padStart(2, "0");
      return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(
        date.getMinutes(),
      )}${pad(date.getSeconds())}`;
    };
    const formatDuration = (ms: number): string => {
      const totalSeconds = Math.max(0, Math.floor(ms / 1000));
      const seconds = totalSeconds % 60;
      const minutesTotal = Math.floor(totalSeconds / 60);
      const minutes = minutesTotal % 60;
      const hours = Math.floor(minutesTotal / 60);
      if (hours > 0) return `${hours}H ${minutes}M ${seconds}S`;
      return `${minutes}M ${seconds}S`;
    };
    const resolveProvider = (adapter?: string): string => {
      if (!adapter) return "n/a";
      const trimmed = adapter.trim();
      if (!trimmed) return "n/a";
      if (trimmed.includes("-")) return trimmed.split("-")[0];
      return trimmed;
    };
    const resolveReasoning = (config?: Record<string, unknown>): string => {
      if (!config) return "n/a";
      const raw = (config as Record<string, unknown>).reasoning ?? (config as Record<string, unknown>).thinking;
      if (typeof raw === "string") return raw;
      if (typeof raw === "boolean") return raw ? "enabled" : "disabled";
      return "n/a";
    };
    const emitLine = (line: string): void => {
      console.info(line);
    };
    const emitBlank = (): void => emitLine("");
    const emitReviewStart = (details: {
      taskKey: string;
      alias: string;
      summary: string;
      model: string;
      provider: string;
      step: string;
      reasoning: string;
      workdir: string;
      sessionId: string;
      startedAt: string;
    }): void => {
      emitLine("╭──────────────────────────────────────────────────────────╮");
      emitLine("│              START OF CODE REVIEW TASK                   │");
      emitLine("╰──────────────────────────────────────────────────────────╯");
      emitLine(`  [🪪] Code Review Task ID: ${details.taskKey}`);
      emitLine(`  [👹] Alias:          ${details.alias}`);
      emitLine(`  [ℹ️] Summary:        ${details.summary}`);
      emitLine(`  [🤖] Model:          ${details.model}`);
      emitLine(`  [🕹️] Provider:       ${details.provider}`);
      emitLine(`  [🧩] Step:           ${details.step}`);
      emitLine(`  [🧠] Reasoning:      ${details.reasoning}`);
      emitLine(`  [📁] Workdir:        ${details.workdir}`);
      emitLine(`  [🔑] Session:        ${details.sessionId}`);
      emitLine(`  [🕒] Started:        ${details.startedAt}`);
      emitBlank();
      emitLine("    ░░░░░ START OF CODE REVIEW TASK ░░░░░");
      emitBlank();
      emitLine(`    [STEP ${details.step}]  [MODEL ${details.model}]`);
      emitBlank();
      emitBlank();
    };
    const emitReviewEnd = (details: {
      taskKey: string;
      statusLabel: string;
      decision?: string;
      findingsCount: number;
      elapsedMs: number;
      tokensTotal: number;
      startedAt: string;
      endedAt: string;
    }): void => {
      emitLine("╭──────────────────────────────────────────────────────────╮");
      emitLine("│                END OF CODE REVIEW TASK                   │");
      emitLine("╰──────────────────────────────────────────────────────────╯");
      emitLine(
        `  👀 CODE REVIEW TASK ${details.taskKey} | 📜 STATUS ${details.statusLabel} | ✅ DECISION ${details.decision ?? "n/a"} | 🔎 FINDINGS ${details.findingsCount} | ⌛ TIME ${formatDuration(details.elapsedMs)}`,
      );
      emitLine(`  [🕒] Started:        ${details.startedAt}`);
      emitLine(`  [🕒] Ended:          ${details.endedAt}`);
      emitLine(`  Tokens used:  ${details.tokensTotal.toLocaleString("en-US")}`);
      emitBlank();
      emitLine("    ░░░░░ END OF CODE REVIEW TASK ░░░░░");
      emitBlank();
    };
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
          discipline: task.type ?? "review",
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

    let abortRemainingReason: string | null = null;
    for (const task of tasks) {
      if (abortRemainingReason) break;
      abortIfSignaled();
      const startedAt = new Date().toISOString();
      const taskStartMs = Date.now();
      const sessionId = formatSessionId(startedAt);
      const taskAlias = `Reviewing task ${task.key}`;
      const taskSummary = task.title ?? task.description ?? "(none)";
      const modelLabel = agent.defaultModel ?? "(default)";
      const providerLabel = resolveProvider(agent.adapter);
      const reasoningLabel = resolveReasoning(agent.config as Record<string, unknown> | undefined);
      const stepLabel = "review";
      let endEmitted = false;
      const emitReviewEndOnce = (details: {
        statusLabel: string;
        decision?: string;
        findingsCount: number;
        tokensTotal: number;
      }): void => {
        if (endEmitted) return;
        endEmitted = true;
        emitReviewEnd({
          taskKey: task.key,
          statusLabel: details.statusLabel,
          decision: details.decision,
          findingsCount: details.findingsCount,
          elapsedMs: Date.now() - taskStartMs,
          tokensTotal: details.tokensTotal,
          startedAt,
          endedAt: new Date().toISOString(),
        });
      };
      const statusBefore = task.status;
      const taskRun = await this.deps.workspaceRepo.createTaskRun({
        taskId: task.id,
        command: "code-review",
        jobId,
        commandRunId: commandRun.id,
        agentId: agent.id,
        status: "running",
        startedAt,
        storyPointsAtRun: task.storyPoints ?? null,
        gitBranch: task.vcsBranch ?? null,
        gitBaseBranch: task.vcsBaseBranch ?? null,
        gitCommitSha: task.vcsLastCommitSha ?? null,
      });

      const statusContext = {
        commandName: "code-review",
        jobId,
        taskRunId: taskRun.id,
        agentId: agent.id,
        metadata: { lane: "review" },
      };

      const findings: ReviewFinding[] = [];
      let decision: ReviewAgentResult["decision"] | undefined;
      let statusAfter: string | undefined;
      let reviewErrorCode: string | undefined;
      const followupCreated: { taskId: string; taskKey: string; epicId: string; userStoryId: string; generic?: boolean }[] = [];
      let commentResolution: { resolved: string[]; reopened: string[]; open: string[] } | undefined;

      // Debug visibility: show prompts/task details for this run
      const systemPrompt = systemPrompts.join("\n\n");
      let tokensTotal = 0;
      let agentOutput = "";

      try {
        emitReviewStart({
          taskKey: task.key,
          alias: taskAlias,
          summary: taskSummary,
          model: modelLabel,
          provider: providerLabel,
          step: stepLabel,
          reasoning: reasoningLabel,
          workdir: this.workspace.workspaceRoot,
          sessionId,
          startedAt,
        });
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
        const diffEmpty = !diff.trim();
        if (diffEmpty) {
          const message = `Empty diff for ${task.key}; reviewing task requirements to confirm whether no changes are acceptable.`;
          warnings.push(message);
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_warning",
            message,
          });
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
        const diffMeta = { diffEmpty, changedPaths };
        const docLinks = await this.gatherDocContext(
          task.title,
          changedPaths.length ? changedPaths : allowedFiles,
          task.acceptanceCriteria,
          Array.isArray((task.metadata as any)?.doc_links) ? (task.metadata as any).doc_links : [],
        );
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
          diffEmpty,
          docContext: docLinks.snippets,
          openapiSnippet,
          historySummary,
          commentBacklog,
          baseRef: state?.baseRef ?? baseRef,
          branch: task.vcsBranch ?? undefined,
        });
        const requireCommentSlugs = Boolean(commentBacklog.trim());

        const separator = "============================================================";
        const deps =
          Array.isArray((task as any).dependencyKeys) && (task as any).dependencyKeys.length
            ? (task as any).dependencyKeys
            : Array.isArray((task.metadata as any)?.depends_on)
              ? ((task.metadata as any).depends_on as string[])
              : [];
        console.info(separator);
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
          diffEmpty,
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
          agentUsed: Agent = agent,
          attempt = 1,
        ) => {
          const tokensPrompt = tokenMeta?.tokensPrompt ?? estimateTokens(promptText);
          const tokensCompletion = tokenMeta?.tokensCompletion ?? estimateTokens(outputText);
          const entryTotal = tokenMeta?.tokensTotal ?? tokensPrompt + tokensCompletion;
          tokensTotal += entryTotal;
          await this.deps.jobService.recordTokenUsage({
            workspaceId: this.workspace.workspaceId,
            agentId: agentUsed.id,
            modelName: tokenMeta?.model ?? (agentUsed as any).defaultModel ?? undefined,
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
            metadata: { commandName: "code-review", phase, action: phase, attempt },
          });
        };

        agentOutput = "";
        let durationSeconds = 0;
        let lastStreamMeta: any;
        let agentUsedForOutput: Agent = agent;
        let outputAttempt = 1;
        const invokeReviewAgent = async (
          agentToUse: Agent,
          useStream: boolean,
          logSource: "agent" | "agent_retry",
        ): Promise<{ output: string; durationSeconds: number; metadata?: any }> => {
          let output = "";
          let metadata: any;
          const started = Date.now();
          if (useStream && this.deps.agentService.invokeStream) {
            const stream = await withAbort(
              this.deps.agentService.invokeStream(agentToUse.id, {
                input: prompt,
                metadata: { taskKey: task.key, retry: logSource === "agent_retry" },
              }),
            );
            while (true) {
              abortIfSignaled();
              const { value, done } = await withAbort(stream.next());
              if (done) break;
              const chunk = value;
              output += chunk.output ?? "";
              metadata = chunk.metadata ?? metadata;
              await this.deps.workspaceRepo.insertTaskLog({
                taskRunId: taskRun.id,
                sequence: this.sequenceForTask(taskRun.id),
                timestamp: new Date().toISOString(),
                source: logSource,
                message: chunk.output ?? "",
              });
            }
          } else {
            const response = await withAbort(
              this.deps.agentService.invoke(agentToUse.id, {
                input: prompt,
                metadata: { taskKey: task.key, retry: logSource === "agent_retry" },
              }),
            );
            output = response.output ?? "";
            metadata = response.metadata;
            await this.deps.workspaceRepo.insertTaskLog({
              taskRunId: taskRun.id,
              sequence: this.sequenceForTask(taskRun.id),
              timestamp: new Date().toISOString(),
              source: logSource,
              message: output,
            });
          }
          const durationSeconds = Math.round(((Date.now() - started) / 1000) * 1000) / 1000;
          return { output, durationSeconds, metadata };
        };

        try {
          const invocation = await invokeReviewAgent(
            agent,
            Boolean(agentStream && this.deps.agentService.invokeStream),
            "agent",
          );
          agentOutput = invocation.output;
          durationSeconds = invocation.durationSeconds;
          lastStreamMeta = invocation.metadata;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isRetryableAgentError(message)) {
            throw error;
          }
          outputAttempt = 2;
          agentUsedForOutput = reviewJsonAgent ?? agent;
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "agent_retry",
            message: `Transient agent error (${message}); retrying once with ${agentUsedForOutput.slug ?? agentUsedForOutput.id}.`,
          });
          const invocation = await invokeReviewAgent(agentUsedForOutput, false, "agent_retry");
          agentOutput = invocation.output;
          durationSeconds = invocation.durationSeconds;
          lastStreamMeta = invocation.metadata;
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
        await recordUsage("review_main", prompt, agentOutput, durationSeconds, tokenMetaMain, agentUsedForOutput, outputAttempt);

        const primaryOutput = agentOutput;
        let retryOutput: string | undefined;
        let retryAgentUsed: Agent | undefined;
        let normalization = normalizeReviewOutput(agentOutput);
        let parsed = normalization.result;
        let validationError = validateReviewOutput(parsed, { requireCommentSlugs });
        if (validationError === "resolvedSlugs/unresolvedSlugs required when comment backlog exists.") {
          const warning = `Review output missing comment slugs for ${task.key}; assuming no backlog items resolved.`;
          warnings.push(warning);
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_warning",
            message: warning,
          });
          validationError = undefined;
        }

        const needsRetry = Boolean(validationError) || normalization.usedFallback;
        if (needsRetry) {
          const retryReason = validationError
            ? `Invalid review schema (${validationError}); retrying once with stricter instructions.`
            : "Unstructured review output; retrying once with stricter instructions.";
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "agent",
            message: retryReason,
          });
          const buildRetryPrompt = (raw: string): string =>
            [
              "Your previous response was invalid JSON. Reformat it to match the schema below.",
              JSON_RETRY_RULES,
              JSON_CONTRACT,
              "RESPONSE_TO_CONVERT:",
              raw,
            ].join("\n");
          const retryPrompt = agentOutput.trim()
            ? buildRetryPrompt(agentOutput)
            : `${prompt}\n\n${JSON_RETRY_RULES}\n${JSON_CONTRACT}`;
          const retryStarted = Date.now();
          retryAgentUsed = reviewJsonAgent ?? agent;
          if (retryAgentUsed.id !== agent.id) {
            await this.deps.workspaceRepo.insertTaskLog({
              taskRunId: taskRun.id,
              sequence: this.sequenceForTask(taskRun.id),
              timestamp: new Date().toISOString(),
              source: "agent_retry",
              message: `Retrying with JSON-only agent override: ${retryAgentUsed.slug ?? retryAgentUsed.id}`,
            });
          }
          const retryResp = await withAbort(
            this.deps.agentService.invoke(retryAgentUsed.id, { input: retryPrompt, metadata: { taskKey: task.key, retry: true } }),
          );
          retryOutput = retryResp.output ?? "";
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
          await recordUsage("review_retry", retryPrompt, retryOutput, retryDuration, retryTokenMeta, retryAgentUsed, 2);
          normalization = normalizeReviewOutput(retryOutput);
          parsed = normalization.result;
          validationError = validateReviewOutput(parsed, { requireCommentSlugs });
          if (validationError === "resolvedSlugs/unresolvedSlugs required when comment backlog exists.") {
            const warning = `Review output missing comment slugs for ${task.key} after retry; assuming no backlog items resolved.`;
            warnings.push(warning);
            await this.deps.workspaceRepo.insertTaskLog({
              taskRunId: taskRun.id,
              sequence: this.sequenceForTask(taskRun.id),
              timestamp: new Date().toISOString(),
              source: "review_warning",
              message: warning,
            });
            validationError = undefined;
          }
          agentOutput = retryOutput;
        }

        if (validationError) {
          const fallbackSummary = `Review output missing required fields (${validationError}); treated as informational.`;
          warnings.push(`Review output missing required fields for ${task.key}; proceeding with info_only.`);
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_warning",
            message: fallbackSummary,
          });
          parsed = {
            decision: "info_only",
            summary: fallbackSummary,
            findings: [],
            testRecommendations: [],
            raw: retryOutput ?? agentOutput,
          };
          normalization = { parsedFromJson: false, usedFallback: true, issues: ["validation_error"], result: parsed };
        }

        if (normalization.usedFallback) {
          const fallbackMessage = `Review output was not valid JSON for ${task.key}; treated as informational.`;
          warnings.push(fallbackMessage);
          await this.deps.workspaceRepo.insertTaskLog({
            taskRunId: taskRun.id,
            sequence: this.sequenceForTask(taskRun.id),
            timestamp: new Date().toISOString(),
            source: "review_warning",
            message: fallbackMessage,
          });
          try {
            const artifactPath = await this.persistReviewOutput(jobId, task.id, {
              schema_version: 1,
              task_key: task.key,
              created_at: new Date().toISOString(),
              agent_id: agent.id,
              retry_agent_id: retryAgentUsed?.id ?? agent.id,
              primary_output: primaryOutput,
              retry_output: retryOutput ?? agentOutput,
              validation_error: validationError ?? null,
            });
            warnings.push(`Review output saved to ${artifactPath} for ${task.key}.`);
          } catch (persistError) {
            warnings.push(
              `Failed to persist review output for ${task.key}: ${persistError instanceof Error ? persistError.message : String(persistError)}`,
            );
          }
        }
        parsed.raw = parsed.raw ?? agentOutput;
        const originalDecision = parsed.decision;
        decision = parsed.decision;
        findings.push(...(parsed.findings ?? []));

        const historySupportsNoChanges =
          (task.metadata as any)?.completed_reason === "no_changes" ||
          historySummary.toLowerCase().includes("no_changes") ||
          historySummary.toLowerCase().includes("no changes");
        const summarySupportsNoChanges = summaryIndicatesNoChanges(parsed.summary);
        const approveDecision = parsed.decision === "approve" || parsed.decision === "info_only";
        let finalDecision = parsed.decision;
        let emptyDiffOverride = false;
        if (diffEmpty && approveDecision && !(summarySupportsNoChanges && historySupportsNoChanges)) {
          finalDecision = "changes_requested";
          emptyDiffOverride = true;
        }
        if (finalDecision === "changes_requested" && isNonBlockingOnly(parsed.findings ?? []) && !emptyDiffOverride) {
          finalDecision = "info_only";
          warnings.push(
            `Review for ${task.key} requested changes but only low/info findings were reported; downgrading to info_only.`,
          );
        }

        commentResolution = await this.applyCommentResolutions({
          task,
          taskRunId: taskRun.id,
          jobId,
          agentId: agent.id,
          findings: parsed.findings ?? [],
          resolvedSlugs: parsed.resolvedSlugs ?? undefined,
          unresolvedSlugs: parsed.unresolvedSlugs ?? undefined,
          decision: finalDecision,
          existingComments: commentContext.comments,
        });
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
        if (emptyDiffOverride) {
          const message = [
            "Empty diff detected; approval requires an explicit no-changes justification",
            "and task history indicating no changes were needed.",
          ].join(" ");
          const slug = createTaskCommentSlug({
            source: "code-review",
            message,
            category: "review_empty_diff",
          });
          const body = formatTaskCommentBody({
            slug,
            source: "code-review",
            message,
            status: "open",
            category: "review_empty_diff",
          });
          await this.deps.workspaceRepo.createTaskComment({
            taskId: task.id,
            taskRunId: taskRun.id,
            jobId,
            sourceCommand: "code-review",
            authorType: "agent",
            authorAgentId: agent.id,
            category: "review_empty_diff",
            slug,
            status: "open",
            body,
            createdAt: new Date().toISOString(),
          });
          warnings.push(`Empty diff approval rejected for ${task.key}; requesting explicit no-changes justification.`);
        }
        const appendSyntheticFinding = (message: string, suggestedFix?: string) => {
          const finding: ReviewFinding = {
            type: "process",
            severity: "info",
            message,
            suggestedFix,
          };
          if (!parsed.findings) {
            parsed.findings = [];
          }
          parsed.findings.push(finding);
          findings.push(finding);
        };
        if (finalDecision === "changes_requested" && (parsed.findings?.length ?? 0) === 0) {
          if (emptyDiffOverride) {
            appendSyntheticFinding(
              "Empty diff lacks explicit no-changes justification; changes requested to confirm no code updates were required.",
              "Update the review summary to state no changes were required and confirm task history reflects no_changes.",
            );
          } else if (commentResolution?.open?.length) {
            appendSyntheticFinding(
              `Unresolved comment backlog remains (${formatSlugList(commentResolution.open)}); approval requires resolving these items.`,
              "Resolve or explicitly reopen the listed comment slugs before approving.",
            );
          } else {
            finalDecision = "info_only";
            warnings.push(
              `Review requested changes for ${task.key} but provided no findings; downgrading to info_only.`,
            );
          }
        }
        parsed.decision = finalDecision;
        decision = finalDecision;

        if (allowFollowups) {
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
        }

        let taskStatusUpdate = statusBefore;
        if (!request.dryRun) {
          const approveDecision = parsed.decision === "approve" || parsed.decision === "info_only";
          if (approveDecision) {
            if (diffEmpty) {
              await this.stateService.markCompleted(task, { review_no_changes: true }, statusContext);
              taskStatusUpdate = "completed";
            } else {
              await this.stateService.markReadyToQa(task, undefined, statusContext);
              taskStatusUpdate = "ready_to_qa";
            }
          } else if (parsed.decision === "changes_requested") {
            await this.stateService.markChangesRequested(task, undefined, statusContext);
            taskStatusUpdate = "changes_requested";
          } else if (parsed.decision === "block") {
            await this.stateService.markFailed(task, "review_blocked", statusContext);
            taskStatusUpdate = "failed";
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

        const review = await this.deps.workspaceRepo.createTaskReview({
          taskId: task.id,
          jobId,
          agentId: agent.id,
          modelName: (agent as any).defaultModel ?? undefined,
          decision: parsed.decision,
          summary: parsed.summary ?? undefined,
          findingsJson: parsed.findings ?? [],
          testRecommendationsJson: parsed.testRecommendations ?? [],
          metadata: diffMeta,
          createdAt: new Date().toISOString(),
        });
        await this.stateService.recordReviewMetadata(task, {
          decision: parsed.decision,
          agentId: agent.id,
          modelName: (agent as any).defaultModel ?? null,
          jobId,
          reviewId: review.id,
          diffEmpty,
          changedPaths,
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
        emitReviewEndOnce({
          statusLabel: "FAILED",
          decision: "error",
          findingsCount: findings.length,
          tokensTotal,
        });
        await maybeRateTask(task, taskRun.id, tokensTotal);
        if (isAuthErrorMessage(message)) {
          abortRemainingReason = message;
          warnings.push(`Auth/rate limit error detected; stopping after ${task.key}. ${message}`);
          break;
        }
        continue;
      }

      results.push({
        taskId: task.id,
        taskKey: task.key,
        statusBefore,
        statusAfter,
        decision,
        findings,
        error: reviewErrorCode,
        followupTasks: followupCreated,
      });
      const statusLabel = reviewErrorCode
        ? "FAILED"
        : decision === "approve" || decision === "info_only"
          ? "APPROVED"
          : decision === "block"
            ? "FAILED"
            : decision === "changes_requested"
              ? "CHANGES_REQUESTED"
              : "FAILED";
      emitReviewEndOnce({
        statusLabel,
        decision,
        findingsCount: findings.length,
        tokensTotal,
      });

      await this.deps.jobService.updateJobStatus(jobId, "running", {
        processedItems: state?.reviewed.length ?? 0,
      });
      await maybeRateTask(task, taskRun.id, tokensTotal);
    }

    if (abortRemainingReason) {
      await this.deps.jobService.updateJobStatus(jobId, "failed", {
        processedItems: state?.reviewed.length ?? 0,
        totalItems: selectedTaskIds.length,
        errorSummary: AUTH_ERROR_REASON,
      });
      await this.deps.jobService.finishCommandRun(commandRun.id, "failed", abortRemainingReason);
      return { jobId, commandRunId: commandRun.id, tasks: results, warnings };
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
