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
const TASK_LOCK_TTL_SECONDS = 60 * 60;
const DEFAULT_CODE_WRITER_PROMPT = [
  "You are the code-writing agent. Before coding, query docdex with the task key and feature keywords (MCP `docdex_search` limit 4–8 or CLI `docdexd query --repo <repo> --query \"<term>\" --limit 6 --snippets=false`). If results look stale, reindex (`docdex_index` or `docdexd index --repo <repo>`) then re-run search. Fetch snippets via `docdex_open` or `/snippet/:doc_id?text_only=true` only for specific hits.",
  "Use docdex snippets to ground decisions (data model, offline/online expectations, constraints, acceptance criteria). Note when docdex is unavailable and fall back to local docs.",
  "Re-use existing store/slices/adapters and tests; avoid inventing new backends or ad-hoc actions. Keep behavior backward-compatible and scoped to the documented contracts.",
  "If you encounter merge conflicts, resolve them first (clean conflict markers and ensure code compiles) before continuing task work.",
  "If a target file does not exist, create it by emitting a new-file unified diff with full content (no placeholder edits to missing paths).",
].join("\n");
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";

export interface WorkOnTasksRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  noCommit?: boolean;
  dryRun?: boolean;
  agentName?: string;
  agentStream?: boolean;
  baseBranch?: string;
  onAgentChunk?: (chunk: string) => void;
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

const maybeConvertApplyPatch = (patch: string): string => {
  if (!patch.trimStart().startsWith("*** Begin Patch")) return patch;
  const lines = patch.split(/\r?\n/);
  let i = 0;
  const out: string[] = [];
  const next = () => lines[++i];
  const current = () => lines[i];
  const advanceUntilNextFile = () => {
    while (i < lines.length && !current().startsWith("*** ")) i += 1;
  };

  while (i < lines.length) {
    const line = current();
    if (line.startsWith("*** Begin Patch") || line.startsWith("*** End Patch")) {
      i += 1;
      continue;
    }
    if (line.startsWith("*** Add File: ")) {
      const file = line.replace("*** Add File: ", "").trim();
      const content: string[] = [];
      i += 1;
      while (i < lines.length && !current().startsWith("*** ")) {
        const l = current();
        if (l.startsWith("+")) {
          content.push(l.slice(1));
        } else if (!l.startsWith("\\ No newline at end of file")) {
          // Some apply_patch emitters omit the leading "+", so treat raw lines as content.
          content.push(l);
        }
        i += 1;
      }
      const count = content.length;
      out.push(`diff --git a/${file} b/${file}`);
      out.push("new file mode 100644");
      out.push("--- /dev/null");
      out.push(`+++ b/${file}`);
      if (count > 0) {
        out.push(`@@ -0,0 +1,${count} @@`);
        content.forEach((l) => out.push(`+${l}`));
      } else {
        out.push("@@ -0,0 +0,0 @@");
      }
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      const file = line.replace("*** Delete File: ", "").trim();
      out.push(`diff --git a/${file} b/${file}`);
      out.push("deleted file mode 100644");
      out.push(`--- a/${file}`);
      out.push("+++ /dev/null");
      out.push("@@ -1 +0,0 @@");
      i += 1;
      advanceUntilNextFile();
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const file = line.replace("*** Update File: ", "").trim();
      i += 1;
      // Skip optional move line
      if (i < lines.length && current().startsWith("*** Move to: ")) i += 1;
      out.push(`diff --git a/${file} b/${file}`);
      out.push(`--- a/${file}`);
      out.push(`+++ b/${file}`);
      while (i < lines.length && !current().startsWith("*** ")) {
        const l = current();
        if (l.startsWith("@@") || l.startsWith("+++") || l.startsWith("---") || l.startsWith("+") || l.startsWith("-") || l.startsWith(" ")) {
          out.push(l);
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("\n");
};

const ensureDiffHeader = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const hasHeader = /^diff --git /m.test(patch);
  const minusIdx = lines.findIndex((l) => l.startsWith("--- "));
  const plusIdx = lines.findIndex((l) => l.startsWith("+++ "));
  if (minusIdx === -1 || plusIdx === -1) return patch;
  const minusPathRaw = lines[minusIdx].replace(/^---\s+/, "").trim();
  const plusPathRaw = lines[plusIdx].replace(/^\+\+\+\s+/, "").trim();
  const lhs =
    minusPathRaw === "/dev/null"
      ? plusPathRaw.replace(/^b\//, "")
      : minusPathRaw.replace(/^a\//, "");
  const rhs = plusPathRaw.replace(/^b\//, "");
  const header = `diff --git a/${lhs} b/${rhs}`;
  const result: string[] = [...lines];
  if (!hasHeader) {
    result.unshift(header);
  }
  const headerIdx = result.findIndex((l) => l.startsWith("diff --git "));
  const hasNewFileMode = result.some((l) => l.startsWith("new file mode"));
  const isAdd = minusPathRaw === "/dev/null";
  if (isAdd && !hasNewFileMode) {
    result.splice(headerIdx + 1, 0, "new file mode 100644");
  }
  return result.join("\n");
};

const stripInvalidIndexLines = (patch: string): string =>
  patch
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith("index ")) return true;
      const value = line.replace(/^index\s+/, "").trim();
      return /^[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/.test(value);
    })
    .join("\n");

const isPlaceholderPatch = (patch: string): boolean => /\?\?\?/.test(patch) || /rest of existing code/i.test(patch);

const normalizeHunkHeaders = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  let currentAddFile = false;

  const countLines = (start: number): { minus: number; plus: number } => {
    let minus = 0;
    let plus = 0;
    for (let j = start; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.startsWith("@@") || l.startsWith("diff --git ") || l.startsWith("*** End Patch")) break;
      if (l.startsWith("+++ ") || l.startsWith("--- ")) continue;
      if (l.startsWith(" ")) {
        minus += 1;
        plus += 1;
      } else if (l.startsWith("-")) {
        minus += 1;
      } else if (l.startsWith("+")) {
        plus += 1;
      } else if (!l.trim()) {
        minus += 1;
        plus += 1;
      } else {
        break;
      }
    }
    return { minus, plus };
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      currentAddFile = false;
      out.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      currentAddFile = line.includes("/dev/null");
      out.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      out.push(line);
      continue;
    }

    const isHunk = line.startsWith("@@");
    const hasRanges = /^@@\s+-\d+/.test(line);
    if (isHunk && !hasRanges) {
      const { minus, plus } = countLines(i + 1);
      const minusCount = currentAddFile ? 0 : minus;
      const plusCount = currentAddFile ? Math.max(plus, 0) : plus;
      out.push(`@@ -0,${minusCount} +1,${plusCount} @@`);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
};

const fixMissingPrefixesInHunks = (patch: string): string => {
  const lines = patch.split(/\r?\n/);
  const out: string[] = [];
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith("@@")) {
      inHunk = true;
      out.push(line);
      continue;
    }
    if (inHunk) {
      if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("*** End Patch")) {
        inHunk = false;
        out.push(line);
        continue;
      }
      if (!/^[+\-\s]/.test(line) && line.trim().length) {
        out.push(`+${line}`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
};

const parseAddedFileContents = (patch: string): Record<string, string> => {
  const lines = patch.split(/\r?\n/);
  const additions: Record<string, string[]> = {};
  let currentFile: string | null = null;
  let isAdd = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      isAdd = false;
    }
    if (line.startsWith("--- ")) {
      const minusPath = line.replace(/^---\s+/, "").trim();
      isAdd = minusPath === "/dev/null";
    }
    if (line.startsWith("+++ ") && isAdd) {
      const plusPath = line.replace(/^\+\+\+\s+/, "").trim().replace(/^b\//, "");
      currentFile = plusPath;
      additions[currentFile] = [];
    }
    if (currentFile && isAdd) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        additions[currentFile].push(line.slice(1));
      }
    }
  }
  return Object.fromEntries(Object.entries(additions).map(([file, content]) => [file, content.join("\n")]));
};

const updateAddPatchForExistingFile = (patch: string, existingFiles: Set<string>, cwd: string): { patch: string; skipped: string[] } => {
  const additions = parseAddedFileContents(patch);
  const skipped: string[] = [];
  let updated = patch;
  for (const file of Object.keys(additions)) {
    const absolute = path.join(cwd, file);
    if (!existingFiles.has(absolute)) continue;
    try {
      const content = fs.readFileSync(absolute, "utf8");
      if (content.trim() === additions[file].trim()) {
        skipped.push(file);
        continue;
      }
    } catch {
      // ignore read errors; fall back to converting patch
    }
    // Convert add patch to update by removing new file mode and dev/null markers.
    const lines = updated.split(/\r?\n/);
    const out: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith("diff --git ")) {
        out.push(line);
        continue;
      }
      if (line.startsWith("new file mode") && lines[i + 1]?.includes(file)) {
        continue;
      }
      if (line.startsWith("--- /dev/null") && lines[i + 1]?.includes(file)) {
        out.push(`--- a/${file}`);
        continue;
      }
      out.push(line);
    }
    updated = out.join("\n");
  }
  return { patch: updated, skipped };
};

const splitPatchIntoDiffs = (patch: string): string[] => {
  const parts = patch.split(/^diff --git /m).filter(Boolean);
  if (parts.length <= 1) return [patch];
  return parts.map((part) => `diff --git ${part}`.trim());
};

export class WorkOnTasksService {
  private selectionService: TaskSelectionService;
  private stateService: TaskStateService;
  private taskLogSeq = new Map<string, number>();
  private vcs: VcsClient;
  private routingService: RoutingService;
  private async readPromptFiles(paths: string[]): Promise<string[]> {
    const contents: string[] = [];
    const seen = new Set<string>();
    for (const promptPath of paths) {
      try {
        const content = await fs.promises.readFile(promptPath, "utf8");
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
    const agentPrompts =
      "getPrompts" in this.deps.agentService ? await (this.deps.agentService as any).getPrompts(agentId) : undefined;
    const mcodaPromptPath = path.join(this.workspace.workspaceRoot, ".mcoda", "prompts", "code-writer.md");
    const workspacePromptPath = path.join(this.workspace.workspaceRoot, "prompts", "code-writer.md");
    try {
      await fs.promises.mkdir(path.dirname(mcodaPromptPath), { recursive: true });
      await fs.promises.access(mcodaPromptPath);
      console.info(`[work-on-tasks] using existing code-writer prompt at ${mcodaPromptPath}`);
    } catch {
      try {
        await fs.promises.access(workspacePromptPath);
        await fs.promises.copyFile(workspacePromptPath, mcodaPromptPath);
        console.info(`[work-on-tasks] copied code-writer prompt to ${mcodaPromptPath}`);
      } catch {
        console.info(`[work-on-tasks] no code-writer prompt found at ${workspacePromptPath}; writing default prompt to ${mcodaPromptPath}`);
        await fs.promises.writeFile(mcodaPromptPath, DEFAULT_CODE_WRITER_PROMPT, "utf8");
      }
    }
    const commandPromptFiles = await this.readPromptFiles([
      mcodaPromptPath,
      workspacePromptPath,
    ]);
    const mergedCommandPrompt = (() => {
      const parts = [...commandPromptFiles];
      if (agentPrompts?.commandPrompts?.["work-on-tasks"]) {
        parts.push(agentPrompts.commandPrompts["work-on-tasks"]);
      }
      if (!parts.length) parts.push(DEFAULT_CODE_WRITER_PROMPT);
      return parts.filter(Boolean).join("\n\n");
    })();
    return {
      jobPrompt: agentPrompts?.jobPrompt ?? DEFAULT_JOB_PROMPT,
      characterPrompt: agentPrompts?.characterPrompt ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: mergedCommandPrompt || undefined,
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
    await maybeClose(this.deps.routingService);
    await maybeClose(this.deps.docdex);
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
    const docdexHint =
      docSummary ||
      "Use docdex: search workspace docs with project key and fetch linked documents when present (doc_links metadata).";
    return [
      `Task ${task.task.key}: ${task.task.title}`,
      `Description: ${task.task.description ?? "(none)"}`,
      `Epic: ${task.task.epicKey} (${task.task.epicTitle ?? "n/a"}), Story: ${task.task.storyKey} (${task.task.storyTitle ?? "n/a"})`,
      `Acceptance: ${acceptance || "Refer to SDS/OpenAPI for expected behavior."}`,
      deps,
      `Allowed files: ${fileScope.length ? fileScope.join(", ") : "(not constrained)"}`,
      `Doc context:\n${docdexHint}`,
      "Verify target paths against the current workspace (use docdex/file hints); do not assume hashed or generated asset names exist. If a path is missing, emit a new-file diff with full content (and parent dirs) instead of editing a non-existent file so git apply succeeds. Use JSON.parse-friendly unified diffs.",
      "Produce a concise plan and a patch in unified diff fenced with ```patch```.",
    ].join("\n");
  }

  private async checkoutBaseBranch(baseBranch: string): Promise<void> {
    await this.vcs.ensureRepo(this.workspace.workspaceRoot);
    await this.vcs.ensureBaseBranch(this.workspace.workspaceRoot, baseBranch);
    const dirtyBefore = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcodaBefore = dirtyBefore.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcodaBefore.length) {
      await this.vcs.stage(this.workspace.workspaceRoot, nonMcodaBefore);
      const status = await this.vcs.status(this.workspace.workspaceRoot);
      if (status.trim().length) {
        await this.vcs.commit(this.workspace.workspaceRoot, "[mcoda] auto-commit workspace changes");
      }
    }
    const dirtyAfter = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcodaAfter = dirtyAfter.filter((p: string) => !p.startsWith(".mcoda"));
    if (nonMcodaAfter.length) {
      throw new Error(`Working tree dirty: ${nonMcodaAfter.join(", ")}`);
    }
    await this.vcs.checkoutBranch(this.workspace.workspaceRoot, baseBranch);
  }

  private async commitPendingChanges(
    branchInfo: { branch: string; base: string } | null,
    taskKey: string,
    taskTitle: string,
    reason: string,
    taskId: string,
    taskRunId: string,
  ): Promise<void> {
    const dirty = await this.vcs.dirtyPaths(this.workspace.workspaceRoot);
    const nonMcoda = dirty.filter((p: string) => !p.startsWith(".mcoda"));
    if (!nonMcoda.length) return;
    await this.vcs.stage(this.workspace.workspaceRoot, nonMcoda);
    const status = await this.vcs.status(this.workspace.workspaceRoot);
    if (!status.trim().length) return;
    const message = `[${taskKey}] ${taskTitle} (${reason})`;
    await this.vcs.commit(this.workspace.workspaceRoot, message);
    const head = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
    await this.deps.workspaceRepo.updateTask(taskId, {
      vcsLastCommitSha: head,
      vcsBranch: branchInfo?.branch ?? null,
      vcsBaseBranch: branchInfo?.base ?? null,
    });
    await this.logTask(taskRunId, `Auto-committed pending changes (${reason})`, "vcs", {
      branch: branchInfo?.branch,
      base: branchInfo?.base,
      head,
    });
  }

  private async ensureBranches(
    taskKey: string,
    baseBranch: string,
    taskRunId: string,
  ): Promise<{ branch: string; base: string; mergeConflicts?: string[]; remoteSyncNote?: string }> {
    const branch = `${DEFAULT_TASK_BRANCH_PREFIX}${taskKey}`;
    await this.checkoutBaseBranch(baseBranch);
    const hasRemote = await this.vcs.hasRemote(this.workspace.workspaceRoot);
    if (hasRemote) {
      try {
        await this.vcs.pull(this.workspace.workspaceRoot, "origin", baseBranch, true);
      } catch (error) {
        await this.logTask(taskRunId, `Warning: failed to pull ${baseBranch} from origin; continuing with local base.`, "vcs", {
          error: (error as Error).message,
        });
      }
    }
    const branchExists = await this.vcs.branchExists(this.workspace.workspaceRoot, branch);
    let remoteSyncNote = "";
    if (branchExists) {
      await this.vcs.checkoutBranch(this.workspace.workspaceRoot, branch);
      const dirty = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
      if (dirty.length) {
        throw new Error(`Task branch ${branch} has uncommitted changes: ${dirty.join(", ")}`);
      }
      if (hasRemote) {
        try {
          await this.vcs.pull(this.workspace.workspaceRoot, "origin", branch, true);
        } catch (error) {
          const errorText = this.formatGitError(error);
          await this.logTask(taskRunId, `Warning: failed to pull ${branch} from origin; continuing with local branch.`, "vcs", {
            error: errorText,
          });
          if (this.isNonFastForwardPull(errorText)) {
            remoteSyncNote = `Remote task branch ${branch} is ahead/diverged. Sync it with origin (pull/rebase or merge) and resolve conflicts before continuing task work.`;
          }
        }
      }
      try {
        await this.vcs.merge(this.workspace.workspaceRoot, baseBranch, branch, true);
      } catch (error) {
        const conflicts = await this.vcs.conflictPaths(this.workspace.workspaceRoot);
        if (conflicts.length) {
          await this.logTask(taskRunId, `Merge conflicts detected while merging ${baseBranch} into ${branch}.`, "vcs", {
            conflicts,
          });
          return { branch, base: baseBranch, mergeConflicts: conflicts, remoteSyncNote };
        }
        throw new Error(`Failed to merge ${baseBranch} into ${branch}: ${(error as Error).message}`);
      }
    } else {
      await this.vcs.createOrCheckoutBranch(this.workspace.workspaceRoot, branch, baseBranch);
    }
    return { branch, base: baseBranch, remoteSyncNote: remoteSyncNote || undefined };
  }

  private formatGitError(error: unknown): string {
    if (!error) return "";
    const stderr = typeof (error as any).stderr === "string" ? (error as any).stderr : "";
    const stdout = typeof (error as any).stdout === "string" ? (error as any).stdout : "";
    const message = error instanceof Error ? error.message : String(error);
    return [message, stderr, stdout].filter(Boolean).join(" ");
  }

  private isNonFastForwardPush(errorText: string): boolean {
    return /non-fast-forward|fetch first|rejected/i.test(errorText);
  }

  private isNonFastForwardPull(errorText: string): boolean {
    return /not possible to fast-forward|divergent|non-fast-forward|rejected/i.test(errorText);
  }

  private isRemotePermissionError(errorText: string): boolean {
    return /protected branch|gh006|permission denied|not authorized|not allowed to push|access denied|403|forbidden/i.test(errorText);
  }

  private isCommitHookFailure(errorText: string): boolean {
    return /hook|pre-commit|commit-msg|husky/i.test(errorText);
  }

  private isGpgSignFailure(errorText: string): boolean {
    return /gpg|signing key|signing failed|gpg failed|no secret key/i.test(errorText);
  }
  private async pushWithRecovery(taskRunId: string, branch: string): Promise<{ pushed: boolean; skipped: boolean; reason?: string }> {
    const cwd = this.workspace.workspaceRoot;
    try {
      await this.vcs.push(cwd, "origin", branch);
      return { pushed: true, skipped: false };
    } catch (error) {
      const errorText = this.formatGitError(error);
      if (this.isRemotePermissionError(errorText)) {
        await this.logTask(
          taskRunId,
          `Remote rejected push for ${branch} due to permissions or branch protection; continuing with local commits.`,
          "vcs",
          {
            error: errorText,
            guidance: "Use a token with write access or push to an unprotected branch and open a PR.",
          },
        );
        return { pushed: false, skipped: true, reason: "permission" };
      }
      if (!this.isNonFastForwardPush(errorText)) {
        throw error;
      }
      await this.logTask(
        taskRunId,
        `Non-fast-forward push rejected for ${branch}; attempting to pull and retry.`,
        "vcs",
        { error: errorText },
      );
      const currentBranch = await this.vcs.currentBranch(cwd);
      if (currentBranch && currentBranch !== branch) {
        await this.vcs.ensureClean(cwd);
        await this.vcs.checkoutBranch(cwd, branch);
      }
      try {
        await this.vcs.pull(cwd, "origin", branch, false);
        await this.vcs.push(cwd, "origin", branch);
      } catch (retryError) {
        const retryText = this.formatGitError(retryError);
        if (this.isRemotePermissionError(retryText)) {
          await this.logTask(
            taskRunId,
            `Remote rejected push for ${branch} after sync due to permissions or branch protection; continuing with local commits.`,
            "vcs",
            {
              error: retryText,
              guidance: "Use a token with write access or push to an unprotected branch and open a PR.",
            },
          );
          return { pushed: false, skipped: true, reason: "permission" };
        }
        throw new Error(`Non-fast-forward push rejected for ${branch}; retry after pull failed: ${retryText}`);
      } finally {
        if (currentBranch && currentBranch !== branch) {
          await this.vcs.checkoutBranch(cwd, currentBranch);
        }
      }
      await this.logTask(taskRunId, `Push recovered after syncing ${branch} from origin.`, "vcs");
      return { pushed: true, skipped: false };
    }
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
  ): Promise<{ touched: string[]; error?: string; warnings?: string[] }> {
    const touched = new Set<string>();
    const warnings: string[] = [];
    let applied = 0;
    for (const patch of patches) {
      const normalized = maybeConvertApplyPatch(patch);
      const withHeader = ensureDiffHeader(normalized);
      const withHunks = normalizeHunkHeaders(withHeader);
      const withPrefixes = fixMissingPrefixesInHunks(withHunks);
      const sanitized = stripInvalidIndexLines(withPrefixes);
      if (isPlaceholderPatch(sanitized)) {
        warnings.push("Skipped placeholder patch that contained ??? or 'rest of existing code'.");
        continue;
      }
      const files = touchedFilesFromPatch(sanitized);
      if (!files.length) {
        warnings.push("Skipped patch with no recognizable file paths.");
        continue;
      }
      const segments = splitPatchIntoDiffs(sanitized);
      for (const segment of segments) {
        const segmentFiles = touchedFilesFromPatch(segment);
        const existingFiles = new Set(segmentFiles.map((f) => path.join(cwd, f)).filter((f) => fs.existsSync(f)));
        let patchToApply = segment;
        if (existingFiles.size > 0) {
          const { patch: converted, skipped } = updateAddPatchForExistingFile(segment, existingFiles, cwd);
          patchToApply = converted;
          if (skipped.length) {
            warnings.push(`Skipped add patch for existing files: ${skipped.join(", ")}`);
            continue;
          }
        }
        if (dryRun) {
          segmentFiles.forEach((f) => touched.add(f));
          applied += 1;
          continue;
        }
        // Ensure target directories exist for new/updated files.
        for (const file of segmentFiles) {
          const dir = path.dirname(path.join(cwd, file));
          try {
            await fs.promises.mkdir(dir, { recursive: true });
          } catch {
            /* ignore mkdir errors; git apply will surface issues */
          }
        }
        try {
          await this.vcs.applyPatch(cwd, patchToApply);
          segmentFiles.forEach((f) => touched.add(f));
          applied += 1;
        } catch (error) {
          // Fallback: if the segment only adds new files and git apply fails, write the files directly.
          const additions = parseAddedFileContents(patchToApply);
          const addTargets = Object.keys(additions);
          if (addTargets.length && segmentFiles.length === addTargets.length) {
            try {
              for (const file of addTargets) {
                const dest = path.join(cwd, file);
                await fs.promises.mkdir(path.dirname(dest), { recursive: true });
                await fs.promises.writeFile(dest, additions[file], "utf8");
                touched.add(file);
              }
              applied += 1;
              warnings.push(`Applied add-only segment by writing files directly: ${addTargets.join(", ")}`);
              continue;
            } catch (writeError) {
              warnings.push(
                `Patch segment failed and fallback write failed (${segmentFiles.join(", ") || "unknown files"}): ${(writeError as Error).message}`,
              );
              continue;
            }
          }
          warnings.push(`Patch segment failed (${segmentFiles.join(", ") || "unknown files"}): ${(error as Error).message}`);
        }
      }
    }
    if (!applied && warnings.length) {
      return { touched: Array.from(touched), warnings, error: "No patches applied; all were skipped as placeholders." };
    }
    return { touched: Array.from(touched), warnings };
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
    const configuredBaseBranch = request.baseBranch ?? this.workspace.config?.branch;
    const baseBranch = DEFAULT_BASE_BRANCH;
    const baseBranchWarnings =
      configuredBaseBranch && configuredBaseBranch !== baseBranch
        ? [`Base branch forced to ${baseBranch}; ignoring configured ${configuredBaseBranch}.`]
        : [];
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
      await this.checkoutBaseBranch(baseBranch);
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
      const warnings: string[] = [...baseBranchWarnings, ...selection.warnings];
      const agent = await this.resolveAgent(request.agentName);
      const prompts = await this.loadPrompts(agent.id);
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
      const formatCount = (value: number): string => value.toLocaleString("en-US");
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
      const emitTaskStart = (details: {
        taskKey: string;
        alias: string;
        summary: string;
        model: string;
        provider: string;
        step: string;
        reasoning: string;
        workdir: string;
        sessionId: string;
      }): void => {
        console.info("╭──────────────────────────────────────────────────────────╮");
        console.info("│                      START OF TASK                       │");
        console.info("╰──────────────────────────────────────────────────────────╯");
        console.info(`  [🪪] Start Task ID:  ${details.taskKey}`);
        console.info(`  [👹] Alias:          ${details.alias}`);
        console.info(`  [ℹ️] Summary:        ${details.summary}`);
        console.info(`  [🤖] Model:          ${details.model}`);
        console.info(`  [🕹️] Provider:       ${details.provider}`);
        console.info(`  [🧩] Step:           ${details.step}`);
        console.info(`  [🧠] Reasoning:      ${details.reasoning}`);
        console.info(`  [📁] Workdir:        ${details.workdir}`);
        console.info(`  [🔑] Session:        ${details.sessionId}`);
        console.info("");
        console.info("    ░░░░░ START OF A NEW TASK ░░░░░");
        console.info("");
        console.info(`    [STEP ${details.step}]  [MODEL ${details.model}]`);
        console.info("");
        console.info("");
      };
      const emitTaskEnd = async (details: {
        taskKey: string;
        status: TaskExecutionResult["status"];
        terminal: string;
        storyPoints?: number | null;
        elapsedMs: number;
        tokensPrompt: number;
        tokensCompletion: number;
        promptEstimate: number;
        taskBranch?: string | null;
        baseBranch?: string | null;
        touchedFiles: number;
        mergeStatus: "merged" | "skipped" | "failed";
        headSha?: string | null;
      }): Promise<void> => {
        const tokensTotal = details.tokensPrompt + details.tokensCompletion;
        const promptEstimate = Math.max(1, details.promptEstimate);
        const usagePercent = (tokensTotal / promptEstimate) * 100;
        const completion = details.status === "succeeded" ? 100 : 0;
        const completionBar = "💰".repeat(15);
        const statusLabel =
          details.status === "succeeded"
            ? "COMPLETED"
            : details.status === "skipped"
              ? "SKIPPED"
              : details.status === "blocked"
                ? "BLOCKED"
                : "FAILED";
        const hasRemote = await this.vcs.hasRemote(this.workspace.workspaceRoot);
        const tracking = details.taskBranch ? (hasRemote ? `origin/${details.taskBranch}` : "n/a") : "n/a";
        const headSha = details.headSha ?? "n/a";
        const baseLabel = details.baseBranch ?? baseBranch;
        console.info("╭──────────────────────────────────────────────────────────╮");
        console.info("│                       END OF TASK                        │");
        console.info("╰──────────────────────────────────────────────────────────╯");
        console.info(
          `  👏🏼 TASK ${details.taskKey} | 📜 STATUS ${statusLabel} | 🏠 TERMINAL ${details.terminal} | ⚡ SP ${
            details.storyPoints ?? 0
          } | ⌛ TIME ${formatDuration(details.elapsedMs)}`,
        );
        console.info("");
        console.info(`  [${completionBar}] ${completion.toFixed(1)}% Complete`);
        console.info(`  Tokens used:  ${formatCount(tokensTotal)}`);
        console.info(`  ${usagePercent.toFixed(1)}% used vs prompt est (x${(tokensTotal / promptEstimate).toFixed(2)})`);
        console.info(`  Est. tokens:   ${formatCount(promptEstimate)}`);
        console.info("");
        console.info("🌿 Git summary");
        console.info("────────────────────────────────────────────────────────────");
        console.info(`  [🎋] Task branch: ${details.taskBranch ?? "n/a"}`);
        console.info(`  [🗿] Tracking:    ${tracking}`);
        console.info(`  [🚀] Merge→dev:   ${details.mergeStatus}`);
        console.info(`  [🐲] HEAD:        ${headSha}`);
        console.info(`  [♨️] Files:       ${details.touchedFiles}`);
        console.info(`  [🔑] Base:        ${baseLabel}`);
        console.info("  [🧾] Git log:    n/a");
        console.info("");
        console.info("🗂 Artifacts");
        console.info("────────────────────────────────────────────────────────────");
        console.info("  • History:    n/a");
        console.info("  • Git log:    n/a");
        console.info("");
        console.info("    ░░░░░ END OF THE TASK WORK ░░░░░");
        console.info("");
      };

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

        const sessionId = formatSessionId(startedAt);
        const taskAlias = `Working on task ${task.task.key}`;
        const taskSummary = task.task.title || task.task.description || "(none)";
        const modelLabel = agent.defaultModel ?? "(default)";
        const providerLabel = resolveProvider(agent.adapter);
        const reasoningLabel = resolveReasoning(agent.config as Record<string, unknown> | undefined);
        const stepLabel = "patch";
        const taskStartMs = Date.now();
        let taskStatus: TaskExecutionResult["status"] | null = null;
        let tokensPromptTotal = 0;
        let tokensCompletionTotal = 0;
        let promptEstimate = 0;
        let mergeStatus: "merged" | "skipped" | "failed" = "skipped";
        let patchApplied = false;
        let touched: string[] = [];
        let taskBranchName: string | null = task.task.vcsBranch ?? null;
        let baseBranchName: string | null = task.task.vcsBaseBranch ?? baseBranch;
        let branchInfo: { branch: string; base: string; mergeConflicts?: string[]; remoteSyncNote?: string } | null = {
          branch: task.task.vcsBranch ?? "",
          base: task.task.vcsBaseBranch ?? baseBranch,
        };
        let headSha: string | null = task.task.vcsLastCommitSha ?? null;
        let taskEndEmitted = false;

        emitTaskStart({
          taskKey: task.task.key,
          alias: taskAlias,
          summary: taskSummary,
          model: modelLabel,
          provider: providerLabel,
          step: stepLabel,
          reasoning: reasoningLabel,
          workdir: this.workspace.workspaceRoot,
          sessionId,
        });

        const emitTaskEndOnce = async () => {
          if (taskEndEmitted) return;
          taskEndEmitted = true;
          const status = taskStatus ?? "failed";
          const terminal =
            status === "succeeded"
              ? patchApplied || touched.length
                ? "COMPLETED_WITH_CHANGES"
                : "COMPLETED_NO_CHANGES"
              : status === "blocked"
                ? "BLOCKED"
                : status === "skipped"
                  ? "SKIPPED"
                  : "FAILED";
          let resolvedHead = headSha;
          if (!resolvedHead) {
            try {
              resolvedHead = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
            } catch {
              resolvedHead = null;
            }
          }
          await emitTaskEnd({
            taskKey: task.task.key,
            status,
            terminal,
            storyPoints: task.task.storyPoints ?? 0,
            elapsedMs: Date.now() - taskStartMs,
            tokensPrompt: tokensPromptTotal,
            tokensCompletion: tokensCompletionTotal,
            promptEstimate,
            taskBranch: taskBranchName || null,
            baseBranch: baseBranchName || baseBranch,
            touchedFiles: touched.length,
            mergeStatus,
            headSha: resolvedHead,
          });
        };

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
          taskStatus = "blocked";
          await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
          await emitTaskEndOnce();
          continue;
        }

        await endPhase("selection");
        let lockAcquired = false;
        if (!request.dryRun) {
          const ttlSeconds = Math.max(1, TASK_LOCK_TTL_SECONDS);
          const lockResult = await this.deps.workspaceRepo.tryAcquireTaskLock(
            task.task.id,
            taskRun.id,
            job.id,
            ttlSeconds,
          );
          if (!lockResult.acquired) {
            await this.logTask(taskRun.id, "Task already locked by another run; skipping.", "vcs", {
              lock: lockResult.lock ?? null,
            });
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "cancelled",
              finishedAt: new Date().toISOString(),
            });
            results.push({ taskKey: task.task.key, status: "skipped", notes: "task_locked" });
            taskStatus = "skipped";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            await emitTaskEndOnce();
            continue;
          }
          lockAcquired = true;
        }

        try {
          const metadata = (task.task.metadata as any) ?? {};
          let allowedFiles = Array.isArray(metadata.files) ? normalizePaths(this.workspace.workspaceRoot, metadata.files) : [];
          const testCommands = Array.isArray(metadata.tests) ? (metadata.tests as string[]) : [];
          let mergeConflicts: string[] = [];
          let remoteSyncNote = "";
          const softFailures: string[] = [];
          let lastLockRefresh = Date.now();
          const getLockRefreshIntervalMs = () => {
            const ttlSeconds = Math.max(1, TASK_LOCK_TTL_SECONDS);
            const ttlMs = ttlSeconds * 1000;
            return Math.max(250, Math.min(ttlMs - 250, Math.floor(ttlMs / 3)));
          };
          const refreshLock = async (label: string, force = false): Promise<boolean> => {
            if (!lockAcquired) return true;
            const now = Date.now();
            if (!force && now - lastLockRefresh < getLockRefreshIntervalMs()) return true;
            try {
              const refreshed = await this.deps.workspaceRepo.refreshTaskLock(task.task.id, taskRun.id, TASK_LOCK_TTL_SECONDS);
              if (!refreshed) {
                await this.logTask(taskRun.id, `Task lock lost during ${label}; another run may have taken it.`, "vcs", {
                  reason: "lock_stolen",
                });
              }
              if (refreshed) {
                lastLockRefresh = now;
              }
              return refreshed;
            } catch (error) {
              await this.logTask(taskRun.id, `Failed to refresh task lock (${label}); treating as lock loss.`, "vcs", {
                error: (error as Error).message,
                reason: "refresh_failed",
              });
              return false;
            }
            return true;
          };

          if (!request.dryRun) {
            try {
              branchInfo = await this.ensureBranches(task.task.key, baseBranch, taskRun.id);
              taskBranchName = branchInfo.branch || taskBranchName;
              baseBranchName = branchInfo.base || baseBranchName;
              mergeConflicts = branchInfo.mergeConflicts ?? [];
              remoteSyncNote = branchInfo.remoteSyncNote ?? "";
              if (mergeConflicts.length && allowedFiles.length) {
                allowedFiles = Array.from(new Set([...allowedFiles, ...mergeConflicts.map((f) => f.replace(/\\/g, "/"))]));
              }
              await this.deps.workspaceRepo.updateTask(task.task.id, {
                vcsBranch: branchInfo.branch,
                vcsBaseBranch: branchInfo.base,
              });
              await this.logTask(taskRun.id, `Using branch ${branchInfo.branch} (base ${branchInfo.base})`, "vcs");
            } catch (error) {
              const message = `Failed to prepare branches: ${(error as Error).message}`;
              await this.logTask(taskRun.id, message, "vcs");
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              results.push({ taskKey: task.task.key, status: "failed", notes: message });
              taskStatus = "failed";
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue;
            }
          }

          await startPhase("context", { allowedFiles, tests: testCommands });
          const docLinks = Array.isArray((metadata as any).doc_links) ? (metadata as any).doc_links : [];
          const { summary: docSummary, warnings: docWarnings } = await this.gatherDocContext(request.projectKey, docLinks);
          if (docWarnings.length) {
            warnings.push(...docWarnings);
            await this.logTask(taskRun.id, docWarnings.join("; "), "docdex");
          }
          await endPhase("context", { docWarnings, docSummary: Boolean(docSummary) });

          await startPhase("prompt", { docSummary: Boolean(docSummary), agent: agent.id });
          const conflictNote = mergeConflicts.length
            ? `Merge conflicts detected in: ${mergeConflicts.join(", ")}. Resolve these conflicts before any other task work. Remove conflict markers and ensure the files are consistent.`
            : "";
          const promptBase = this.buildPrompt(task, docSummary, allowedFiles);
          const notes = [remoteSyncNote, conflictNote].filter(Boolean).join("\n");
          const prompt = notes ? `${notes}\n\n${promptBase}` : promptBase;
          const commandPrompt = prompts.commandPrompt ?? "";
          const systemPrompt = [prompts.jobPrompt, prompts.characterPrompt, commandPrompt].filter(Boolean).join("\n\n");
          await this.logTask(taskRun.id, `System prompt:\n${systemPrompt || "(none)"}`, "prompt");
          await this.logTask(taskRun.id, `Task prompt:\n${prompt}`, "prompt");
          promptEstimate = estimateTokens(systemPrompt + prompt);
          await endPhase("prompt", { hasSystemPrompt: Boolean(systemPrompt) });

          if (request.dryRun) {
            await this.logTask(taskRun.id, "Dry-run enabled; skipping execution.", "execution");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
              status: "succeeded",
              finishedAt: new Date().toISOString(),
            });
            results.push({ taskKey: task.task.key, status: "skipped", notes: "dry_run" });
            taskStatus = "skipped";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue;
          }

          try {
            await this.stateService.transitionToInProgress(task.task);
          } catch (error) {
            await this.logTask(taskRun.id, `Failed to move task to in_progress: ${(error as Error).message}`, "state");
          }

          const streamChunk = (text?: string) => {
            if (!text) return;
            if (request.onAgentChunk) {
              request.onAgentChunk(text);
              return;
            }
            if (agentStream) {
              process.stdout.write(text);
            }
          };

          const invokeAgentOnce = async (input: string, phaseLabel: string) => {
            let output = "";
            const started = Date.now();
            if (agentStream && this.deps.agentService.invokeStream) {
              const stream = await this.deps.agentService.invokeStream(agent.id, {
                input,
                metadata: { taskKey: task.task.key },
              });
              let pollLockLost = false;
              const refreshTimer = setInterval(() => {
                void refreshLock("agent_stream_poll").then((ok) => {
                  if (!ok) pollLockLost = true;
                });
              }, getLockRefreshIntervalMs());
              try {
                for await (const chunk of stream) {
                  output += chunk.output ?? "";
                  streamChunk(chunk.output);
                  await this.logTask(taskRun.id, chunk.output ?? "", phaseLabel);
                  if (!(await refreshLock("agent_stream"))) {
                    await this.logTask(taskRun.id, "Aborting task: lock lost during agent streaming.", "vcs");
                    throw new Error("Task lock lost during agent stream.");
                  }
                }
              } finally {
                clearInterval(refreshTimer);
              }
              if (pollLockLost) {
                await this.logTask(taskRun.id, "Aborting task: lock lost during agent stream.", "vcs");
                throw new Error("Task lock lost during agent stream.");
              }
            } else {
              let pollLockLost = false;
              let rejectLockLost: ((error: Error) => void) | null = null;
              const lockLostPromise = new Promise<never>((_, reject) => {
                rejectLockLost = reject;
              });
              const refreshTimer = setInterval(() => {
                void refreshLock("agent_poll").then((ok) => {
                  if (ok || pollLockLost) return;
                  pollLockLost = true;
                  if (rejectLockLost) rejectLockLost(new Error("Task lock lost during agent invoke."));
                });
              }, getLockRefreshIntervalMs());
              const invokePromise = this.deps.agentService
                .invoke(agent.id, { input, metadata: { taskKey: task.task.key } })
                .catch((error) => {
                  if (pollLockLost) return null as any;
                  throw error;
                });
              try {
                const result = await Promise.race([invokePromise, lockLostPromise]);
                if (result) {
                  output = result.output ?? "";
                }
              } finally {
                clearInterval(refreshTimer);
              }
              if (pollLockLost) {
                await this.logTask(taskRun.id, "Aborting task: lock lost during agent invoke.", "vcs");
                throw new Error("Task lock lost during agent invoke.");
              }
              streamChunk(output);
              await this.logTask(taskRun.id, output, phaseLabel);
            }
            return { output, durationSeconds: (Date.now() - started) / 1000 };
          };

      let agentOutput = "";
      let agentDuration = 0;
      let triedRetry = false;

      try {
        await startPhase("agent", { agent: agent.id, stream: agentStream });
        const first = await invokeAgentOnce(`${systemPrompt}\n\n${prompt}`, "agent");
        agentOutput = first.output;
        agentDuration = first.durationSeconds;
        await endPhase("agent", { agentDurationSeconds: agentDuration });
        if (!(await refreshLock("agent"))) {
          await this.logTask(taskRun.id, "Aborting task: lock lost after agent completion.", "vcs");
          throw new Error("Task lock lost after agent completion.");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/task lock lost/i.test(message)) {
          throw error;
        }
        await this.logTask(taskRun.id, `Agent invocation failed: ${message}`, "agent");
        await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "agent", "error", { error: message });
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
        });
        results.push({ taskKey: task.task.key, status: "failed", notes: message });
        taskStatus = "failed";
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        continue;
      }

      const recordUsage = async (phase: "agent" | "agent_retry", output: string, durationSeconds: number) => {
        const promptTokens = promptEstimate || estimateTokens(systemPrompt + prompt);
        if (!promptEstimate) promptEstimate = promptTokens;
        const completionTokens = estimateTokens(output);
        tokensPromptTotal += promptTokens;
        tokensCompletionTotal += completionTokens;
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
          phase,
          durationSeconds,
        });
      };

      await recordUsage("agent", agentOutput, agentDuration);

      let patches = extractPatches(agentOutput);
      if (patches.length === 0 && !triedRetry) {
        triedRetry = true;
        await this.logTask(taskRun.id, "Agent output did not include a patch; retrying with explicit patch-only instruction.", "agent");
        try {
          const retry = await invokeAgentOnce(
            `${systemPrompt}\n\n${prompt}\n\nONLY OUTPUT the code changes as unified diff inside \`\`\`patch\`\`\` fences. Do not include analysis or narration.`,
            "agent",
          );
          agentOutput = retry.output;
          agentDuration += retry.durationSeconds;
          await recordUsage("agent_retry", retry.output, retry.durationSeconds);
          patches = extractPatches(agentOutput);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.logTask(taskRun.id, `Agent retry failed: ${message}`, "agent");
        }
      }

          if (patches.length === 0) {
            const message = "Agent output did not include a patch.";
            await this.logTask(taskRun.id, message, "agent");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
            await this.stateService.markBlocked(task.task, "missing_patch");
            results.push({ taskKey: task.task.key, status: "failed", notes: "missing_patch" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue;
          }

          if (patches.length) {
            if (!(await refreshLock("apply_start", true))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost before apply.", "vcs");
              throw new Error("Task lock lost before apply.");
            }
            await startPhase("apply", { patchCount: patches.length });
            const applied = await this.applyPatches(
              patches,
              this.workspace.workspaceRoot,
              request.dryRun ?? false,
            );
            touched = applied.touched;
            if (applied.warnings?.length) {
              await this.logTask(taskRun.id, applied.warnings.join("; "), "patch");
            }
            if (applied.error) {
              await this.logTask(taskRun.id, `Patch apply failed: ${applied.error}`, "patch");
              await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "apply", "error", { error: applied.error });
              await this.stateService.markBlocked(task.task, "patch_failed");
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              results.push({ taskKey: task.task.key, status: "failed", notes: "patch_failed" });
              taskStatus = "failed";
              if (!request.dryRun && request.noCommit !== true) {
                await this.commitPendingChanges(
                  branchInfo,
                  task.task.key,
                  task.task.title,
                  "auto-save (patch_failed)",
                  task.task.id,
                  taskRun.id,
                );
              }
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue;
            }
            patchApplied = true;
            await endPhase("apply", { touched });
            if (!(await refreshLock("apply"))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost after apply.", "vcs");
              throw new Error("Task lock lost after apply.");
            }
          }

          if (patchApplied && allowedFiles.length) {
            const dirtyAfterApply = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
            const scopeCheck = this.validateScope(allowedFiles, normalizePaths(this.workspace.workspaceRoot, dirtyAfterApply));
            if (!scopeCheck.ok) {
              await this.logTask(taskRun.id, scopeCheck.message ?? "Scope violation", "scope");
              await this.stateService.markBlocked(task.task, "scope_violation");
              await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
              results.push({ taskKey: task.task.key, status: "failed", notes: "scope_violation" });
              taskStatus = "failed";
              if (!request.dryRun && request.noCommit !== true && patchApplied) {
                await this.commitPendingChanges(branchInfo, task.task.key, task.task.title, "auto-save (scope_violation)", task.task.id, taskRun.id);
              }
              await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
              continue;
            }
          }

          if (!request.dryRun && testCommands.length && patchApplied) {
            await startPhase("tests", { commands: testCommands });
            const testResult = await this.runTests(testCommands, this.workspace.workspaceRoot);
            await this.logTask(taskRun.id, "Test results", "tests", { results: testResult.results });
            if (!testResult.ok) {
              await this.logTask(taskRun.id, "Tests failed; continuing task run with warnings.", "tests");
              softFailures.push("tests_failed");
              await endPhase("tests", { results: testResult.results, warning: "tests_failed" });
            } else {
              await endPhase("tests", { results: testResult.results });
            }
            if (!(await refreshLock("tests"))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost after tests.", "vcs");
              throw new Error("Task lock lost after tests.");
            }
          }

      if (!request.dryRun && request.noCommit !== true) {
        if (!(await refreshLock("vcs_start", true))) {
          await this.logTask(taskRun.id, "Aborting task: lock lost before VCS phase.", "vcs");
          throw new Error("Task lock lost before VCS phase.");
        }
        await startPhase("vcs", { branch: branchInfo.branch, base: branchInfo.base });
        try {
          const dirty = (await this.vcs.dirtyPaths(this.workspace.workspaceRoot)).filter((p) => !p.startsWith(".mcoda"));
          const toStage = dirty.length ? dirty : touched.length ? touched : ["."];
          await this.vcs.stage(this.workspace.workspaceRoot, toStage);
          const status = await this.vcs.status(this.workspace.workspaceRoot);
          const hasChanges = status.trim().length > 0;
          if (hasChanges) {
            const commitMessage = `[${task.task.key}] ${task.task.title}`;
            let committed = false;
            try {
              await this.vcs.commit(this.workspace.workspaceRoot, commitMessage);
              committed = true;
            } catch (error) {
              const errorText = this.formatGitError(error);
              const hookFailure = this.isCommitHookFailure(errorText);
              const gpgFailure = this.isGpgSignFailure(errorText);
              if (hookFailure || gpgFailure) {
                const guidance = [
                  hookFailure
                    ? "Commit hook failed; run hooks manually or configure bypass (e.g., HUSKY=0) if policy allows."
                    : "",
                  gpgFailure
                    ? "GPG signing failed; configure signing key or disable commit.gpgsign for this repo."
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                await this.logTask(taskRun.id, `Commit failed; retrying with bypass flags. ${guidance}`, "vcs", {
                  error: errorText,
                });
                try {
                  await this.vcs.commit(this.workspace.workspaceRoot, commitMessage, {
                    noVerify: hookFailure,
                    noGpgSign: gpgFailure,
                  });
                  committed = true;
                  await this.logTask(taskRun.id, "Commit succeeded after bypassing hook/signing checks.", "vcs");
                } catch (retryError) {
                  const retryText = this.formatGitError(retryError);
                  throw new Error(`Commit failed after retry: ${retryText}`);
                }
              } else {
                throw error;
              }
            }
            if (committed) {
              const head = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
              await this.deps.workspaceRepo.updateTask(task.task.id, { vcsLastCommitSha: head });
              await this.logTask(taskRun.id, `Committed changes (${head})`, "vcs");
              headSha = head;
            }
          } else {
            await this.logTask(taskRun.id, "No changes to commit.", "vcs");
          }

          // Always merge back into base and end on base branch.
          try {
            await this.vcs.merge(this.workspace.workspaceRoot, branchInfo.branch, branchInfo.base);
            mergeStatus = "merged";
            try {
              headSha = await this.vcs.lastCommitSha(this.workspace.workspaceRoot);
            } catch {
              // Best-effort head capture.
            }
            await this.logTask(taskRun.id, `Merged ${branchInfo.branch} into ${branchInfo.base}`, "vcs");
            if (!(await refreshLock("vcs_merge"))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost after merge.", "vcs");
              throw new Error("Task lock lost after merge.");
            }
          } catch (error) {
            mergeStatus = "failed";
            const conflicts = await this.vcs.conflictPaths(this.workspace.workspaceRoot);
            if (conflicts.length) {
              await this.logTask(taskRun.id, `Merge conflicts while merging ${branchInfo.branch} into ${branchInfo.base}.`, "vcs", {
                conflicts,
              });
              throw new Error(
                `Merge conflict(s) while merging ${branchInfo.branch} into ${branchInfo.base}: ${conflicts.join(", ")}`,
              );
            }
            throw error;
          }

          if (await this.vcs.hasRemote(this.workspace.workspaceRoot)) {
            const branchPush = await this.pushWithRecovery(taskRun.id, branchInfo.branch);
            if (branchPush.pushed) {
              await this.logTask(taskRun.id, "Pushed branch to remote origin", "vcs");
            } else if (branchPush.skipped) {
              await this.logTask(taskRun.id, "Skipped pushing branch to remote origin due to permissions/protection.", "vcs");
            }
            if (!(await refreshLock("vcs_push_branch"))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost after pushing branch.", "vcs");
              throw new Error("Task lock lost after pushing branch.");
            }
            const basePush = await this.pushWithRecovery(taskRun.id, branchInfo.base);
            if (basePush.pushed) {
              await this.logTask(taskRun.id, `Pushed base branch ${branchInfo.base} to remote origin`, "vcs");
            } else if (basePush.skipped) {
              await this.logTask(taskRun.id, `Skipped pushing base branch ${branchInfo.base} due to permissions/protection.`, "vcs");
            }
            if (!(await refreshLock("vcs_push_base"))) {
              await this.logTask(taskRun.id, "Aborting task: lock lost after pushing base branch.", "vcs");
              throw new Error("Task lock lost after pushing base branch.");
            }
          } else {
            await this.logTask(taskRun.id, "No remote configured; merge completed locally.", "vcs");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/task lock lost/i.test(message)) {
            throw error;
          }
          await this.logTask(taskRun.id, `VCS commit/push failed: ${message}`, "vcs");
          await this.updateTaskPhase(job.id, taskRun.id, task.task.key, "vcs", "error", { error: message });
          await this.stateService.markBlocked(task.task, "vcs_failed");
          await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
          results.push({ taskKey: task.task.key, status: "failed", notes: "vcs_failed" });
          taskStatus = "failed";
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

        const reviewMetadata: Record<string, unknown> = { last_run: finishedAt };
        if (softFailures.length) {
          reviewMetadata.soft_failures = softFailures;
        }
        await this.stateService.markReadyToReview(task.task, reviewMetadata);
        await this.deps.workspaceRepo.updateTaskRun(taskRun.id, {
          status: "succeeded",
          finishedAt,
          spPerHourEffective: spPerHour,
          gitBranch: branchInfo.branch,
          gitBaseBranch: branchInfo.base,
        });

        storyPointsProcessed += task.task.storyPoints ?? 0;
        await endPhase("finalize", { spPerHour: spPerHour ?? undefined });

        const resultNotes = softFailures.length ? `ready_to_review_with_warnings:${softFailures.join(",")}` : "ready_to_review";
        taskStatus = "succeeded";
        results.push({
          taskKey: task.task.key,
          status: "succeeded",
          notes: resultNotes,
          branch: branchInfo.branch,
        });
        await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
        await this.checkpoint(job.id, "task_completed", { taskKey: task.task.key });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/task lock lost/i.test(message)) {
            await this.logTask(taskRun.id, `Task aborted: ${message}`, "vcs");
            await this.deps.workspaceRepo.updateTaskRun(taskRun.id, { status: "failed", finishedAt: new Date().toISOString() });
            await this.stateService.markBlocked(task.task, "task_lock_lost");
            if (!request.dryRun && request.noCommit !== true) {
              await this.commitPendingChanges(branchInfo, task.task.key, task.task.title, "auto-save (lock_lost)", task.task.id, taskRun.id);
            }
            results.push({ taskKey: task.task.key, status: "failed", notes: "task_lock_lost" });
            taskStatus = "failed";
            await this.deps.jobService.updateJobStatus(job.id, "running", { processedItems: index + 1 });
            continue;
          }
          throw error;
        } finally {
          await emitTaskEndOnce();
          if (lockAcquired) {
            await this.deps.workspaceRepo.releaseTaskLock(task.task.id, taskRun.id);
          }
        }
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
  } finally {
    // Best-effort return to base branch after processing.
    try {
      await this.vcs.checkoutBranch(this.workspace.workspaceRoot, baseBranch);
    } catch {
      // ignore if checkout fails (e.g., dirty tree); user can resolve manually.
    }
  }
}
