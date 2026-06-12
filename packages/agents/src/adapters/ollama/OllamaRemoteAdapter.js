import { Agent as HttpsAgent } from "node:https";
const normalizeBaseUrl = (value) => {
    if (!value)
        return undefined;
    const str = String(value).trim();
    if (!str)
        return undefined;
    return str.endsWith("/") ? str.slice(0, -1) : str;
};
export class OllamaRemoteAdapter {
    constructor(config) {
        this.config = config;
        this.baseUrl = normalizeBaseUrl(config.baseUrl);
        const headers = config.headers;
        this.headers = headers && typeof headers === "object" ? headers : undefined;
        this.verifyTls = typeof config.verifyTls === "boolean" ? Boolean(config.verifyTls) : undefined;
        if (this.verifyTls === false) {
            this.tlsAgent = new HttpsAgent({ rejectUnauthorized: false });
        }
        this.assertConfig();
    }
    assertConfig() {
        if (!this.baseUrl) {
            throw new Error("Ollama baseUrl is not configured; set config.baseUrl to http://host:11434");
        }
        if (!/^https?:\/\//i.test(this.baseUrl)) {
            throw new Error("Ollama baseUrl must start with http:// or https://");
        }
    }
    async getCapabilities() {
        return this.config.capabilities;
    }
    async healthCheck() {
        const url = this.baseUrl;
        if (!url) {
            return {
                agentId: this.config.agent.id,
                status: "unreachable",
                lastCheckedAt: new Date().toISOString(),
                details: { reason: "missing_base_url" },
            };
        }
        const started = Date.now();
        try {
            const resp = await fetch(`${url}/api/tags`);
            const healthy = resp.ok;
            return {
                agentId: this.config.agent.id,
                status: healthy ? "healthy" : "unreachable",
                lastCheckedAt: new Date().toISOString(),
                latencyMs: Date.now() - started,
                details: { adapter: "ollama-remote", baseUrl: url, status: resp.status },
            };
        }
        catch (error) {
            return {
                agentId: this.config.agent.id,
                status: "unreachable",
                lastCheckedAt: new Date().toISOString(),
                details: { reason: "connection_error", error: error.message, baseUrl: url },
            };
        }
    }
    ensureBaseUrl() {
        return this.baseUrl;
    }
    ensureModel() {
        const model = this.config.model;
        if (!model) {
            throw new Error("Ollama model is not configured for this agent");
        }
        return model;
    }
    extractMetrics(data) {
        const metrics = {};
        if (typeof data?.prompt_eval_count === "number")
            metrics.promptEvalCount = data.prompt_eval_count;
        if (typeof data?.eval_count === "number")
            metrics.evalCount = data.eval_count;
        if (typeof data?.total_duration === "number")
            metrics.totalDurationNs = data.total_duration;
        if (Object.keys(metrics).length === 0)
            return undefined;
        return metrics;
    }
    async invoke(request) {
        const url = this.ensureBaseUrl();
        const model = this.ensureModel();
        const init = {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(this.headers ?? {}) },
            body: JSON.stringify({ model, prompt: request.input, stream: false }),
        };
        if (this.tlsAgent)
            init.agent = this.tlsAgent;
        const resp = await fetch(`${url}/api/generate`, init);
        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            if (resp.status === 404 && /model.*not found/i.test(text)) {
                throw new Error(`MODEL_NOT_FOUND: model=${model} baseUrl=${url} ${text}`.trim());
            }
            throw new Error(`Ollama generate failed (${resp.status}): ${text}`);
        }
        const data = await resp.json().catch(() => ({}));
        const metrics = this.extractMetrics(data);
        const output = typeof data?.response === "string"
            ? data.response
            : typeof data?.message === "string"
                ? data.message
                : JSON.stringify(data);
        return {
            output: output.trim(),
            adapter: this.config.adapter ?? "ollama-remote",
            model,
            metadata: {
                adapterType: this.config.adapter ?? "ollama-remote",
                baseUrl: url,
                capabilities: this.config.capabilities,
                metrics,
            },
        };
    }
    async *invokeStream(request) {
        const url = this.ensureBaseUrl();
        const model = this.ensureModel();
        const init = {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(this.headers ?? {}) },
            body: JSON.stringify({ model, prompt: request.input, stream: true }),
        };
        if (this.tlsAgent)
            init.agent = this.tlsAgent;
        const resp = await fetch(`${url}/api/generate`, init);
        if (!resp.ok || !resp.body) {
            const text = !resp.ok ? await resp.text().catch(() => "") : "";
            if (resp.status === 404 && /model.*not found/i.test(text)) {
                throw new Error(`MODEL_NOT_FOUND: model=${model} baseUrl=${url} ${text}`.trim());
            }
            throw new Error(`Ollama generate (stream) failed (${resp.status}): ${text}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            while (true) {
                const idx = buffer.indexOf("\n");
                if (idx === -1)
                    break;
                const line = buffer.slice(0, idx).trim();
                buffer = buffer.slice(idx + 1);
                if (!line)
                    continue;
                try {
                    const data = JSON.parse(line);
                    const chunk = typeof data?.response === "string"
                        ? data.response
                        : typeof data?.message === "string"
                            ? data.message
                            : "";
                    const metrics = this.extractMetrics(data);
                    if (chunk) {
                        yield {
                            output: chunk,
                            adapter: this.config.adapter ?? "ollama-remote",
                            model,
                            metadata: {
                                adapterType: this.config.adapter ?? "ollama-remote",
                                baseUrl: url,
                                capabilities: this.config.capabilities,
                                streaming: true,
                                metrics,
                                raw: line,
                            },
                        };
                    }
                    if (data?.done) {
                        return;
                    }
                }
                catch {
                    // Ignore malformed lines; keep streaming.
                }
            }
        }
        const tail = buffer.trim();
        if (tail) {
            yield {
                output: tail,
                adapter: this.config.adapter ?? "ollama-remote",
                model,
                metadata: {
                    adapterType: this.config.adapter ?? "ollama-remote",
                    baseUrl: url,
                    capabilities: this.config.capabilities,
                    streaming: true,
                    raw: tail,
                },
            };
        }
    }
}
