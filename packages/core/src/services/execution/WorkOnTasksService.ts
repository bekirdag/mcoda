import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, VcsClient } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository } from "@mcoda/db";
import { PathHelper } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService, type JobState } from "../jobs/JobService.js";
import { TaskSelectionService, TaskSelectionFilters, TaskSelectionPlan } from "./TaskSelectionService.js";
import { TaskStateService } from "./TaskStateService.js";
import { RoutingService } from "../agents/RoutingService.js";

const exec = promisify(execCb);
const DEFAULT_BASE_BRANCH = "mcoda-dev";
const DEFAULT_TASK_BRANCH_PREFIX = "mcoda/task/";

export interface WorkOnTasksRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  noCommit?: boolean;
  dryRun?: boolean;
  agentName?: string;
  agentStream?: boolean;
  baseBranch?: string;
}

export interface TaskExecutionResult {
  taskKey: string;
  status: "succeeded" | "blocked" | "failed" | "skipped";
  notes?: string;
  branch?: string;
}

export interface WorkOnTasksResult {
  jobId: string;
  commandRunId: string;
  selection: TaskSelectionPlan;
  results: TaskExecutionResult[];
  warnings: string[];
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil((text ?? "").length / 4));

const extractPatches = (output: string): string[] => {
  const matches = [...output.matchAll(/```(?:patch|diff)[\s\S]*?```/g)];
  return matches.map((m) => m[0].replace(/```(?:patch|diff)/, "").replace(/```$/, "").trim()).filter(Boolean);
};

type TaskPhase = "selection" | "context" | "prompt" | "agent" | "apply" | "tests" | "vcs" | "finalize";

const touchedFilesFromPatch = (patch: string): string[] => {
  const files = new Set<string>();
  const regex = /^\+\+\+\s+b\/([^\s]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(patch)) !== null) {
    files.add(match[1]);
  }
  return Array.from(files);
};

const normalizePaths = (workspaceRoot: string, files: string[]): string[] =>
  files.map((f) => path.relative(workspaceRoot, path.isAbsolute(f) ? f : path.join(workspaceRoot, f))).map((f) => f.replace(/\\/g, "/"));
const MCODA_GITIGNORE_ENTRY = ".mcoda/\n";
const WORK_DIR = (jobId: string, workspaceRoot: string) => path.join(workspaceRoot, ".mcoda", "jobs", jobId, "work");

export class WorkOnTasksService {
  private selectionService: TaskSelectionService;
  private stateService: TaskStateService;
  private taskLogSeq = new Map<string, number>();
  private vcs: VcsClient;
  private routingService: RoutingService;

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
    },
  ) {
    this.selectionService = deps.selectionService ?? new TaskSelectionService(workspace, deps.workspaceRepo);
    this.stateService = deps.stateService ?? new TaskStateService(deps.workspaceRepo);
    this.vcs = deps.vcsClient ?? new VcsClient();
    this.routingService = deps.routingService;
  }

  private async loadPrompts(agentId: string): Promise<{
    jobPrompt?: string;
    characterPrompt?: string;
    commandPrompt?: string;
  }> {
    if (!("getPrompts" in this.deps.agentService)) return {};
    const prompts = await (this.deps.agentService as any).getPrompts(agentId);
    return {
      jobPrompt: prompts?.jobPrompt,
      characterPrompt: prompts?.characterPrompt,
      commandPrompt: prompts?.commandPrompts?.["work-on-tasks"],
    };
  }

  private async ensureMcoda(): Promise<void> {
    await PathHelper.ensureDir(this.workspace.mcodaDir);
    const gitignorePath = path.join(this.workspace.workspaceRoot, ".gitignore");
    try {
      const content = await fs.promises.readFile(gitignorePath, "utf8");
      if (!content.includes(".mcoda/")) {
        await fs.promises.writeFile(gitignorePath, `${content.trimEnd()}\n${MCODA_GITIGNORE_ENTRY}`, "utf8");
      }
    } catch {
      await fs.promises.writeFile(gitignorePath, MCODA_GITIGNORE_ENTRY, "utf8");
    }
  }

  private async writeWorkCheckpoint(jobId: string, data: Record<string, unknown>): Promise<void> {
    const dir = WORK_DIR(jobId, this.workspace.workspaceRoot);
    await fs.promises.mkdir(dir, { recursive: true });
    const target = path.join(dir, "state.json");
    await fs.promises.writeFile(target, JSON.stringify({ ...data, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  }

  private async checkpoint(jobId: string, stage: string, details?: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    await this.deps.jobService.writeCheckpoint(jobId, {
      stage,
      timestamp,
      details,
    });
    await this.writeWorkCheckpoint(jobId, { stage, details, timestamp });
  }

  static async create(workspace: WorkspaceResolution): Promise<WorkOnTasksService> {
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
    return new WorkOnTasksService(workspace, {
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
  }

  private async resolveAgent(agentName?: string) {
    const resolved = await this.routingService.resolveAgentForCommand({
      workspace: this.workspace,
      commandName: "work-on-tasks",
      overrideAgentSlug: agentName,
    });
    return resolved.agent;
  }

  private nextLogSeq(taskRunId: string): number {
    const next = (this.taskLogSeq.get(taskRunId) ?? 0) + 1;
    this.taskLogSeq.set(taskRunId, next);
    return next;
  }

  private async logTask(taskRunId: string, message: string, source?: string, details?: Record<string, unknown>): Promise<void> {
    await this.deps.workspaceRepo.insertTaskLog({
      taskRunId,
      sequence: this.nextLogSeq(taskRunId),
      timestamp: new Date().toISOString(),
      source: source ?? "work-on-tasks",
      message,
      details: details ?? undefined,
    });
  }

  private async recordTokenUsage(params: {
    agentId: string;
    model?: string;
    jobId: string;
    commandRunId: string;
    taskRunId: string;
    taskId: string;
    projectId?: string;
    tokensPrompt: number;
    tokensCompletion: number;
    phase?: string;
    durationSeconds?: number;
  }) {
    const total = params.tokensPrompt + params.tokensCompletion;
    await this.deps.jobService.recordTokenUsage({
      workspaceId: this.workspace.workspaceId,
      agentId: params.agentId,
      modelName: params.model,
      jobId: params.jobId,
      commandRunId: params.commandRunId,
      taskRunId: params.taskRunId,
      taskId: params.taskId,
      projectId: params.projectId,
      tokensPrompt: params.tokensPrompt,
      tokensCompletion: params.tokensCompletion,
      tokensTotal: total,
      durationSeconds: params.durationSeconds ?? null,
      timestamp: new Date().toISOString(),
      metadata: { commandName: "work-on-tasks", phase: params.phase ?? "agent", action: params.phase ?? "agent" },
    });
  }

  private async updateTaskPhase(
    jobId: string,
    taskRunId: string,
    taskKey: string,
    phase: TaskPhase,
    status: "start" | "end" | "error",
    details?: Record<string, unknown>,
  ) {
    const payload = { taskKey, phase, status, ...(details ?? {}) };
    await this.deps.workspaceRepo.updateTaskRun(taskRunId, { runContext: { phase, status } });
    await this.logTask(taskRunId, `${phase}:${status}`, phase, payload);
    await this.checkpoint(jobId, `task:${taskKey}:${phase}:${status}`, payload);
  }

  private async gatherDocContext(projectKey?: string, docLinks: string[] = []): Promise<{ summary: string; warnings: string[] }> {
    const warnings: string[] = [];
    const parts: string[] = [];
    try {
      const docs = await this.deps.docdex.search({ projectKey, profile: "workspace-code" });
      parts.push(
        ...docs
          .slice(0, 5)
          .map((doc) => `- [${doc.docType}] ${doc.title ?? doc.path ?? doc.id}`),
      );
    } catch (error) {
      warnings.push(`docdex search failed: ${(error as Error).message}`);
    }
    for (const link of docLinks) {
      try {
        const doc = await this.deps.docdex.fetchDocumentById(link);
        const excerpt = doc.segments?.[0]?.content?.slice(0, 240);
        parts.push(`- [linked:${doc.docType}] ${doc.title ?? doc.id}${excerpt ? ` — ${excerpt}` : ""}`);
      } catch (error) {
        warnings.push(`docdex fetch failed for ${link}: ${(error as Error).message}`);
      }
    }
    const summary = parts.join("\n");
    return { summary, warnings };
  }

  private buildPrompt(task: TaskSelectionPlan["ordered"][number], docSummary: string, fileScope: string[]): string {
    const deps = task.dependencies.keys.length ? `Depends on: ${task.dependencies.keys.join(", ")}` : "No open dependencies.";
    const acceptance = (task.task.acceptanceCriteria ?? []).join("; ");
    return [
      `Task ${task.task.key}: ${task.task.title}`,
      `Description: ${task.task.description ?? "(none)"}`,
      `Epic: ${task.task.epicKey} (${task.task.epicTitle ?? "n/a"}), Story: ${task.task.storyKey} (${task.task.storyTitle ?? "n/a"})`,
      `Acceptance: ${acceptance || "Refer to SDS/OpenAPI for expected behavior."}`,
      deps,
      `Allowed files: ${fileScope.length ? fileScope.join(", ") : "(not constrained)"}`,
      docSummary ? `Doc context:\n${docSummary}` : "Doc context: none",
      "Produce a concise plan and a patch in unified diff fenced with ```patch```.",
    ].join("\n");
  }

  private async ensureBranches(taskKey: string, baseBranch: string): Promise<{ branch: string; base: string }> {
    const branch = `${DEFAULT_TASK_BRANCH_PREFIX}${taskKey}`;
    await this.vcs.ensureRepo(this.workspace.workspaceRoot);
    await this.vcs.ensureBaseBranch(this.workspace.workspaceRoot, baseBranch);
    const dirty = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcoda = dirty.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcoda.length) {
      throw new Error(`Working tree dirty: ${nonMcoda.join(", ")}`);
    }
    await this.vcs.checkoutBranch(this.workspace.workspaceRoot, baseBranch);
    await this.vcs.createOrCheckoutBranch(this.workspace.workspaceRoot, branch, baseBranch);
    return { branch, base: baseBranch };
  }

  private validateScope(allowed: string[], touched: string[]): { ok: boolean; message?: string } {
    if (!allowed.length) return { ok: true };
    const normalizedAllowed = allowed.map((f) => f.replace(/\\/g, "/"));
    const outOfScope = touched.filter((f) => !normalizedAllowed.some((allowedPath) => f === allowedPath || f.startsWith(`${allowedPath}/`)));
    if (outOfScope.length) {
      return { ok: false, message: `Patch touches files outside allowed scope: ${outOfScope.join(", ")}` };
    }
    return { ok: true };
  }

  private async applyPatches(
    patches: string[],
    cwd: string,
    dryRun: boolean,
  ): Promise<{ touched: string[]; error?: string }> {
    const touched = new Set<string>();
    for (const patch of patches) {
      const files = touchedFilesFromPatch(patch);
      files.forEach((f) => touched.add(f));
      if (dryRun) continue;
      try {
        await this.vcs.applyPatch(cwd, patch);
      } catch (error) {
        return { touched: Array.from(touched), error: (error as Error).message };
      }
    }
    return { touched: Array.from(touched) };
  }

  private async runTests(commands: string[], cwd: string): Promise<{ ok: boolean; results: { command: string; stdout: string; stderr: string; code: number }[] }> {
    const results: { command: string; stdout: string; stderr: string; code: number }[] = [];
    for (const command of commands) {
      try {
        const { stdout, stderr } = await exec(command, { cwd });
        results.push({ command, stdout, stderr, code: 0 });
      } catch (error: any) {
        results.push({
          command,
          stdout: error.stdout ?? "",
          stderr: error.stderr ?? String(error),
          code: typeof error.code === "number" ? error.code : 1,
        });
        return { ok: false, results };
      }
    }
    return { ok: true, results };
  }

  async workOnTasks(request: WorkOnTasksRequest): Promise<WorkOnTasksResult> {
    await this.ensureMcoda();
    const agentStream = request.agentStream !== false;
    const baseBranch = request.baseBranch ?? this.workspace.config?.branch ?? DEFAULT_BASE_BRANCH;
    const commandRun = await this.deps.jobService.startCommandRun("work-on-tasks", request.projectKey, {
      taskIds: request.taskKeys,
    });
    const job = await this.deps.jobService.startJob("work", commandRun.id, request.projectKey, {
      commandName: "work-on-tasks",
      payload: {
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        tasks: request.taskKeys,
        statusFilter: request.statusFilter,
        limit: request.limit,
        parallel: request.parallel,
        noCommit: request.noCommit ?? false,
        dryRun: request.dryRun ?? false,
        agent: request.agentName,
        agentStream,
      },
    });

    let selection: TaskSelectionPlan;
    let storyPointsProcessed = 0;
    try {
      selection = await this.selectionService.selectTasks({
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        taskKeys: request.taskKeys,
        statusFilter: request.statusFilter,
        limit: request.limit,
        parallel: request.parallel,
      });

      await this.checkpoint(job.id, "selection", {
        ordered: selection.ordered.map((t) => t.task.key),
        blocked: selection.blocked.map((t) => t.task.key),
      });

      await this.deps.jobService.updateJobStatus(job.id, "running", {
        payload: {
          ...(job.payload ?? {}),
          selection: selection.ordered.map((t) => t.task.key),
          blocked: selection.blocked.map((t) => t.task.key),
        },
        totalItems: selection.ordered.length,
        processedItems: 0,
      });

      const results: TaskExecutionResult[] = [];
      const warnings: string[] = [...selection.warnings];
      const agent = await this.resolveAgent(request.agentName);
      const prompts = await this.loadPrompts(agent.id);

      for (const [index, task] of selection.ordered.entries()) {
      const startedAt = new Date().toISOString();
      const taskRun = await this.deps.workspaceRepo.createTaskRun({
        taskId: task.task.id,
        command: "work-on-tasks",
        jobId: job.id,
        commandRunId: commandRun.id,
        agentId: agent.id,
        status: "running",
        startedAt,
        storyPointsAtRun: task.task.storyPoints ?? null,
        gitBranch: task.task.vcsBranch ?? null,
        gitBaseBranch: task.task.vcsBaseBranch ?? null,
        gitCommitSha: task.task.vcsLastCommitSha ?? null,
      });

      const phaseTimers: Partial<Record<TaskPhase, number>> = {};
      const startPhase = async (phase: TaskPhase, details?: Record<string, unknown>) => {
        phaseTimers[phase] = Date.now();
        await this.updateTaskPhase(job.id, taskRun.id, task.task.key, phase, "start", details);
      };
      const endPhase = async (phase: TaskPhase, details?: Record<string, unknown>) => {
        const started = phaseTimers[phase];
        const durationSeconds = started ? Math.round(((Date.now() - started) / 1000) * 1000) / 1000 : undefined;
        await this.updateTaskPhase(job.id, taskRun.id, task.task.key, phase, "end", {
          ...(details ?? {}),
          durationSeconds,
        });
      };

      await startPhase("selection", {
        dependencies: task.dependencies.keys,
        blockedReason: task.blockedReason,
      });
      await this.logTask(taskRun.id, `Selected task ${task.task.key}`, "selection", {
        dependencies: task.dependencies.keys,
        blockedReason: task.blockedReason,
      });

      if (task.blockedReason && !request.dryRun) {
        await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "selection", "error", {
          blockedReason: task.blockedReason,
        });
        await this.stateService.markBlocked(task.task, task.blockedReason);
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
        results.push({ taskKey: task.task.key, status: "blocked", notes: task.blockedReason });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }

      await endPhase("selection");
      const metadata = (task.task.metadata as any) ?? {};
      const allowedFiles = Array.isArray(metadata.files) ? normalizePaths(this.workspace.workspaceRoot, metadata.files) : [];
      const testCommands = Array.isArray(metadata.tests) ? (metadata.tests as string[]) : [];

      await startPhase("context", { allowedFiles, tests: testCommands });
      const docLinks = Array.isArray((metadata as any).doc_links) ? (metadata as any).doc_links : [];
      const { summary: docSummary, warnings: docWarnings } = await this.gatherDocContext(request.projectKey, docLinks);
      if (docWarnings.length) {
        warnings.push(...docWarnings);
        await this.logTask(taskRun.id, docWarnings.join("; "), "docdex");
      }
      await endPhase("context", { docWarnings });

      await startPhase("prompt", { docSummary: Boolean(docSummary), agent: agent.id });
      const prompt = this.buildPrompt(task, docSummary, allowedFiles);
      const commandPrompt = prompts.commandPrompt ?? "";
      const systemPrompt = [prompts.jobPrompt, prompts.characterPrompt, commandPrompt].filter(Boolean).join("\n\n");
      await endPhase("prompt", { hasSystemPrompt: Boolean(systemPrompt) });

      if (request.dryRun) {
        await this.logTask(taskRun.id, "Dry-run enabled; skipping execution.", "execution");
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "succeeded",
          finishedAt: new Date().toISOString(),
        });
        results.push({ taskKey: task.task.key, status: "skipped", notes: "dry_run" });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }

      try {
        await this.stateService.transitionToInProgress(task.task);
      } catch (error) {
        await this.logTask(taskRun.id, `Failed to move task to in_progress: ${(error as Error).message}`, "state");
      }

      let agentOutput = "";
      let agentDuration = 0;
      try {
        await startPhase("agent", { agent: agent.id, stream: agentStream });
        const agentStarted = Date.now();
        if (agentStream && this.deps.agentService.invokeStream) {
          const stream = await this.deps.agentService.invokeStream(agent.id, {
            input: `${systemPrompt}\n\n${prompt}`,
            metadata: { taskKey: task.task.key },
          });
          for await (const chunk of stream) {
            agentOutput += chunk.output ?? "";
            await this.logTask(taskRun.id, chunk.output ?? "", "agent");
          }
        } else {
          const result = await this.deps.agentService.invoke(agent.id, { input: `${systemPrompt}\n\n${prompt}`, metadata: { taskKey: task.task.key } });
          agentOutput = result.output ?? "";
          await this.logTask(taskRun.id, agentOutput, "agent");
        }
        agentDuration = (Date.now() - agentStarted) / 1000;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logTask(taskRun.id, `Agent invocation failed: ${message}`, "agent");
        await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "agent", "error", { error: message });
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
        results.push({ taskKey: task.task.key, status: "failed", notes: message });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }
      await endPhase("agent", { agentDurationSeconds: agentDuration });

      const promptTokens = estimateTokens(systemPrompt + prompt);
      const completionTokens = estimateTokens(agentOutput);
      await this.recordTokenUsage({
        agentId: agent.id,
        model: agent.defaultModel,
        jobId: job.id,
        commandRunId: commandRun.id,
        taskRunId: taskRun.id,
        taskId: task.task.id,
        projectId: selection.project?.id,
        tokensPrompt: promptTokens,
        tokensCompletion: completionTokens,
        phase: "agent",
        durationSeconds: agentDuration,
      });

      const patches = extractPatches(agentOutput);
      if (patches.length === 0) {
        const message = "Agent output did not include a patch.";
        await this.logTask(taskRun.id, message, "agent");
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
        await this.stateService.markBlocked(task.task, "missing_patch");
        results.push({ taskKey: task.task.key, status: "failed", notes: "missing_patch" });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }

      let branchInfo = { branch: task.task.vcsBranch ?? "", base: task.task.vcsBaseBranch ?? baseBranch };
      if (!request.dryRun) {
        try {
          branchInfo = await this.ensureBranches(task.task.key, baseBranch);
          await this.deps.workspaceRepo.updateTask(task.task.id, { vcsBranch: branchInfo.branch, vcsBaseBranch: branchInfo.base });
          await this.logTask(taskRun.id, `Using branch ${branchInfo.branch} (base ${branchInfo.base})`, "vcs");
        } catch (error) {
          const message = `Failed to prepare branches: ${(error as Error).message}`;
          await this.logTask(taskRun.id, message, "vcs");
          await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
          results.push({ taskKey: task.task.key, status: "failed", notes: message });
          await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
          continue;
        }
      }

      await startPhase("apply", { patchCount: patches.length });
      const { touched, error: applyError } = await this.applyPatches(patches, this.workspace.workspaceRoot, request.dryRun ?? false);
      if (applyError) {
        await this.logTask(taskRun.id, `Patch apply failed: ${applyError}`, "patch");
        await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", { error: applyError });
        await this.stateService.markBlocked(task.task, "patch_failed");
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
        results.push({ taskKey: task.task.key, status: "failed", notes: "patch_failed" });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }
      await endPhase("apply", { touched });

      const scopeCheck = this.validateScope(allowedFiles, normalizePaths(this.workspace.workspaceRoot, touched));
      if (!scopeCheck.ok) {
        await this.logTask(taskRun.id, scopeCheck.message ?? "Scope violation", "scope");
        await this.stateService.markBlocked(task.task, "scope_violation");
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
        results.push({ taskKey: task.task.key, status: "failed", notes: "scope_violation" });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }

      if (!request.dryRun && testCommands.length) {
        await startPhase("tests", { commands: testCommands });
        const testResult = await this.runTests(testCommands, this.workspace.workspaceRoot);
        await this.logTask(taskRun.id, "Test results", "tests", { results: testResult.results });
        if (!testResult.ok) {
          await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "tests", "error", { results: testResult.results });
          await this.stateService.markBlocked(task.task, "tests_failed");
          await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
          results.push({ taskKey: task.task.key, status: "failed", notes: "tests_failed" });
          await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
          continue;
        }
        await endPhase("tests", { results: testResult.results });
      }

      if (!request.dryRun && request.noCommit !== true) {
        await startPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base });
        try {
          const toStage = touched.length ? touched : ["."];
          await this.vcs.stage(this.workspace.workspaceRoot, toStage);
          const status = await this.vcs.status(this.workspace.workspaceRoot);
          if (status.trim().length === 0) {
            await this.logTask(taskRun.id, "No changes to commit.", "vcs");
          } else {
            await this.vcs.commit(this.workspace.workspaceRoot, `[${task.task.key}] ${task.task.title}`);
            const head = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
            await this.deps.workspaceRepo.updateTask(task.task.id, { vcsLastCommitSha: head });
            await this.logTask(taskRun.id, `Committed changes (${head})`, "vcs");
            if (await this.vcs.hasRemote(this.workspace.workspaceRoot)) {
              await this.vcs.push(this.workspace.workspaceRoot, "origin", branchInfo.branch);
              await this.logTask(taskRun.id, "Pushed branch to remote origin", "vcs");
              await this.vcs.merge(this.workspace.workspaceRoot, branchInfo.branch, branchInfo.base);
              await this.vcs.push(this.workspace.workspaceRoot, "origin", branchInfo.base);
            } else {
              await this.logTask(taskRun.id, "No remote configured; skipping push/merge.", "vcs");
            }
          }
        } catch (error) {
          await this.logTask(taskRun.id, `VCS commit/push failed: ${(error as Error).message}`, "vcs");
          await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "vcs", "error", { error: (error as Error).message });
          await this.stateService.markBlocked(task.task, "vcs_failed");
          await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
          results.push({ taskKey: task.task.key, status: "failed", notes: "vcs_failed" });
          await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
          continue;
        }
        await endPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base });
      } else if (request.dryRun) {
        await this.logTask(taskRun.id, "Dry-run: skipped commit/push.", "vcs");
      } else if (request.noCommit) {
        await this.logTask(taskRun.id, "no-commit set: skipped commit/push.", "vcs");
      }

      await startPhase("finalize");
      const finishedAt = new Date().toISOString();
      const elapsedSeconds = Math.max(1, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1000);
      const spPerHour =
        task.task.storyPoints && task.task.storyPoints > 0 ? (task.task.storyPoints / elapsedSeconds) * 3600 : null;

      await this.stateService.markReadyToReview(task.task, { last_run: finishedAt });
      await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
        status: "succeeded",
        finishedAt,
        spPerHourEffective: spPerHour,
        gitBranch: branchInfo.branch,
        gitBaseBranch: branchInfo.base,
      });

      storyPointsProcessed += task.task.storyPoints ?? 0;
      await endPhase("finalize", { spPerHour: spPerHour ?? undefined });

      results.push({
        taskKey: task.task.key,
        status: "succeeded",
        notes: "ready_to_review",
        branch: branchInfo.branch,
      });
      await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
      await this.checkpoint(job.id, "task_completed", { taskKey: task.task.key });
    }

    const failureCount = results.filter((r) => r.status === "failed" || r.status === "blocked").length;
    const state: JobState =
      failureCount === 0 ? "completed" : failureCount === results.length ? "failed" : ("partial" as JobState);
    const errorSummary = failureCount ? `${failureCount} task(s) failed or blocked` : undefined;
    await this.deps.jobService.updateJobStatus(job.id, state, {
      processedItems: results.length,
      errorSummary,
    });
    await this.deps.jobService.finishCommandRun(
      commandRun.id,
      state === "completed" ? "succeeded" : "failed",
      errorSummary,
      storyPointsProcessed || undefined,
    );

    return {
      jobId: job.id,
      commandRunId: commandRun.id,
      selection,
      results,
      warnings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await this.deps.jobService.updateJobStatus(job.id, "failed", {
      processedItems: undefined,
      errorSummary: message,
    });
    await this.deps.jobService.finishCommandRun(commandRun.id, "failed", message, storyPointsProcessed || undefined);
    throw error;
  }
  }
}
