import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CryptoHelper, LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES, isLocalOpenAiCompatibleAdapter, } from "@mcoda/shared";
import { GlobalRepository } from "@mcoda/db";
import { CodexAdapter } from "../adapters/codex/CodexAdapter.js";
import { GeminiAdapter } from "../adapters/gemini/GeminiAdapter.js";
import { LocalAdapter } from "../adapters/local/LocalAdapter.js";
import { CodaliAdapter } from "../adapters/codali/CodaliAdapter.js";
import { OllamaRemoteAdapter } from "../adapters/ollama/OllamaRemoteAdapter.js";
import { OllamaCliAdapter } from "../adapters/ollama/OllamaCliAdapter.js";
import { OpenAiAdapter } from "../adapters/openai/OpenAiAdapter.js";
import { MswarmWorkerAdapter } from "../adapters/mswarm/MswarmWorkerAdapter.js";
import { OpenAiCliAdapter } from "../adapters/openai/OpenAiCliAdapter.js";
import { ZhipuApiAdapter } from "../adapters/zhipu/ZhipuApiAdapter.js";
import { QaAdapter } from "../adapters/qa/QaAdapter.js";
import { ClaudeAdapter } from "../adapters/claude/ClaudeAdapter.js";
import { parseInvocationFailure } from "./InvocationFailureParser.js";
const CLI_BASED_ADAPTERS = new Set(["codex-cli", "gemini-cli", "openai-cli", "ollama-cli", "codali-cli", "claude-cli"]);
const LOCAL_ADAPTERS = new Set(["local-model"]);
const LOCAL_OPENAI_COMPATIBLE_ADAPTERS = new Set(LOCAL_OPENAI_COMPATIBLE_ADAPTER_ALIASES);
const OFFLINE_CAPABLE_ADAPTERS = new Set([
    "local-model",
    "ollama-cli",
    "qa-cli",
    ...LOCAL_OPENAI_COMPATIBLE_ADAPTERS,
]);
const SUPPORTED_ADAPTERS = new Set([
    "openai-api",
    "codex-cli",
    "gemini-cli",
    "openai-cli",
    "claude-cli",
    "zhipu-api",
    "local-model",
    "qa-cli",
    "ollama-remote",
    "ollama-cli",
    "codali-cli",
    "mswarm-worker",
    ...LOCAL_OPENAI_COMPATIBLE_ADAPTERS,
]);
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT = "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";
const HANDOFF_ENV_INLINE = "MCODA_GATEWAY_HANDOFF";
const HANDOFF_ENV_PATH = "MCODA_GATEWAY_HANDOFF_PATH";
const HANDOFF_HEADER = "[Gateway handoff]";
const IO_ENV = "MCODA_STREAM_IO";
const IO_PROMPT_ENV = "MCODA_STREAM_IO_PROMPT";
const IO_PREFIX = "[agent-io]";
const DOCDEX_GUIDANCE_HEADER = "[Docdex guidance]";
const DOCDEX_GUIDANCE_PATH = path.join(os.homedir(), ".docdex", "agents.md");
let docdexGuidanceCache;
let docdexGuidanceLoaded = false;
const DOCDEX_JSON_ONLY_MARKERS = [/output json only/i, /return json only/i, /no prose, no analysis/i];
const HANDOFF_END_MARKERS = [/^\s*END OF FILE\s*$/i, /^\s*\*\*\* End of File\s*$/i];
const EQUIVALENCE_THRESHOLD = 1.5;
const MAX_SLEEP_CHUNK_MS = 60 * 60 * 1000;
const DEFAULT_CONNECTIVITY_POLL_INTERVAL_MS = 5000;
const INTERNET_CHECK_TIMEOUT_MS = 2500;
const INTERNET_CHECK_TARGETS = ["https://clients3.google.com/generate_204", "https://www.cloudflare.com/cdn-cgi/trace"];
const WINDOW_RESET_FALLBACK_MS = {
    rolling_5h: 5 * 60 * 60 * 1000,
    daily: 24 * 60 * 60 * 1000,
    weekly: 7 * 24 * 60 * 60 * 1000,
    other: 60 * 60 * 1000,
};
const getManagedMswarmKind = (agent) => {
    const config = agent.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return undefined;
    }
    const record = config;
    const cloud = record.mswarmCloud;
    if (cloud &&
        typeof cloud === "object" &&
        !Array.isArray(cloud) &&
        cloud.managed === true) {
        return "cloud";
    }
    const selfHosted = record.mswarmSelfHosted;
    if (selfHosted &&
        typeof selfHosted === "object" &&
        !Array.isArray(selfHosted) &&
        selfHosted.managed === true) {
        return "self-hosted";
    }
    const worker = record.mswarmWorker;
    if (worker &&
        typeof worker === "object" &&
        !Array.isArray(worker) &&
        worker.managed === true) {
        return "worker";
    }
    return undefined;
};
const isIoEnabled = () => {
    const raw = process.env[IO_ENV];
    if (!raw)
        return false;
    const normalized = raw.trim().toLowerCase();
    return !["0", "false", "off", "no"].includes(normalized);
};
const isIoPromptEnabled = () => {
    const raw = process.env[IO_PROMPT_ENV];
    if (!raw)
        return true;
    const normalized = raw.trim().toLowerCase();
    return !["0", "false", "off", "no"].includes(normalized);
};
let ioWriteQueue = Promise.resolve();
const emitIoLine = (line) => {
    const normalized = line.endsWith("\n") ? line : `${line}\n`;
    ioWriteQueue = ioWriteQueue
        .then(() => new Promise((resolve) => {
        try {
            process.stderr.write(normalized, () => resolve());
        }
        catch {
            resolve();
        }
    }))
        .catch(() => { });
};
const renderIoHeader = (agent, request, mode) => {
    emitIoLine(`${IO_PREFIX} begin agent=${agent.slug ?? agent.id} adapter=${agent.adapter} model=${agent.defaultModel ?? "default"} mode=${mode}`);
    const command = request.metadata?.command ? ` command=${String(request.metadata.command)}` : "";
    if (command)
        emitIoLine(`${IO_PREFIX} meta${command}`);
    if (isIoPromptEnabled()) {
        emitIoLine(`${IO_PREFIX} input`);
        emitIoLine(request.input ?? "");
    }
};
const renderIoChunk = (chunk) => {
    if (chunk.output) {
        emitIoLine(`${IO_PREFIX} output ${chunk.output}`);
    }
};
const createStreamIoRenderer = () => {
    let buffer = "";
    const flushLine = (line) => {
        const cleaned = line.endsWith("\r") ? line.slice(0, -1) : line;
        emitIoLine(`${IO_PREFIX} output ${cleaned}`);
    };
    return {
        push: (chunk) => {
            if (!chunk.output)
                return;
            buffer += chunk.output;
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
                const line = buffer.slice(0, newlineIndex);
                flushLine(line);
                buffer = buffer.slice(newlineIndex + 1);
                newlineIndex = buffer.indexOf("\n");
            }
        },
        flush: () => {
            if (!buffer)
                return;
            flushLine(buffer);
            buffer = "";
        },
    };
};
const renderIoEnd = () => {
    emitIoLine(`${IO_PREFIX} end`);
};
const stripHandoffEndMarkers = (content) => {
    const lines = content.split(/\r?\n/);
    const filtered = lines.filter((line) => !HANDOFF_END_MARKERS.some((marker) => marker.test(line)));
    return filtered.join("\n").trim();
};
const readGatewayHandoff = async () => {
    const inline = process.env[HANDOFF_ENV_INLINE];
    if (inline && inline.trim()) {
        const normalized = stripHandoffEndMarkers(inline.trim());
        if (!normalized)
            return undefined;
        return normalized;
    }
    const filePath = process.env[HANDOFF_ENV_PATH];
    if (!filePath)
        return undefined;
    try {
        const content = await fs.readFile(filePath, "utf8");
        const normalized = stripHandoffEndMarkers(content.trim());
        if (!normalized)
            return undefined;
        return normalized;
    }
    catch {
        return undefined;
    }
};
const readDocdexGuidance = async () => {
    if (docdexGuidanceLoaded)
        return docdexGuidanceCache;
    docdexGuidanceLoaded = true;
    try {
        const content = await fs.readFile(DOCDEX_GUIDANCE_PATH, "utf8");
        const trimmed = content.trim();
        if (!trimmed)
            return undefined;
        docdexGuidanceCache = trimmed;
        return docdexGuidanceCache;
    }
    catch {
        return undefined;
    }
};
const stripJsonOnlyGuidance = (guidance) => {
    const lines = guidance.split(/\r?\n/);
    const filtered = lines.filter((line) => !DOCDEX_JSON_ONLY_MARKERS.some((marker) => marker.test(line)));
    return filtered.join("\n").trim();
};
const normalizeDocdexGuidanceInput = (input, prefix) => {
    const trimmed = input.trimStart();
    if (!trimmed.startsWith(DOCDEX_GUIDANCE_HEADER)) {
        return `${prefix}${input}`;
    }
    if (!trimmed.startsWith(prefix)) {
        return trimmed;
    }
    let remainder = trimmed.slice(prefix.length);
    while (remainder.startsWith(prefix)) {
        remainder = remainder.slice(prefix.length);
    }
    return `${prefix}${remainder}`;
};
export class AgentService {
    constructor(repo, options = {}) {
        this.repo = repo;
        this.options = options;
    }
    static async create() {
        const repo = await GlobalRepository.create();
        return new AgentService(repo);
    }
    async close() {
        await this.repo.close();
    }
    async resolveAgent(identifier) {
        const byId = await this.repo.getAgentById(identifier);
        if (byId)
            return byId;
        const bySlug = await this.repo.getAgentBySlug(identifier);
        if (!bySlug) {
            throw new Error(`Agent ${identifier} not found`);
        }
        return bySlug;
    }
    async getPrompts(agentId) {
        return this.repo.getAgentPrompts(agentId);
    }
    async getCapabilities(agentId) {
        return this.repo.getAgentCapabilities(agentId);
    }
    async getAuthMetadata(agentId) {
        return this.repo.getAgentAuthMetadata(agentId);
    }
    async getDecryptedSecret(agentId) {
        const secret = await this.repo.getAgentAuthSecret(agentId);
        if (!secret?.encryptedSecret)
            return undefined;
        return CryptoHelper.decryptSecret(secret.encryptedSecret);
    }
    async buildAdapterConfig(agent) {
        const [capabilities, prompts, authMetadata] = await Promise.all([
            this.getCapabilities(agent.id),
            this.getPrompts(agent.id),
            this.getAuthMetadata(agent.id),
        ]);
        const secret = await this.getDecryptedSecret(agent.id);
        const adapterConfig = (agent.config ?? {});
        const mergedPrompts = {
            agentId: agent.id,
            jobPrompt: prompts?.jobPrompt ?? DEFAULT_JOB_PROMPT,
            characterPrompt: prompts?.characterPrompt ?? DEFAULT_CHARACTER_PROMPT,
            commandPrompts: prompts?.commandPrompts,
            jobPath: prompts?.jobPath,
            characterPath: prompts?.characterPath,
        };
        return {
            ...adapterConfig,
            agent,
            capabilities,
            model: agent.defaultModel,
            apiKey: secret,
            prompts: mergedPrompts,
            authMetadata,
        };
    }
    resolveAdapterType(agent, apiKey, adapterOverride) {
        const hasSecret = Boolean(apiKey);
        const config = agent.config;
        const cliAdapter = config?.cliAdapter;
        const localAdapter = config?.localAdapter;
        let adapterType = adapterOverride?.trim() || agent.adapter;
        if (!SUPPORTED_ADAPTERS.has(adapterType)) {
            throw new Error(`Unsupported adapter type: ${adapterType}`);
        }
        if (adapterType.endsWith("-api")) {
            if (hasSecret)
                return adapterType;
            const managedMswarmKind = adapterType === "openai-api" || adapterType === "mswarm-worker"
                ? getManagedMswarmKind(agent)
                : undefined;
            if (managedMswarmKind) {
                const label = agent.slug ?? agent.id;
                const syncCommand = managedMswarmKind === "worker"
                    ? "mcoda workers sync"
                    : managedMswarmKind === "self-hosted"
                        ? "mcoda self-hosted agent sync"
                        : "mcoda cloud agent sync";
                throw new Error(`AUTH_REQUIRED: Managed mswarm ${managedMswarmKind} agent ${label} is missing the synced API key; run \`mcoda config set mswarm-api-key <KEY>\` and \`${syncCommand}\`.`);
            }
            if (adapterType === "codex-api" || adapterType === "openai-api") {
                // Default to the codex CLI when API creds are missing.
                adapterType = "codex-cli";
            }
            else if (adapterType === "gemini-api") {
                adapterType = "gemini-cli";
            }
            else if (cliAdapter && CLI_BASED_ADAPTERS.has(cliAdapter)) {
                adapterType = cliAdapter;
            }
            else if (localAdapter) {
                throw new Error(`AUTH_REQUIRED: API credentials missing for adapter ${adapterType}; configure cliAdapter (${localAdapter}) or provide credentials.`);
            }
            else {
                throw new Error(`AUTH_REQUIRED: API credentials missing for adapter ${adapterType}`);
            }
        }
        return adapterType;
    }
    async getAdapter(agent, adapterOverride) {
        const config = await this.buildAdapterConfig(agent);
        const adapterType = this.resolveAdapterType(agent, config.apiKey, adapterOverride);
        const configWithAdapter = { ...config, adapter: adapterType };
        if (adapterType === "openai-api" || isLocalOpenAiCompatibleAdapter(adapterType)) {
            return new OpenAiAdapter(configWithAdapter);
        }
        if (adapterType === "mswarm-worker") {
            return new MswarmWorkerAdapter(configWithAdapter);
        }
        if (adapterType === "zhipu-api") {
            return new ZhipuApiAdapter(configWithAdapter);
        }
        if (adapterType === "codex-cli") {
            return new CodexAdapter(configWithAdapter);
        }
        if (adapterType === "gemini-cli") {
            return new GeminiAdapter(configWithAdapter);
        }
        if (adapterType === "openai-cli") {
            return new OpenAiCliAdapter(configWithAdapter);
        }
        if (adapterType === "claude-cli") {
            return new ClaudeAdapter(configWithAdapter);
        }
        if (adapterType === "local-model" || LOCAL_ADAPTERS.has(adapterType)) {
            return new LocalAdapter(configWithAdapter);
        }
        if (adapterType === "ollama-remote") {
            return new OllamaRemoteAdapter(configWithAdapter);
        }
        if (adapterType === "ollama-cli") {
            return new OllamaCliAdapter(configWithAdapter);
        }
        if (adapterType === "codali-cli") {
            return new CodaliAdapter(configWithAdapter);
        }
        if (adapterType === "gemini-cli") {
            return new GeminiAdapter(configWithAdapter);
        }
        if (adapterType === "qa-cli") {
            return new QaAdapter(configWithAdapter);
        }
        throw new Error(`Unsupported adapter type: ${adapterType}`);
    }
    nowMs() {
        return this.options.now ? this.options.now() : Date.now();
    }
    async sleepMs(ms) {
        if (ms <= 0)
            return;
        if (this.options.sleep) {
            await this.options.sleep(ms);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
    }
    async sleepUntil(timestampMs) {
        while (true) {
            const remaining = timestampMs - this.nowMs();
            if (remaining <= 0)
                return;
            await this.sleepMs(Math.min(remaining, MAX_SLEEP_CHUNK_MS));
        }
    }
    getConnectivityPollIntervalMs() {
        const configured = this.options.connectivityPollIntervalMs;
        if (!Number.isFinite(configured))
            return DEFAULT_CONNECTIVITY_POLL_INTERVAL_MS;
        const normalized = Math.floor(Number(configured));
        return normalized > 0 ? normalized : DEFAULT_CONNECTIVITY_POLL_INTERVAL_MS;
    }
    async isInternetReachable() {
        if (this.options.checkInternetReachable) {
            try {
                return Boolean(await this.options.checkInternetReachable());
            }
            catch {
                return false;
            }
        }
        const globalFetch = globalThis.fetch;
        if (typeof globalFetch !== "function")
            return false;
        for (const target of INTERNET_CHECK_TARGETS) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), INTERNET_CHECK_TIMEOUT_MS);
            try {
                const response = await globalFetch(target, {
                    method: "HEAD",
                    cache: "no-store",
                    signal: controller.signal,
                });
                if (response.status >= 200 && response.status < 500) {
                    return true;
                }
            }
            catch {
                // keep probing next endpoint.
            }
            finally {
                clearTimeout(timeout);
            }
        }
        return false;
    }
    async waitForInternetRecovery() {
        const pollMs = this.getConnectivityPollIntervalMs();
        const startedAtMs = this.nowMs();
        for (;;) {
            const reachable = await this.isInternetReachable();
            if (reachable) {
                const recoveredAtMs = this.nowMs();
                return {
                    startedAtMs,
                    recoveredAtMs,
                    durationMs: Math.max(0, recoveredAtMs - startedAtMs),
                };
            }
            await this.sleepMs(pollMs);
        }
    }
    async isOfflineCapable(agent, adapterOverride) {
        const secret = await this.getDecryptedSecret(agent.id);
        const adapterType = this.resolveAdapterType(agent, secret, adapterOverride);
        return OFFLINE_CAPABLE_ADAPTERS.has(adapterType);
    }
    metric(value, fallback = 5) {
        return Number.isFinite(value) ? Number(value) : fallback;
    }
    estimateWindowResetMs(windowType, nowMs) {
        return nowMs + (WINDOW_RESET_FALLBACK_MS[windowType] ?? WINDOW_RESET_FALLBACK_MS.other);
    }
    estimateResetMsFromWindowTypes(windowTypes, nowMs) {
        const normalized = windowTypes.length ? windowTypes : ["other"];
        let earliest = Number.POSITIVE_INFINITY;
        for (const windowType of normalized) {
            earliest = Math.min(earliest, this.estimateWindowResetMs(windowType, nowMs));
        }
        return Number.isFinite(earliest) ? earliest : this.estimateWindowResetMs("other", nowMs);
    }
    normalizeLimitKey(agent) {
        const model = (agent.defaultModel ?? "").trim().toLowerCase();
        if (model.includes("codex-spark"))
            return "codex-spark";
        if (model.includes("codex"))
            return "codex-main";
        return model || (agent.slug ?? agent.id).trim().toLowerCase();
    }
    async getAgentAvailability(agent, nowMs) {
        const limits = await this.repo.listAgentUsageLimits(agent.id);
        if (!limits.length)
            return { available: true };
        const limitKey = this.normalizeLimitKey(agent);
        const relevant = limits.filter((entry) => {
            if (entry.limitScope === "model") {
                return entry.limitKey === limitKey;
            }
            return true;
        });
        if (!relevant.length)
            return { available: true };
        let earliestResetMs;
        for (const entry of relevant) {
            if (entry.status !== "exhausted")
                continue;
            let resetMs = entry.resetAt ? Date.parse(entry.resetAt) : Number.NaN;
            if (!Number.isFinite(resetMs)) {
                resetMs = this.estimateWindowResetMs(entry.windowType, nowMs);
            }
            if (resetMs > nowMs) {
                earliestResetMs = earliestResetMs === undefined ? resetMs : Math.min(earliestResetMs, resetMs);
            }
        }
        if (earliestResetMs !== undefined)
            return { available: false, earliestResetMs };
        return { available: true };
    }
    async listEquivalentAgents(baseAgent) {
        const baseCapabilities = await this.repo.getAgentCapabilities(baseAgent.id);
        const allAgents = await this.repo.listAgents();
        const healthRows = await this.repo.listAgentHealthSummary();
        const healthByAgentId = new Map(healthRows.map((entry) => [entry.agentId, entry]));
        const baseRating = this.metric(baseAgent.rating);
        const baseReasoning = this.metric(baseAgent.reasoningRating, baseRating);
        const baseComplexity = this.metric(baseAgent.maxComplexity);
        const candidates = [];
        for (const candidate of allAgents) {
            if (candidate.id === baseAgent.id)
                continue;
            const health = healthByAgentId.get(candidate.id);
            if (health?.status === "unreachable")
                continue;
            const candidateCapabilities = await this.repo.getAgentCapabilities(candidate.id);
            const hasAllCapabilities = baseCapabilities.every((capability) => candidateCapabilities.includes(capability));
            if (!hasAllCapabilities)
                continue;
            const candidateRating = this.metric(candidate.rating);
            const candidateReasoning = this.metric(candidate.reasoningRating, candidateRating);
            const candidateComplexity = this.metric(candidate.maxComplexity);
            const ratingDiff = Math.abs(candidateRating - baseRating);
            const reasoningDiff = Math.abs(candidateReasoning - baseReasoning);
            const complexityDiff = Math.abs(candidateComplexity - baseComplexity);
            if (ratingDiff > EQUIVALENCE_THRESHOLD)
                continue;
            if (reasoningDiff > EQUIVALENCE_THRESHOLD)
                continue;
            if (complexityDiff > EQUIVALENCE_THRESHOLD)
                continue;
            candidates.push({
                agent: candidate,
                distance: ratingDiff + reasoningDiff + complexityDiff,
            });
        }
        candidates.sort((left, right) => {
            if (left.distance !== right.distance)
                return left.distance - right.distance;
            const leftRating = this.metric(left.agent.rating);
            const rightRating = this.metric(right.agent.rating);
            if (rightRating !== leftRating)
                return rightRating - leftRating;
            const leftCost = Number.isFinite(left.agent.costPerMillion) ? Number(left.agent.costPerMillion) : Number.POSITIVE_INFINITY;
            const rightCost = Number.isFinite(right.agent.costPerMillion)
                ? Number(right.agent.costPerMillion)
                : Number.POSITIVE_INFINITY;
            if (leftCost !== rightCost)
                return leftCost - rightCost;
            return (left.agent.slug ?? left.agent.id).localeCompare(right.agent.slug ?? right.agent.id);
        });
        return candidates.map((entry) => entry.agent);
    }
    async findNextAvailableAgent(candidates, attemptedAgentIds, nowMs, options) {
        for (const candidate of candidates) {
            if (attemptedAgentIds.has(candidate.id))
                continue;
            if (options?.offlineCapableOnly) {
                const offlineCapable = await this.isOfflineCapable(candidate, options.adapterOverride);
                if (!offlineCapable)
                    continue;
            }
            const availability = await this.getAgentAvailability(candidate, nowMs);
            if (availability.available)
                return candidate;
        }
        return undefined;
    }
    async findEarliestResetMs(candidates, nowMs) {
        let earliest;
        for (const candidate of candidates) {
            const availability = await this.getAgentAvailability(candidate, nowMs);
            if (!availability.earliestResetMs)
                continue;
            earliest = earliest === undefined ? availability.earliestResetMs : Math.min(earliest, availability.earliestResetMs);
        }
        return earliest;
    }
    async persistUsageLimitObservation(agent, observation) {
        const observedAt = new Date(this.nowMs()).toISOString();
        const limitKey = this.normalizeLimitKey(agent);
        const windowTypes = observation.windowTypes.length
            ? observation.windowTypes
            : ["other"];
        const fallbackResetMs = this.estimateResetMsFromWindowTypes(windowTypes, this.nowMs());
        const resolvedResetAt = observation.resetAt ?? new Date(fallbackResetMs).toISOString();
        const resetAtSource = observation.resetAt
            ? observation.resetAtSource ?? "unknown"
            : "estimated_window_fallback";
        const records = windowTypes.map((windowType) => ({
            agentId: agent.id,
            limitScope: "model",
            limitKey,
            windowType,
            status: "exhausted",
            resetAt: resolvedResetAt,
            observedAt,
            source: "invoke_error_parse",
            details: {
                message: observation.message,
                rawText: observation.rawText.slice(0, 4000),
                resetAtSource,
                resetAtProvided: Boolean(observation.resetAt),
                estimatedResetAt: observation.resetAt ? undefined : resolvedResetAt,
            },
        }));
        return this.repo.upsertAgentUsageLimits(records);
    }
    async healthCheck(agentId) {
        const agent = await this.resolveAgent(agentId);
        try {
            const adapter = await this.getAdapter(agent);
            const result = await adapter.healthCheck();
            await this.repo.setAgentHealth(result);
            return result;
        }
        catch (error) {
            const failure = {
                agentId: agent.id,
                status: "unreachable",
                lastCheckedAt: new Date().toISOString(),
                details: { error: error.message },
            };
            await this.repo.setAgentHealth(failure);
            return failure;
        }
    }
    async invoke(agentId, request) {
        const baseAgent = await this.resolveAgent(agentId);
        const equivalentAgents = await this.listEquivalentAgents(baseAgent);
        const attemptedAgentIds = new Set();
        const failoverEvents = [];
        let activeAgent = baseAgent;
        for (;;) {
            attemptedAgentIds.add(activeAgent.id);
            const adapter = await this.getAdapter(activeAgent, request.adapterType);
            if (!adapter.invoke) {
                throw new Error("Adapter does not support invoke");
            }
            const withDocdex = await this.applyDocdexGuidance(request);
            const enriched = await this.applyGatewayHandoff(withDocdex);
            const ioEnabled = isIoEnabled();
            if (ioEnabled) {
                renderIoHeader(activeAgent, enriched, "invoke");
            }
            try {
                const result = await adapter.invoke(enriched);
                if (ioEnabled) {
                    renderIoChunk(result);
                    renderIoEnd();
                }
                if (!failoverEvents.length)
                    return result;
                return {
                    ...result,
                    metadata: {
                        ...(result.metadata ?? {}),
                        failoverEvents,
                    },
                };
            }
            catch (error) {
                await this.recordInvocationFailure(activeAgent, error);
                const nowMs = this.nowMs();
                const parsedFailure = parseInvocationFailure(error, nowMs);
                if (!parsedFailure) {
                    throw error;
                }
                const candidates = [baseAgent, ...equivalentAgents];
                if (parsedFailure.kind === "usage_limit") {
                    await this.persistUsageLimitObservation(activeAgent, parsedFailure.usageLimit);
                    const nextAgent = await this.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs);
                    if (nextAgent) {
                        failoverEvents.push({
                            type: "switch_agent",
                            at: new Date(nowMs).toISOString(),
                            fromAgentId: activeAgent.id,
                            fromAgentSlug: activeAgent.slug,
                            toAgentId: nextAgent.id,
                            toAgentSlug: nextAgent.slug,
                            reason: parsedFailure.kind,
                        });
                        activeAgent = nextAgent;
                        continue;
                    }
                    const earliestResetMs = await this.findEarliestResetMs(candidates, nowMs);
                    const fallbackResetMs = this.estimateResetMsFromWindowTypes(parsedFailure.usageLimit.windowTypes, nowMs);
                    const waitUntilMs = earliestResetMs && earliestResetMs > nowMs ? earliestResetMs : Math.max(fallbackResetMs, nowMs + 1000);
                    const durationMs = waitUntilMs - nowMs;
                    failoverEvents.push({
                        type: "sleep_until_reset",
                        at: new Date(nowMs).toISOString(),
                        until: new Date(waitUntilMs).toISOString(),
                        durationMs,
                    });
                    await this.sleepUntil(waitUntilMs);
                    attemptedAgentIds.clear();
                    activeAgent = baseAgent;
                    continue;
                }
                if (parsedFailure.kind === "connectivity_issue") {
                    const internetReachable = await this.isInternetReachable();
                    if (!internetReachable) {
                        const localFallback = await this.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs, {
                            offlineCapableOnly: true,
                            adapterOverride: request.adapterType,
                        });
                        if (localFallback) {
                            failoverEvents.push({
                                type: "switch_agent",
                                at: new Date(nowMs).toISOString(),
                                fromAgentId: activeAgent.id,
                                fromAgentSlug: activeAgent.slug,
                                toAgentId: localFallback.id,
                                toAgentSlug: localFallback.slug,
                                reason: parsedFailure.kind,
                            });
                            activeAgent = localFallback;
                            continue;
                        }
                        const recovery = await this.waitForInternetRecovery();
                        failoverEvents.push({
                            type: "wait_for_internet",
                            at: new Date(recovery.startedAtMs).toISOString(),
                            until: new Date(recovery.recoveredAtMs).toISOString(),
                            durationMs: recovery.durationMs,
                            pollIntervalMs: this.getConnectivityPollIntervalMs(),
                        });
                        attemptedAgentIds.clear();
                        activeAgent = baseAgent;
                        continue;
                    }
                }
                const nextAgent = await this.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs);
                if (!nextAgent) {
                    throw error;
                }
                failoverEvents.push({
                    type: "switch_agent",
                    at: new Date(nowMs).toISOString(),
                    fromAgentId: activeAgent.id,
                    fromAgentSlug: activeAgent.slug,
                    toAgentId: nextAgent.id,
                    toAgentSlug: nextAgent.slug,
                    reason: parsedFailure.kind,
                });
                activeAgent = nextAgent;
            }
        }
    }
    async invokeStream(agentId, request) {
        const baseAgent = await this.resolveAgent(agentId);
        const equivalentAgents = await this.listEquivalentAgents(baseAgent);
        const attemptedAgentIds = new Set();
        const self = this;
        async function* run() {
            let activeAgent = baseAgent;
            const failoverEvents = [];
            for (;;) {
                attemptedAgentIds.add(activeAgent.id);
                const adapter = await self.getAdapter(activeAgent, request.adapterType);
                if (!adapter.invokeStream) {
                    throw new Error("Adapter does not support streaming");
                }
                const withDocdex = await self.applyDocdexGuidance(request);
                const enriched = await self.applyGatewayHandoff(withDocdex);
                const ioEnabled = isIoEnabled();
                let generator;
                try {
                    generator = await adapter.invokeStream(enriched);
                }
                catch (error) {
                    await self.recordInvocationFailure(activeAgent, error);
                    const nowMs = self.nowMs();
                    const parsedFailure = parseInvocationFailure(error, nowMs);
                    if (!parsedFailure)
                        throw error;
                    const candidates = [baseAgent, ...equivalentAgents];
                    if (parsedFailure.kind === "usage_limit") {
                        await self.persistUsageLimitObservation(activeAgent, parsedFailure.usageLimit);
                        const nextAgent = await self.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs);
                        if (nextAgent) {
                            failoverEvents.push({
                                type: "switch_agent",
                                at: new Date(nowMs).toISOString(),
                                fromAgentId: activeAgent.id,
                                fromAgentSlug: activeAgent.slug,
                                toAgentId: nextAgent.id,
                                toAgentSlug: nextAgent.slug,
                                reason: parsedFailure.kind,
                            });
                            activeAgent = nextAgent;
                            continue;
                        }
                        const earliestResetMs = await self.findEarliestResetMs(candidates, nowMs);
                        const fallbackResetMs = self.estimateResetMsFromWindowTypes(parsedFailure.usageLimit.windowTypes, nowMs);
                        const waitUntilMs = earliestResetMs && earliestResetMs > nowMs ? earliestResetMs : Math.max(fallbackResetMs, nowMs + 1000);
                        const durationMs = waitUntilMs - nowMs;
                        failoverEvents.push({
                            type: "sleep_until_reset",
                            at: new Date(nowMs).toISOString(),
                            until: new Date(waitUntilMs).toISOString(),
                            durationMs,
                        });
                        await self.sleepUntil(waitUntilMs);
                        attemptedAgentIds.clear();
                        activeAgent = baseAgent;
                        continue;
                    }
                    if (parsedFailure.kind === "connectivity_issue") {
                        const internetReachable = await self.isInternetReachable();
                        if (!internetReachable) {
                            const localFallback = await self.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs, {
                                offlineCapableOnly: true,
                                adapterOverride: request.adapterType,
                            });
                            if (localFallback) {
                                failoverEvents.push({
                                    type: "switch_agent",
                                    at: new Date(nowMs).toISOString(),
                                    fromAgentId: activeAgent.id,
                                    fromAgentSlug: activeAgent.slug,
                                    toAgentId: localFallback.id,
                                    toAgentSlug: localFallback.slug,
                                    reason: parsedFailure.kind,
                                });
                                activeAgent = localFallback;
                                continue;
                            }
                            const recovery = await self.waitForInternetRecovery();
                            failoverEvents.push({
                                type: "wait_for_internet",
                                at: new Date(recovery.startedAtMs).toISOString(),
                                until: new Date(recovery.recoveredAtMs).toISOString(),
                                durationMs: recovery.durationMs,
                                pollIntervalMs: self.getConnectivityPollIntervalMs(),
                            });
                            attemptedAgentIds.clear();
                            activeAgent = baseAgent;
                            continue;
                        }
                    }
                    const nextAgent = await self.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs);
                    if (!nextAgent) {
                        throw error;
                    }
                    failoverEvents.push({
                        type: "switch_agent",
                        at: new Date(nowMs).toISOString(),
                        fromAgentId: activeAgent.id,
                        fromAgentSlug: activeAgent.slug,
                        toAgentId: nextAgent.id,
                        toAgentSlug: nextAgent.slug,
                        reason: parsedFailure.kind,
                    });
                    activeAgent = nextAgent;
                    continue;
                }
                const streamIo = ioEnabled ? createStreamIoRenderer() : undefined;
                if (ioEnabled) {
                    renderIoHeader(activeAgent, enriched, "stream");
                }
                let emitted = false;
                try {
                    for await (const chunk of generator) {
                        emitted = true;
                        const chunkWithMetadata = failoverEvents.length > 0
                            ? {
                                ...chunk,
                                metadata: {
                                    ...(chunk.metadata ?? {}),
                                    failoverEvents: failoverEvents.map((event) => ({ ...event })),
                                },
                            }
                            : chunk;
                        if (ioEnabled) {
                            streamIo?.push(chunkWithMetadata);
                        }
                        yield chunkWithMetadata;
                    }
                    if (ioEnabled) {
                        streamIo?.flush();
                        renderIoEnd();
                    }
                    return;
                }
                catch (error) {
                    await self.recordInvocationFailure(activeAgent, error);
                    const nowMs = self.nowMs();
                    const parsedFailure = parseInvocationFailure(error, nowMs);
                    if (!parsedFailure)
                        throw error;
                    const candidates = [baseAgent, ...equivalentAgents];
                    if (parsedFailure.kind === "usage_limit") {
                        if (emitted) {
                            failoverEvents.push({
                                type: "stream_restart_after_limit",
                                at: new Date(nowMs).toISOString(),
                                fromAgentId: activeAgent.id,
                                fromAgentSlug: activeAgent.slug,
                            });
                        }
                        await self.persistUsageLimitObservation(activeAgent, parsedFailure.usageLimit);
                        const nextAgent = await self.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs);
                        if (nextAgent) {
                            failoverEvents.push({
                                type: "switch_agent",
                                at: new Date(nowMs).toISOString(),
                                fromAgentId: activeAgent.id,
                                fromAgentSlug: activeAgent.slug,
                                toAgentId: nextAgent.id,
                                toAgentSlug: nextAgent.slug,
                                reason: parsedFailure.kind,
                            });
                            activeAgent = nextAgent;
                            continue;
                        }
                        const earliestResetMs = await self.findEarliestResetMs(candidates, nowMs);
                        const fallbackResetMs = self.estimateResetMsFromWindowTypes(parsedFailure.usageLimit.windowTypes, nowMs);
                        const waitUntilMs = earliestResetMs && earliestResetMs > nowMs ? earliestResetMs : Math.max(fallbackResetMs, nowMs + 1000);
                        const durationMs = waitUntilMs - nowMs;
                        failoverEvents.push({
                            type: "sleep_until_reset",
                            at: new Date(nowMs).toISOString(),
                            until: new Date(waitUntilMs).toISOString(),
                            durationMs,
                        });
                        await self.sleepUntil(waitUntilMs);
                        attemptedAgentIds.clear();
                        activeAgent = baseAgent;
                        continue;
                    }
                    if (emitted) {
                        failoverEvents.push({
                            type: "stream_restart_after_failure",
                            at: new Date(nowMs).toISOString(),
                            fromAgentId: activeAgent.id,
                            fromAgentSlug: activeAgent.slug,
                            reason: parsedFailure.kind,
                        });
                    }
                    if (parsedFailure.kind === "connectivity_issue") {
                        const internetReachable = await self.isInternetReachable();
                        if (!internetReachable) {
                            const localFallback = await self.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs, {
                                offlineCapableOnly: true,
                                adapterOverride: request.adapterType,
                            });
                            if (localFallback) {
                                failoverEvents.push({
                                    type: "switch_agent",
                                    at: new Date(nowMs).toISOString(),
                                    fromAgentId: activeAgent.id,
                                    fromAgentSlug: activeAgent.slug,
                                    toAgentId: localFallback.id,
                                    toAgentSlug: localFallback.slug,
                                    reason: parsedFailure.kind,
                                });
                                activeAgent = localFallback;
                                continue;
                            }
                            const recovery = await self.waitForInternetRecovery();
                            failoverEvents.push({
                                type: "wait_for_internet",
                                at: new Date(recovery.startedAtMs).toISOString(),
                                until: new Date(recovery.recoveredAtMs).toISOString(),
                                durationMs: recovery.durationMs,
                                pollIntervalMs: self.getConnectivityPollIntervalMs(),
                            });
                            attemptedAgentIds.clear();
                            activeAgent = baseAgent;
                            continue;
                        }
                    }
                    const nextAgent = await self.findNextAvailableAgent(candidates, attemptedAgentIds, nowMs);
                    if (!nextAgent) {
                        throw error;
                    }
                    failoverEvents.push({
                        type: "switch_agent",
                        at: new Date(nowMs).toISOString(),
                        fromAgentId: activeAgent.id,
                        fromAgentSlug: activeAgent.slug,
                        toAgentId: nextAgent.id,
                        toAgentSlug: nextAgent.slug,
                        reason: parsedFailure.kind,
                    });
                    activeAgent = nextAgent;
                }
            }
        }
        return run();
    }
    async applyGatewayHandoff(request) {
        if (request.metadata?.command === "gateway-agent") {
            return request;
        }
        const currentInput = request.input ?? "";
        if (currentInput.includes(HANDOFF_HEADER)) {
            return request;
        }
        if (request.metadata?.gatewayHandoffApplied) {
            return request;
        }
        const handoff = await readGatewayHandoff();
        if (!handoff)
            return request;
        const suffix = `\n\n${HANDOFF_HEADER}\n${handoff}`;
        const metadata = { ...(request.metadata ?? {}), gatewayHandoffApplied: true };
        return { ...request, input: `${currentInput}${suffix}`, metadata };
    }
    async recordInvocationFailure(agent, error) {
        const adapter = (agent.adapter ?? "").toLowerCase();
        if (adapter !== "ollama-remote")
            return;
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (!/MODEL_NOT_FOUND/i.test(message))
            return;
        const baseUrl = agent.config?.baseUrl;
        const health = {
            agentId: agent.id,
            status: "unreachable",
            lastCheckedAt: new Date().toISOString(),
            details: {
                reason: "model_missing",
                model: agent.defaultModel ?? null,
                baseUrl,
                error: message,
            },
        };
        try {
            await this.repo.setAgentHealth(health);
        }
        catch {
            // ignore health update failures
        }
    }
    async applyDocdexGuidance(request) {
        const guidance = await readDocdexGuidance();
        if (!guidance)
            return request;
        const command = request.metadata?.command ? String(request.metadata.command) : "";
        const cleaned = command === "gateway-agent" ? guidance : stripJsonOnlyGuidance(guidance);
        if (!cleaned)
            return request;
        const prefix = `${DOCDEX_GUIDANCE_HEADER}\n${cleaned}\n\n`;
        const currentInput = request.input ?? "";
        const nextInput = normalizeDocdexGuidanceInput(currentInput, prefix);
        if (nextInput === currentInput)
            return request;
        return { ...request, input: nextInput };
    }
}
