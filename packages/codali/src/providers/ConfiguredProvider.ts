import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { CryptoHelper, PathHelper, mswarmClientProductHeaders } from "@mcoda/shared";
import { resolveCredential } from "../runcontext/CredentialFile.js";
import { resolveBinding, type OrchestrationProvider, type ResolvedOrchestrationConfig, type ModelOperation, type EffortLevel } from "../config/OrchestrationConfig.js";
import { OpenAiCompatibleProvider } from "./OpenAiCompatibleProvider.js";
import { ModelServiceError } from "./ModelServiceError.js";
import { parseRequestUsage, type RequestUsageReceipt } from "./RequestUsage.js";
import { registerSecretValue } from "../runtime/SecretRedaction.js";
import type { Provider, ProviderRequest, ProviderResponse } from "./ProviderTypes.js";

export interface CatalogEntry {
  id: string;
  aliases: string[];
  backend?: string;
  health: string;
  supportsTools: boolean;
  contextWindow?: number;
  operations: string[];
  raw: Record<string, unknown>;
}
/** Authenticated host context, separate from user/model supplied request bodies. */
export interface ModelCallerContext { clientIdentity?: string; clientProduct?: string; }
export const normalizeModelCaller = (caller: ModelCallerContext = {}): ModelCallerContext => {
  const clientIdentity = caller.clientIdentity?.trim();
  const clientProduct = caller.clientProduct?.trim().toLowerCase() ?? "codali";
  if (clientIdentity !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(clientIdentity)) throw new Error("Invalid model client identity");
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(clientProduct)) throw new Error("Invalid model client product");
  return { ...(clientIdentity ? { clientIdentity } : {}), clientProduct };
};
const modelCallerHeaders = (caller: ModelCallerContext): Record<string, string> => ({
  ...mswarmClientProductHeaders(caller.clientProduct),
  ...(caller.clientIdentity ? { "x-mswarm-client-identity": caller.clientIdentity, "x-mswarm-client": caller.clientIdentity } : {}),
});
const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Discovery failed before inference; a caller may release its local token reservation. */
export class NativeReasoningTransportError extends Error {
  constructor(message: string) { super(message); this.name = "NativeReasoningTransportError"; }
}

export const providerCredential = async (provider: OrchestrationProvider): Promise<string | undefined> => {
  if (!provider.credentialRef) return undefined;
  const name = provider.credentialRef.slice(4);
  const direct = resolveCredential(name);
  if (direct) { registerSecretValue(direct); return direct; }
  if (provider.adapter === "mswarm" && resolveCredential("CODALI_MSWARM_LOGGED_OUT") === "1") throw new Error("Logged out; use codali login");
  // Migrate by reading the existing user store; never read repository credentials.
  if (provider.adapter === "mswarm" && name === "MCODA_MSWARM_API_KEY") {
    try {
      const config = JSON.parse(await readFile(PathHelper.getGlobalConfigPath(), "utf8")) as { mswarm?: { encryptedApiKey?: string; baseUrl?: string } };
      const existing = config.mswarm;
      if (existing?.encryptedApiKey && new URL(existing.baseUrl ?? "https://api.mswarm.org").origin === new URL(provider.baseUrl).origin) {
        const key = await CryptoHelper.decryptSecret(existing.encryptedApiKey); registerSecretValue(key); return key;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Stored mSwarm credentials could not be loaded; use codali login"); }
  }
  throw new Error(`Missing credential ${name}; use codali login or set the environment variable`);
};

export class ModelServiceClient {
  private cache?: { key: string; expires: number; entries: CatalogEntry[] };
  private readonly caller: ModelCallerContext;
  constructor(readonly provider: OrchestrationProvider, private readonly credentialOverride?: string, caller?: ModelCallerContext) {
    this.caller = normalizeModelCaller(caller);
    if (credentialOverride) registerSecretValue(credentialOverride);
  }
  private credential(): Promise<string | undefined> { return this.credentialOverride === undefined ? providerCredential(this.provider) : Promise.resolve(this.credentialOverride); }

  async json(url: string, options: { signal?: AbortSignal; method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    if (new URL(url).origin !== new URL(this.provider.baseUrl).origin) throw new Error("Refusing credentials to an unconfigured origin");
    const key = await this.credential();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.throwIfAborted(); options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Service request timed out")), options.timeoutMs ?? 30_000);
    try {
      const response = await fetch(url, {
        redirect: "error", method: options.method ?? "GET", signal: controller.signal,
        headers: { accept: "application/json", ...(key ? this.provider.adapter === "mswarm" ? { "x-api-key": key } : { authorization: `Bearer ${key}` } : {}), ...(this.provider.adapter === "mswarm" ? modelCallerHeaders(this.caller) : {}), ...(options.body ? { "content-type": "application/json" } : {}) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
      if (!response.ok) throw await ModelServiceError.fromResponse(response);
      if (!response.body) throw new Error("Empty service response");
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 96 * 1024 * 1024) { await reader.cancel(); throw new Error("Service response exceeds size limit"); } chunks.push(next.value); } }
      finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
  }

  async catalog(signal?: AbortSignal, refresh = false): Promise<CatalogEntry[]> {
    const credential = await this.credential();
    const key = createHash("sha256").update(credential ?? "anonymous").digest("hex");
    if (!refresh && this.cache?.key === key && this.cache.expires > Date.now()) return this.cache.entries;
    const base = new URL(this.provider.baseUrl);
    const url = this.provider.catalogUrl ?? (this.provider.adapter === "mswarm" ? new URL("/v1/swarm/self-hosted/agents", base).toString() : `${this.provider.baseUrl.replace(/\/$/, "")}/models`);
    const payload = record(await this.json(url, { signal }));
    const items = payload.agents ?? payload.data;
    if (!Array.isArray(items)) throw new Error("Invalid model catalog response");
    const entries = items.map(item => {
      const raw = record(item);
      const aliases = [raw.slug, raw.public_model_id, raw.default_model, raw.id].filter((v): v is string => typeof v === "string" && !!v);
      return { id: aliases[0] ?? "", aliases, backend: raw.adapter === "strata-local" ? "strata" : typeof raw.backend === "string" ? raw.backend : typeof raw.adapter === "string" ? raw.adapter : undefined,
        health: String(raw.health_status ?? "unknown"), supportsTools: raw.supports_tools === true,
        contextWindow: typeof raw.context_window === "number" ? raw.context_window : undefined,
        operations: Array.isArray(raw.operations) ? raw.operations.map(v => typeof v === "string" ? v : String(record(v).type ?? "")) : [], raw };
    }).filter(x => x.id);
    this.cache = { key, expires: Date.now() + 30_000, entries };
    return entries;
  }

  async usage(signal?: AbortSignal): Promise<unknown> {
    if (this.provider.adapter !== "mswarm" && !this.provider.usageUrl) return { available: false };
    return this.json(this.provider.usageUrl ?? new URL("/v1/swarm/runtime/usage-limits", this.provider.baseUrl).toString(), { signal });
  }

  async requestUsage(requestId: string, signal?: AbortSignal): Promise<RequestUsageReceipt> {
    if (this.provider.adapter !== "mswarm") throw new Error("Provider has no authenticated request receipt contract");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw new Error("Invalid request UUID");
    const url = new URL(`/v1/swarm/self-hosted/requests/${encodeURIComponent(requestId)}/receipts`, this.provider.baseUrl);
    return parseRequestUsage(requestId, await this.json(url.href, { signal, timeoutMs: 10_000 }));
  }

  /** The proxy and selected node must both advertise this transport contract.
   * A model's supports_reasoning flag alone says nothing about request forwarding. */
  async requireNativeReasoning(modelId: string, parameters: string[], signal?: AbortSignal): Promise<void> {
    if (this.provider.adapter !== "mswarm" || parameters.length === 0) return;
    const endpoint = new URL(this.provider.baseUrl);
    endpoint.pathname = endpoint.pathname.replace(/\/$/, "");
    endpoint.pathname = ["", "/v1"].includes(endpoint.pathname)
      ? "/v1/swarm/self-hosted/openai/models" : `${endpoint.pathname}/models`;
    const payload = record(await this.json(endpoint.href, { signal }).catch(error => {
      throw new NativeReasoningTransportError(`Native reasoning preflight failed before inference: ${error instanceof Error ? error.message : String(error)}`);
    }));
    const models = Array.isArray(payload.data) ? payload.data.map(record) : [];
    const model = models.find(item => [item.id, item.agent_slug, item.remote_slug].includes(modelId));
    const contract = record(model?.native_reasoning);
    const supported = Array.isArray(contract.parameters) ? contract.parameters : [];
    if (contract.transport_version !== 1 || parameters.some(parameter => !supported.includes(parameter))) {
      throw new NativeReasoningTransportError(`Native reasoning transport is unavailable for ${modelId}; upgrade the mSwarm proxy and selected node, or remove unsupported native reasoning settings from the configuration`);
    }
  }
}

export interface ModelInvocation {
  id: string; binding: string; configHash: string; modelId: string; catalogId: string; backend?: string; host?: string;
  nativeReasoningRequest?: Record<string, unknown>;
}
export class ConfiguredProvider implements Provider {
  readonly name = "configured";
  readonly supportsToolCalls = true;
  private clients = new Map<string, ModelServiceClient>();
  private readonly caller: ModelCallerContext;
  private readonly credentials: Readonly<Record<string, string>>;
  constructor(readonly resolved: ResolvedOrchestrationConfig, readonly binding = "lead", private readonly options: {
    caller?: ModelCallerContext;
    /** Trusted host credential resolution; never accepted from a request/config document. */
    credentials?: Readonly<Record<string, string>>;
    effort?: EffortLevel;
    beforeRequest?: (invocation: ModelInvocation, request: ProviderRequest) => Promise<void>;
    afterRequest?: (invocation: ModelInvocation, response: ProviderResponse) => Promise<void>;
  } = {}) {
    this.caller = normalizeModelCaller(options.caller);
    this.credentials = Object.freeze(Object.assign(Object.create(null), options.credentials));
    for (const [id, credential] of Object.entries(this.credentials)) {
      if (!Object.prototype.hasOwnProperty.call(resolved.config.providers, id) || typeof credential !== "string" || !credential.trim()) throw new Error("Invalid host provider credential mapping");
      registerSecretValue(credential);
    }
  }

  client(providerId: string): ModelServiceClient {
    const provider = this.resolved.config.providers[providerId];
    if (!provider) throw new Error(`Unknown configured provider: ${providerId}`);
    if (!this.clients.has(providerId)) this.clients.set(providerId, new ModelServiceClient(provider, this.credentials[providerId], this.caller));
    return this.clients.get(providerId)!;
  }

  async select(operation: ModelOperation, signal?: AbortSignal, requireTools = false) {
    const candidates = resolveBinding(this.resolved.config, this.binding, operation);
    const reasons: string[] = [];
    for (const candidate of candidates) {
      const { id, model } = candidate;
      const catalog = await this.client(model.provider).catalog(signal);
      const actual = catalog.find(entry => entry.aliases.includes(model.catalogId));
      if (!actual) { reasons.push(`${id}: not entitled/advertised`); continue; }
      if (!["healthy", "unknown", "ready"].includes(actual.health)) { reasons.push(`${id}: ${actual.health}`); continue; }
      if (model.backend && actual.backend !== model.backend) { reasons.push(`${id}: backend identity not verified`); continue; }
      if (actual.operations.length && !actual.operations.includes(operation)) { reasons.push(`${id}: unsupported operation`); continue; }
      if (requireTools && (!model.supportsTools || this.resolved.config.providers[model.provider].adapter === "mswarm" && !actual.supportsTools)) { reasons.push(`${id}: tools unavailable`); continue; }
      return { id, model, actual, provider: this.resolved.config.providers[model.provider] };
    }
    throw new Error(`No eligible configured ${this.binding} route: ${reasons.join("; ")}`);
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    request.signal?.throwIfAborted();
    const requestId = request.requestId ?? randomUUID();
    if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) {
      throw new Error("Model requestId must be a UUID for this inference attempt");
    }
    const { id, model, provider, actual } = await this.select("chat.completions", request.signal, !!request.tools?.length);
    const invocation: ModelInvocation = { id: requestId, binding: this.binding, configHash: this.resolved.hash, modelId: id, catalogId: model.catalogId, backend: actual.backend, host: model.host };
    const nativeReasoning = this.options.effort ? model.reasoning?.[this.options.effort] : undefined;
    if (nativeReasoning) invocation.nativeReasoningRequest = { ...nativeReasoning };
    if (nativeReasoning) await this.client(model.provider).requireNativeReasoning(model.catalogId, Object.keys(nativeReasoning), request.signal);
    const maxTokens = Math.min(request.maxTokens ?? model.maxOutputTokens, model.maxOutputTokens);
    const inputEstimate = Math.ceil(JSON.stringify([request.messages, request.tools]).length / 3);
    if (inputEstimate + maxTokens > Math.min(model.contextWindow, actual.contextWindow ?? model.contextWindow)) throw new Error("Context budget exceeded; checkpoint and compact before continuing");
    const bounded = { ...request, requestId, maxTokens, stream: request.stream === true && model.supportsStreaming === true };
    await this.options.beforeRequest?.(invocation, bounded);
    const adapter = new OpenAiCompatibleProvider({
      model: model.catalogId, baseUrl: provider.baseUrl, apiKey: this.credentials[model.provider] ?? await providerCredential(provider), timeoutMs: 300_000,
      supportsStreaming: model.supportsStreaming ?? true, supportsTools: model.supportsTools,
      headers: provider.adapter === "mswarm" ? { ...modelCallerHeaders(this.caller), "x-request-id": requestId } : undefined, retryTransient: false,
      extraBody: nativeReasoning,
    });
    const result = await adapter.generate(bounded);
    await this.options.afterRequest?.(invocation, result);
    return { ...result, route: invocation };
  }
}
