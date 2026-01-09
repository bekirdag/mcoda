import path from "node:path";
import fs from "node:fs/promises";
import { AgentService } from "@mcoda/agents";
import { GlobalRepository, WorkspaceRepository } from "@mcoda/db";
import { Agent } from "@mcoda/shared";
import { RoutingService } from "./RoutingService.js";
import { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";
import {
  computeAlpha,
  computeRunScore,
  DEFAULT_RATING_BUDGETS,
  DEFAULT_RATING_WEIGHTS,
  RatingBudgets,
  RatingWeights,
  updateEmaRating,
} from "./AgentRatingFormula.js";

const DEFAULT_REVIEW_PROMPT = [
  "You are the system reviewer for mcoda.",
  "Rate the agent's delivered work quality on a 0-10 scale.",
  "Base your rating on correctness, completeness, and adherence to task requirements.",
  "Return JSON only with this schema:",
  "{",
  '  "quality_score": number,',
  '  "reasoning": "short explanation",',
  '  "strengths": ["..."],',
  '  "defects": ["..."]',
  "}",
].join("\n");

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const extractJson = (raw: string): Record<string, unknown> | undefined => {
  if (!raw) return undefined;
  const fenced = raw.match(/```json([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
};

export type AgentRatingRequest = {
  workspace: WorkspaceResolution;
  agentId: string;
  commandName: string;
  jobId?: string;
  commandRunId?: string;
  taskId?: string;
  taskKey?: string;
  discipline?: string;
  complexity?: number;
  reviewerAgentName?: string;
  ratingWindow?: number;
};

type UsageRow = {
  tokens_total: number | null;
  duration_seconds: number | null;
  cost_estimate: number | null;
  metadata_json?: string | null;
};

type ReviewerResult = {
  qualityScore: number;
  raw: Record<string, unknown> | null;
  reasoning?: string;
};

export class AgentRatingService {
  constructor(
    private workspace: WorkspaceResolution,
    private deps: {
      workspaceRepo: WorkspaceRepository;
      globalRepo: GlobalRepository;
      agentService: AgentService;
      routingService: RoutingService;
    },
  ) {}

  static async create(workspace: WorkspaceResolution): Promise<AgentRatingService> {
    const workspaceRepo = await WorkspaceRepository.create(workspace.workspaceRoot);
    const globalRepo = await GlobalRepository.create();
    const agentService = new AgentService(globalRepo);
    const routingService = await RoutingService.create();
    return new AgentRatingService(workspace, {
      workspaceRepo,
      globalRepo,
      agentService,
      routingService,
    });
  }

  async close(): Promise<void> {
    await this.deps.workspaceRepo.close();
    await this.deps.globalRepo.close();
    if ((this.deps.routingService as any)?.close) {
      await (this.deps.routingService as any).close();
    }
  }

  private ratingPromptPath(): string {
    return path.join(this.workspace.workspaceRoot, ".mcoda", "prompts", "agent-rating.md");
  }

  private async loadRatingPrompt(): Promise<string> {
    const promptPath = this.ratingPromptPath();
    try {
      const raw = await fs.readFile(promptPath, "utf8");
      const trimmed = raw.trim();
      if (trimmed) return trimmed;
    } catch {
      await fs.mkdir(path.dirname(promptPath), { recursive: true });
      await fs.writeFile(promptPath, DEFAULT_REVIEW_PROMPT, "utf8");
    }
    return DEFAULT_REVIEW_PROMPT;
  }

  private async resolveReviewer(agentOverride?: string): Promise<Agent> {
    if (agentOverride) {
      return this.deps.agentService.resolveAgent(agentOverride);
    }
    const resolved = await this.deps.routingService.resolveAgentForCommand({
      commandName: "agent-rating",
      workspace: this.workspace,
    });
    return resolved.agent;
  }

  private async loadUsage(request: AgentRatingRequest): Promise<UsageRow[]> {
    const db = this.deps.workspaceRepo.getDb();
    const clauses = ["workspace_id = ?", "agent_id = ?"];
    const params: any[] = [this.workspace.workspaceId, request.agentId];
    if (request.commandRunId) {
      clauses.push("command_run_id = ?");
      params.push(request.commandRunId);
    }
    if (request.jobId) {
      clauses.push("job_id = ?");
      params.push(request.jobId);
    }
    if (request.taskId) {
      clauses.push("task_id = ?");
      params.push(request.taskId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    return db.all<UsageRow[]>(`SELECT tokens_total, duration_seconds, cost_estimate, metadata_json FROM token_usage ${where}`, ...params);
  }

  private countIterations(rows: UsageRow[]): number {
    if (!rows.length) return 0;
    const attempts = rows.filter((row) => {
      if (!row.metadata_json) return false;
      try {
        const meta = JSON.parse(row.metadata_json);
        const action = String(meta.action ?? meta.phase ?? "").toLowerCase();
        return action.includes("agent") || action.includes("review") || action.includes("qa");
      } catch {
        return false;
      }
    });
    const count = attempts.length || rows.length;
    return Math.max(1, count);
  }

  private async loadDurationSeconds(request: AgentRatingRequest, usageRows: UsageRow[]): Promise<number> {
    const sum = usageRows.reduce((acc, row) => acc + (row.duration_seconds ?? 0), 0);
    if (sum > 0) return sum;
    const db = this.deps.workspaceRepo.getDb();
    if (request.commandRunId) {
      const row = await db.get<any>(
        "SELECT started_at, completed_at, duration_seconds FROM command_runs WHERE id = ?",
        request.commandRunId,
      );
      if (row?.duration_seconds) return row.duration_seconds;
      if (row?.started_at && row?.completed_at) {
        return Math.max(0, (Date.parse(row.completed_at) - Date.parse(row.started_at)) / 1000);
      }
    }
    if (request.jobId) {
      const row = await db.get<any>(
        "SELECT created_at, completed_at FROM jobs WHERE id = ?",
        request.jobId,
      );
      if (row?.created_at && row?.completed_at) {
        return Math.max(0, (Date.parse(row.completed_at) - Date.parse(row.created_at)) / 1000);
      }
    }
    return 0;
  }

  private async buildReviewContext(request: AgentRatingRequest): Promise<string> {
    if (!request.taskId && !request.taskKey) {
      return `Command: ${request.commandName}`;
    }
    let task = undefined;
    if (request.taskId) {
      task = await this.deps.workspaceRepo.getTaskById(request.taskId);
    } else if (request.taskKey) {
      task = await this.deps.workspaceRepo.getTaskByKey(request.taskKey);
    }
    const comments = task ? await this.deps.workspaceRepo.listTaskComments(task.id, { limit: 5 }) : [];
    const qaRuns = task ? await this.deps.workspaceRepo.listTaskQaRuns(task.id) : [];
    const review = task ? await this.deps.workspaceRepo.getLatestTaskReview(task.id) : undefined;
    const commentText = comments.map((c) => `- [${c.category ?? "comment"}] ${c.body}`).join("\n");
    const qaText = qaRuns.slice(0, 2).map((q) => `- outcome=${q.recommendation ?? q.rawOutcome ?? "n/a"}`).join("\n");
    return [
      `Command: ${request.commandName}`,
      task ? `Task: ${task.key} ${task.title}` : "",
      task?.description ? `Description: ${task.description}` : "",
      review ? `Latest review decision: ${review.decision}` : "",
      qaText ? `Latest QA:\n${qaText}` : "",
      commentText ? `Recent comments:\n${commentText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async runReviewer(prompt: string, reviewer: Agent): Promise<ReviewerResult> {
    const response = await this.deps.agentService.invoke(reviewer.id, { input: prompt, metadata: { command: "agent-rating" } });
    const parsed = extractJson(response.output ?? "");
    const qualityRaw = typeof parsed?.quality_score === "number" ? parsed?.quality_score : undefined;
    const qualityScore = clamp(qualityRaw ?? 7, 0, 10);
    return {
      qualityScore,
      raw: parsed ?? null,
      reasoning: typeof parsed?.reasoning === "string" ? parsed?.reasoning : undefined,
    };
  }

  private computeBudgets(complexity: number): RatingBudgets {
    const factor = clamp(complexity / 5, 0.5, 2);
    return {
      costUsd: DEFAULT_RATING_BUDGETS.costUsd * factor,
      durationSeconds: DEFAULT_RATING_BUDGETS.durationSeconds * factor,
      iterations: Math.max(1, Math.round(DEFAULT_RATING_BUDGETS.iterations + complexity / 3)),
    };
  }

  async rate(request: AgentRatingRequest): Promise<void> {
    const agent = await this.deps.globalRepo.getAgentById(request.agentId);
    if (!agent) {
      throw new Error(`Agent ${request.agentId} not found for rating.`);
    }
    const usageRows = await this.loadUsage(request);
    const tokensTotal = usageRows.reduce((acc, row) => acc + (row.tokens_total ?? 0), 0);
    const durationSeconds = await this.loadDurationSeconds(request, usageRows);
    const iterations = this.countIterations(usageRows);
    const costEstimate = usageRows.reduce((acc, row) => acc + (row.cost_estimate ?? 0), 0);
    const costPerMillion = agent.costPerMillion ?? 0;
    const totalCost = costEstimate > 0 ? costEstimate : (tokensTotal * costPerMillion) / 1_000_000;

    const complexity = clamp(Math.round(request.complexity ?? 5), 1, 10);
    const budgets = this.computeBudgets(complexity);
    const weights: RatingWeights = DEFAULT_RATING_WEIGHTS;

    const reviewContext = await this.buildReviewContext(request);
    const reviewerPrompt = await this.loadRatingPrompt();
    const reviewer = await this.resolveReviewer(request.reviewerAgentName);
    const reviewerInput = [reviewerPrompt, "", reviewContext].filter(Boolean).join("\n");
    const review = await this.runReviewer(reviewerInput, reviewer);

    const runScore = computeRunScore({
      qualityScore: review.qualityScore,
      totalCost,
      durationSeconds,
      iterations,
      budgets,
      weights,
    });

    const alpha = computeAlpha(request.ratingWindow ?? 50);
    const baseRating = agent.rating ?? runScore;
    const updatedRating = updateEmaRating(baseRating, runScore, alpha);
    const updatedSamples = (agent.ratingSamples ?? 0) + 1;
    const now = new Date().toISOString();

    let maxComplexity = agent.maxComplexity ?? 5;
    let complexitySamples = agent.complexitySamples ?? 0;
    let complexityUpdatedAt = agent.complexityUpdatedAt ?? undefined;
    const promoteThreshold = 7.5;
    const demoteThreshold = 4.0;
    if (runScore >= promoteThreshold && review.qualityScore >= 7 && complexity >= maxComplexity) {
      maxComplexity = Math.min(10, maxComplexity + 1);
      complexityUpdatedAt = now;
      complexitySamples += 1;
    } else if (runScore <= demoteThreshold && complexity <= maxComplexity) {
      maxComplexity = Math.max(1, maxComplexity - 1);
      complexityUpdatedAt = now;
      complexitySamples += 1;
    }

    await this.deps.globalRepo.updateAgent(agent.id, {
      rating: updatedRating,
      reasoningRating: agent.reasoningRating ?? updatedRating,
      ratingSamples: updatedSamples,
      ratingLastScore: runScore,
      ratingUpdatedAt: now,
      maxComplexity,
      complexitySamples,
      complexityUpdatedAt,
    });

    await this.deps.globalRepo.insertAgentRunRating({
      agentId: agent.id,
      jobId: request.jobId ?? null,
      commandRunId: request.commandRunId ?? null,
      taskId: request.taskId ?? null,
      taskKey: request.taskKey ?? null,
      commandName: request.commandName,
      discipline: request.discipline ?? null,
      complexity,
      qualityScore: review.qualityScore,
      tokensTotal,
      durationSeconds,
      iterations,
      totalCost,
      runScore,
      ratingVersion: "v1",
      rawReview: review.raw,
      createdAt: now,
    });

    await this.writeRatingArtifact(request.jobId, {
      agentId: agent.id,
      commandName: request.commandName,
      taskKey: request.taskKey,
      qualityScore: review.qualityScore,
      tokensTotal,
      durationSeconds,
      iterations,
      totalCost,
      runScore,
      rating: updatedRating,
      maxComplexity,
      reviewerAgent: reviewer.slug ?? reviewer.id,
    });
  }

  private async writeRatingArtifact(jobId: string | undefined, payload: Record<string, unknown>): Promise<void> {
    if (!jobId) return;
    const outDir = path.join(this.workspace.workspaceRoot, ".mcoda", "jobs", jobId);
    await fs.mkdir(outDir, { recursive: true });
    const filePath = path.join(outDir, "rating.json");
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  }
}
