import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export type EffortLevel = "low" | "medium" | "high" | "max";
export type ModelOperation = "chat.completions" | "embeddings" | "images.generations" | "audio.generations" | "videos.generations";
export interface EffortBudget {
  maxSteps: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxTotalTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
}
export const EFFORT_BUDGETS: Readonly<Record<EffortLevel, Readonly<EffortBudget>>> = Object.freeze({
  low: Object.freeze({ maxSteps: 12, maxToolCalls: 12, maxModelCalls: 12, maxTotalTokens: 32_000, maxOutputTokens: 2048, timeoutMs: 300_000 }),
  medium: Object.freeze({ maxSteps: 32, maxToolCalls: 48, maxModelCalls: 36, maxTotalTokens: 128_000, maxOutputTokens: 4096, timeoutMs: 900_000 }),
  high: Object.freeze({ maxSteps: 64, maxToolCalls: 128, maxModelCalls: 72, maxTotalTokens: 320_000, maxOutputTokens: 8192, timeoutMs: 1_800_000 }),
  max: Object.freeze({ maxSteps: 128, maxToolCalls: 256, maxModelCalls: 144, maxTotalTokens: 640_000, maxOutputTokens: 8192, timeoutMs: 3_600_000 }),
});

export interface OrchestrationProvider {
  adapter: "mswarm" | "openai-compatible";
  baseUrl: string;
  credentialRef?: string;
  catalogUrl?: string;
  usageUrl?: string;
  /** Opt-in mswarm-media-jobs-v1 contract; synchronous adapters may omit it. */
  mediaJobsUrl?: string;
}
export interface OrchestrationModel {
  provider: string;
  catalogId: string;
  revision: string;
  operations: ModelOperation[];
  backend?: string;
  host?: string;
  resourcePool?: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  embeddingDimensions?: number;
  embedding?: { queryPrefix: string; documentPrefix: string; normalization: "none" | "l2"; pooling: string };
  reasoning?: Partial<Record<EffortLevel, Record<string, unknown>>>;
}
export interface ModelBinding {
  candidates?: string[];
  useBinding?: string;
  enabled?: boolean;
  embeddingSpace?: string;
}
export interface TaskControlConfig {
  maxWritingTasksPerWorktree: 1;
  maxConcurrentHelpers: number;
  helpers: "read-only-or-draft";
  repeatedFailureThreshold: number;
  repairAttemptsBeforeReplan: number;
  checkpointOn: string[];
  reviewPolicy: "risk-and-evidence";
}
export interface InteractionConfig {
  routerBinding?: string; answerBinding?: string; promptVersion?: string;
  routerResponseFormat?: "json" | "json_schema";
  routerPrompt?: string; answerPrompt?: string;
  maxInputChars?: number; historyChars?: number; maxOutputTokens?: number;
  maxTotalTokens?: number; maxModelCalls?: number; maxInspectionSteps?: number; timeoutMs?: number;
  /** Optional single bounded revision pass for answers that already needed reasoning. */
  answerReview?: { enabled: boolean; binding?: string; maxOutputTokens?: number };
  /** Experimental pure arithmetic tool for reasoning turns; disabled unless explicitly enabled. */
  calculator?: boolean;
}
export interface OrchestrationConfig {
  schemaVersion: 1;
  profile: string;
  providers: Record<string, OrchestrationProvider>;
  models: Record<string, OrchestrationModel>;
  bindings: Record<string, ModelBinding>;
  routing?: { strategy: "capability-and-capacity"; requiredBackends?: Record<string, string[]> };
  effort?: Partial<Record<EffortLevel, Partial<EffortBudget>>>;
  taskControl?: TaskControlConfig;
  interaction?: InteractionConfig;
  skills?: { enabled?: boolean; directories?: string[] };
  docdex?: { binary?: string; binarySha256?: string; startupTimeoutMs?: number };
}
export interface ResolvedOrchestrationConfig {
  config: OrchestrationConfig;
  hash: string;
  source: string;
}

export const pinOrchestrationConfig = (resolved: ResolvedOrchestrationConfig): ResolvedOrchestrationConfig => {
  const config = validateOrchestrationConfig(structuredClone(resolved.config));
  if (orchestrationHash(config) !== resolved.hash) throw new Error("Orchestration configuration hash does not match its contents");
  return { config, hash: resolved.hash, source: resolved.source };
};

const operations = new Set<ModelOperation>(["chat.completions", "embeddings", "images.generations", "audio.generations", "videos.generations"]);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const object = (v: unknown, label: string): Record<string, unknown> => {
  if (!isRecord(v)) throw new Error(`${label} must be an object`);
  return v;
};
const fields = (v: Record<string, unknown>, allowed: string[], label: string): void => {
  for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`);
};
const nonempty = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !v.trim() || /[\x00-\x1f]/.test(v)) throw new Error(`${label} must be a nonempty string`);
  return v;
};
const positive = (v: unknown, label: string): void => {
  if (!Number.isSafeInteger(v) || (v as number) <= 0) throw new Error(`${label} must be a positive integer`);
};
const trustedUrl = (v: unknown, label: string): void => {
  const url = new URL(nonempty(v, label));
  if (url.username || url.password || url.search || url.hash) throw new Error(`${label} must not contain credentials, query or fragment`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error(`${label} requires HTTPS (HTTP is permitted only for loopback development)`);
  }
};
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : isRecord(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const orchestrationHash = (config: OrchestrationConfig): string => createHash("sha256").update(JSON.stringify(canonical(config))).digest("hex");

export const validateOrchestrationConfig = (input: unknown): OrchestrationConfig => {
  const root = object(input, "orchestration");
  fields(root, ["schemaVersion", "profile", "providers", "models", "bindings", "routing", "effort", "taskControl", "docdex", "interaction", "skills"], "orchestration");
  if (root.schemaVersion !== 1) throw new Error("Unsupported orchestration schemaVersion");
  nonempty(root.profile, "profile");
  const providers = object(root.providers, "providers");
  for (const [id, entry] of Object.entries(providers)) {
    const p = object(entry, `providers.${id}`);
    fields(p, ["adapter", "baseUrl", "credentialRef", "catalogUrl", "usageUrl", "mediaJobsUrl"], `providers.${id}`);
    if (!["mswarm", "openai-compatible"].includes(String(p.adapter))) throw new Error(`Unsupported adapter: ${id}`);
    trustedUrl(p.baseUrl, `${id}.baseUrl`);
    if (p.credentialRef !== undefined && !/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(String(p.credentialRef))) throw new Error(`${id}: credentialRef must be env:NAME`);
    if (p.adapter === "mswarm" && !p.credentialRef) throw new Error(`${id}: mSwarm requires credentialRef`);
    for (const key of ["catalogUrl", "usageUrl", "mediaJobsUrl"]) if (p[key] !== undefined) {
      trustedUrl(p[key], `${id}.${key}`);
      if (new URL(String(p[key])).origin !== new URL(String(p.baseUrl)).origin) throw new Error(`${id}.${key} must use the provider origin`);
    }
  }
  const models = object(root.models, "models");
  for (const [id, entry] of Object.entries(models)) {
    const m = object(entry, `models.${id}`);
    fields(m, ["provider", "catalogId", "revision", "operations", "backend", "host", "resourcePool", "contextWindow", "maxOutputTokens", "supportsTools", "supportsStreaming", "embeddingDimensions", "embedding", "reasoning"], `models.${id}`);
    if (!hasOwn(providers, String(m.provider))) throw new Error(`${id}: unknown provider`);
    nonempty(m.catalogId, `${id}.catalogId`); nonempty(m.revision, `${id}.revision`);
    positive(m.contextWindow, `${id}.contextWindow`); positive(m.maxOutputTokens, `${id}.maxOutputTokens`);
    if (Number(m.maxOutputTokens) > Number(m.contextWindow)) throw new Error(`${id}: output exceeds context window`);
    if (!Array.isArray(m.operations) || !m.operations.length || m.operations.some(o => !operations.has(o as ModelOperation))) throw new Error(`${id}: invalid operations`);
    for (const key of ["supportsTools", "supportsStreaming"]) if (m[key] !== undefined && typeof m[key] !== "boolean") throw new Error(`${id}.${key} must be boolean`);
    for (const key of ["host", "backend", "resourcePool"]) if (m[key] !== undefined) nonempty(m[key], `${id}.${key}`);
    if (m.embeddingDimensions !== undefined) positive(m.embeddingDimensions, `${id}.embeddingDimensions`);
    if (m.embedding !== undefined) {
      const e = object(m.embedding, `${id}.embedding`);
      fields(e, ["queryPrefix", "documentPrefix", "normalization", "pooling"], `${id}.embedding`);
      for (const key of ["queryPrefix", "documentPrefix"]) if (typeof e[key] !== "string" || String(e[key]).length > 256 || /[\x00-\x1f]/.test(String(e[key]))) throw new Error(`${id}.embedding.${key} must be a bounded string`);
      if (!["none", "l2"].includes(String(e.normalization))) throw new Error(`${id}: invalid embedding normalization`);
      nonempty(e.pooling, `${id}.embedding.pooling`);
    }
    if (m.reasoning !== undefined) {
      const mapping = object(m.reasoning, `${id}.reasoning`);
      fields(mapping, ["low", "medium", "high", "max"], `${id}.reasoning`);
      for (const [level, settings] of Object.entries(mapping)) {
        const values = object(settings, `${id}.reasoning.${level}`);
        fields(values, ["reasoning_effort", "reasoning_budget", "reasoning_budget_tokens", "enable_thinking"], `${id}.reasoning.${level}`);
        if (values.reasoning_effort !== undefined) nonempty(values.reasoning_effort, `${id}.reasoning.${level}.reasoning_effort`);
        if (values.reasoning_budget !== undefined) positive(values.reasoning_budget, `${id}.reasoning.${level}.reasoning_budget`);
        if (values.reasoning_budget_tokens !== undefined && (!Number.isSafeInteger(values.reasoning_budget_tokens) || Number(values.reasoning_budget_tokens) < 0 || Number(values.reasoning_budget_tokens) > 1_000_000)) throw new Error(`${id}.reasoning.${level}.reasoning_budget_tokens must be an integer from 0 through 1000000`);
        if (values.enable_thinking !== undefined && typeof values.enable_thinking !== "boolean") throw new Error(`${id}.reasoning.${level}.enable_thinking must be boolean`);
      }
    }
  }
  const bindings = object(root.bindings, "bindings");
  if (!hasOwn(bindings, "lead")) throw new Error("Missing lead binding");
  for (const [name, entry] of Object.entries(bindings)) {
    const b = object(entry, `bindings.${name}`);
    fields(b, ["candidates", "useBinding", "enabled", "embeddingSpace"], `bindings.${name}`);
    if (b.enabled !== undefined && typeof b.enabled !== "boolean") throw new Error(`${name}.enabled must be boolean`);
    if (b.enabled === false) { if (name === "lead") throw new Error("Lead cannot be disabled"); continue; }
    if ((b.candidates !== undefined) === (b.useBinding !== undefined)) throw new Error(`${name}: specify candidates or useBinding`);
    if (b.useBinding !== undefined && !hasOwn(bindings, String(b.useBinding))) throw new Error(`${name}: unknown binding alias`);
    if (b.candidates !== undefined && (!Array.isArray(b.candidates) || !b.candidates.length || b.candidates.some(id => typeof id !== "string" || !hasOwn(models, id)) || new Set(b.candidates).size !== b.candidates.length)) throw new Error(`${name}: invalid/duplicate/undeclared candidates`);
    if (b.embeddingSpace !== undefined) nonempty(b.embeddingSpace, `${name}.embeddingSpace`);
  }
  if (root.routing !== undefined) {
    const r = object(root.routing, "routing"); fields(r, ["strategy", "requiredBackends"], "routing");
    if (r.strategy !== "capability-and-capacity") throw new Error("Unsupported routing strategy");
    for (const [role, values] of Object.entries(object(r.requiredBackends ?? {}, "requiredBackends"))) {
      if (!hasOwn(bindings, role) || !Array.isArray(values) || !values.length || values.some(x => typeof x !== "string" || !x)) throw new Error(`Invalid requiredBackends: ${role}`);
    }
  }
  if (root.effort !== undefined) {
    const profiles = object(root.effort, "effort"); fields(profiles, ["low", "medium", "high", "max"], "effort");
    for (const [level, entry] of Object.entries(profiles)) {
      const p = object(entry, `effort.${level}`); fields(p, Object.keys(EFFORT_BUDGETS.low), `effort.${level}`);
      for (const [key, value] of Object.entries(p)) positive(value, `effort.${level}.${key}`);
    }
  }
  if (root.taskControl !== undefined) {
    const t = object(root.taskControl, "taskControl");
    fields(t, ["maxWritingTasksPerWorktree", "maxConcurrentHelpers", "helpers", "repeatedFailureThreshold", "repairAttemptsBeforeReplan", "checkpointOn", "reviewPolicy"], "taskControl");
    if (t.maxWritingTasksPerWorktree !== 1 || t.helpers !== "read-only-or-draft" || t.reviewPolicy !== "risk-and-evidence") throw new Error("Invalid task-control safety policy");
    for (const key of ["maxConcurrentHelpers", "repeatedFailureThreshold", "repairAttemptsBeforeReplan"]) positive(t[key], `taskControl.${key}`);
    if (!Array.isArray(t.checkpointOn) || t.checkpointOn.some(v => !["task-transition", "before-compaction", "before-exit"].includes(String(v)))) throw new Error("Invalid checkpointOn policy");
  }
  if (root.interaction !== undefined) {
    const value = object(root.interaction, "interaction");
    fields(value, ["routerBinding", "answerBinding", "promptVersion", "routerPrompt", "answerPrompt", "maxInputChars", "historyChars", "maxOutputTokens", "maxTotalTokens", "maxModelCalls", "maxInspectionSteps", "timeoutMs", "answerReview", "routerResponseFormat", "calculator"], "interaction");
    if (value.calculator !== undefined && typeof value.calculator !== "boolean") throw new Error("interaction.calculator: expected boolean");
    for (const key of ["routerBinding", "answerBinding"]) if (value[key] !== undefined) {
      nonempty(value[key], `interaction.${key}`);
      if (!hasOwn(bindings, String(value[key])) || object(bindings[String(value[key])], key).enabled === false) throw new Error(`interaction.${key}: unavailable binding`);
    }
    if (value.promptVersion !== undefined) nonempty(value.promptVersion, "interaction.promptVersion");
    if (value.routerResponseFormat !== undefined && !["json", "json_schema"].includes(String(value.routerResponseFormat))) throw new Error("interaction.routerResponseFormat: expected json or json_schema");
    for (const key of ["routerPrompt", "answerPrompt"]) if (value[key] !== undefined && (typeof value[key] !== "string" || !String(value[key]).trim() || String(value[key]).length > 16000)) throw new Error(`interaction.${key}: expected bounded nonempty prompt`);
    for (const key of ["maxInputChars", "historyChars", "maxOutputTokens", "maxTotalTokens", "maxModelCalls", "maxInspectionSteps", "timeoutMs"]) if (value[key] !== undefined) positive(value[key], `interaction.${key}`);
    if (value.answerReview !== undefined) {
      const review = object(value.answerReview, "interaction.answerReview");
      fields(review, ["enabled", "binding", "maxOutputTokens"], "interaction.answerReview");
      if (typeof review.enabled !== "boolean") throw new Error("interaction.answerReview.enabled: expected boolean");
      if (review.binding !== undefined) {
        nonempty(review.binding, "interaction.answerReview.binding");
        if (!hasOwn(bindings, String(review.binding)) || object(bindings[String(review.binding)], "review binding").enabled === false) throw new Error("interaction.answerReview.binding: unavailable binding");
      }
      if (review.maxOutputTokens !== undefined) {
        positive(review.maxOutputTokens, "interaction.answerReview.maxOutputTokens");
        if (Number(review.maxOutputTokens) > 4096) throw new Error("interaction.answerReview.maxOutputTokens: exceeds 4096");
      }
    }
  }
  if (root.skills !== undefined) {
    const skills = object(root.skills, "skills"); fields(skills, ["enabled", "directories"], "skills");
    if (skills.enabled !== undefined && typeof skills.enabled !== "boolean") throw new Error("skills.enabled: expected boolean");
    if (skills.directories !== undefined && (!Array.isArray(skills.directories) || skills.directories.length > 16 || skills.directories.some(value => typeof value !== "string" || !value.trim() || value.length > 4096 || value.includes("\0")))) throw new Error("skills.directories: expected at most 16 directory paths");
  }
  if (root.docdex !== undefined) {
    const d = object(root.docdex, "docdex"); fields(d, ["binary", "binarySha256", "startupTimeoutMs"], "docdex");
    if (d.binary !== undefined) nonempty(d.binary, "docdex.binary");
    if (d.binarySha256 !== undefined && (typeof d.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.binarySha256) || d.binary === undefined)) throw new Error("docdex.binarySha256 requires an explicit binary and a SHA-256 digest");
    if (d.startupTimeoutMs !== undefined) positive(d.startupTimeoutMs, "docdex.startupTimeoutMs");
  }
  const config = structuredClone(root) as unknown as OrchestrationConfig;
  for (const name of Object.keys(config.bindings)) if (config.bindings[name].enabled !== false) resolveBinding(config, name);
  if (config.bindings.embedding && config.bindings.embedding.enabled !== false) configuredEmbeddingSpace(config);
  return config;
};

/** Every candidate in a failover binding must produce the same vector space. */
export const configuredEmbeddingSpace = (config: OrchestrationConfig, binding = "embedding") => {
  let key = binding;
  const seen = new Set<string>();
  let label: string | undefined;
  while (config.bindings[key] && !seen.has(key)) {
    seen.add(key); label ??= config.bindings[key].embeddingSpace;
    if (!config.bindings[key].useBinding) break;
    key = config.bindings[key].useBinding!;
  }
  if (!label) throw new Error("Enabled embedding binding requires embeddingSpace");
  const candidates = resolveBinding(config, binding, "embeddings");
  const identities = candidates.map(({ id, model }) => {
    if (!model.embeddingDimensions || model.embeddingDimensions > 4096 || !model.embedding || /^(catalog-unversioned|latest|unknown)$/.test(model.revision)) {
      throw new Error(`${id}: embeddings require a pinned revision, dimensions and explicit preprocessing`);
    }
    return { revision: model.revision, dimensions: model.embeddingDimensions, ...model.embedding };
  });
  const signature = JSON.stringify(canonical(identities[0]));
  if (identities.some(identity => JSON.stringify(canonical(identity)) !== signature)) throw new Error("Embedding failover candidates have incompatible vector spaces");
  return { label, ...identities[0], id: createHash("sha256").update(JSON.stringify([label, signature])).digest("hex") };
};

export const resolveBinding = (config: OrchestrationConfig, name: string, operation?: ModelOperation): Array<{ id: string; model: OrchestrationModel }> => {
  const seen = new Set<string>();
  let key = name;
  while (true) {
    if (seen.has(key)) throw new Error(`Binding alias cycle: ${name}`);
    seen.add(key);
    const binding = config.bindings[key];
    if (!binding || binding.enabled === false) throw new Error(`Binding unavailable: ${key}`);
    if (binding.useBinding) { key = binding.useBinding; continue; }
    const requiredBackends = [...seen].map(role => config.routing?.requiredBackends?.[role]).filter((v): v is string[] => !!v);
    const candidates = (binding.candidates ?? []).map(id => ({ id, model: config.models[id] })).filter(({ model }) =>
      model && (!operation || model.operations.includes(operation)) && requiredBackends.every(allowed => allowed.includes(model.backend ?? "")));
    if (!candidates.length) throw new Error(`No compatible configured candidates for ${name}${operation ? ` (${operation})` : ""}`);
    return candidates;
  }
};

export const loadOrchestrationConfig = async (file = process.env.CODALI_ORCHESTRATION_CONFIG ?? path.join(homedir(), ".codali", "orchestration.json")): Promise<ResolvedOrchestrationConfig> => {
  const source = path.resolve(file);
  const config = validateOrchestrationConfig(JSON.parse(await readFile(source, "utf8")));
  return { config, source, hash: orchestrationHash(config) };
};
export const effortBudget = (config: OrchestrationConfig, level: EffortLevel): EffortBudget => ({ ...EFFORT_BUDGETS[level], ...config.effort?.[level] });
