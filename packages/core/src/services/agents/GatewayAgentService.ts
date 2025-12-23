import path from "node:path";
import fs from "node:fs";
import { AgentService } from "@mcoda/agents";
import { DocdexClient, DocdexDocument } from "@mcoda/integrations";
import { GlobalRepository, WorkspaceRepository } from "@mcoda/db";
import { Agent, canonicalizeCommandName, getCommandRequiredCapabilities } from "@mcoda/shared";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import { JobService } from "../jobs/JobService.js";
import { TaskSelectionService, TaskSelectionFilters, SelectedTask } from "../execution/TaskSelectionService.js";
import { RoutingService } from "./RoutingService.js";

const DEFAULT_GATEWAY_PROMPT = [
  "You are the gateway agent. Read the task context and docdex snippets, then summarize the task, decide what to do, and plan the work.",
  "Return JSON only with the following schema:",
  "{",
  '  "summary": "1-3 sentence summary of the task and intent",',
  '  "understanding": "short statement of what success looks like",',
  '  "plan": ["step 1", "step 2", "step 3"],',
  '  "complexity": 1-10,',
  '  "discipline": "backend|frontend|uiux|docs|architecture|qa|planning|ops|other",',
  '  "assumptions": ["assumption 1"],',
  '  "risks": ["risk 1"],',
  '  "docdexNotes": ["notes about docdex coverage/gaps"]',
  "}",
  "If information is missing, keep arrays empty and mention the gap in assumptions or docdexNotes.",
].join("\n");

const DEFAULT_JOB_PROMPT =
  "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";

const extractJson = (raw: string): any | undefined => {
  const fenced = raw.match(/```json([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  const body = candidate.slice(start, end + 1);
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const estimateTokens = (text: string): number => Math.max(1, Math.ceil((text ?? "").length / 4));

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const normalizeList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
};

const normalizeDiscipline = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  const allowed = new Set(["backend", "frontend", "uiux", "docs", "architecture", "qa", "planning", "ops", "other"]);
  return allowed.has(normalized) ? normalized : "other";
};

const inferDiscipline = (job: string, taskTitles: string[], input?: string): string => {
  const text = [job, ...taskTitles, input ?? ""].join(" ").toLowerCase();
  if (text.includes("sds") || text.includes("pdr") || text.includes("documentation")) return "docs";
  if (text.includes("openapi") || text.includes("spec")) return "docs";
  if (text.includes("qa") || text.includes("test")) return "qa";
  if (text.includes("architecture") || text.includes("design")) return "architecture";
  if (text.includes("refine") || text.includes("create-tasks") || text.includes("planning")) return "planning";
  if (text.includes("frontend") || text.includes("ui") || text.includes("ux")) return "frontend";
  if (text.includes("backend") || text.includes("api") || text.includes("database")) return "backend";
  return "other";
};

const usageKeywords: Record<string, string[]> = {
  backend: ["backend", "api", "server", "db", "database"],
  frontend: ["frontend", "ui", "ux", "web", "react", "mobile"],
  uiux: ["ui", "ux", "design", "prototype"],
  docs: ["doc", "documentation", "sds", "pdr", "spec"],
  architecture: ["arch", "architecture", "system", "design"],
  qa: ["qa", "test", "testing", "quality"],
  planning: ["plan", "planning", "product", "pm"],
  ops: ["ops", "devops", "infra", "deployment"],
};

const scoreUsage = (discipline: string, bestUsage?: string, capabilities?: string[]): number => {
  if (!discipline) return 0;
  const normalized = (bestUsage ?? "").toLowerCase();
  const keywords = usageKeywords[discipline] ?? [];
  const hasKeyword = keywords.some((k) => normalized.includes(k));
  let score = hasKeyword ? 1 : 0;
  const caps = new Set((capabilities ?? []).map((c) => c.toLowerCase()));
  if (discipline === "docs" && caps.has("docdex_query")) score += 0.5;
  if (discipline === "qa" && caps.has("qa_interpretation")) score += 0.5;
  if (discipline === "planning" && caps.has("plan")) score += 0.5;
  if ((discipline === "backend" || discipline === "frontend") && caps.has("code_write")) score += 0.5;
  return score;
};

const DEFAULT_STATUS_FILTER = [
  "not_started",
  "in_progress",
  "blocked",
  "ready_to_review",
  "ready_to_qa",
  "completed",
  "cancelled",
  "failed",
  "skipped",
];

const summarizeDoc = (doc: DocdexDocument, index: number): GatewayDocSummary => {
  const title = doc.title ?? doc.path ?? doc.id ?? `doc-${index + 1}`;
  const excerptSource = doc.segments?.[0]?.content ?? doc.content ?? "";
  const excerpt = excerptSource ? (excerptSource.length > 480 ? `${excerptSource.slice(0, 480)}...` : excerptSource) : undefined;
  return {
    id: doc.id ?? `doc-${index + 1}`,
    docType: doc.docType,
    title,
    path: doc.path,
    excerpt,
  };
};

const buildDocContext = (docs: GatewayDocSummary[]): string => {
  if (docs.length === 0) return "Docdex: (no matching documents found)";
  return [
    "Docdex context:",
    ...docs.map((doc) => {
      const head = `[${doc.docType}] ${doc.title}`;
      const tail = doc.path ? ` (${doc.path})` : "";
      const excerpt = doc.excerpt ? `\n  Excerpt: ${doc.excerpt}` : "";
      return `- ${head}${tail}${excerpt}`;
    }),
  ].join("\n");
};

const buildTaskContext = (tasks: GatewayTaskSummary[]): string => {
  if (tasks.length === 0) return "Task context: (no task records found)";
  const lines: string[] = ["Task context:"];
  for (const task of tasks) {
    lines.push(
      [
        `- ${task.key}: ${task.title}`,
        task.description ? `  Description: ${task.description}` : undefined,
        task.status ? `  Status: ${task.status}` : undefined,
        task.storyKey ? `  Story: ${task.storyKey} ${task.storyTitle ?? ""}`.trim() : undefined,
        task.epicKey ? `  Epic: ${task.epicKey} ${task.epicTitle ?? ""}`.trim() : undefined,
        task.storyPoints !== undefined ? `  Story points: ${task.storyPoints}` : undefined,
        task.acceptanceCriteria?.length ? `  Acceptance: ${task.acceptanceCriteria.join(" | ")}` : undefined,
        task.dependencies?.length ? `  Dependencies: ${task.dependencies.join(", ")}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return lines.join("\n");
};

export interface GatewayDocSummary {
  id: string;
  docType: string;
  title: string;
  path?: string;
  excerpt?: string;
}

export interface GatewayTaskSummary {
  key: string;
  title: string;
  description?: string;
  status?: string;
  storyPoints?: number;
  storyKey?: string;
  storyTitle?: string;
  epicKey?: string;
  epicTitle?: string;
  acceptanceCriteria?: string[];
  dependencies?: string[];
}

export interface GatewayAnalysis {
  summary: string;
  understanding: string;
  plan: string[];
  complexity: number;
  discipline: string;
  assumptions: string[];
  risks: string[];
  docdexNotes: string[];
}

export interface GatewayAgentDecision {
  agentId: string;
  agentSlug: string;
  rating?: number;
  reasoningRating?: number;
  bestUsage?: string;
  costPerMillion?: number;
  rationale: string;
}

export interface GatewayAgentResult {
  commandRunId: string;
  job: string;
  gatewayAgent: { id: string; slug: string };
  tasks: GatewayTaskSummary[];
  docdex: GatewayDocSummary[];
  analysis: GatewayAnalysis;
  chosenAgent: GatewayAgentDecision;
  warnings: string[];
}

export interface GatewayAgentRequest extends TaskSelectionFilters {
  workspace: WorkspaceResolution;
  job: string;
  inputText?: string;
  gatewayAgentName?: string;
  maxDocs?: number;
}

type Candidate = {
  agent: Agent;
  capabilities: string[];
  health?: { status?: string };
  quality: number;
  reasoning: number;
  usageScore: number;
  cost: number;
};

export class GatewayAgentService {
  private taskSelectionService: TaskSelectionService;

  private constructor(
    private workspace: WorkspaceResolution,
    private deps: {
      agentService: AgentService;
      docdex: DocdexClient;
      globalRepo: GlobalRepository;
      jobService: JobService;
      workspaceRepo: WorkspaceRepository;
      routingService: RoutingService;
    },
  ) {
    this.taskSelectionService = new TaskSelectionService(workspace, deps.workspaceRepo);
  }

  static async create(workspace: WorkspaceResolution): Promise<GatewayAgentService> {
    const globalRepo = await GlobalRepository.create();
    const agentService = new AgentService(globalRepo);
    const routingService = await RoutingService.create();
    const docdex = new DocdexClient({
      workspaceRoot: workspace.workspaceRoot,
      baseUrl: workspace.config?.docdexUrl ?? process.env.MCODA_DOCDEX_URL,
    });
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const jobService = new JobService(workspace, workspaceRepo);
    return new GatewayAgentService(workspace, {
      agentService,
      docdex,
      globalRepo,
      jobService,
      workspaceRepo,
      routingService,
    });
  }

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

  async close(): Promise<void> {
    const maybeClose = async (target: unknown) => {
      try {
        if ((target as any)?.close) await (target as any).close();
      } catch {
        /* ignore */
      }
    };
    await maybeClose(this.taskSelectionService);
    await maybeClose(this.deps.agentService);
    await maybeClose(this.deps.docdex);
    await maybeClose(this.deps.globalRepo);
    await maybeClose(this.deps.jobService);
    await maybeClose(this.deps.workspaceRepo);
    await maybeClose(this.deps.routingService);
  }

  private async loadGatewayPrompts(agentId: string): Promise<{ jobPrompt: string; characterPrompt: string; commandPrompt: string }> {
    const agentPrompts =
      "getPrompts" in this.deps.agentService ? await (this.deps.agentService as any).getPrompts(agentId) : undefined;
    const mcodaPromptPath = path.join(this.workspace.workspaceRoot, ".mcoda", "prompts", "gateway-agent.md");
    const workspacePromptPath = path.join(this.workspace.workspaceRoot, "prompts", "gateway-agent.md");
    try {
      await fs.promises.mkdir(path.dirname(mcodaPromptPath), { recursive: true });
      await fs.promises.access(mcodaPromptPath);
    } catch {
      try {
        await fs.promises.access(workspacePromptPath);
        await fs.promises.copyFile(workspacePromptPath, mcodaPromptPath);
      } catch {
        await fs.promises.writeFile(mcodaPromptPath, DEFAULT_GATEWAY_PROMPT, "utf8");
      }
    }
    const commandPromptFiles = await this.readPromptFiles([mcodaPromptPath, workspacePromptPath]);
    const mergedCommandPrompt = (() => {
      const parts = [...commandPromptFiles];
      if (agentPrompts?.commandPrompts?.["gateway-agent"]) {
        parts.push(agentPrompts.commandPrompts["gateway-agent"]);
      }
      if (!parts.length) parts.push(DEFAULT_GATEWAY_PROMPT);
      return parts.filter(Boolean).join("\n\n");
    })();
    return {
      jobPrompt: agentPrompts?.jobPrompt ?? DEFAULT_JOB_PROMPT,
      characterPrompt: agentPrompts?.characterPrompt ?? DEFAULT_CHARACTER_PROMPT,
      commandPrompt: mergedCommandPrompt,
    };
  }

  private async resolveGatewayAgent(override?: string, warnings: string[] = []): Promise<Agent> {
    try {
      const resolved = await this.deps.routingService.resolveAgentForCommand({
        workspace: this.workspace,
        commandName: "gateway-agent",
        overrideAgentSlug: override,
      });
      return resolved.agent;
    } catch (error) {
      warnings.push(`Routing defaults unavailable for gateway-agent; using best available agent (${(error as Error).message})`);
      const requiredCaps = getCommandRequiredCapabilities("gateway-agent");
      if (override) {
        try {
          const overrideAgent = await this.deps.agentService.resolveAgent(override);
          const caps = await this.deps.globalRepo.getAgentCapabilities(overrideAgent.id);
          const missing = requiredCaps.filter((cap) => !caps.includes(cap));
          const health = await this.deps.globalRepo.getAgentHealth(overrideAgent.id);
          if (missing.length === 0 && health?.status !== "unreachable") {
            return overrideAgent;
          }
          if (missing.length) {
            warnings.push(
              `Override agent ${overrideAgent.slug} is missing gateway capabilities (${missing.join(", ")}); ignoring override.`,
            );
          } else if (health?.status === "unreachable") {
            warnings.push(`Override agent ${overrideAgent.slug} is unreachable; ignoring override.`);
          }
        } catch (overrideError) {
          warnings.push(`Override agent ${override} could not be resolved (${(overrideError as Error).message}); ignoring override.`);
        }
      }
      const candidates = await this.listCandidates(requiredCaps, "planning");
      if (!candidates.length) {
        throw new Error("No eligible gateway agents available; add a plan/docdex_query-capable agent");
      }
      const sorted = candidates
        .slice()
        .sort((a, b) => {
          const qa = b.reasoning || b.quality;
          const qb = a.reasoning || a.quality;
          if (qa !== qb) return qa - qb;
          if (b.quality !== a.quality) return b.quality - a.quality;
          return a.cost - b.cost;
        });
      return sorted[0].agent;
    }
  }

  private async buildTasksSummary(request: GatewayAgentRequest, warnings: string[]): Promise<GatewayTaskSummary[]> {
    const hasFilters =
      Boolean(request.projectKey) ||
      Boolean(request.epicKey) ||
      Boolean(request.storyKey) ||
      Boolean(request.taskKeys?.length);
    if (!hasFilters) return [];
    const limit = request.taskKeys?.length ? request.taskKeys.length : request.limit ?? 8;
    try {
      const filters: TaskSelectionFilters = {
        projectKey: request.projectKey,
        epicKey: request.epicKey,
        storyKey: request.storyKey,
        taskKeys: request.taskKeys,
        statusFilter: request.statusFilter?.length ? request.statusFilter : DEFAULT_STATUS_FILTER,
        limit,
      };
      const selection = await this.taskSelectionService.selectTasks(filters);
      if (selection.warnings.length) warnings.push(...selection.warnings);
      const combined: SelectedTask[] = [...selection.ordered, ...selection.blocked];
      return combined.slice(0, limit).map((entry) => ({
        key: entry.task.key,
        title: entry.task.title,
        description: entry.task.description ?? undefined,
        status: entry.task.status,
        storyPoints: entry.task.storyPoints ?? undefined,
        storyKey: entry.task.storyKey,
        storyTitle: entry.task.storyTitle,
        epicKey: entry.task.epicKey,
        epicTitle: entry.task.epicTitle,
        acceptanceCriteria: entry.task.acceptanceCriteria,
        dependencies: entry.dependencies.keys,
      }));
    } catch (error) {
      warnings.push(`Task lookup failed: ${(error as Error).message}`);
      return [];
    }
  }

  private pickDocTypes(job: string, input?: string): string[] {
    const types = new Set<string>();
    const lower = `${job} ${input ?? ""}`.toLowerCase();
    if (lower.includes("sds")) types.add("SDS");
    if (lower.includes("pdr")) types.add("PDR");
    if (lower.includes("rfp")) types.add("RFP");
    if (lower.includes("openapi")) types.add("OPENAPI");
    if (lower.includes("doc")) {
      types.add("SDS");
      types.add("PDR");
    }
    if (types.size === 0) {
      types.add("SDS");
      types.add("PDR");
      types.add("OPENAPI");
    }
    return Array.from(types);
  }

  private buildQuerySeed(tasks: GatewayTaskSummary[], input?: string): string {
    const seeds: string[] = [];
    tasks.forEach((task) => {
      seeds.push(task.key, task.title);
      if (task.storyTitle) seeds.push(task.storyTitle);
      if (task.epicTitle) seeds.push(task.epicTitle);
    });
    if (input) {
      seeds.push(...input.split(/\s+/).slice(0, 12));
    }
    return Array.from(new Set(seeds.map((s) => s.trim()).filter(Boolean))).slice(0, 10).join(" ");
  }

  private async buildDocSummaries(
    request: GatewayAgentRequest,
    tasks: GatewayTaskSummary[],
    warnings: string[],
  ): Promise<GatewayDocSummary[]> {
    const maxDocs = request.maxDocs ?? 4;
    if (maxDocs <= 0) return [];
    const docTypes = this.pickDocTypes(request.job, request.inputText);
    const query = this.buildQuerySeed(tasks, request.inputText);
    const summaries: GatewayDocSummary[] = [];
    for (const docType of docTypes) {
      if (summaries.length >= maxDocs) break;
      try {
        const docs = await this.deps.docdex.search({
          projectKey: request.projectKey,
          docType,
          query,
        });
        for (const doc of docs) {
          if (summaries.length >= maxDocs) break;
          summaries.push(summarizeDoc(doc, summaries.length));
        }
      } catch (error) {
        warnings.push(`Docdex search failed (${docType}): ${(error as Error).message}`);
      }
    }
    return summaries;
  }

  private buildGatewayPrompt(
    job: string,
    tasks: GatewayTaskSummary[],
    docs: GatewayDocSummary[],
    inputText?: string,
  ): string {
    const taskContext = buildTaskContext(tasks);
    const docContext = buildDocContext(docs);
    const inputBlock = inputText ? `Additional input:\n${inputText}` : "Additional input: (none)";
    return [`Job: ${job}`, taskContext, inputBlock, docContext].join("\n\n");
  }

  private normalizeAnalysis(raw: any, job: string, tasks: GatewayTaskSummary[], inputText?: string): GatewayAnalysis {
    const summary = typeof raw?.summary === "string" && raw.summary.trim().length ? raw.summary.trim() : undefined;
    const understanding =
      typeof raw?.understanding === "string" && raw.understanding.trim().length ? raw.understanding.trim() : "";
    const plan = normalizeList(raw?.plan);
    const complexityRaw = Number(raw?.complexity);
    const complexity = Number.isFinite(complexityRaw) ? clamp(Math.round(complexityRaw), 1, 10) : 5;
    const discipline =
      normalizeDiscipline(typeof raw?.discipline === "string" ? raw.discipline : undefined) ??
      inferDiscipline(job, tasks.map((t) => t.title), inputText);
    const fallbackSummary =
      summary ??
      (tasks.length
        ? `Handle ${tasks.length} task${tasks.length > 1 ? "s" : ""}: ${tasks.map((t) => t.key).join(", ")}.`
        : inputText?.slice(0, 200) ?? "Summarize the requested job.");
    return {
      summary: fallbackSummary,
      understanding,
      plan: plan.length ? plan : ["Review requirements and docs", "Execute the job", "Verify outcomes"],
      complexity,
      discipline,
      assumptions: normalizeList(raw?.assumptions),
      risks: normalizeList(raw?.risks),
      docdexNotes: normalizeList(raw?.docdexNotes),
    };
  }

  private async listCandidates(requiredCaps: string[], discipline: string): Promise<Candidate[]> {
    const agents = await this.deps.globalRepo.listAgents();
    if (agents.length === 0) {
      throw new Error("No agents available; register one with mcoda agent add");
    }
    const health = await this.deps.globalRepo.listAgentHealthSummary();
    const healthById = new Map(health.map((row) => [row.agentId, row]));
    const candidates: Candidate[] = [];
    for (const agent of agents) {
      const capabilities = await this.deps.globalRepo.getAgentCapabilities(agent.id);
      const missing = requiredCaps.filter((cap) => !capabilities.includes(cap));
      if (missing.length) continue;
      const healthEntry = healthById.get(agent.id);
      if (healthEntry?.status === "unreachable") continue;
      const rating = agent.rating ?? 0;
      const reasoning = agent.reasoningRating ?? rating;
      const quality =
        discipline === "architecture" || discipline === "planning"
          ? reasoning || rating || 5
          : rating || reasoning || 5;
      const usageScore = scoreUsage(discipline, agent.bestUsage, capabilities);
      const cost = agent.costPerMillion ?? Number.POSITIVE_INFINITY;
      const adjustedQuality = healthEntry?.status === "degraded" ? quality - 0.5 : quality;
      candidates.push({
        agent,
        capabilities,
        health: healthEntry,
        quality: adjustedQuality,
        reasoning,
        usageScore,
        cost,
      });
    }
    return candidates;
  }

  private chooseCandidate(candidates: Candidate[], complexity: number, discipline: string): { pick: Candidate; rationale: string } {
    if (candidates.length === 0) {
      throw new Error("No eligible agents available for this job");
    }
    const sortedQuality = candidates.map((c) => c.quality);
    const maxQuality = Math.max(...sortedQuality);
    if (complexity >= 9) {
      const pick = candidates
        .slice()
        .sort((a, b) => {
          if (b.quality !== a.quality) return b.quality - a.quality;
          if (b.usageScore !== a.usageScore) return b.usageScore - a.usageScore;
          if (b.reasoning !== a.reasoning) return b.reasoning - a.reasoning;
          return a.cost - b.cost;
        })[0];
      return {
        pick,
        rationale: `Complexity ${complexity}/10 requires the highest capability; selected top-rated agent with best fit for ${discipline}.`,
      };
    }
    if (complexity >= 8) {
      const pool = candidates.filter((c) => c.quality >= maxQuality - 1);
      const pick = (pool.length ? pool : candidates)
        .slice()
        .sort((a, b) => {
          if (b.usageScore !== a.usageScore) return b.usageScore - a.usageScore;
          if (a.cost !== b.cost) return a.cost - b.cost;
          return b.quality - a.quality;
        })[0];
      return {
        pick,
        rationale: `Complexity ${complexity}/10 favors strong agents with good cost/fit balance; selected best-fit candidate.`,
      };
    }
    const target = complexity;
    const pool = candidates.filter((c) => c.quality >= target);
    const base = pool.length ? pool : candidates;
    const pick = base
      .slice()
      .sort((a, b) => {
        const diffA = Math.abs(a.quality - target);
        const diffB = Math.abs(b.quality - target);
        if (diffA !== diffB) return diffA - diffB;
        if (b.usageScore !== a.usageScore) return b.usageScore - a.usageScore;
        if (a.cost !== b.cost) return a.cost - b.cost;
        return a.quality - b.quality;
      })[0];
    return {
      pick,
      rationale: `Complexity ${complexity}/10 targets a comparable tier agent; selected closest match with discipline fit and cost awareness.`,
    };
  }

  private async selectAgentForJob(job: string, analysis: GatewayAnalysis): Promise<GatewayAgentDecision> {
    const normalizedJob = canonicalizeCommandName(job);
    const requiredCaps = getCommandRequiredCapabilities(normalizedJob);
    const candidates = await this.listCandidates(requiredCaps, analysis.discipline);
    const { pick, rationale } = this.chooseCandidate(candidates, analysis.complexity, analysis.discipline);
    return {
      agentId: pick.agent.id,
      agentSlug: pick.agent.slug ?? pick.agent.id,
      rating: pick.agent.rating ?? undefined,
      reasoningRating: pick.agent.reasoningRating ?? undefined,
      bestUsage: pick.agent.bestUsage ?? undefined,
      costPerMillion: Number.isFinite(pick.cost) ? pick.cost : undefined,
      rationale,
    };
  }

  async run(request: GatewayAgentRequest): Promise<GatewayAgentResult> {
    const warnings: string[] = [];
    const normalizedJob = canonicalizeCommandName(request.job);
    const commandRun = await this.deps.jobService.startCommandRun("gateway-agent", request.projectKey);
    try {
      const tasks = await this.buildTasksSummary(request, warnings);
      const docs = await this.buildDocSummaries(request, tasks, warnings);
      const gatewayAgent = await this.resolveGatewayAgent(request.gatewayAgentName, warnings);
      const prompts = await this.loadGatewayPrompts(gatewayAgent.id);
      const prompt = [
        prompts.jobPrompt,
        prompts.characterPrompt,
        prompts.commandPrompt,
        this.buildGatewayPrompt(normalizedJob, tasks, docs, request.inputText),
      ]
        .filter(Boolean)
        .join("\n\n");
      const startedAt = Date.now();
      const response = await this.deps.agentService.invoke(gatewayAgent.id, {
        input: prompt,
        metadata: { command: "gateway-agent", job: normalizedJob },
      });
      const durationSeconds = (Date.now() - startedAt) / 1000;
      const promptTokens = estimateTokens(prompt);
      const completionTokens = estimateTokens(response.output ?? "");
      await this.deps.jobService.recordTokenUsage({
        timestamp: new Date().toISOString(),
        workspaceId: this.workspace.workspaceId,
        commandName: "gateway-agent",
        commandRunId: commandRun.id,
        agentId: gatewayAgent.id,
        modelName: gatewayAgent.defaultModel,
        promptTokens,
        completionTokens,
        tokensPrompt: promptTokens,
        tokensCompletion: completionTokens,
        tokensTotal: promptTokens + completionTokens,
        durationSeconds,
        metadata: { action: "gateway_summary", job: normalizedJob },
      });
      const parsed = extractJson(response.output) ?? {};
      const analysis = this.normalizeAnalysis(parsed, normalizedJob, tasks, request.inputText);
      const chosenAgent = await this.selectAgentForJob(normalizedJob, analysis);
      await this.deps.jobService.finishCommandRun(commandRun.id, "succeeded");
      return {
        commandRunId: commandRun.id,
        job: normalizedJob,
        gatewayAgent: { id: gatewayAgent.id, slug: gatewayAgent.slug ?? gatewayAgent.id },
        tasks,
        docdex: docs,
        analysis,
        chosenAgent,
        warnings,
      };
    } catch (error) {
      await this.deps.jobService.finishCommandRun(commandRun.id, "failed", (error as Error).message);
      throw error;
    }
  }
}
