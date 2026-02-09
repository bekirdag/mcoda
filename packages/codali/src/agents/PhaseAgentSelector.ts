import { GlobalRepository } from "@mcoda/db";
import type { Agent } from "@mcoda/shared";
import type { PipelinePhase } from "../cognitive/ProviderRouting.js";
import type { BuilderConfig } from "../config/Config.js";
import {
  resolveAgentConfigFromRecord,
  type ResolvedAgentConfig,
} from "./AgentResolver.js";

export type PhaseAgentSource = "override" | "auto" | "fallback" | "none";

export interface PhaseAgentSelection {
  phase: PipelinePhase;
  agent?: Agent;
  capabilities: string[];
  resolved?: ResolvedAgentConfig;
  source: PhaseAgentSource;
  score?: number;
  reason?: string;
}

export interface PhaseAgentSelectionOptions {
  overrides: Partial<Record<PipelinePhase, string>>;
  builderMode: BuilderConfig["mode"];
  fallbackAgent?: ResolvedAgentConfig;
  allowCloudModels?: boolean;
  excludeAgentIds?: Partial<Record<PipelinePhase, string[]>>;
}

const PHASE_CAPABILITIES: Record<PipelinePhase, string[]> = {
  librarian: ["docdex_query", "summarization", "keyword_extraction", "log_analysis"],
  architect: ["plan", "system_architecture", "architectural_design", "deep_reasoning"],
  builder: ["code_write", "complex_refactoring", "migration_assist", "debugging"],
  critic: ["code_review", "pull_request_review", "final_code_review", "standard_compliance"],
  interpreter: ["code_review", "pull_request_review", "final_code_review", "standard_compliance"],
};

const PHASE_REQUIRED_CAPS: Record<PipelinePhase, string[]> = {
  librarian: ["docdex_query", "summarization", "keyword_extraction", "log_analysis"],
  architect: ["plan", "system_architecture", "architectural_design", "deep_reasoning"],
  builder: ["code_write", "simple_refactor", "iterative_coding", "migration_assist"],
  critic: ["code_review", "pull_request_review", "final_code_review", "standard_compliance"],
  interpreter: ["code_review", "pull_request_review", "final_code_review", "standard_compliance"],
};

const PHASE_BEST_USAGE: Record<PipelinePhase, string[]> = {
  librarian: ["lightweight_tasks", "log_analysis", "summarization", "doc_generation"],
  architect: ["system_architecture", "architectural_design", "deep_reasoning", "plan"],
  builder: ["code_write", "coding_light", "iterative_coding", "rapid_prototyping"],
  critic: ["code_review", "code_review_secondary", "production_verification"],
  interpreter: ["code_review", "code_review_secondary", "production_verification"],
};

const STRUCTURED_OUTPUT_CAPABILITIES = [
  "strict_instruction_following",
  "json_formatting",
  "schema_adherence",
  "structured_output",
];

const PATCH_JSON_EXECUTION_CAPABILITIES = [
  "iterative_coding",
  "simple_refactor",
];

const PATCH_JSON_RELIABILITY_CAPABILITIES = [
  "iterative_coding",
  "strict_instruction_following",
  "json_formatting",
  "schema_adherence",
  "structured_output",
  "test_fixing",
];

type AgentReadiness = {
  authConfigured?: boolean;
  healthStatus?: "healthy" | "degraded" | "unreachable";
};

const ADAPTERS_REQUIRING_AUTH = new Set([
  "openai-api",
  "zhipu-api",
  "gemini-cli",
  "codex-cli",
]);

const countMatches = (capabilities: string[], required: string[]): number =>
  required.filter((cap) => capabilities.includes(cap)).length;

const isCloudModel = (model?: string): boolean => {
  if (!model) return false;
  return model.toLowerCase().includes(":cloud");
};

const normalizeAdapter = (adapter?: string): string => (adapter ?? "").trim().toLowerCase();

const requiresConfiguredAuth = (agent: Agent): boolean =>
  ADAPTERS_REQUIRING_AUTH.has(normalizeAdapter(agent.adapter));

const adjustScoreForReadiness = (
  score: number,
  agent: Agent,
  readiness: AgentReadiness,
): number => {
  let adjusted = score;
  if (readiness.healthStatus === "degraded") adjusted -= 25;
  if (requiresConfiguredAuth(agent) && readiness.authConfigured === false) adjusted -= 80;
  return adjusted;
};

const scoreAgent = (
  phase: PipelinePhase,
  agent: Agent,
  capabilities: string[],
  builderMode: BuilderConfig["mode"],
): number => {
  if (builderMode === "tool_calls" && phase === "builder" && agent.supportsTools === false) {
    return Number.NEGATIVE_INFINITY;
  }
  const rating = agent.rating ?? 0;
  const reasoning = agent.reasoningRating ?? rating;
  const cost = agent.costPerMillion ?? 0;
  const maxComplexity = agent.maxComplexity ?? 0;
  const capHits = countMatches(capabilities, PHASE_CAPABILITIES[phase]);
  const requiredHits = countMatches(capabilities, PHASE_REQUIRED_CAPS[phase]);
  const structuredHits = countMatches(capabilities, STRUCTURED_OUTPUT_CAPABILITIES);
  const patchExecutionHits = countMatches(capabilities, PATCH_JSON_EXECUTION_CAPABILITIES);
  const patchReliabilityHits = countMatches(capabilities, PATCH_JSON_RELIABILITY_CAPABILITIES);
  const hasIterativeCoding = capabilities.includes("iterative_coding");
  const hasToolRunner = capabilities.includes("tool_runner");
  const usageBoost = agent.bestUsage && PHASE_BEST_USAGE[phase].includes(agent.bestUsage) ? 2 : 0;
  const patchJsonBuilder = phase === "builder" && builderMode === "patch_json";

  let score = 0;
  if (phase === "architect" || phase === "critic" || phase === "interpreter") {
    score += reasoning * 3 + rating * 2;
  } else if (phase === "builder") {
    score += rating * 2 + reasoning;
  } else {
    score += rating + reasoning * 0.5;
  }

  score += capHits * 4;
  if (capHits === 0) score -= 3;
  score += requiredHits * 2;
  if (patchJsonBuilder) score += requiredHits * 3;
  score += usageBoost;
  if (patchJsonBuilder) {
    score += structuredHits * 14;
    score += patchExecutionHits * 4;
    score += patchReliabilityHits * 3;
    if (structuredHits === 0) score -= 24;
    if (patchExecutionHits === 0) score -= 8;
    if (!hasIterativeCoding) score -= 8;
    else score += 8;
    if (requiredHits === 0) score -= 12;
    if (agent.supportsTools === false) score -= 14;
    else score += 3;
    if (hasToolRunner) score += 2;
  }

  const prefersStructuredBuilder =
    patchJsonBuilder && structuredHits > 0;
  const costPenalty =
    phase === "builder"
      ? prefersStructuredBuilder ? 1.5 : patchJsonBuilder ? 2 : 5
      : phase === "librarian" ? 4 : phase === "architect" ? 1.5 : 1;
  if (phase === "builder") {
    score -= cost * costPenalty;
    score -= maxComplexity * 0.5;
  } else if (phase === "librarian") {
    score -= cost * costPenalty;
    score -= maxComplexity;
  } else {
    score -= cost * costPenalty;
  }

  return score;
};

const resolveOverrideAgent = async (
  repo: GlobalRepository,
  agentRef: string,
): Promise<{ agent: Agent; capabilities: string[]; resolved: ResolvedAgentConfig }> => {
  const agent =
    (await repo.getAgentById(agentRef)) ?? (await repo.getAgentBySlug(agentRef));
  if (!agent) {
    throw new Error(`Agent ${agentRef} not found`);
  }
  const capabilities = await repo.getAgentCapabilities(agent.id);
  const resolved = await resolveAgentConfigFromRecord(agent, repo);
  return { agent, capabilities, resolved };
};

export const selectPhaseAgents = async (
  options: PhaseAgentSelectionOptions,
): Promise<Record<PipelinePhase, PhaseAgentSelection>> => {
  const repo = await GlobalRepository.create();
  try {
    const agents = await repo.listAgents();
    const capCache = new Map<string, string[]>();
    const readinessCache = new Map<string, AgentReadiness>();
    const getCaps = async (agent: Agent): Promise<string[]> => {
      const cached = capCache.get(agent.id);
      if (cached) return cached;
      const caps = await repo.getAgentCapabilities(agent.id);
      capCache.set(agent.id, caps);
      return caps;
    };
    const getReadiness = async (agent: Agent): Promise<AgentReadiness> => {
      const cached = readinessCache.get(agent.id);
      if (cached) return cached;
      const [auth, health] = await Promise.all([
        repo.getAgentAuthMetadata(agent.id),
        repo.getAgentHealth(agent.id),
      ]);
      const readiness: AgentReadiness = {
        authConfigured: auth.configured,
        healthStatus: health?.status,
      };
      readinessCache.set(agent.id, readiness);
      return readiness;
    };

    const buildSelection = async (phase: PipelinePhase): Promise<PhaseAgentSelection> => {
      const excludedIds = new Set(options.excludeAgentIds?.[phase] ?? []);
      const overrideRef = options.overrides[phase];
      if (overrideRef) {
        const resolvedOverride = await resolveOverrideAgent(repo, overrideRef);
        return {
          phase,
          agent: resolvedOverride.agent,
          capabilities: resolvedOverride.capabilities,
          resolved: resolvedOverride.resolved,
          source: "override",
          reason: "routing.agent override",
        };
      }

      const scored: Array<{
        agent: Agent;
        caps: string[];
        score: number;
        requiredHits: number;
        structuredHits: number;
        patchExecutionHits: number;
      }> = [];
      const patchJsonBuilder = phase === "builder" && options.builderMode === "patch_json";
      for (const agent of agents) {
        if (excludedIds.has(agent.id)) continue;
        if (!agent.defaultModel) continue;
        if (!options.allowCloudModels && isCloudModel(agent.defaultModel)) continue;
        const readiness = await getReadiness(agent);
        if (readiness.healthStatus === "unreachable") continue;
        const caps = await getCaps(agent);
        const requiredHits = countMatches(caps, PHASE_REQUIRED_CAPS[phase]);
        const structuredHits = countMatches(caps, STRUCTURED_OUTPUT_CAPABILITIES);
        const patchExecutionHits = countMatches(caps, PATCH_JSON_EXECUTION_CAPABILITIES);
        const score = adjustScoreForReadiness(
          scoreAgent(phase, agent, caps, options.builderMode),
          agent,
          readiness,
        );
        if (!Number.isFinite(score)) continue;
        scored.push({
          agent,
          caps,
          score,
          requiredHits,
          structuredHits,
          patchExecutionHits,
        });
      }
      const hasRequired = scored.some((candidate) => candidate.requiredHits > 0);
      let candidates = hasRequired
        ? scored.filter((candidate) => candidate.requiredHits > 0)
        : scored;
      if (patchJsonBuilder) {
        const structuredCandidates = candidates.filter(
          (candidate) => candidate.structuredHits > 0,
        );
        if (structuredCandidates.length > 0) {
          candidates = structuredCandidates;
        } else {
          const patchExecutionCandidates = candidates.filter(
            (candidate) => candidate.patchExecutionHits > 0,
          );
          if (patchExecutionCandidates.length > 0) {
            candidates = patchExecutionCandidates;
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score);

      for (const candidate of candidates) {
        try {
          const resolved = await resolveAgentConfigFromRecord(candidate.agent, repo);
          return {
            phase,
            agent: candidate.agent,
            capabilities: candidate.caps,
            resolved,
            source: "auto",
            score: candidate.score,
            reason: "scored capability match",
          };
        } catch {
          continue;
        }
      }

      if (options.fallbackAgent) {
        const fallbackCaps = await getCaps(options.fallbackAgent.agent);
        return {
          phase,
          agent: options.fallbackAgent.agent,
          capabilities: fallbackCaps,
          resolved: options.fallbackAgent,
          source: "fallback",
          reason: "auto selection failed",
        };
      }

      return { phase, capabilities: [], source: "none", reason: "no eligible agents" };
    };

    const result: Record<PipelinePhase, PhaseAgentSelection> = {
      librarian: await buildSelection("librarian"),
      architect: await buildSelection("architect"),
      builder: await buildSelection("builder"),
      critic: await buildSelection("critic"),
      interpreter: await buildSelection("interpreter"),
    };
    return result;
  } finally {
    await repo.close();
  }
};
