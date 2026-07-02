import type { CodaliRuntimeAgentInput } from "../runtime/CodaliRuntime.js";
import type {
  CodaliAgentRolePolicy,
  CodaliAgentTierPolicy,
  CodaliGatewayModelTier,
} from "./CodaliGatewayTypes.js";

export type CodaliGatewayAgentSource =
  | "local"
  | "self_hosted"
  | "worker"
  | "cloud"
  | "unknown";

export type CodaliGatewayAgentHealth =
  | "healthy"
  | "degraded"
  | "unreachable"
  | "limited"
  | "unknown";

export interface CodaliGatewayAgentCandidate {
  id?: string;
  slug: string;
  adapter: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  runnerKind?: string;
  source: CodaliGatewayAgentSource;
  healthStatus: CodaliGatewayAgentHealth;
  latencyMs?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsImageGeneration?: boolean;
  supportsArtifacts?: boolean;
  supportsStreaming?: boolean;
  capabilities: string[];
  bestUsage?: string;
  rating?: number;
  reasoningRating?: number;
  costPerMillion?: number;
  maxComplexity?: number;
  tier: CodaliGatewayModelTier;
  raw?: unknown;
}

export interface CodaliGatewayAgentCandidateDiagnostic {
  role: string;
  slug: string;
  tier: CodaliGatewayModelTier;
  source: CodaliGatewayAgentSource;
  eligible: boolean;
  score?: number;
  reasons: string[];
}

export interface CodaliGatewayAgentTierError {
  code: string;
  message: string;
  role?: string;
  details?: Record<string, unknown>;
}

export interface CodaliGatewayAgentAssignment {
  role: string;
  policy: CodaliAgentRolePolicy;
  candidate: CodaliGatewayAgentCandidate;
  agent: CodaliRuntimeAgentInput;
  score: number;
  reasons: string[];
}

export interface AgentTierResolverInput {
  inventory: unknown[];
  agentPolicy?: CodaliAgentTierPolicy;
  roles?: string[];
  allowImageWorker?: boolean;
}

export interface AgentTierResolution {
  ok: boolean;
  assignments: Record<string, CodaliGatewayAgentAssignment>;
  candidates: CodaliGatewayAgentCandidate[];
  diagnostics: CodaliGatewayAgentCandidateDiagnostic[];
  warnings: CodaliGatewayAgentTierError[];
  errors: CodaliGatewayAgentTierError[];
}

export const DEFAULT_CODALI_GATEWAY_AGENT_ROLES = [
  "classifier",
  "planner",
  "rag_worker",
  "tool_worker",
  "verifier",
  "context_refiner",
  "final_synthesizer",
] as const;

export const DEFAULT_CODALI_GATEWAY_ROLE_POLICIES: Record<
  string,
  CodaliAgentRolePolicy
> = {
  classifier: { tier: "small", requiresJsonSchema: true },
  context_refiner: { tier: "medium", requiresJsonSchema: true, minContextWindow: 8_000 },
  extractor: { tier: "small", requiresJsonSchema: true },
  final_synthesizer: { tier: "large", minContextWindow: 16_000 },
  image_worker: { tier: "image" },
  planner: { tier: "medium", requiresJsonSchema: true, minContextWindow: 8_000 },
  query_expander: { tier: "small", requiresJsonSchema: true },
  rag_worker: { tier: "medium", requiresTools: true, minContextWindow: 8_000 },
  repair: { tier: "medium", requiresJsonSchema: true },
  router: { tier: "small", requiresJsonSchema: true },
  tool_worker: { tier: "medium", requiresTools: true },
  verifier: { tier: "medium", requiresJsonSchema: true, minContextWindow: 8_000 },
};

const LOCAL_ADAPTER_HINTS = new Set([
  "codex-cli",
  "llama-cpp",
  "local-model",
  "ollama-cli",
  "ollama-remote",
  "openai-compatible-local",
  "openai-cli",
  "vllm",
]);

const STRUCTURED_OUTPUT_CAPABILITIES = new Set([
  "json_formatting",
  "json_schema",
  "schema_adherence",
  "strict_instruction_following",
  "structured_output",
]);

const IMAGE_CAPABILITIES = new Set([
  "image",
  "image_generation",
  "image_generation_llm",
  "text_to_image",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const readString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = normalizeString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const readNumber = (
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
};

const readBoolean = (
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
};

const readRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
};

const normalizeCapabilities = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  for (const item of value) {
    const capability = normalizeString(item)?.toLowerCase();
    if (capability) {
      seen.add(capability);
    }
  }
  return [...seen].sort();
};

const readDefaultModel = (record: Record<string, unknown>): string | undefined => {
  const direct = readString(record, ["model", "defaultModel", "default_model"]);
  if (direct) {
    return direct;
  }
  const models = record.models;
  if (!Array.isArray(models)) {
    return undefined;
  }
  for (const model of models) {
    if (!isRecord(model)) {
      continue;
    }
    const modelName = readString(model, ["modelName", "model_name", "name"]);
    if (modelName && model.isDefault === true) {
      return modelName;
    }
  }
  for (const model of models) {
    if (!isRecord(model)) {
      continue;
    }
    const modelName = readString(model, ["modelName", "model_name", "name"]);
    if (modelName) {
      return modelName;
    }
  }
  return undefined;
};

const normalizeHealth = (
  record: Record<string, unknown>,
): { status: CodaliGatewayAgentHealth; latencyMs?: number } => {
  const health = readRecord(record, ["health"]);
  const rawStatus =
    readString(record, ["healthStatus", "health_status", "status"]) ??
    (health ? readString(health, ["status"]) : undefined);
  const normalized = rawStatus?.toLowerCase();
  const status: CodaliGatewayAgentHealth =
    normalized === "healthy" ||
    normalized === "degraded" ||
    normalized === "unreachable" ||
    normalized === "limited"
      ? normalized
      : "unknown";
  return {
    status,
    latencyMs:
      (health ? readNumber(health, ["latencyMs", "latency_ms"]) : undefined) ??
      readNumber(record, ["latencyMs", "latency_ms"]),
  };
};

const normalizeSource = (
  record: Record<string, unknown>,
  slug: string,
  adapter: string,
): CodaliGatewayAgentSource => {
  const config = readRecord(record, ["config"]);
  const adapterKey = adapter.toLowerCase();
  if (
    slug.startsWith("mswarm-cloud-") ||
    Boolean(config && readRecord(config, ["mswarmCloud", "mswarm_cloud"]))
  ) {
    return "cloud";
  }
  if (
    slug.startsWith("mswarm-self-hosted-") ||
    Boolean(config && readRecord(config, ["mswarmSelfHosted", "mswarm_self_hosted"]))
  ) {
    return "self_hosted";
  }
  if (
    adapterKey === "mswarm-worker" ||
    Boolean(config && readRecord(config, ["mswarmWorker", "mswarm_worker"]))
  ) {
    return "worker";
  }
  if (
    LOCAL_ADAPTER_HINTS.has(adapterKey) ||
    Boolean(config && readRecord(config, ["localRunner", "local_runner"]))
  ) {
    return "local";
  }
  return "unknown";
};

const normalizeProvider = (adapter: string, explicit?: string): string | undefined => {
  if (explicit) {
    return explicit;
  }
  const normalized = adapter.toLowerCase();
  if (normalized === "openai-api") return "openai-compatible";
  if (normalized === "mswarm-worker") return "mswarm-worker";
  if (normalized === "codex-cli" || normalized === "openai-cli") return "codex-cli";
  if (
    normalized === "ollama-cli" ||
    normalized === "ollama-remote" ||
    normalized === "local-model" ||
    normalized === "llama-cpp" ||
    normalized === "vllm"
  ) {
    return "ollama-remote";
  }
  return undefined;
};

const containsNestedSelfHostedMarker = (value: string | undefined): boolean => {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return (
    normalized.includes("mswarm-self-hosted-") &&
    (
      normalized.indexOf("mswarm-self-hosted-") !== normalized.lastIndexOf("mswarm-self-hosted-") ||
      normalized.includes("/mswarm-self-hosted-") ||
      !normalized.startsWith("mswarm-self-hosted-")
    )
  );
};

const isNestedSelfHostedRelayCandidate = (
  candidate: CodaliGatewayAgentCandidate,
): boolean => {
  if (candidate.source !== "self_hosted") {
    return false;
  }
  const raw = isRecord(candidate.raw) ? candidate.raw : undefined;
  const config = raw ? readRecord(raw, ["config"]) : undefined;
  const selfHosted = config
    ? readRecord(config, ["mswarmSelfHosted", "mswarm_self_hosted"])
    : undefined;
  return [
    candidate.slug,
    candidate.model,
    selfHosted ? readString(selfHosted, ["remoteSlug", "remote_slug"]) : undefined,
    selfHosted ? readString(selfHosted, ["agentSlug", "agent_slug"]) : undefined,
    selfHosted ? readString(selfHosted, ["sourceAgentSlug", "source_agent_slug"]) : undefined,
  ].some(containsNestedSelfHostedMarker);
};

const readBaseUrl = (record: Record<string, unknown>): string | undefined => {
  const direct = readString(record, ["baseUrl", "base_url", "endpoint", "apiBaseUrl"]);
  if (direct) {
    return direct;
  }
  const config = readRecord(record, ["config"]);
  if (!config) {
    return undefined;
  }
  const localRunner = readRecord(config, ["localRunner", "local_runner"]);
  const worker = readRecord(config, ["mswarmWorker", "mswarm_worker"]);
  return (
    (localRunner ? readString(localRunner, ["baseUrl", "base_url"]) : undefined) ??
    (worker ? readString(worker, ["apiRunUrl", "api_run_url", "baseUrl", "base_url"]) : undefined) ??
    readString(config, ["baseUrl", "base_url", "endpoint", "apiBaseUrl"])
  );
};

const readRunnerKind = (record: Record<string, unknown>): string | undefined => {
  const direct = readString(record, ["runnerKind", "runner_kind"]);
  if (direct) {
    return direct;
  }
  const config = readRecord(record, ["config"]);
  const localRunner = config ? readRecord(config, ["localRunner", "local_runner"]) : undefined;
  return localRunner ? readString(localRunner, ["runnerKind", "runner_kind"]) : undefined;
};

const inferSupportsJsonSchema = (
  record: Record<string, unknown>,
  capabilities: string[],
): boolean | undefined => {
  const explicit = readBoolean(record, ["supportsJsonSchema", "supports_json_schema"]);
  if (explicit !== undefined) {
    return explicit;
  }
  const config = readRecord(record, ["config"]);
  const localRunner = config ? readRecord(config, ["localRunner", "local_runner"]) : undefined;
  const local = localRunner
    ? readBoolean(localRunner, ["supportsJsonSchema", "supports_json_schema"])
    : undefined;
  if (local !== undefined) {
    return local;
  }
  return capabilities.some((capability) => STRUCTURED_OUTPUT_CAPABILITIES.has(capability))
    ? true
    : undefined;
};

const inferSupportsImage = (
  record: Record<string, unknown>,
  capabilities: string[],
): boolean | undefined => {
  const explicit = readBoolean(record, [
    "supportsImageGeneration",
    "supports_image_generation",
    "supportsImages",
    "supports_images",
  ]);
  if (explicit !== undefined) {
    return explicit;
  }
  return capabilities.some((capability) => IMAGE_CAPABILITIES.has(capability))
    ? true
    : undefined;
};

const inferTier = (
  record: Record<string, unknown>,
  capabilities: string[],
  supportsImageGeneration: boolean | undefined,
): CodaliGatewayModelTier => {
  const explicit = readString(record, ["tier", "modelTier", "model_tier"])?.toLowerCase();
  if (
    explicit === "small" ||
    explicit === "medium" ||
    explicit === "large" ||
    explicit === "image"
  ) {
    return explicit;
  }
  if (supportsImageGeneration || capabilities.some((capability) => IMAGE_CAPABILITIES.has(capability))) {
    return "image";
  }
  const contextWindow = readNumber(record, ["contextWindow", "context_window"]) ?? 0;
  const reasoningRating = readNumber(record, ["reasoningRating", "reasoning_rating"]) ?? 0;
  const maxComplexity = readNumber(record, ["maxComplexity", "max_complexity"]) ?? 0;
  if (
    maxComplexity >= 8 ||
    reasoningRating >= 8 ||
    contextWindow >= 64_000 ||
    capabilities.includes("deep_reasoning") ||
    capabilities.includes("final_answer_synthesis")
  ) {
    return "large";
  }
  if (maxComplexity >= 5 || reasoningRating >= 5.5 || contextWindow >= 16_000) {
    return "medium";
  }
  return "small";
};

export const normalizeCodaliGatewayAgentCandidate = (
  input: unknown,
): CodaliGatewayAgentCandidate | undefined => {
  if (!isRecord(input)) {
    return undefined;
  }
  const slug = readString(input, ["slug", "id"]);
  const adapter = readString(input, ["adapter"]);
  const model = readDefaultModel(input);
  if (!slug || !adapter || !model) {
    return undefined;
  }
  const capabilities = normalizeCapabilities(input.capabilities);
  const supportsImageGeneration = inferSupportsImage(input, capabilities);
  const { status, latencyMs } = normalizeHealth(input);
  return {
    id: readString(input, ["id"]),
    slug,
    adapter,
    provider: normalizeProvider(adapter, readString(input, ["provider"])),
    model,
    baseUrl: readBaseUrl(input),
    runnerKind: readRunnerKind(input),
    source: normalizeSource(input, slug, adapter),
    healthStatus: status,
    latencyMs,
    contextWindow: readNumber(input, ["contextWindow", "context_window"]),
    maxOutputTokens: readNumber(input, ["maxOutputTokens", "max_output_tokens"]),
    supportsTools: readBoolean(input, ["supportsTools", "supports_tools"]),
    supportsJsonSchema: inferSupportsJsonSchema(input, capabilities),
    supportsImageGeneration,
    supportsArtifacts: readBoolean(input, ["supportsArtifacts", "supports_artifacts"]),
    supportsStreaming: readBoolean(input, ["supportsStreaming", "supports_streaming"]),
    capabilities,
    bestUsage: readString(input, ["bestUsage", "best_usage"]),
    rating: readNumber(input, ["rating"]),
    reasoningRating: readNumber(input, ["reasoningRating", "reasoning_rating"]),
    costPerMillion: readNumber(input, ["costPerMillion", "cost_per_million"]),
    maxComplexity: readNumber(input, ["maxComplexity", "max_complexity"]),
    tier: inferTier(input, capabilities, supportsImageGeneration),
    raw: input,
  };
};

const capabilityMisses = (
  candidate: CodaliGatewayAgentCandidate,
  required: readonly string[] | undefined,
): string[] => {
  if (!required || required.length === 0) {
    return [];
  }
  const capabilities = new Set(candidate.capabilities.map((capability) => capability.toLowerCase()));
  return required.filter((capability) => !capabilities.has(capability.toLowerCase()));
};

const evaluateCandidate = (
  role: string,
  policy: CodaliAgentRolePolicy,
  candidate: CodaliGatewayAgentCandidate,
  allowCloudFallback: boolean,
  allowImageWorker: boolean,
): CodaliGatewayAgentCandidateDiagnostic => {
  const reasons: string[] = [];
  let eligible = true;

  if (role === "image_worker" && !allowImageWorker) {
    eligible = false;
    reasons.push("image_worker_disabled");
  }
  if (candidate.healthStatus === "unreachable" || candidate.healthStatus === "limited") {
    eligible = false;
    reasons.push(`health_${candidate.healthStatus}`);
  }
  if (candidate.source === "cloud" && !allowCloudFallback) {
    eligible = false;
    reasons.push("cloud_fallback_disabled");
  }
  if (candidate.tier !== policy.tier) {
    eligible = false;
    reasons.push(`tier_mismatch:${candidate.tier}`);
  }
  if (policy.tier === "image" && candidate.supportsImageGeneration !== true) {
    eligible = false;
    reasons.push("image_generation_required");
  }
  if (policy.requiresTools === true && candidate.supportsTools !== true) {
    eligible = false;
    reasons.push("tools_required");
  }
  if (policy.requiresJsonSchema === true && candidate.supportsJsonSchema !== true) {
    eligible = false;
    reasons.push("json_schema_required");
  }
  if (
    policy.minContextWindow &&
    (candidate.contextWindow ?? 0) < policy.minContextWindow
  ) {
    eligible = false;
    reasons.push("context_window_too_small");
  }
  if (
    policy.maxLatencyMs &&
    candidate.latencyMs !== undefined &&
    candidate.latencyMs > policy.maxLatencyMs
  ) {
    eligible = false;
    reasons.push("latency_too_high");
  }
  const missingCapabilities = capabilityMisses(candidate, policy.capabilities);
  if (missingCapabilities.length > 0) {
    eligible = false;
    reasons.push(`missing_capabilities:${missingCapabilities.join(",")}`);
  }

  return {
    role,
    slug: candidate.slug,
    tier: candidate.tier,
    source: candidate.source,
    eligible,
    reasons,
  };
};

const scoreCandidate = (
  role: string,
  policy: CodaliAgentRolePolicy,
  candidate: CodaliGatewayAgentCandidate,
): { score: number; reasons: string[] } => {
  const reasons: string[] = [];
  let score = 100;
  const rating = candidate.rating ?? 0;
  const reasoning = candidate.reasoningRating ?? rating;
  score += rating * 5;
  score += reasoning * (role === "final_synthesizer" ? 6 : 3);
  score += (candidate.contextWindow ?? 0) / 8_000;

  if (candidate.healthStatus === "healthy") {
    score += 25;
    reasons.push("healthy");
  } else if (candidate.healthStatus === "degraded") {
    score -= 20;
    reasons.push("degraded");
  } else {
    score -= 5;
    reasons.push("health_unknown");
  }

  if (candidate.source === "local") {
    score += 25;
    reasons.push("local");
  } else if (candidate.source === "self_hosted") {
    score += 22;
    reasons.push("self_hosted");
  } else if (candidate.source === "worker") {
    score += 8;
    reasons.push("worker");
  } else if (candidate.source === "cloud") {
    score -= 30;
    reasons.push("cloud_fallback");
  }

  if (policy.requiresTools && candidate.supportsTools) {
    score += 12;
    reasons.push("tools");
  }
  if (policy.requiresJsonSchema && candidate.supportsJsonSchema) {
    score += 12;
    reasons.push("json_schema");
  }
  if (policy.preferredRunnerKinds?.includes(candidate.runnerKind ?? "")) {
    score += 18;
    reasons.push("preferred_runner");
  }
  if (policy.capabilities && policy.capabilities.length > 0) {
    score += policy.capabilities.length * 8;
    reasons.push("required_capabilities");
  }
  if (candidate.bestUsage && candidate.bestUsage.toLowerCase().includes(role)) {
    score += 10;
    reasons.push("best_usage");
  }
  if (isNestedSelfHostedRelayCandidate(candidate)) {
    score -= 120;
    reasons.push("nested_self_hosted_relay_penalty");
  }
  if (candidate.latencyMs !== undefined) {
    score -= candidate.latencyMs / 1_000;
  }
  score -= (candidate.costPerMillion ?? 0) * 2;
  return { score, reasons };
};

const toRuntimeAgentInput = (
  candidate: CodaliGatewayAgentCandidate,
): CodaliRuntimeAgentInput => ({
  slug: candidate.slug,
  adapter: candidate.adapter,
  provider: candidate.provider,
  model: candidate.model,
  baseUrl: candidate.baseUrl,
  runnerKind: candidate.runnerKind as CodaliRuntimeAgentInput["runnerKind"],
  supportsTools: candidate.supportsTools,
  capabilities: candidate.capabilities,
  contextWindow: candidate.contextWindow,
  maxOutputTokens: candidate.maxOutputTokens,
});

const resolveRolePolicy = (
  role: string,
  agentPolicy: CodaliAgentTierPolicy | undefined,
): CodaliAgentRolePolicy =>
  agentPolicy?.roles?.[role] ??
  DEFAULT_CODALI_GATEWAY_ROLE_POLICIES[role] ??
  { tier: "medium" };

const requestedRoles = (input: AgentTierResolverInput): string[] => {
  if (input.roles && input.roles.length > 0) {
    return [...new Set(input.roles)];
  }
  const policyRoles = Object.keys(input.agentPolicy?.roles ?? {});
  if (policyRoles.length > 0) {
    return policyRoles;
  }
  return [...DEFAULT_CODALI_GATEWAY_AGENT_ROLES];
};

export const resolveCodaliGatewayAgentTiers = (
  input: AgentTierResolverInput,
): AgentTierResolution => {
  const candidates = input.inventory
    .map(normalizeCodaliGatewayAgentCandidate)
    .filter((candidate): candidate is CodaliGatewayAgentCandidate => Boolean(candidate));
  const assignments: Record<string, CodaliGatewayAgentAssignment> = {};
  const diagnostics: CodaliGatewayAgentCandidateDiagnostic[] = [];
  const errors: CodaliGatewayAgentTierError[] = [];
  const warnings: CodaliGatewayAgentTierError[] = [];
  const allowCloudFallback = input.agentPolicy?.allowCloudFallback === true;
  const allowImageWorker = input.allowImageWorker === true;

  for (const role of requestedRoles(input)) {
    const policy = resolveRolePolicy(role, input.agentPolicy);
    const roleDiagnostics = candidates.map((candidate) =>
      evaluateCandidate(role, policy, candidate, allowCloudFallback, allowImageWorker),
    );
    for (const diagnostic of roleDiagnostics) {
      if (diagnostic.eligible) {
        const candidate = candidates.find((item) => item.slug === diagnostic.slug);
        if (candidate) {
          const scored = scoreCandidate(role, policy, candidate);
          diagnostic.score = scored.score;
          diagnostic.reasons.push(...scored.reasons);
        }
      }
      diagnostics.push(diagnostic);
    }

    const eligible = roleDiagnostics
      .filter((diagnostic) => diagnostic.eligible)
      .map((diagnostic) => {
        const candidate = candidates.find((item) => item.slug === diagnostic.slug);
        if (!candidate || diagnostic.score === undefined) {
          return undefined;
        }
        return { diagnostic, candidate };
      })
      .filter(
        (
          value,
        ): value is {
          diagnostic: CodaliGatewayAgentCandidateDiagnostic;
          candidate: CodaliGatewayAgentCandidate;
        } => Boolean(value),
      )
      .sort((left, right) => {
        const scoreDelta = (right.diagnostic.score ?? 0) - (left.diagnostic.score ?? 0);
        if (scoreDelta !== 0) return scoreDelta;
        const costDelta =
          (left.candidate.costPerMillion ?? 0) - (right.candidate.costPerMillion ?? 0);
        if (costDelta !== 0) return costDelta;
        return left.candidate.slug.localeCompare(right.candidate.slug);
      });

    const selected = eligible[0];
    if (!selected) {
      errors.push({
        code:
          role === "image_worker" && !allowImageWorker
            ? "GATEWAY_IMAGE_WORKER_DISABLED"
            : "GATEWAY_AGENT_ROLE_UNRESOLVED",
        message: `No eligible agent candidate found for role ${role}.`,
        role,
        details: { policy },
      });
      continue;
    }

    assignments[role] = {
      role,
      policy,
      candidate: selected.candidate,
      agent: toRuntimeAgentInput(selected.candidate),
      score: selected.diagnostic.score ?? 0,
      reasons: selected.diagnostic.reasons,
    };
  }

  if (candidates.length === 0) {
    errors.push({
      code: "GATEWAY_AGENT_INVENTORY_EMPTY",
      message: "No mcoda agent candidates were available to resolve gateway roles.",
    });
  }

  if (!allowCloudFallback) {
    const cloudCount = candidates.filter((candidate) => candidate.source === "cloud").length;
    if (cloudCount > 0) {
      warnings.push({
        code: "GATEWAY_CLOUD_FALLBACK_BLOCKED",
        message: "Cloud candidates were present but excluded by policy.",
        details: { cloudCount },
      });
    }
  }

  return {
    ok: errors.length === 0,
    assignments,
    candidates,
    diagnostics,
    warnings,
    errors,
  };
};

export const resolveGatewayAgentTiers = resolveCodaliGatewayAgentTiers;
