import { CryptoHelper } from "@mcoda/shared";
import { GlobalRepository } from "@mcoda/db";
import { CodexAdapter } from "../adapters/codex/CodexAdapter.js";
import { GeminiAdapter } from "../adapters/gemini/GeminiAdapter.js";
import { LocalAdapter } from "../adapters/local/LocalAdapter.js";
import { OpenAiAdapter } from "../adapters/openai/OpenAiAdapter.js";
import { QaAdapter } from "../adapters/qa/QaAdapter.js";
const CLI_BASED_ADAPTERS = new Set(["codex-cli", "gemini-cli"]);
const LOCAL_ADAPTERS = new Set(["local-model"]);
const DEFAULT_JOB_PROMPT = "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT = "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";
export class AgentService {
    constructor(repo) {
        this.repo = repo;
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
        const mergedPrompts = {
            agentId: agent.id,
            jobPrompt: prompts?.jobPrompt ?? DEFAULT_JOB_PROMPT,
            characterPrompt: prompts?.characterPrompt ?? DEFAULT_CHARACTER_PROMPT,
            commandPrompts: prompts?.commandPrompts,
            jobPath: prompts?.jobPath,
            characterPath: prompts?.characterPath,
        };
        return {
            agent,
            capabilities,
            model: agent.defaultModel,
            apiKey: secret,
            prompts: mergedPrompts,
            authMetadata,
        };
    }
    resolveAdapterType(agent, apiKey) {
        const hasSecret = Boolean(apiKey);
        const config = agent.config;
        const cliAdapter = config?.cliAdapter;
        const localAdapter = config?.localAdapter;
        let adapterType = agent.adapter;
        if (adapterType.endsWith("-api") && !hasSecret) {
            if (adapterType === "codex-api") {
                adapterType = "codex-cli";
            }
            else if (adapterType === "gemini-api") {
                adapterType = "gemini-cli";
            }
            else if (cliAdapter && CLI_BASED_ADAPTERS.has(cliAdapter)) {
                adapterType = cliAdapter;
            }
            else if (localAdapter) {
                adapterType = localAdapter;
            }
            else {
                throw new Error(`AUTH_REQUIRED: API credentials missing for adapter ${adapterType}`);
            }
        }
        return adapterType;
    }
    async getAdapter(agent) {
        const config = await this.buildAdapterConfig(agent);
        const adapterType = this.resolveAdapterType(agent, config.apiKey);
        const configWithAdapter = { ...config, adapter: adapterType };
        if (adapterType === "openai-api") {
            return new OpenAiAdapter(configWithAdapter);
        }
        if (adapterType === "codex-cli") {
            return new CodexAdapter(configWithAdapter);
        }
        if (adapterType === "gemini-cli") {
            return new GeminiAdapter(configWithAdapter);
        }
        if (adapterType === "local-model" || LOCAL_ADAPTERS.has(adapterType)) {
            return new LocalAdapter(configWithAdapter);
        }
        if (adapterType === "qa-cli") {
            return new QaAdapter(configWithAdapter);
        }
        throw new Error(`Unsupported adapter type: ${adapterType}`);
    }
    async healthCheck(agentId) {
        const agent = await this.resolveAgent(agentId);
        const adapter = await this.getAdapter(agent);
        const result = await adapter.healthCheck();
        await this.repo.setAgentHealth(result);
        return result;
    }
    async invoke(agentId, request) {
        const agent = await this.resolveAgent(agentId);
        const adapter = await this.getAdapter(agent);
        if (!adapter.invoke) {
            throw new Error("Adapter does not support invoke");
        }
        return adapter.invoke(request);
    }
    async invokeStream(agentId, request) {
        const agent = await this.resolveAgent(agentId);
        const adapter = await this.getAdapter(agent);
        if (!adapter.invokeStream) {
            throw new Error("Adapter does not support streaming");
        }
        return adapter.invokeStream(request);
    }
}
