import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { GatewayAgentService, type GatewayAgentResult } from "../agents/GatewayAgentService.js";
import {
  buildGatewayHandoffContent,
  buildGatewayHandoffDocdexUsage,
  withGatewayHandoff,
  writeGatewayHandoffFile,
} from "../agents/GatewayHandoff.js";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService, type JobState } from "../jobs/JobService.js";
import { TaskSelectionFilters, TaskSelectionPlan, TaskSelectionService } from "./TaskSelectionService.js";
import { WorkOnTasksService, type WorkOnTasksResult } from "./WorkOnTasksService.js";
import { CodeReviewService, type CodeReviewResult } from "../review/CodeReviewService.js";
import { QaTasksService, type QaTasksResponse } from "./QaTasksService.js";

const DEFAULT_STATUS_FILTER = ["not_started", "in_progress", "ready_to_review", "ready_to_qa"];
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "failed"]);
const BLOCKED_STATUSES = new Set(["blocked"]);
const RETRYABLE_BLOCK_REASONS = new Set([
  "missing_patch",
  "patch_failed",
  "tests_not_configured",
  "tests_failed",
  "no_changes",
  "qa_infra_issue",
  "review_blocked",
]);
const ESCALATION_REASONS = new Set(["missing_patch", "patch_failed", "tests_failed", "agent_timeout"]);
const NO_CHANGE_REASON = "no_changes";
const DONE_DEPENDENCY_STATUSES = new Set(["completed", "cancelled"]);
const HEARTBEAT_INTERVAL_MS = 30000;

type StepName = "work" | "review" | "qa";

type AgentSelectionOptions = {
  avoidAgents?: string[];
  forceStronger?: boolean;
};

type StepOutcome = {
  step: StepName;
  status: "succeeded" | "failed" | "blocked" | "skipped";
  decision?: string;
  outcome?: string;
  error?: string;
  chosenAgent?: string;
  ratingSummary?: RatingSummary;
};

type FailureRecord = {
  step: StepName;
  agent: string;
  reason: string;
  attempt: number;
  timestamp: string;
};

type RatingSummary = {
  step: StepName;
  agent: string;
  rating?: number;
  maxComplexity?: number;
  runScore?: number;
  qualityScore?: number;
};

type TaskProgress = {
  taskKey: string;
  attempts: number;
  status: "pending" | "completed" | "blocked" | "failed" | "skipped";
  lastStep?: StepName;
  lastError?: string;
  lastDecision?: string;
  lastOutcome?: string;
  chosenAgents: { work?: string; review?: string; qa?: string };
  failureHistory?: FailureRecord[];
  ratings?: RatingSummary[];
};

type GatewayTrioState = {
  schema_version: 1;
  job_id: string;
  command_run_id: string;
  cycle: number;
  tasks: Record<string, TaskProgress>;
};

export interface GatewayTrioRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  maxIterations?: number;
  maxCycles?: number;
  onJobStart?: (jobId: string, commandRunId: string) => void;
  gatewayAgentName?: string;
  workAgentName?: string;
  reviewAgentName?: string;
  qaAgentName?: string;
  maxDocs?: number;
  agentStream?: boolean;
  noCommit?: boolean;
  dryRun?: boolean;
  reviewBase?: string;
  maxAgentSeconds?: number;
  qaProfileName?: string;
  qaLevel?: string;
  qaTestCommand?: string;
  qaMode?: "auto" | "manual";
  qaFollowups?: "auto" | "none" | "prompt";
  qaResult?: "pass" | "fail" | "blocked";
  qaNotes?: string;
  qaEvidenceUrl?: string;
  qaAllowDirty?: boolean;
  resumeJobId?: string;
  rateAgents?: boolean;
  escalateOnNoChange?: boolean;
}

export interface GatewayTrioTaskSummary {
  taskKey: string;
  attempts: number;
  status: TaskProgress["status"];
  lastStep?: StepName;
  lastDecision?: string;
  lastOutcome?: string;
  lastError?: string;
  chosenAgents: TaskProgress["chosenAgents"];
  ratings?: RatingSummary[];
}

export interface GatewayTrioResult {
  jobId: string;
  commandRunId: string;
  tasks: GatewayTrioTaskSummary[];
  warnings: string[];
  blocked: string[];
  failed: string[];
  skipped: string[];
}

export class GatewayTrioService {
  private selectionService: TaskSelectionService;
  private projectKeyCache = new Map<string, string>();

  private constructor(
    private workspace: WorkspaceResolution,
    private deps: {
      workspaceRepo: WorkspaceRepository;
      jobService: JobService;
      gatewayService: GatewayAgentService;
      workService: WorkOnTasksService;
      reviewService: CodeReviewService;
      qaService: QaTasksService;
      selectionService?: TaskSelectionService;
    },
  ) {
    this.selectionService =
      deps.selectionService ?? new TaskSelectionService(workspace, deps.workspaceRepo);
  }

  static async create(workspace: WorkspaceResolution, options: { noTelemetry?: boolean } = {}): Promise<GatewayTrioService> {
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo);
    const gatewayService = await GatewayAgentService.create(workspace);
    const workService = await WorkOnTasksService.create(workspace);
    const reviewService = await CodeReviewService.create(workspace);
    const qaService = await QaTasksService.create(workspace, { noTelemetry: options.noTelemetry ?? false });
    const selectionService = new TaskSelectionService(workspace, workspaceRepo);
    return new GatewayTrioService(workspace, {
      workspaceRepo,
      jobService,
      gatewayService,
      workService,
      reviewService,
      qaService,
      selectionService,
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
    await maybeClose(this.selectionService);
    await maybeClose(this.deps.gatewayService);
    await maybeClose(this.deps.workService);
    await maybeClose(this.deps.reviewService);
    await maybeClose(this.deps.qaService);
    await maybeClose(this.deps.jobService);
    await maybeClose(this.deps.workspaceRepo);
  }

  private trioDir(jobId: string): string {
    return path.join(this.workspace.workspaceRoot, ".mcoda", "jobs", jobId, "gateway-trio");
  }

  private statePath(jobId: string): string {
    return path.join(this.trioDir(jobId), "state.json");
  }

  private async writeState(state: GatewayTrioState): Promise<void> {
    await PathHelper.ensureDir(this.trioDir(state.job_id));
    await fs.writeFile(this.statePath(state.job_id), JSON.stringify(state, null, 2), "utf8");
  }

  private async loadState(jobId: string): Promise<GatewayTrioState | undefined> {
    try {
      const raw = await fs.readFile(this.statePath(jobId), "utf8");
      return JSON.parse(raw) as GatewayTrioState;
    } catch {
      return undefined;
    }
  }

  private async readManifest(jobId: string): Promise<Record<string, unknown> | undefined> {
    const manifestPath = path.join(this.workspace.workspaceRoot, ".mcoda", "jobs", jobId, "manifest.json");
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private async cleanupExpiredTaskLocks(warnings: string[]): Promise<void> {
    const cleared = await this.deps.workspaceRepo.cleanupExpiredTaskLocks();
    if (cleared.length > 0) {
      warnings.push(`Cleared ${cleared.length} expired task lock(s): ${cleared.join(", ")}`);
    }
  }

  private assertResumeAllowed(job: any, manifest?: Record<string, unknown>): void {
    const state = job.jobState ?? job.state ?? job.status ?? "unknown";
    if (["completed", "cancelled"].includes(state)) {
      throw new Error(`Job ${job.id} is ${state}; cannot resume.`);
    }
    if (["running", "queued", "checkpointing"].includes(state)) {
      throw new Error(`Job ${job.id} is ${state}; wait for it to finish or cancel before resuming.`);
    }
    const supported =
      job.resumeSupported ?? job.resume_supported ?? (job.payload as any)?.resumeSupported ?? (job.payload as any)?.resume_supported;
    if (supported === 0 || supported === false) {
      throw new Error(`Job ${job.id} does not support resume.`);
    }
    if (!manifest) {
      throw new Error(`Missing manifest for job ${job.id}; cannot resume safely.`);
    }
    const manifestJobId = (manifest as any).job_id ?? (manifest as any).id;
    if (manifestJobId && manifestJobId !== job.id) {
      throw new Error(`Checkpoint manifest for ${job.id} does not match job id (${manifestJobId}); aborting resume.`);
    }
    const manifestType = (manifest as any).type ?? (manifest as any).job_type;
    if (manifestType && manifestType !== job.type) {
      throw new Error(`Checkpoint manifest type (${manifestType}) does not match job type (${job.type}); cannot resume.`);
    }
    const manifestCommand = (manifest as any).command ?? (manifest as any).command_name ?? (manifest as any).commandName;
    if (manifestCommand && job.commandName && manifestCommand !== job.commandName) {
      throw new Error(`Checkpoint manifest command (${manifestCommand}) does not match job command (${job.commandName}); cannot resume.`);
    }
  }

  private async writeHandoffArtifact(
    jobId: string,
    taskKey: string,
    step: StepName,
    attempt: number,
    content: string,
  ): Promise<string> {
    const dir = path.join(this.trioDir(jobId), "handoffs");
    await PathHelper.ensureDir(dir);
    const safeKey = taskKey.replace(/[^a-z0-9_-]+/gi, "_");
    const filename = `${String(attempt).padStart(2, "0")}-${safeKey}-${step}.md`;
    const target = path.join(dir, filename);
    await fs.writeFile(target, content, "utf8");
    return target;
  }

  private async prepareHandoff(
    jobId: string,
    taskKey: string,
    step: StepName,
    attempt: number,
    content: string,
  ): Promise<string> {
    const safeKey = taskKey.replace(/[^a-z0-9_-]+/gi, "_");
    const handoffId = `${safeKey}-${step}-${String(attempt).padStart(2, "0")}`;
    const handoffPath = await writeGatewayHandoffFile(this.workspace.workspaceRoot, handoffId, content, "gateway-trio");
    await this.writeHandoffArtifact(jobId, taskKey, step, attempt, content);
    return handoffPath;
  }

  private async projectKeyForTask(projectId?: string): Promise<string | undefined> {
    if (!projectId) return undefined;
    if (this.projectKeyCache.has(projectId)) return this.projectKeyCache.get(projectId);
    const project = await this.deps.workspaceRepo.getProjectById(projectId);
    if (!project) return undefined;
    this.projectKeyCache.set(projectId, project.key);
    return project.key;
  }

  private async seedExplicitTasks(state: GatewayTrioState, explicitTasks: Set<string>, warnings: string[]): Promise<void> {
    for (const taskKey of explicitTasks) {
      if (state.tasks[taskKey]) continue;
      const task = await this.deps.workspaceRepo.getTaskByKey(taskKey);
      if (!task) {
        warnings.push(`Explicit task ${taskKey} not found; skipping.`);
        continue;
      }
      this.ensureProgress(state, taskKey);
    }
  }

  private ensureProgress(state: GatewayTrioState, taskKey: string): TaskProgress {
    const existing = state.tasks[taskKey];
    if (existing) {
      if (!existing.chosenAgents) existing.chosenAgents = {};
      if (!existing.failureHistory) existing.failureHistory = [];
      return existing;
    }
    const created: TaskProgress = {
      taskKey,
      attempts: 0,
      status: "pending",
      chosenAgents: {},
      failureHistory: [],
    };
    state.tasks[taskKey] = created;
    return created;
  }

  private hasReachedMaxIterations(progress: TaskProgress | undefined, maxIterations?: number): boolean {
    if (maxIterations === undefined) return false;
    const attempts = progress?.attempts ?? 0;
    return attempts >= maxIterations;
  }

  private hasIterationsRemaining(progress: TaskProgress, maxIterations?: number): boolean {
    if (maxIterations === undefined) return true;
    return progress.attempts < maxIterations;
  }

  private async reopenRetryableBlockedTasks(
    state: GatewayTrioState,
    explicitTasks: Set<string>,
    maxIterations: number | undefined,
    warnings: string[],
  ): Promise<void> {
    const keys = new Set<string>([...explicitTasks, ...Object.keys(state.tasks)]);
    for (const taskKey of keys) {
      const progress = state.tasks[taskKey];
      if (progress?.status === "completed") continue;
      if (this.hasReachedMaxIterations(progress, maxIterations)) continue;
      const task = await this.deps.workspaceRepo.getTaskByKey(taskKey);
      if (!task) continue;
      const status = this.normalizeStatus(task.status);
      const metadata = (task.metadata as Record<string, unknown> | undefined) ?? {};
      const blockedReason = typeof metadata.blocked_reason === "string" ? metadata.blocked_reason : undefined;
      if (status === "blocked") {
        if (!blockedReason) continue;
        const testsFailedCount = this.countFailures(progress, "work", "tests_failed");
        if (blockedReason === "tests_failed" && testsFailedCount >= 2) {
          warnings.push(`Task ${taskKey} remains blocked after repeated tests_failed; skipping reopen.`);
          continue;
        }
        if (blockedReason === "dependency_not_ready") {
          const depsReady = await this.dependenciesReady(task.id, warnings);
          if (!depsReady) continue;
        } else if (!RETRYABLE_BLOCK_REASONS.has(blockedReason)) {
          continue;
        }
      } else if (progress?.status !== "failed") {
        continue;
      }
      const nextMetadata = { ...metadata };
      delete nextMetadata.blocked_reason;
      if (status === "blocked") {
        await this.deps.workspaceRepo.updateTask(task.id, {
          status: "in_progress",
          metadata: nextMetadata,
        });
      }
      if (progress) {
        progress.status = "pending";
        progress.lastError = undefined;
        state.tasks[taskKey] = progress;
      }
      warnings.push(
        status === "blocked"
          ? `Reopened blocked task ${taskKey} (reason=${blockedReason}) for retry.`
          : `Reopened failed task ${taskKey} for retry (attempts=${progress?.attempts ?? 0}${
              maxIterations !== undefined ? `/${maxIterations}` : ""
            }).`,
      );
    }
  }

  private async dependenciesReady(taskId: string, warnings: string[]): Promise<boolean> {
    const deps = await this.deps.workspaceRepo.getTaskDependencies([taskId]);
    if (!deps.length) return true;
    const depIds = deps.map((dep) => dep.dependsOnTaskId).filter((id): id is string => Boolean(id));
    if (!depIds.length) return true;
    const depTasks = await this.deps.workspaceRepo.getTasksByIds(depIds);
    const depMap = new Map(depTasks.map((task) => [task.id, task]));
    for (const depId of depIds) {
      const depTask = depMap.get(depId);
      if (!depTask) {
        warnings.push(`Dependency ${depId} not found for task ${taskId}; treating as not ready.`);
        return false;
      }
      const status = this.normalizeStatus(depTask.status);
      if (!status || !DONE_DEPENDENCY_STATUSES.has(status)) return false;
    }
    return true;
  }

  private normalizeStatus(status?: string): string | undefined {
    return status ? status.toLowerCase().trim() : undefined;
  }

  private resolveRequest(request: GatewayTrioRequest, payload?: Record<string, unknown>): GatewayTrioRequest {
    if (!payload) return request;
    const raw = payload as any;
    const payloadTasks = Array.isArray(raw.tasks) ? raw.tasks : undefined;
    const payloadStatuses = Array.isArray(raw.statusFilter) ? raw.statusFilter : undefined;
    return {
      ...request,
      projectKey: request.projectKey ?? raw.projectKey,
      epicKey: request.epicKey ?? raw.epicKey,
      storyKey: request.storyKey ?? raw.storyKey,
      taskKeys: request.taskKeys && request.taskKeys.length ? request.taskKeys : payloadTasks,
      statusFilter: request.statusFilter && request.statusFilter.length ? request.statusFilter : payloadStatuses,
      limit: request.limit ?? raw.limit,
      parallel: request.parallel ?? raw.parallel,
      maxIterations: request.maxIterations ?? raw.maxIterations,
      maxCycles: request.maxCycles ?? raw.maxCycles,
      gatewayAgentName: request.gatewayAgentName ?? raw.gatewayAgentName,
      workAgentName: request.workAgentName ?? raw.workAgentName,
      reviewAgentName: request.reviewAgentName ?? raw.reviewAgentName,
      qaAgentName: request.qaAgentName ?? raw.qaAgentName,
      maxDocs: request.maxDocs ?? raw.maxDocs,
      agentStream: request.agentStream ?? raw.agentStream,
      noCommit: request.noCommit ?? raw.noCommit,
      dryRun: request.dryRun ?? raw.dryRun,
      reviewBase: request.reviewBase ?? raw.reviewBase,
      maxAgentSeconds: request.maxAgentSeconds ?? raw.maxAgentSeconds,
      qaProfileName: request.qaProfileName ?? raw.qaProfileName,
      qaLevel: request.qaLevel ?? raw.qaLevel,
      qaTestCommand: request.qaTestCommand ?? raw.qaTestCommand,
      qaMode: request.qaMode ?? raw.qaMode,
      qaFollowups: request.qaFollowups ?? raw.qaFollowups,
      qaResult: request.qaResult ?? raw.qaResult,
      qaNotes: request.qaNotes ?? raw.qaNotes,
      qaEvidenceUrl: request.qaEvidenceUrl ?? raw.qaEvidenceUrl,
      qaAllowDirty: request.qaAllowDirty ?? raw.qaAllowDirty,
      escalateOnNoChange: request.escalateOnNoChange ?? raw.escalateOnNoChange,
    };
  }

  private async buildStatusFilter(
    request: GatewayTrioRequest,
    warnings: string[],
  ): Promise<string[]> {
    const base = request.statusFilter && request.statusFilter.length ? request.statusFilter : DEFAULT_STATUS_FILTER;
    const normalized = new Set(base.map((s) => this.normalizeStatus(s)).filter(Boolean) as string[]);
    const explicit = request.taskKeys ?? [];
    for (const key of explicit) {
      const task = await this.deps.workspaceRepo.getTaskByKey(key);
      if (!task) {
        warnings.push(`Task not found: ${key}`);
        continue;
      }
      const status = this.normalizeStatus(task.status);
      if (!status) continue;
      if (TERMINAL_STATUSES.has(status)) {
        warnings.push(`Skipping terminal task ${key} (${status}).`);
        continue;
      }
      if (!normalized.has(status)) normalized.add(status);
    }
    return Array.from(normalized);
  }

  private async refreshTaskStatus(taskKey: string, warnings: string[]): Promise<string | undefined> {
    const task = await this.deps.workspaceRepo.getTaskByKey(taskKey);
    if (!task) {
      warnings.push(`Task ${taskKey} not found while refreshing status.`);
      return undefined;
    }
    return this.normalizeStatus(task.status);
  }

  private parseWorkResult(taskKey: string, result: WorkOnTasksResult): StepOutcome {
    const entry = result.results.find((r) => r.taskKey === taskKey);
    if (!entry) {
      return { step: "work", status: "failed", error: "Task not processed by work-on-tasks" };
    }
    if (entry.status === "succeeded") {
      if (entry.notes === "no_changes") return { step: "work", status: "failed", error: "no_changes" };
      return { step: "work", status: "succeeded" };
    }
    if (entry.status === "blocked") return { step: "work", status: "blocked", error: entry.notes };
    if (entry.status === "skipped") return { step: "work", status: "skipped", error: entry.notes };
    return { step: "work", status: "failed", error: entry.notes };
  }

  private parseReviewResult(taskKey: string, result: CodeReviewResult): StepOutcome {
    const entry = result.tasks.find((t) => t.taskKey === taskKey);
    if (!entry) {
      return { step: "review", status: "failed", error: "Task not processed by code-review" };
    }
    if (entry.error) {
      return { step: "review", status: "failed", error: entry.error };
    }
    const decision = entry.decision ?? "error";
    if (decision === "approve" || decision === "info_only") return { step: "review", status: "succeeded", decision };
    if (decision === "block") return { step: "review", status: "blocked", decision };
    return { step: "review", status: "failed", decision };
  }

  private parseQaResult(taskKey: string, result: QaTasksResponse): StepOutcome {
    const entry = result.results.find((r) => r.taskKey === taskKey);
    if (!entry) {
      return { step: "qa", status: "failed", error: "Task not processed by qa-tasks" };
    }
    if (entry.outcome === "pass") return { step: "qa", status: "succeeded", outcome: entry.outcome };
    if (entry.outcome === "infra_issue") return { step: "qa", status: "blocked", outcome: entry.outcome };
    if (entry.outcome === "fix_required" || entry.outcome === "unclear") {
      return { step: "qa", status: "failed", outcome: entry.outcome };
    }
    return { step: "qa", status: "failed", outcome: entry.outcome };
  }

  private shouldRetryAfter(step: StepOutcome): boolean {
    if (step.status === "blocked" || step.status === "skipped") return false;
    return step.status !== "succeeded";
  }

  private escalationReasons(escalateOnNoChange: boolean): Set<string> {
    const reasons = new Set(ESCALATION_REASONS);
    if (escalateOnNoChange) reasons.add(NO_CHANGE_REASON);
    return reasons;
  }

  private recordFailure(progress: TaskProgress, step: StepOutcome, attempt: number): void {
    if (step.status !== "failed" && step.status !== "blocked") return;
    const reason = step.error ?? step.decision ?? step.outcome;
    const agent = step.chosenAgent;
    if (!reason || !agent) return;
    const history = progress.failureHistory ?? [];
    history.push({ step: step.step, agent, reason, attempt, timestamp: new Date().toISOString() });
    progress.failureHistory = history;
  }

  private countFailures(progress: TaskProgress | undefined, step: StepName, reason: string): number {
    if (!progress?.failureHistory?.length) return 0;
    return progress.failureHistory.filter((failure) => failure.step === step && failure.reason === reason).length;
  }

  private prioritizeFeedbackTasks(
    ordered: TaskSelectionPlan["ordered"],
    state: GatewayTrioState,
  ): TaskSelectionPlan["ordered"] {
    const feedback = new Set<string>();
    for (const progress of Object.values(state.tasks)) {
      if (progress.lastDecision === "changes_requested") {
        feedback.add(progress.taskKey);
        continue;
      }
      if (progress.lastOutcome === "fix_required" || progress.lastOutcome === "unclear") {
        feedback.add(progress.taskKey);
      }
    }
    if (feedback.size === 0) return ordered;
    const prioritized: TaskSelectionPlan["ordered"] = [];
    const remaining: TaskSelectionPlan["ordered"] = [];
    for (const entry of ordered) {
      if (feedback.has(entry.task.key)) {
        prioritized.push(entry);
      } else {
        remaining.push(entry);
      }
    }
    return [...prioritized, ...remaining];
  }

  private buildAgentOptions(
    progress: TaskProgress,
    step: StepName,
    request: GatewayTrioRequest,
  ): { avoidAgents: string[]; forceStronger: boolean } {
    const reasons = this.escalationReasons(request.escalateOnNoChange !== false);
    const avoid = new Set<string>();
    const history = progress.failureHistory ?? [];
    for (const failure of history) {
      if (failure.step !== step) continue;
      if (!reasons.has(failure.reason)) continue;
      avoid.add(failure.agent);
    }
    const avoidAgents = Array.from(avoid);
    return { avoidAgents, forceStronger: avoidAgents.length > 0 };
  }

  private recordRating(progress: TaskProgress, summary: RatingSummary | undefined): void {
    if (!summary) return;
    const existing = progress.ratings ?? [];
    const next = existing.filter((entry) => entry.step !== summary.step);
    next.push(summary);
    progress.ratings = next;
  }

  private async loadRatingSummary(
    jobId: string | undefined,
    step: StepName,
    agent: string,
  ): Promise<RatingSummary | undefined> {
    if (!jobId) return undefined;
    try {
      const payload = await fs.readFile(path.join(this.workspace.workspaceRoot, ".mcoda", "jobs", jobId, "rating.json"), "utf8");
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const rating = typeof parsed.rating === "number" ? parsed.rating : undefined;
      const maxComplexity = typeof parsed.maxComplexity === "number" ? parsed.maxComplexity : undefined;
      const runScore = typeof parsed.runScore === "number" ? parsed.runScore : undefined;
      const qualityScore = typeof parsed.qualityScore === "number" ? parsed.qualityScore : undefined;
      return { step, agent, rating, maxComplexity, runScore, qualityScore };
    } catch {
      return undefined;
    }
  }

  private async runStepWithTimeout(
    step: StepName,
    jobId: string,
    taskKey: string,
    attempt: number,
    maxAgentSeconds: number | undefined,
    fn: (signal: AbortSignal) => Promise<StepOutcome>,
  ): Promise<StepOutcome> {
    await this.deps.jobService.writeCheckpoint(jobId, {
      stage: `task:${taskKey}:${step}:start`,
      timestamp: new Date().toISOString(),
      details: { taskKey, attempt, step },
    });
    const timeoutMs = typeof maxAgentSeconds === "number" && maxAgentSeconds > 0 ? maxAgentSeconds * 1000 : undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const controller = new AbortController();
    const heartbeat = setInterval(() => {
      void this.deps.jobService.writeCheckpoint(jobId, {
        stage: `task:${taskKey}:${step}:heartbeat`,
        timestamp: new Date().toISOString(),
        details: { taskKey, attempt, step },
      });
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeat.unref === "function") {
      heartbeat.unref();
    }
    try {
      if (timeoutMs) {
        const timeoutPromise = new Promise<StepOutcome>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort("agent_timeout");
            reject(new Error("agent_timeout"));
          }, timeoutMs);
        });
        return await Promise.race([fn(controller.signal), timeoutPromise]);
      }
      return await fn(controller.signal);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      return { step, status: "failed", error: message === "agent_timeout" ? "agent_timeout" : message };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      clearInterval(heartbeat);
    }
  }

  private async runGateway(
    job: string,
    taskKey: string,
    projectKey: string | undefined,
    request: GatewayTrioRequest,
    agentOptions?: AgentSelectionOptions,
  ): Promise<GatewayAgentResult> {
    return this.deps.gatewayService.run({
      workspace: this.workspace,
      job,
      projectKey,
      taskKeys: [taskKey],
      gatewayAgentName: request.gatewayAgentName,
      maxDocs: request.maxDocs,
      agentStream: request.agentStream,
      rateAgents: request.rateAgents,
      avoidAgents: agentOptions?.avoidAgents,
      forceStronger: agentOptions?.forceStronger,
    });
  }

  private async runWorkStep(
    jobId: string,
    attempt: number,
    taskKey: string,
    projectKey: string | undefined,
    statusFilter: string[],
    request: GatewayTrioRequest,
    warnings: string[],
    agentOptions: AgentSelectionOptions,
    abortSignal?: AbortSignal,
    onResolvedAgent?: (agent: string) => Promise<void> | void,
  ): Promise<StepOutcome> {
    let gateway: GatewayAgentResult | undefined;
    let handoff: string;
    let resolvedAgent: string | undefined;
    try {
      gateway = await this.runGateway("work-on-tasks", taskKey, projectKey, request, agentOptions);
      handoff = buildGatewayHandoffContent(gateway);
      resolvedAgent = request.workAgentName ?? gateway.chosenAgent.agentSlug;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!request.workAgentName) throw error;
      resolvedAgent = request.workAgentName;
      handoff = [
        "# Gateway Handoff",
        "",
        `Gateway agent failed; proceeding with override agent ${resolvedAgent}.`,
        `Error: ${message}`,
        "",
        buildGatewayHandoffDocdexUsage(),
      ].join("\n");
      warnings.push(`Gateway agent failed for work ${taskKey}; using override ${resolvedAgent}: ${message}`);
    }
    if (!resolvedAgent) {
      throw new Error(`No agent resolved for work step on ${taskKey}`);
    }
    if (onResolvedAgent) {
      await onResolvedAgent(resolvedAgent);
    }
    const handoffPath = await this.prepareHandoff(jobId, taskKey, "work", attempt, handoff);
    const result = await withGatewayHandoff(handoffPath, async () =>
      this.deps.workService.workOnTasks({
        workspace: this.workspace,
        projectKey,
        taskKeys: [taskKey],
        statusFilter,
        limit: 1,
        noCommit: request.noCommit,
        dryRun: request.dryRun,
        agentName: resolvedAgent,
        agentStream: request.agentStream,
        rateAgents: request.rateAgents,
        abortSignal,
        maxAgentSeconds: request.maxAgentSeconds,
      }),
    );
    const parsed = this.parseWorkResult(taskKey, result);
    const ratingSummary = request.rateAgents
      ? await this.loadRatingSummary(result.jobId, "work", resolvedAgent)
      : undefined;
    return { ...parsed, chosenAgent: resolvedAgent, ratingSummary };
  }

  private async runReviewStep(
    jobId: string,
    attempt: number,
    taskKey: string,
    projectKey: string | undefined,
    statusFilter: string[],
    request: GatewayTrioRequest,
    warnings: string[],
    agentOptions: AgentSelectionOptions,
    abortSignal?: AbortSignal,
    onResolvedAgent?: (agent: string) => Promise<void> | void,
  ): Promise<StepOutcome> {
    let gateway: GatewayAgentResult | undefined;
    let handoff: string;
    let resolvedAgent: string | undefined;
    try {
      gateway = await this.runGateway("code-review", taskKey, projectKey, request, agentOptions);
      handoff = buildGatewayHandoffContent(gateway);
      resolvedAgent = request.reviewAgentName ?? gateway.chosenAgent.agentSlug;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!request.reviewAgentName) throw error;
      resolvedAgent = request.reviewAgentName;
      handoff = [
        "# Gateway Handoff",
        "",
        `Gateway agent failed; proceeding with override agent ${resolvedAgent}.`,
        `Error: ${message}`,
        "",
        buildGatewayHandoffDocdexUsage(),
      ].join("\n");
      warnings.push(`Gateway agent failed for review ${taskKey}; using override ${resolvedAgent}: ${message}`);
    }
    if (!resolvedAgent) {
      throw new Error(`No agent resolved for review step on ${taskKey}`);
    }
    if (onResolvedAgent) {
      await onResolvedAgent(resolvedAgent);
    }
    const handoffPath = await this.prepareHandoff(jobId, taskKey, "review", attempt, handoff);
    const result = await withGatewayHandoff(handoffPath, async () =>
      this.deps.reviewService.reviewTasks({
        workspace: this.workspace,
        projectKey,
        taskKeys: [taskKey],
        statusFilter,
        baseRef: request.reviewBase,
        dryRun: request.dryRun,
        agentName: resolvedAgent,
        agentStream: request.agentStream,
        rateAgents: request.rateAgents,
        abortSignal,
      }),
    );
    const parsed = this.parseReviewResult(taskKey, result);
    const ratingSummary = request.rateAgents
      ? await this.loadRatingSummary(result.jobId, "review", resolvedAgent)
      : undefined;
    return { ...parsed, chosenAgent: resolvedAgent, ratingSummary };
  }

  private async runQaStep(
    jobId: string,
    attempt: number,
    taskKey: string,
    projectKey: string | undefined,
    statusFilter: string[],
    request: GatewayTrioRequest,
    warnings: string[],
    agentOptions: AgentSelectionOptions,
    abortSignal?: AbortSignal,
    onResolvedAgent?: (agent: string) => Promise<void> | void,
  ): Promise<StepOutcome> {
    let gateway: GatewayAgentResult | undefined;
    let handoff: string;
    let resolvedAgent: string | undefined;
    try {
      gateway = await this.runGateway("qa-tasks", taskKey, projectKey, request, agentOptions);
      handoff = buildGatewayHandoffContent(gateway);
      resolvedAgent = request.qaAgentName ?? gateway.chosenAgent.agentSlug;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!request.qaAgentName) throw error;
      resolvedAgent = request.qaAgentName;
      handoff = [
        "# Gateway Handoff",
        "",
        `Gateway agent failed; proceeding with override agent ${resolvedAgent}.`,
        `Error: ${message}`,
        "",
        buildGatewayHandoffDocdexUsage(),
      ].join("\n");
      warnings.push(`Gateway agent failed for QA ${taskKey}; using override ${resolvedAgent}: ${message}`);
    }
    if (!resolvedAgent) {
      throw new Error(`No agent resolved for QA step on ${taskKey}`);
    }
    if (onResolvedAgent) {
      await onResolvedAgent(resolvedAgent);
    }
    const handoffPath = await this.prepareHandoff(jobId, taskKey, "qa", attempt, handoff);
    const result = await withGatewayHandoff(handoffPath, async () =>
      this.deps.qaService.run({
        workspace: this.workspace,
        projectKey,
        taskKeys: [taskKey],
        statusFilter,
        mode: request.qaMode ?? "auto",
        profileName: request.qaProfileName,
        level: request.qaLevel,
        testCommand: request.qaTestCommand,
        agentName: resolvedAgent,
        agentStream: request.agentStream,
        rateAgents: request.rateAgents,
        createFollowupTasks: request.qaFollowups ?? "auto",
        dryRun: request.dryRun,
        result: request.qaResult,
        notes: request.qaNotes,
        evidenceUrl: request.qaEvidenceUrl,
        allowDirty: request.qaAllowDirty,
        abortSignal,
      }),
    );
    const parsed = this.parseQaResult(taskKey, result);
    const ratingSummary = request.rateAgents
      ? await this.loadRatingSummary(result.jobId, "qa", resolvedAgent)
      : undefined;
    return { ...parsed, chosenAgent: resolvedAgent, ratingSummary };
  }

  private toSummary(state: GatewayTrioState): GatewayTrioTaskSummary[] {
    return Object.values(state.tasks).map((task) => ({
      taskKey: task.taskKey,
      attempts: task.attempts,
      status: task.status,
      lastStep: task.lastStep,
      lastDecision: task.lastDecision,
      lastOutcome: task.lastOutcome,
      lastError: task.lastError,
      chosenAgents: task.chosenAgents,
      ratings: task.ratings,
    }));
  }

  async run(request: GatewayTrioRequest): Promise<GatewayTrioResult> {
    const warnings: string[] = [];
    let resumeJob: any | undefined;
    if (request.resumeJobId) {
      const job = await this.deps.jobService.getJob(request.resumeJobId);
      if (!job) throw new Error(`Job not found: ${request.resumeJobId}`);
      const manifest = await this.readManifest(job.id);
      this.assertResumeAllowed(job, manifest);
      const command = (job.commandName ?? job.type ?? "").toLowerCase();
      if (command !== "gateway-trio") {
        throw new Error(`Job ${request.resumeJobId} is not a gateway-trio job`);
      }
      resumeJob = job;
    }
    const resolvedRequest = this.resolveRequest(request, resumeJob?.payload as Record<string, unknown> | undefined);
    const maxIterations = resolvedRequest.maxIterations;
    const maxCycles = resolvedRequest.maxCycles;
    const maxAgentSeconds = resolvedRequest.maxAgentSeconds;
    if (!resolvedRequest.rateAgents) {
      warnings.push("Agent rating disabled; use --rate-agents to track rating/complexity updates.");
    }
    const statusFilter = await this.buildStatusFilter(resolvedRequest, warnings);
    const commandRun = await this.deps.jobService.startCommandRun("gateway-trio", resolvedRequest.projectKey, {
      taskIds: resolvedRequest.taskKeys,
      jobId: request.resumeJobId,
    });

    let jobId = request.resumeJobId;
    let state: GatewayTrioState | undefined;
    if (request.resumeJobId) {
      state = await this.loadState(request.resumeJobId);
      if (!state) throw new Error(`Missing gateway-trio state for job ${request.resumeJobId}`);
      await this.deps.jobService.updateJobStatus(request.resumeJobId, "running", {
        job_state_detail: "resuming",
      } as any);
    } else {
      const job = await this.deps.jobService.startJob("gateway-trio", commandRun.id, resolvedRequest.projectKey, {
        commandName: "gateway-trio",
        payload: {
          projectKey: resolvedRequest.projectKey,
          epicKey: resolvedRequest.epicKey,
          storyKey: resolvedRequest.storyKey,
          tasks: resolvedRequest.taskKeys,
          statusFilter,
          maxIterations,
          maxCycles,
          limit: resolvedRequest.limit,
          parallel: resolvedRequest.parallel,
          gatewayAgentName: resolvedRequest.gatewayAgentName,
          workAgentName: resolvedRequest.workAgentName,
          reviewAgentName: resolvedRequest.reviewAgentName,
          qaAgentName: resolvedRequest.qaAgentName,
          maxDocs: resolvedRequest.maxDocs,
          agentStream: resolvedRequest.agentStream,
          noCommit: resolvedRequest.noCommit,
          dryRun: resolvedRequest.dryRun,
          reviewBase: resolvedRequest.reviewBase,
          maxAgentSeconds,
          qaProfileName: resolvedRequest.qaProfileName,
          qaLevel: resolvedRequest.qaLevel,
          qaTestCommand: resolvedRequest.qaTestCommand,
          qaMode: resolvedRequest.qaMode,
          qaFollowups: resolvedRequest.qaFollowups,
          qaResult: resolvedRequest.qaResult,
          qaNotes: resolvedRequest.qaNotes,
          qaEvidenceUrl: resolvedRequest.qaEvidenceUrl,
          qaAllowDirty: resolvedRequest.qaAllowDirty,
          escalateOnNoChange: resolvedRequest.escalateOnNoChange,
          resumeSupported: true,
        },
        totalItems: 0,
        processedItems: 0,
      });
      jobId = job.id;
      state = {
        schema_version: 1,
        job_id: job.id,
        command_run_id: commandRun.id,
        cycle: 0,
        tasks: {},
      };
      await this.writeState(state);
    }

    if (!jobId || !state) {
      throw new Error("gateway-trio job initialization failed");
    }
    if (resolvedRequest.onJobStart) {
      resolvedRequest.onJobStart(jobId, commandRun.id);
    }

    await this.cleanupExpiredTaskLocks(warnings);

    const explicitTasks = new Set(resolvedRequest.taskKeys ?? []);
    await this.seedExplicitTasks(state, explicitTasks, warnings);
    await this.writeState(state);
    let cycle = state.cycle ?? 0;

    try {
      while (maxCycles === undefined || cycle < maxCycles) {
        await this.reopenRetryableBlockedTasks(state, explicitTasks, maxIterations, warnings);
        await this.writeState(state);
        const selection = await this.selectionService.selectTasks({
          projectKey: resolvedRequest.projectKey,
          epicKey: resolvedRequest.epicKey,
          storyKey: resolvedRequest.storyKey,
          taskKeys: resolvedRequest.taskKeys,
          statusFilter,
          limit: resolvedRequest.limit,
          parallel: resolvedRequest.parallel,
        });
        const blockedKeys = new Set(selection.blocked.map((t) => t.task.key));
        if (selection.warnings.length) warnings.push(...selection.warnings);

        const ordered = this.prioritizeFeedbackTasks(selection.ordered, state);
        for (const blocked of selection.blocked) {
          const taskKey = blocked.task.key;
          if (explicitTasks.has(taskKey)) continue;
          const progress = this.ensureProgress(state, taskKey);
          progress.status = "skipped";
          progress.lastError = "dependency_blocked";
          state.tasks[taskKey] = progress;
        }
        await this.writeState(state);
        await this.deps.jobService.updateJobStatus(jobId, "running", {
          totalItems: ordered.length,
          processedItems: 0,
        });

        let completedThisCycle = 0;
        let processedThisCycle = 0;
        let attemptedThisCycle = 0;

        for (const entry of ordered) {
          const taskKey = entry.task.key;
          if (blockedKeys.has(taskKey) && !explicitTasks.has(taskKey)) {
            warnings.push(`Task ${taskKey} blocked by dependencies; skipping this cycle.`);
            const progress = this.ensureProgress(state, taskKey);
            progress.status = "skipped";
            progress.lastError = "dependency_blocked";
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            continue;
          }
          const normalizedStatus = this.normalizeStatus(entry.task.status);
          if (normalizedStatus && TERMINAL_STATUSES.has(normalizedStatus)) {
            warnings.push(`Skipping terminal task ${taskKey} (${normalizedStatus}).`);
            continue;
          }

          const progress = this.ensureProgress(state, taskKey);
          if (progress.status === "skipped") {
            progress.status = "pending";
            progress.lastError = undefined;
          }

          if (progress.status === "completed" || progress.status === "blocked") {
            continue;
          }
          if (progress.status === "failed") {
            if (this.hasReachedMaxIterations(progress, maxIterations)) {
              continue;
            }
            progress.status = "pending";
            progress.lastError = undefined;
            state.tasks[taskKey] = progress;
          }

          if (this.hasReachedMaxIterations(progress, maxIterations)) {
            progress.status = "failed";
            progress.lastError = "max_iterations_reached";
            state.tasks[taskKey] = progress;
            if (maxIterations !== undefined) {
              warnings.push(`Task ${taskKey} hit max iterations (${maxIterations}).`);
            }
            continue;
          }

          const attemptIndex = progress.attempts + 1;
          attemptedThisCycle += 1;
          const projectKey = await this.projectKeyForTask(entry.task.projectId);
          const statusBefore = this.normalizeStatus(entry.task.status);
          const workWasSkipped = statusBefore === "ready_to_review" || statusBefore === "ready_to_qa";
          const reviewWasSkipped = statusBefore === "ready_to_qa";

          progress.attempts = attemptIndex;
          progress.lastError = undefined;
          state.tasks[taskKey] = progress;
          await this.writeState(state);

          if (!workWasSkipped) {
            const workAgentOptions = this.buildAgentOptions(progress, "work", resolvedRequest);
            progress.lastStep = "work";
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            const workOutcome = await this.runStepWithTimeout(
              "work",
              jobId,
              taskKey,
              attemptIndex,
              maxAgentSeconds,
              (signal) =>
                this.runWorkStep(
                  jobId,
                  attemptIndex,
                  taskKey,
                  projectKey,
                  statusFilter,
                  resolvedRequest,
                  warnings,
                  workAgentOptions,
                  signal,
                  async (agent) => {
                    progress.chosenAgents.work = agent;
                    state.tasks[taskKey] = progress;
                    await this.writeState(state);
                  },
                ),
            );
            progress.lastStep = "work";
            progress.lastError = workOutcome.error;
            progress.chosenAgents.work = workOutcome.chosenAgent ?? progress.chosenAgents.work;
            this.recordFailure(progress, workOutcome, attemptIndex);
            this.recordRating(progress, workOutcome.ratingSummary);
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            await this.deps.jobService.writeCheckpoint(jobId, {
              stage: `task:${taskKey}:work`,
              timestamp: new Date().toISOString(),
              details: { taskKey, attempt: attemptIndex, outcome: workOutcome },
            });

            if (workOutcome.error === "tests_failed") {
              const testsFailedCount = this.countFailures(progress, "work", "tests_failed");
              if (testsFailedCount >= 2) {
                progress.status = "blocked";
                progress.lastError = "tests_failed";
                state.tasks[taskKey] = progress;
                await this.writeState(state);
                warnings.push(`Task ${taskKey} blocked after repeated tests_failed.`);
                continue;
              }
              warnings.push(`Retrying ${taskKey} after tests_failed with stronger agent.`);
              state.tasks[taskKey] = progress;
              await this.writeState(state);
              continue;
            }

            if (workOutcome.status === "blocked") {
              progress.status = "blocked";
              progress.lastError = workOutcome.error ?? "blocked";
              state.tasks[taskKey] = progress;
              await this.writeState(state);
              continue;
            }
            if (workOutcome.status === "skipped") {
              progress.status = "skipped";
              progress.lastError = workOutcome.error ?? "skipped";
              state.tasks[taskKey] = progress;
              await this.writeState(state);
              continue;
            }
            if (workOutcome.status !== "succeeded") {
              if (this.shouldRetryAfter(workOutcome)) {
                warnings.push(`Retrying ${taskKey} after work step (${workOutcome.status}).`);
                state.tasks[taskKey] = progress;
                await this.writeState(state);
                continue;
              }
            }

            if (!resolvedRequest.dryRun) {
              const statusAfterWork = await this.refreshTaskStatus(taskKey, warnings);
              if (statusAfterWork && statusAfterWork !== "ready_to_review") {
                warnings.push(`Task ${taskKey} status ${statusAfterWork} after work; retrying work step.`);
                continue;
              }
            }
          } else {
            progress.lastStep = "work";
            progress.lastError = undefined;
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            await this.deps.jobService.writeCheckpoint(jobId, {
              stage: `task:${taskKey}:work:skipped`,
              timestamp: new Date().toISOString(),
              details: { taskKey, attempt: attemptIndex, reason: statusBefore ?? "ready" },
            });
          }

          if (!reviewWasSkipped) {
            const reviewAgentOptions = this.buildAgentOptions(progress, "review", resolvedRequest);
            progress.lastStep = "review";
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            const reviewOutcome = await this.runStepWithTimeout(
              "review",
              jobId,
              taskKey,
              attemptIndex,
              maxAgentSeconds,
              (signal) =>
                this.runReviewStep(
                  jobId,
                  attemptIndex,
                  taskKey,
                  projectKey,
                  ["ready_to_review", ...statusFilter],
                  resolvedRequest,
                  warnings,
                  reviewAgentOptions,
                  signal,
                  async (agent) => {
                    progress.chosenAgents.review = agent;
                    state.tasks[taskKey] = progress;
                    await this.writeState(state);
                  },
                ),
            );
            progress.lastStep = "review";
            progress.lastDecision = reviewOutcome.decision;
            progress.lastError = reviewOutcome.error;
            progress.chosenAgents.review = reviewOutcome.chosenAgent ?? progress.chosenAgents.review;
            this.recordFailure(progress, reviewOutcome, attemptIndex);
            this.recordRating(progress, reviewOutcome.ratingSummary);
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            await this.deps.jobService.writeCheckpoint(jobId, {
              stage: `task:${taskKey}:review`,
              timestamp: new Date().toISOString(),
              details: { taskKey, attempt: attemptIndex, outcome: reviewOutcome },
            });

            if (reviewOutcome.status === "blocked") {
              progress.status = "blocked";
              progress.lastError = reviewOutcome.error ?? "blocked";
              state.tasks[taskKey] = progress;
              await this.writeState(state);
              continue;
            }
            if (this.shouldRetryAfter(reviewOutcome)) {
              warnings.push(`Retrying ${taskKey} after review (${reviewOutcome.decision ?? reviewOutcome.status}).`);
              state.tasks[taskKey] = progress;
              await this.writeState(state);
              continue;
            }
            if (!resolvedRequest.dryRun) {
              const statusAfterReview = await this.refreshTaskStatus(taskKey, warnings);
              if (statusAfterReview && statusAfterReview !== "ready_to_qa") {
                warnings.push(`Task ${taskKey} status ${statusAfterReview} after review; retrying work step.`);
                continue;
              }
            }
          } else {
            progress.lastStep = "review";
            progress.lastDecision = "skipped";
            progress.lastError = undefined;
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            await this.deps.jobService.writeCheckpoint(jobId, {
              stage: `task:${taskKey}:review:skipped`,
              timestamp: new Date().toISOString(),
              details: { taskKey, attempt: attemptIndex, reason: statusBefore ?? "ready_to_qa" },
            });
          }

          progress.lastStep = "qa";
          state.tasks[taskKey] = progress;
          await this.writeState(state);
          const qaOutcome = await this.runStepWithTimeout(
            "qa",
            jobId,
            taskKey,
            attemptIndex,
            maxAgentSeconds,
            (signal) =>
              this.runQaStep(
                jobId,
                attemptIndex,
                taskKey,
                projectKey,
                ["ready_to_qa", ...statusFilter],
                resolvedRequest,
                warnings,
                this.buildAgentOptions(progress, "qa", resolvedRequest),
                signal,
                async (agent) => {
                  progress.chosenAgents.qa = agent;
                  state.tasks[taskKey] = progress;
                  await this.writeState(state);
                },
              ),
          );
          progress.lastStep = "qa";
            progress.lastOutcome = qaOutcome.outcome;
            progress.lastError = qaOutcome.error;
            progress.chosenAgents.qa = qaOutcome.chosenAgent ?? progress.chosenAgents.qa;
            this.recordFailure(progress, qaOutcome, attemptIndex);
            this.recordRating(progress, qaOutcome.ratingSummary);
            state.tasks[taskKey] = progress;
            await this.writeState(state);
          await this.deps.jobService.writeCheckpoint(jobId, {
            stage: `task:${taskKey}:qa`,
            timestamp: new Date().toISOString(),
            details: { taskKey, attempt: attemptIndex, outcome: qaOutcome },
          });

          if (qaOutcome.status === "blocked") {
            progress.status = "blocked";
            progress.lastError = qaOutcome.error ?? "blocked";
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            continue;
          }
          if (this.shouldRetryAfter(qaOutcome)) {
            warnings.push(`Retrying ${taskKey} after QA (${qaOutcome.outcome ?? qaOutcome.status}).`);
            state.tasks[taskKey] = progress;
            await this.writeState(state);
            continue;
          }
          if (!resolvedRequest.dryRun) {
            const statusAfterQa = await this.refreshTaskStatus(taskKey, warnings);
            if (statusAfterQa && statusAfterQa !== "completed") {
              warnings.push(`Task ${taskKey} status ${statusAfterQa} after QA; retrying work step.`);
              state.tasks[taskKey] = progress;
              await this.writeState(state);
              continue;
            }
          }

          progress.status = "completed";
          state.tasks[taskKey] = progress;
          await this.writeState(state);
          completedThisCycle += 1;
          processedThisCycle += 1;
          await this.deps.jobService.updateJobStatus(jobId, "running", {
            processedItems: processedThisCycle,
          });
        }

        cycle += 1;
        state.cycle = cycle;
        await this.writeState(state);

        if (attemptedThisCycle === 0) {
          const hasPending = Object.values(state.tasks).some(
            (task) => task.status === "pending" && this.hasIterationsRemaining(task, maxIterations),
          );
          if (hasPending) {
            if (maxCycles === undefined) {
              warnings.push(
                "No tasks attempted in this cycle; pending tasks remain, stopping to avoid infinite loop without max-cycles.",
              );
              break;
            }
            warnings.push("No tasks attempted in this cycle; pending tasks remain, continuing.");
            continue;
          }
          warnings.push("No tasks attempted in this cycle; stopping to avoid infinite loop.");
          break;
        }
      }

      const summaries = this.toSummary(state);
      const blocked = summaries.filter((t) => t.status === "blocked").map((t) => t.taskKey);
      const failed = summaries.filter((t) => t.status === "failed").map((t) => t.taskKey);
      const skipped = summaries.filter((t) => t.status === "skipped").map((t) => t.taskKey);
      const pending = summaries.filter((t) => t.status === "pending").map((t) => t.taskKey);

      const failureCount = failed.length + blocked.length + skipped.length + pending.length;
      const endState: JobState = failureCount === 0 ? "completed" : "partial";
      const errorSummary = failureCount ? `${failureCount} task(s) not fully completed` : undefined;
      await this.deps.jobService.updateJobStatus(jobId, endState, { errorSummary });
      await this.deps.jobService.finishCommandRun(commandRun.id, endState === "completed" ? "succeeded" : "failed", errorSummary);
      await this.deps.jobService.writeCheckpoint(jobId, {
        stage: "completed",
        timestamp: new Date().toISOString(),
        details: { cycle, tasks: summaries },
      });

      return {
        jobId,
        commandRunId: commandRun.id,
        tasks: summaries,
        warnings,
        blocked,
        failed,
        skipped,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.jobService.updateJobStatus(jobId, "failed", { errorSummary: message });
      await this.deps.jobService.finishCommandRun(commandRun.id, "failed", message);
      throw error;
    }
  }
}
