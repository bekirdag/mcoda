const DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_CODING_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const DEFAULT_TEMPERATURE = 0.1;
const normalizeBaseUrl = (value) => {
    if (!value)
        return undefined;
    const str = String(value).trim();
    if (!str)
        return undefined;
    return str.endsWith("/") ? str.slice(0, -1) : str;
};
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const usesCodingBaseUrl = (model) => {
    if (!model)
        return false;
    const normalized = model.trim().toLowerCase();
    return normalized === "glm-4.7" || normalized.startsWith("glm-4.7-");
};
const defaultBaseUrlForModel = (model) => usesCodingBaseUrl(model) ? DEFAULT_CODING_BASE_URL : DEFAULT_BASE_URL;
const normalizeThinking = (value) => {
    if (value === true)
        return { type: "enabled" };
    if (value === false)
        return { type: "disabled" };
    return isRecord(value) && Object.keys(value).length > 0 ? value : undefined;
};
const extractUsage = (usage) => {
    if (!usage || typeof usage !== "object")
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
    if (tokensPrompt === undefined && tokensCompletion === undefined && tokensTotal === undefined)
        return undefined;
    return { tokensPrompt, tokensCompletion, tokensTotal };
};
export class ZhipuApiAdapter {
    constructor(config) {
        this.config = config;
        this.baseUrl = normalizeBaseUrl(config.baseUrl) ?? defaultBaseUrlForModel(config.model);
        this.headers = isRecord(config.headers) ? config.headers : undefined;
        this.temperature = typeof config.temperature === "number" ? config.temperature : undefined;
        this.thinking = normalizeThinking(config.thinking);
        this.extraBody = isRecord(config.extraBody) ? config.extraBody : undefined;
        this.assertConfig();
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        if (!this.config.apiKey) {
            return {
                agentId: this.config.agent.id,
                status: "unreachable",
                lastCheckedAt: new Date().toISOString(),
                details: { reason: "missing_api_key" },
            };
        }
        return {
            agentId: this.config.agent.id,
            status: "healthy",
            lastCheckedAt: new Date().toISOString(),
            latencyMs: 0,
            details: { adapter: "zhipu-api", model: this.config.model, baseUrl: this.baseUrl },
        };
    }
    async invoke(request) {
        const url = this.ensureBaseUrl();
        const model = this.ensureModel();
        const apiKey = this.ensureApiKey();
        const body = this.buildBody(request.input, model, false);
        const resp = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: this.buildHeaders(apiKey, false),
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`Zhipu chat completions failed (${resp.status}): ${text}`);
        }
        const data = await resp.json().catch(() => ({}));
        const choice = data?.choices?.[0];
        const message = choice?.message;
        const content = typeof message?.content === "string" ? message.content : undefined;
        const reasoning = typeof message?.reasoning_content === "string" ? message.reasoning_content : undefined;
        const output = content ?? reasoning ?? (typeof data?.output_text === "string" ? data.output_text : JSON.stringify(data));
        const usage = extractUsage(data?.usage);
        return {
            output: output.trim(),
            adapter: this.config.adapter ?? "zhipu-api",
            model,
            metadata: {
                mode: "api",
                adapterType: this.config.adapter ?? "zhipu-api",
                baseUrl: url,
                capabilities: this.config.capabilities,
                usage: data?.usage,
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
        const apiKey = this.ensureApiKey();
        const body = this.buildBody(request.input, model, true);
        const resp = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: this.buildHeaders(apiKey, true),
            body: JSON.stringify(body),
        });
        if (!resp.ok || !resp.body) {
            const text = !resp.ok ? await resp.text().catch(() => "") : "";
            throw new Error(`Zhipu chat completions (stream) failed (${resp.status}): ${text}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let latestUsage;
        const buildChunk = (payload) => {
            const data = JSON.parse(payload);
            const choice = data?.choices?.[0];
            const delta = choice?.delta ?? choice?.message ?? {};
            const content = typeof delta?.content === "string" ? delta.content : "";
            const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
            const usage = extractUsage(data?.usage);
            if (usage)
                latestUsage = usage;
            const output = content || reasoning || "";
            const shouldEmit = Boolean(output) || Boolean(usage);
            if (!shouldEmit)
                return null;
            return {
                output,
                adapter: this.config.adapter ?? "zhipu-api",
                model,
                metadata: {
                    mode: "api",
                    adapterType: this.config.adapter ?? "zhipu-api",
                    baseUrl: url,
                    capabilities: this.config.capabilities,
                    streaming: true,
                    reasoning,
                    usage: data?.usage,
                    tokensPrompt: latestUsage?.tokensPrompt,
                    tokensCompletion: latestUsage?.tokensCompletion,
                    tokensTotal: latestUsage?.tokensTotal,
                    tokens_prompt: latestUsage?.tokensPrompt,
                    tokens_completion: latestUsage?.tokensCompletion,
                    tokens_total: latestUsage?.tokensTotal,
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
                    // Ignore malformed lines; keep streaming.
                }
            }
        }
        const tail = buffer.trim();
        if (tail) {
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
                    // Ignore malformed lines; keep streaming.
                }
            }
        }
    }
    assertConfig() {
        if (!/^https?:\/\//i.test(this.baseUrl)) {
            throw new Error("Zhipu baseUrl must start with http:// or https://");
        }
    }
    ensureBaseUrl() {
        return this.baseUrl;
    }
    ensureModel() {
        if (!this.config.model) {
            throw new Error("Zhipu model is not configured for this agent");
        }
        return this.config.model;
    }
    ensureApiKey() {
        if (!this.config.apiKey) {
            throw new Error("AUTH_REQUIRED: Zhipu API key missing; run `mcoda agent auth set <name>`");
        }
        return this.config.apiKey;
    }
    buildHeaders(apiKey, streaming) {
        return {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(streaming ? { Accept: "text/event-stream" } : {}),
            ...(this.headers ?? {}),
        };
    }
    buildBody(input, model, stream) {
        const body = {
            model,
            messages: [{ role: "user", content: input }],
            stream,
        };
        const temperature = this.temperature ?? DEFAULT_TEMPERATURE;
        if (typeof temperature === "number")
            body.temperature = temperature;
        if (this.thinking)
            body.thinking = this.thinking;
        if (this.extraBody) {
            for (const [key, value] of Object.entries(this.extraBody)) {
                if (body[key] === undefined)
                    body[key] = value;
            }
        }
        return body;
    }
}
