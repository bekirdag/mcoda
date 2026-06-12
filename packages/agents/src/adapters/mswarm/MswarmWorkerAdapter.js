const MAX_RESPONSE_DETAIL_CHARS = 500;
const SENSITIVE_METADATA_KEY = /(?:secret|token|api[_-]?key|encryption[_-]?key|repo[_-]?(?:id|key))/i;
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const resolveString = (value) => {
    const raw = typeof value === "string" ? value.trim() : "";
    return raw || undefined;
};
const resolveBoolean = (value) => typeof value === "boolean" ? value : undefined;
const readRecord = (record, key) => {
    const value = record?.[key];
    return isRecord(value) ? value : undefined;
};
const normalizeBaseUrl = (value) => value.replace(/\/+$/, "");
function resolveWorkerConfig(config) {
    const anyConfig = config;
    const agentConfig = config.agent
        ?.config;
    const worker = readRecord(anyConfig, "mswarmWorker") ?? readRecord(agentConfig, "mswarmWorker");
    if (!worker || worker.managed !== true) {
        throw new Error("mswarm-worker adapter requires a managed mswarmWorker config");
    }
    return worker;
}
function resolveRunUrl(config, worker) {
    const explicit = resolveString(worker.apiRunUrl) ?? resolveString(worker.api_run_url);
    if (explicit) {
        return explicit;
    }
    const workerId = resolveString(worker.workerId) ??
        resolveString(worker.worker_id) ??
        resolveString(worker.remoteSlug);
    if (!workerId) {
        throw new Error("mswarm-worker adapter config is missing workerId");
    }
    const catalogBase = resolveString(worker.catalogBaseUrl) ??
        resolveString(worker.catalog_base_url) ??
        resolveString(config.baseUrl);
    if (!catalogBase) {
        throw new Error("mswarm-worker adapter config is missing catalogBaseUrl");
    }
    return `${normalizeBaseUrl(catalogBase)}/v1/swarm/workers/${encodeURIComponent(workerId)}/run`;
}
function parseWorkerOutput(payload) {
    const direct = resolveString(payload.output);
    if (direct !== undefined)
        return direct;
    const result = isRecord(payload.result) ? payload.result : {};
    return resolveString(result.output) ?? JSON.stringify(payload);
}
const resolveIdempotencyKey = (metadata) => resolveString(metadata?.idempotencyKey) ??
    resolveString(metadata?.idempotency_key) ??
    resolveString(metadata?.runId) ??
    resolveString(metadata?.run_id);
function sanitizeMetadataValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeMetadataValue(entry));
    }
    if (!isRecord(value)) {
        return value;
    }
    const sanitized = {};
    for (const [key, child] of Object.entries(value)) {
        if (SENSITIVE_METADATA_KEY.test(key)) {
            continue;
        }
        sanitized[key] = sanitizeMetadataValue(child);
    }
    return sanitized;
}
function buildResponseSummary(payload, result) {
    const summary = {
        runId: resolveString(payload.run_id) ?? resolveString(payload.runId),
        requestId: resolveString(payload.request_id) ?? resolveString(payload.requestId),
        status: resolveString(payload.status),
        accepted: resolveBoolean(payload.accepted),
        agent: sanitizeMetadataValue(payload.agent),
    };
    const resultMetadata = isRecord(result.runtime_metadata)
        ? result.runtime_metadata
        : isRecord(result.metadata)
            ? result.metadata
            : undefined;
    if (resultMetadata) {
        summary.resultMetadata = sanitizeMetadataValue(resultMetadata);
    }
    for (const [key, value] of Object.entries(summary)) {
        if (value === undefined) {
            delete summary[key];
        }
    }
    return summary;
}
export class MswarmWorkerAdapter {
    constructor(config) {
        this.config = config;
        this.worker = resolveWorkerConfig(config);
        this.runUrl = resolveRunUrl(config, this.worker);
    }
    async getCapabilities() {
        return this.config.capabilities ?? [];
    }
    async healthCheck() {
        const configured = Boolean(this.config.apiKey);
        const workerMetadata = readRecord(this.worker, "worker") ?? {};
        const enabled = resolveBoolean(this.worker.enabled) ?? resolveBoolean(workerMetadata.enabled);
        return {
            agentId: this.config.agent.id,
            status: configured && enabled !== false ? "healthy" : "unreachable",
            lastCheckedAt: new Date().toISOString(),
            details: {
                source: "mswarm_worker",
                workerId: resolveString(this.worker.workerId),
                remoteSlug: resolveString(this.worker.remoteSlug),
                reason: !configured
                    ? "missing_api_key"
                    : enabled === false
                        ? "worker_disabled"
                        : "catalog_metadata_only",
            },
        };
    }
    async invoke(request) {
        if (!this.config.apiKey) {
            throw new Error("AUTH_REQUIRED: Managed mswarm worker is missing the synced API key; run `mcoda config set mswarm-api-key <KEY>` and `mcoda workers sync`.");
        }
        const started = Date.now();
        const response = await fetch(this.runUrl, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                accept: "application/json",
                "x-api-key": this.config.apiKey,
                ...(resolveIdempotencyKey(request.metadata)
                    ? { "idempotency-key": resolveIdempotencyKey(request.metadata) }
                    : {}),
            },
            body: JSON.stringify({
                text: request.input,
                input: request.input,
                metadata: request.metadata ?? {},
            }),
        });
        const responseText = await response.text();
        let payload = {};
        if (responseText.trim()) {
            try {
                const parsed = JSON.parse(responseText);
                payload = isRecord(parsed) ? parsed : { output: responseText };
            }
            catch {
                payload = { output: responseText };
            }
        }
        if (!response.ok) {
            throw new Error(`mswarm_worker request failed (${response.status}): ${responseText.slice(0, MAX_RESPONSE_DETAIL_CHARS) || response.statusText}`);
        }
        const result = isRecord(payload.result) ? payload.result : {};
        const responseSummary = buildResponseSummary(payload, result);
        return {
            output: parseWorkerOutput(payload),
            adapter: "mswarm-worker",
            model: resolveString(payload.model) ??
                resolveString(result.model) ??
                this.config.model,
            metadata: {
                mswarmWorker: {
                    runUrl: this.runUrl,
                    workerId: resolveString(this.worker.workerId),
                    remoteSlug: resolveString(this.worker.remoteSlug),
                    durationMs: Date.now() - started,
                    responseSummary,
                },
            },
        };
    }
}
