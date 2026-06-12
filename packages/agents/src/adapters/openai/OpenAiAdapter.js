import { normalizeLocalOpenAiCompatibleRunnerConfig, } from "@mcoda/shared";
import { parseUsageLimitError } from "../../AgentService/UsageLimitParser.js";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_DETAIL_CHARS = 500;
const LOCAL_HEALTH_TIMEOUT_MS = 10000;
const RATE_LIMIT_HEADER_NAMES = [
    "retry-after",
    "x-ratelimit-reset-after",
    "x-ratelimit-reset",
    "x-ratelimit-reset-at",
    "x-ratelimit-remaining",
];
const asString = (value) => (typeof value === "string" ? value : undefined);
const resolveString = (value) => {
    const raw = asString(value)?.trim();
    return raw ? raw : undefined;
};
const resolveBoolean = (value) => typeof value === "boolean" ? value : undefined;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const normalizeBaseUrl = (value) => {
    const str = resolveString(value);
    if (!str)
        return undefined;
    return str.endsWith("/") ? str.slice(0, -1) : str;
};
const resolveStringArray = (value) => {
    if (!Array.isArray(value))
        return undefined;
    const entries = value
        .map((entry) => resolveString(entry))
        .filter((entry) => Boolean(entry));
    return entries.length ? entries : undefined;
};
const normalizeBooleanMap = (value) => {
    if (!isRecord(value))
        return undefined;
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "boolean")
            output[key] = entry;
    }
    return Object.keys(output).length ? output : undefined;
};
const firstDefined = (...values) => values.find((value) => value !== undefined);
const readRecord = (record, key) => {
    const value = record?.[key];
    return isRecord(value) ? value : undefined;
};
const buildRateLimitProbeMessage = (response, responseText) => {
    const parts = [`openai_probe http ${response.status}`];
    const retryAfter = response.headers.get("retry-after")?.trim();
    if (retryAfter) {
        const retryAfterSeconds = Number.parseInt(retryAfter, 10);
        parts.push(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? `Retry after ${retryAfterSeconds} seconds`
            : `Retry after ${retryAfter}`);
    }
    for (const headerName of RATE_LIMIT_HEADER_NAMES) {
        if (headerName === "retry-after")
            continue;
        const headerValue = response.headers.get(headerName)?.trim();
        if (headerValue) {
            parts.push(`${headerName}: ${headerValue}`);
        }
    }
    const trimmedResponse = responseText.trim();
    if (trimmedResponse) {
        parts.push(trimmedResponse);
    }
    return parts.join(". ");
};
const resolveRetryAfterMs = (resetAt, nowMs) => {
    if (!resetAt)
        return undefined;
    const timestampMs = Date.parse(resetAt);
    if (!Number.isFinite(timestampMs))
        return undefined;
    return Math.max(0, timestampMs - nowMs);
};
const resolveBaseUrl = (config) => {
    const anyConfig = config;
    const agentConfig = config.agent?.config;
    return (normalizeBaseUrl(anyConfig.baseUrl) ??
        normalizeBaseUrl(anyConfig.endpoint) ??
        normalizeBaseUrl(anyConfig.apiBaseUrl) ??
        normalizeBaseUrl(agentConfig?.baseUrl) ??
        normalizeBaseUrl(agentConfig?.endpoint) ??
        normalizeBaseUrl(agentConfig?.apiBaseUrl) ??
        DEFAULT_BASE_URL);
};
const isManagedMswarmConfig = (config) => {
    const anyConfig = config;
    const agentConfig = config.agent?.config;
    const cloud = readRecord(anyConfig, "mswarmCloud") ?? readRecord(agentConfig, "mswarmCloud");
    const selfHosted = readRecord(anyConfig, "mswarmSelfHosted") ?? readRecord(agentConfig, "mswarmSelfHosted");
    const worker = readRecord(anyConfig, "mswarmWorker") ?? readRecord(agentConfig, "mswarmWorker");
    return cloud?.managed === true || selfHosted?.managed === true || worker?.managed === true;
};
const resolveDocdexContext = (config, metadata) => {
    if (!isManagedMswarmConfig(config))
        return undefined;
    const anyConfig = config;
    const configDocdex = isRecord(anyConfig.docdex) ? anyConfig.docdex : undefined;
    const metadataDocdexValue = metadata?.docdex;
    const metadataDocdex = isRecord(metadataDocdexValue) ? metadataDocdexValue : undefined;
    const enabled = firstDefined(resolveBoolean(metadataDocdex?.enabled), resolveBoolean(metadata?.docdexEnabled), resolveBoolean(metadata?.docdex_enabled), resolveBoolean(configDocdex?.enabled));
    if (enabled === false)
        return undefined;
    const baseUrl = firstDefined(resolveString(metadataDocdex?.baseUrl), resolveString(metadataDocdex?.base_url), resolveString(metadata?.docdexBaseUrl), resolveString(metadata?.docdex_base_url), resolveString(anyConfig.docdexBaseUrl), resolveString(configDocdex?.baseUrl), resolveString(configDocdex?.base_url));
    const repoId = firstDefined(resolveString(metadataDocdex?.repoId), resolveString(metadataDocdex?.repo_id), resolveString(metadata?.docdexRepoId), resolveString(metadata?.docdex_repo_id), resolveString(anyConfig.docdexRepoId), resolveString(configDocdex?.repoId), resolveString(configDocdex?.repo_id));
    const repoRoot = firstDefined(resolveString(metadataDocdex?.repoRoot), resolveString(metadataDocdex?.repo_root), resolveString(metadata?.docdexRepoRoot), resolveString(metadata?.docdex_repo_root), resolveString(anyConfig.docdexRepoRoot), resolveString(configDocdex?.repoRoot), resolveString(configDocdex?.repo_root));
    const required = firstDefined(resolveBoolean(metadataDocdex?.required), resolveBoolean(metadata?.docdexRequired), resolveBoolean(metadata?.docdex_required), resolveBoolean(configDocdex?.required));
    const allowedOperations = firstDefined(resolveStringArray(metadataDocdex?.allowedOperations), resolveStringArray(metadataDocdex?.allowed_operations), resolveStringArray(metadata?.docdexAllowedOperations), resolveStringArray(metadata?.docdex_allowed_operations), resolveStringArray(configDocdex?.allowedOperations), resolveStringArray(configDocdex?.allowed_operations));
    const credentialSource = firstDefined(resolveString(metadataDocdex?.credentialSource), resolveString(metadataDocdex?.credential_source), resolveString(metadata?.docdexCredentialSource), resolveString(metadata?.docdex_credential_source), resolveString(configDocdex?.credentialSource), resolveString(configDocdex?.credential_source));
    const capabilities = firstDefined(normalizeBooleanMap(metadataDocdex?.capabilities), normalizeBooleanMap(metadata?.docdexCapabilities), normalizeBooleanMap(metadata?.docdex_capabilities), normalizeBooleanMap(configDocdex?.capabilities));
    const dagSessionId = firstDefined(resolveString(metadataDocdex?.dagSessionId), resolveString(metadataDocdex?.dag_session_id), resolveString(metadata?.docdexDagSessionId), resolveString(metadata?.docdex_dag_session_id), resolveString(configDocdex?.dagSessionId), resolveString(configDocdex?.dag_session_id));
    const initialize = firstDefined(resolveBoolean(metadataDocdex?.initialize), resolveBoolean(configDocdex?.initialize));
    const allowWeb = firstDefined(resolveBoolean(metadataDocdex?.allowWeb), resolveBoolean(metadataDocdex?.allow_web), resolveBoolean(configDocdex?.allowWeb), resolveBoolean(configDocdex?.allow_web));
    const allowMemoryWrite = firstDefined(resolveBoolean(metadataDocdex?.allowMemoryWrite), resolveBoolean(metadataDocdex?.allow_memory_write), resolveBoolean(configDocdex?.allowMemoryWrite), resolveBoolean(configDocdex?.allow_memory_write));
    const allowProfileWrite = firstDefined(resolveBoolean(metadataDocdex?.allowProfileWrite), resolveBoolean(metadataDocdex?.allow_profile_write), resolveBoolean(configDocdex?.allowProfileWrite), resolveBoolean(configDocdex?.allow_profile_write));
    const allowIndexRebuild = firstDefined(resolveBoolean(metadataDocdex?.allowIndexRebuild), resolveBoolean(metadataDocdex?.allow_index_rebuild), resolveBoolean(configDocdex?.allowIndexRebuild), resolveBoolean(configDocdex?.allow_index_rebuild));
    const hasContext = baseUrl !== undefined ||
        repoId !== undefined ||
        repoRoot !== undefined ||
        required !== undefined ||
        allowedOperations !== undefined ||
        capabilities !== undefined ||
        dagSessionId !== undefined ||
        initialize !== undefined ||
        allowWeb !== undefined ||
        allowMemoryWrite !== undefined ||
        allowProfileWrite !== undefined ||
        allowIndexRebuild !== undefined ||
        metadataDocdex !== undefined ||
        configDocdex !== undefined;
    if (!hasContext)
        return undefined;
    return {
        enabled: true,
        baseUrl,
        repoId,
        repoRoot,
        dagSessionId,
        required,
        allowedOperations,
        credentialSource: credentialSource ?? "attached_mswarm_api_key",
        capabilities,
        initialize,
        allowWeb,
        allowMemoryWrite,
        allowProfileWrite,
        allowIndexRebuild,
    };
};
const toDocdexRequestBody = (context) => {
    const body = {};
    if (context.baseUrl !== undefined)
        body.base_url = context.baseUrl;
    if (context.repoId !== undefined)
        body.repo_id = context.repoId;
    if (context.repoRoot !== undefined)
        body.repo_root = context.repoRoot;
    if (context.dagSessionId !== undefined)
        body.dag_session_id = context.dagSessionId;
    if (context.required !== undefined)
        body.required = context.required;
    if (context.allowedOperations !== undefined)
        body.allowed_operations = context.allowedOperations;
    if (context.credentialSource !== undefined)
        body.credential_source = context.credentialSource;
    if (context.capabilities !== undefined)
        body.capabilities = context.capabilities;
    if (context.initialize !== undefined)
        body.initialize = context.initialize;
    if (context.allowWeb !== undefined)
        body.allow_web = context.allowWeb;
    if (context.allowMemoryWrite !== undefined)
        body.allow_memory_write = context.allowMemoryWrite;
    if (context.allowProfileWrite !== undefined)
        body.allow_profile_write = context.allowProfileWrite;
    if (context.allowIndexRebuild !== undefined)
        body.allow_index_rebuild = context.allowIndexRebuild;
    return body;
};
const extractUsage = (usage) => {
    if (!isRecord(usage))
        return undefined;
    const tokensPrompt = typeof usage.prompt_tokens === "number"
        ? usage.prompt_tokens
        : typeof usage.promptTokens === "number"
            ? usage.promptTokens
            : undefined;
    const tokensCompletion = typeof usage.completion_tokens === "number"
        ? usage.completion_tokens
        : typeof usage.completionTokens === "number"
            ? usage.completionTokens
            : undefined;
    let tokensTotal = typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : typeof usage.totalTokens === "number"
            ? usage.totalTokens
            : undefined;
    if (tokensTotal === undefined && typeof tokensPrompt === "number" && typeof tokensCompletion === "number") {
        tokensTotal = tokensPrompt + tokensCompletion;
    }
    if (tokensPrompt === undefined && tokensCompletion === undefined && tokensTotal === undefined) {
        return undefined;
    }
    return { tokensPrompt, tokensCompletion, tokensTotal };
};
const collectContentText = (value) => {
    const direct = asString(value);
    if (direct !== undefined)
        return [direct];
    if (Array.isArray(value))
        return value.flatMap((entry) => collectContentText(entry));
    if (!isRecord(value))
        return [];
    const partType = resolveString(value.type)?.toLowerCase();
    if (partType?.startsWith("reasoning"))
        return [];
    if (asString(value.text) !== undefined)
        return [value.text];
    if (asString(value.output_text) !== undefined)
        return [value.output_text];
    if (asString(value.input_text) !== undefined)
        return [value.input_text];
    if ("content" in value)
        return collectContentText(value.content);
    return [];
};
const collectReasoningText = (value) => {
    const direct = asString(value);
    if (direct !== undefined)
        return [direct];
    if (Array.isArray(value))
        return value.flatMap((entry) => collectReasoningText(entry));
    if (!isRecord(value))
        return [];
    const partType = resolveString(value.type)?.toLowerCase();
    if (partType?.startsWith("reasoning")) {
        if (asString(value.text) !== undefined)
            return [value.text];
        if ("content" in value)
            return collectReasoningText(value.content);
    }
    const reasoningFields = [value.reasoning_content, value.reasoning_text, value.summary, value.reasoning];
    const segments = reasoningFields.flatMap((entry) => collectReasoningText(entry));
    if (segments.length > 0)
        return segments;
    return [];
};
const collapseText = (segments) => {
    const joined = segments.join("");
    const trimmed = joined.trim();
    return trimmed ? trimmed : undefined;
};
const extractResponseText = (data) => {
    const payload = isRecord(data) ? data : {};
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = choices[0];
    const message = isRecord(choice) && (isRecord(choice.message) ? choice.message : isRecord(choice.delta) ? choice.delta : {})
        ? (isRecord(choice.message) ? choice.message : choice.delta)
        : {};
    const content = collapseText(collectContentText(message.content ?? message));
    const reasoning = collapseText(collectReasoningText(message.reasoning ?? message));
    const fallback = resolveString(payload.output_text) ??
        collapseText(collectContentText(payload.output ?? payload.response ?? payload.data));
    return { output: content ?? reasoning ?? fallback, reasoning };
};
export class OpenAiAdapter {
    constructor(config) {
        this.config = config;
        const normalizedLocal = normalizeLocalOpenAiCompatibleRunnerConfig({
            adapter: config.adapter ?? config.agent.adapter,
            config,
            agentConfig: config.agent.config,
        });
        this.baseUrl = normalizeBaseUrl(normalizedLocal.config.baseUrl) ?? resolveBaseUrl(config);
        this.headers = normalizedLocal.config.headers;
        this.temperature = typeof config.temperature === "number" ? config.temperature : undefined;
        this.extraBody = normalizedLocal.config.extraBody;
        this.runnerKind = normalizedLocal.config.runnerKind;
        this.authMode = normalizedLocal.config.authMode ?? "bearer";
        this.dummyBearerToken = normalizedLocal.config.dummyBearerToken;
        this.healthPath = normalizedLocal.config.healthPath;
        this.modelsPath = normalizedLocal.config.modelsPath;
        this.localConfigIssues = normalizedLocal.issues;
        this.isLocalOpenAiCompatible = normalizedLocal.isLocalOpenAiCompatible || this.authMode !== "bearer";
        this.assertConfig();
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const startedAt = Date.now();
        try {
            const model = this.ensureModel();
            const auth = this.resolveAuth();
            const url = this.ensureBaseUrl();
            if (this.isLocalOpenAiCompatible) {
                return await this.healthCheckLocal({ model, auth, url, startedAt });
            }
            const response = await fetch(`${url}/chat/completions`, {
                method: "POST",
                headers: this.buildHeaders(auth, false),
                body: JSON.stringify(this.buildHealthCheckBody(model)),
            });
            const responseText = await response.text().catch(() => "");
            const checkedAtMs = Date.now();
            const lastCheckedAt = new Date(checkedAtMs).toISOString();
            const latencyMs = checkedAtMs - startedAt;
            if (!response.ok) {
                if (response.status === 429) {
                    const parsedLimit = parseUsageLimitError(new Error(buildRateLimitProbeMessage(response, responseText)), checkedAtMs);
                    return {
                        agentId: this.config.agent.id,
                        status: "healthy",
                        lastCheckedAt,
                        latencyMs,
                        details: {
                            adapter: "openai-api",
                            source: "openai_probe",
                            model,
                            baseUrl: url,
                            reason: "rate_limited",
                            transient: true,
                            rateLimited: true,
                            httpStatus: response.status,
                            response: responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS),
                            resetAt: parsedLimit?.resetAt,
                            resetAtSource: parsedLimit?.resetAtSource,
                            retryAfterMs: resolveRetryAfterMs(parsedLimit?.resetAt, checkedAtMs),
                            windowTypes: parsedLimit?.windowTypes,
                        },
                    };
                }
                return {
                    agentId: this.config.agent.id,
                    status: "unreachable",
                    lastCheckedAt,
                    latencyMs,
                    details: {
                        adapter: "openai-api",
                        source: "openai_probe",
                        model,
                        baseUrl: url,
                        reason: "http_error",
                        httpStatus: response.status,
                        response: responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS),
                    },
                };
            }
            return {
                agentId: this.config.agent.id,
                status: "healthy",
                lastCheckedAt,
                latencyMs,
                details: {
                    adapter: "openai-api",
                    source: "openai_probe",
                    model,
                    baseUrl: url,
                },
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const reason = /model is not configured/i.test(message)
                ? "missing_model"
                : /missing api key|api key missing/i.test(message)
                    ? "missing_api_key"
                    : "probe_failed";
            return {
                agentId: this.config.agent.id,
                status: "unreachable",
                lastCheckedAt: new Date().toISOString(),
                latencyMs: Date.now() - startedAt,
                details: {
                    adapter: "openai-api",
                    source: "openai_probe",
                    model: this.config.model,
                    baseUrl: this.baseUrl,
                    reason,
                    error: message,
                },
            };
        }
    }
    async invoke(request) {
        const url = this.ensureBaseUrl();
        const model = this.ensureModel();
        const auth = this.resolveAuth();
        const docdex = resolveDocdexContext(this.config, request.metadata);
        const resp = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: this.buildHeaders(auth, false, docdex),
            body: JSON.stringify(this.buildBody(request.input, model, false, docdex)),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`OpenAI chat completions failed (${resp.status}): ${text}`);
        }
        const data = await resp.json().catch(() => ({}));
        const usage = extractUsage(isRecord(data) ? data.usage : undefined);
        const { output, reasoning } = extractResponseText(data);
        return {
            output: (output ?? JSON.stringify(data)).trim(),
            adapter: this.config.adapter ?? "openai-api",
            model,
            metadata: {
                mode: "api",
                capabilities: this.config.capabilities,
                prompts: this.config.prompts,
                authMode: auth.metadataAuthMode,
                adapterType: this.config.adapter ?? "openai-api",
                baseUrl: url,
                usage: isRecord(data) ? data.usage : undefined,
                tokensPrompt: usage?.tokensPrompt,
                tokensCompletion: usage?.tokensCompletion,
                tokensTotal: usage?.tokensTotal,
                tokens_prompt: usage?.tokensPrompt,
                tokens_completion: usage?.tokensCompletion,
                tokens_total: usage?.tokensTotal,
                reasoning,
            },
        };
    }
    async *invokeStream(request) {
        const url = this.ensureBaseUrl();
        const model = this.ensureModel();
        const auth = this.resolveAuth();
        const docdex = resolveDocdexContext(this.config, request.metadata);
        const resp = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: this.buildHeaders(auth, true, docdex),
            body: JSON.stringify(this.buildBody(request.input, model, true, docdex)),
        });
        if (!resp.ok || !resp.body) {
            const text = !resp.ok ? await resp.text().catch(() => "") : "";
            throw new Error(`OpenAI chat completions (stream) failed (${resp.status}): ${text}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let latestUsage;
        const buildChunk = (payload) => {
            const data = JSON.parse(payload);
            const usage = extractUsage(isRecord(data) ? data.usage : undefined);
            if (usage)
                latestUsage = usage;
            const { output, reasoning } = extractResponseText(data);
            if (!output && !usage)
                return null;
            return {
                output: output ?? "",
                adapter: this.config.adapter ?? "openai-api",
                model,
                metadata: {
                    mode: "api",
                    authMode: auth.metadataAuthMode,
                    adapterType: this.config.adapter ?? "openai-api",
                    baseUrl: url,
                    capabilities: this.config.capabilities,
                    prompts: this.config.prompts,
                    streaming: true,
                    usage: isRecord(data) ? data.usage : undefined,
                    tokensPrompt: latestUsage?.tokensPrompt,
                    tokensCompletion: latestUsage?.tokensCompletion,
                    tokensTotal: latestUsage?.tokensTotal,
                    tokens_prompt: latestUsage?.tokensPrompt,
                    tokens_completion: latestUsage?.tokensCompletion,
                    tokens_total: latestUsage?.tokensTotal,
                    reasoning,
                    raw: payload,
                },
            };
        };
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line || !line.startsWith("data:"))
                    continue;
                const payload = line.slice(5).trim();
                if (!payload)
                    continue;
                if (payload === "[DONE]")
                    return;
                try {
                    const chunk = buildChunk(payload);
                    if (chunk)
                        yield chunk;
                }
                catch {
                    // Ignore malformed SSE lines and continue streaming.
                }
            }
        }
        const tail = buffer.trim();
        if (!tail)
            return;
        const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:"))
                continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]")
                continue;
            try {
                const chunk = buildChunk(payload);
                if (chunk)
                    yield chunk;
            }
            catch {
                // Ignore malformed SSE lines and continue streaming.
            }
        }
    }
    assertConfig() {
        if (!/^https?:\/\//i.test(this.baseUrl)) {
            throw new Error("OpenAI baseUrl must start with http:// or https://");
        }
    }
    ensureBaseUrl() {
        return this.baseUrl;
    }
    ensureModel() {
        if (!this.config.model) {
            throw new Error("OpenAI model is not configured for this agent");
        }
        return this.config.model;
    }
    resolveAuth() {
        if (this.authMode === "none") {
            return { mode: "none", metadataAuthMode: "none" };
        }
        if (this.authMode === "dummy-bearer") {
            return {
                mode: "dummy-bearer",
                authorization: `Bearer ${this.dummyBearerToken ?? "local"}`,
                metadataAuthMode: "dummy-bearer",
            };
        }
        if (!this.config.apiKey) {
            throw new Error(`AUTH_REQUIRED: OpenAI API key missing; run \`mcoda agent auth set ${this.config.agent.slug ?? this.config.agent.id}\``);
        }
        return {
            mode: "bearer",
            authorization: `Bearer ${this.config.apiKey}`,
            metadataAuthMode: "api",
        };
    }
    buildHeaders(auth, streaming, docdex) {
        return {
            ...(auth.authorization ? { Authorization: auth.authorization } : {}),
            "Content-Type": "application/json",
            Accept: streaming ? "text/event-stream" : "application/json",
            ...(docdex?.repoId ? { "x-docdex-repo-id": docdex.repoId } : {}),
            ...(docdex?.repoRoot ? { "x-docdex-repo-root": docdex.repoRoot } : {}),
            ...(docdex?.dagSessionId ? { "x-docdex-dag-session": docdex.dagSessionId } : {}),
            ...(this.headers ?? {}),
        };
    }
    buildBody(input, model, stream, docdex) {
        const body = {
            model,
            messages: [{ role: "user", content: input }],
            stream,
        };
        if (docdex) {
            body.docdex = toDocdexRequestBody(docdex);
        }
        if (typeof this.temperature === "number") {
            body.temperature = this.temperature;
        }
        if (this.extraBody) {
            for (const [key, value] of Object.entries(this.extraBody)) {
                if (body[key] === undefined)
                    body[key] = value;
            }
        }
        if (stream && body.stream_options === undefined) {
            body.stream_options = { include_usage: true };
        }
        return body;
    }
    buildHealthCheckBody(model) {
        const body = this.buildBody("healthcheck", model, false);
        if (body.max_tokens === undefined && body.max_completion_tokens === undefined) {
            body.max_tokens = 1;
        }
        if (body.temperature === undefined) {
            body.temperature = 0;
        }
        return body;
    }
    async healthCheckLocal(params) {
        const { model, auth, url, startedAt } = params;
        if (this.healthPath) {
            const result = await this.fetchHealthPath(url, auth, this.healthPath);
            const checkedAtMs = Date.now();
            if (result.ok) {
                return this.buildHealthResult("healthy", checkedAtMs, startedAt, {
                    source: "local_health_path",
                    model,
                    baseUrl: url,
                    healthPath: this.healthPath,
                    health: this.summarizeProbe(result),
                });
            }
            return this.buildHealthResult("unreachable", checkedAtMs, startedAt, {
                source: "local_health_path",
                model,
                baseUrl: url,
                reason: result.error ? "health_path_failed" : "health_path_http_error",
                healthPath: this.healthPath,
                health: this.summarizeProbe(result),
            });
        }
        const modelListing = await this.fetchModels(url, auth, model);
        const checkedAtMs = Date.now();
        if (modelListing.ok) {
            if (modelListing.modelFound === false) {
                return this.buildHealthResult("degraded", checkedAtMs, startedAt, {
                    source: "local_models",
                    model,
                    baseUrl: url,
                    reason: "model_not_listed",
                    modelListing: this.summarizeModelListing(modelListing),
                });
            }
            return this.buildHealthResult("healthy", checkedAtMs, startedAt, {
                source: "local_models",
                model,
                baseUrl: url,
                modelListing: this.summarizeModelListing(modelListing),
            });
        }
        const chatProbe = await this.fetchChatProbe(url, auth, model);
        const afterChatMs = Date.now();
        if (chatProbe.ok) {
            return this.buildHealthResult("degraded", afterChatMs, startedAt, {
                source: "local_chat_probe",
                model,
                baseUrl: url,
                reason: "model_listing_failed",
                modelListing: this.summarizeModelListing(modelListing),
                chatProbe: this.summarizeProbe(chatProbe),
            });
        }
        return this.buildHealthResult("unreachable", afterChatMs, startedAt, {
            source: "local_models",
            model,
            baseUrl: url,
            reason: modelListing.error ? "model_listing_failed" : "model_listing_http_error",
            modelListing: this.summarizeModelListing(modelListing),
            chatProbe: this.summarizeProbe(chatProbe),
        });
    }
    buildHealthResult(status, checkedAtMs, startedAt, details) {
        return {
            agentId: this.config.agent.id,
            status,
            lastCheckedAt: new Date(checkedAtMs).toISOString(),
            latencyMs: checkedAtMs - startedAt,
            details: {
                adapter: this.config.adapter ?? "openai-api",
                runnerKind: this.runnerKind,
                authMode: this.authMode,
                configIssues: this.localConfigIssues.length ? this.localConfigIssues : undefined,
                ...details,
            },
        };
    }
    async fetchHealthPath(baseUrl, auth, healthPath) {
        const url = this.resolveRunnerUrl(baseUrl, healthPath);
        return this.fetchJsonProbe(url, auth);
    }
    async fetchModels(baseUrl, auth, model) {
        const candidates = this.resolveModelListUrls(baseUrl);
        let last;
        for (const url of candidates) {
            const result = await this.fetchJsonProbe(url, auth);
            if (!result.ok) {
                last = { ...result, models: [], modelFound: false };
                continue;
            }
            const models = this.extractModelIds(result.data);
            return {
                ...result,
                models,
                modelFound: models.length === 0 ? undefined : models.includes(model),
            };
        }
        return last ?? {
            ok: false,
            url: candidates[0] ?? baseUrl,
            error: "No model listing URL candidates were available.",
            models: [],
            modelFound: false,
        };
    }
    async fetchChatProbe(baseUrl, auth, model) {
        const url = `${baseUrl}/chat/completions`;
        return this.fetchJsonProbe(url, auth, {
            method: "POST",
            body: JSON.stringify(this.buildHealthCheckBody(model)),
        });
    }
    async fetchJsonProbe(url, auth, init = {}) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), LOCAL_HEALTH_TIMEOUT_MS);
        try {
            const response = await fetch(url, {
                method: init.method ?? "GET",
                headers: this.buildHeaders(auth, false),
                body: init.body,
                signal: controller.signal,
            });
            const responseText = await response.text().catch(() => "");
            let data;
            if (responseText.trim()) {
                try {
                    data = JSON.parse(responseText);
                }
                catch {
                    data = undefined;
                }
            }
            return {
                ok: response.ok,
                status: response.status,
                url,
                response: responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS),
                data,
            };
        }
        catch (error) {
            return {
                ok: false,
                url,
                error: error instanceof Error ? error.message : String(error),
            };
        }
        finally {
            clearTimeout(timeout);
        }
    }
    resolveRunnerUrl(baseUrl, rawPath) {
        try {
            return new URL(rawPath).toString();
        }
        catch {
            // Continue with relative runner paths below.
        }
        if (rawPath.startsWith("/")) {
            const root = new URL(baseUrl);
            return new URL(rawPath, root.origin).toString();
        }
        return new URL(rawPath, `${baseUrl}/`).toString();
    }
    resolveModelListUrls(baseUrl) {
        if (this.modelsPath)
            return [this.resolveRunnerUrl(baseUrl, this.modelsPath)];
        const root = new URL(baseUrl);
        const urls = new Set();
        if (!root.pathname.replace(/\/+$/, "").endsWith("/v1")) {
            urls.add(new URL("/v1/models", root.origin).toString());
        }
        urls.add(new URL("models", `${baseUrl}/`).toString());
        urls.add(new URL("/models", root.origin).toString());
        return Array.from(urls);
    }
    extractModelIds(data) {
        if (!isRecord(data))
            return [];
        const entries = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
        const ids = entries
            .map((entry) => {
            if (typeof entry === "string")
                return entry.trim();
            if (isRecord(entry))
                return resolveString(entry.id) ?? resolveString(entry.name);
            return undefined;
        })
            .filter((entry) => Boolean(entry));
        return Array.from(new Set(ids));
    }
    summarizeProbe(result) {
        return {
            ok: result.ok,
            url: result.url,
            httpStatus: result.status,
            response: result.response,
            error: result.error,
        };
    }
    summarizeModelListing(result) {
        return {
            ...this.summarizeProbe(result),
            models: result.models?.slice(0, 25),
            modelCount: result.models?.length,
            modelFound: result.modelFound,
        };
    }
}
