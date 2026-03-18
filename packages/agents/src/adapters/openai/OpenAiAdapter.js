const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const asString = (value) => (typeof value === "string" ? value : undefined);
const resolveString = (value) => {
    const raw = asString(value)?.trim();
    return raw ? raw : undefined;
};
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const normalizeBaseUrl = (value) => {
    const str = resolveString(value);
    if (!str)
        return undefined;
    return str.endsWith("/") ? str.slice(0, -1) : str;
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
        this.baseUrl = resolveBaseUrl(config);
        this.headers = isRecord(config.headers) ? config.headers : undefined;
        this.temperature = typeof config.temperature === "number" ? config.temperature : undefined;
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
            details: { adapter: "openai-api", model: this.config.model, baseUrl: this.baseUrl },
        };
    }
    async invoke(request) {
        const url = this.ensureBaseUrl();
        const model = this.ensureModel();
        const apiKey = this.ensureApiKey();
        const resp = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: this.buildHeaders(apiKey, false),
            body: JSON.stringify(this.buildBody(request.input, model, false)),
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
                authMode: "api",
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
        const apiKey = this.ensureApiKey();
        const resp = await fetch(`${url}/chat/completions`, {
            method: "POST",
            headers: this.buildHeaders(apiKey, true),
            body: JSON.stringify(this.buildBody(request.input, model, true)),
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
                    authMode: "api",
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
    ensureApiKey() {
        if (!this.config.apiKey) {
            throw new Error(`AUTH_REQUIRED: OpenAI API key missing; run \`mcoda agent auth set ${this.config.agent.slug ?? this.config.agent.id}\``);
        }
        return this.config.apiKey;
    }
    buildHeaders(apiKey, streaming) {
        return {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: streaming ? "text/event-stream" : "application/json",
            ...(this.headers ?? {}),
        };
    }
    buildBody(input, model, stream) {
        const body = {
            model,
            messages: [{ role: "user", content: input }],
            stream,
        };
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
}
