import { promises as fs } from "node:fs";
import { CryptoHelper, Agent, AgentAuthMetadata, AgentHealth, AgentPromptManifest } from "@mcoda/shared";
import { GlobalRepository } from "@mcoda/db";
import { CodexAdapter } from "../adapters/codex/CodexAdapter.js";
import { GeminiAdapter } from "../adapters/gemini/GeminiAdapter.js";
import { LocalAdapter } from "../adapters/local/LocalAdapter.js";
import { OllamaRemoteAdapter } from "../adapters/ollama/OllamaRemoteAdapter.js";
import { OllamaCliAdapter } from "../adapters/ollama/OllamaCliAdapter.js";
import { OpenAiAdapter } from "../adapters/openai/OpenAiAdapter.js";
import { OpenAiCliAdapter } from "../adapters/openai/OpenAiCliAdapter.js";
import { ZhipuApiAdapter } from "../adapters/zhipu/ZhipuApiAdapter.js";
import { QaAdapter } from "../adapters/qa/QaAdapter.js";
import { AgentAdapter, InvocationRequest, InvocationResult } from "../adapters/AdapterTypes.js";

const CLI_BASED_ADAPTERS = new Set(["codex-cli", "gemini-cli", "openai-cli", "ollama-cli"]);
const LOCAL_ADAPTERS = new Set(["local-model"]);
const SUPPORTED_ADAPTERS = new Set([
  "openai-api",
  "codex-cli",
  "gemini-cli",
  "openai-cli",
  "zhipu-api",
  "local-model",
  "qa-cli",
  "ollama-remote",
  "ollama-cli",
]);

const DEFAULT_JOB_PROMPT =
  "You are an mcoda agent that follows workspace runbooks and responds with actionable, concise output.";
const DEFAULT_CHARACTER_PROMPT =
  "Write clearly, avoid hallucinations, cite assumptions, and prioritize risk mitigation for the user.";
const HANDOFF_ENV_INLINE = "MCODA_GATEWAY_HANDOFF";
const HANDOFF_ENV_PATH = "MCODA_GATEWAY_HANDOFF_PATH";
const HANDOFF_HEADER = "[Gateway handoff]";
const MAX_HANDOFF_CHARS = 8000;
const IO_ENV = "MCODA_STREAM_IO";
const IO_PROMPT_ENV = "MCODA_STREAM_IO_PROMPT";
const IO_PREFIX = "[agent-io]";

const isIoEnabled = (): boolean => {
  const raw = process.env[IO_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};

const isIoPromptEnabled = (): boolean => {
  const raw = process.env[IO_PROMPT_ENV];
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};

const emitIoLine = (line: string): void => {
  const normalized = line.endsWith("\n") ? line : `${line}\n`;
  process.stderr.write(normalized);
};

const renderIoHeader = (agent: Agent, request: InvocationRequest, mode: "invoke" | "stream"): void => {
  emitIoLine(`${IO_PREFIX} begin agent=${agent.slug ?? agent.id} adapter=${agent.adapter} model=${agent.defaultModel ?? "default"} mode=${mode}`);
  const command = request.metadata?.command ? ` command=${String(request.metadata.command)}` : "";
  if (command) emitIoLine(`${IO_PREFIX} meta${command}`);
  if (isIoPromptEnabled()) {
    emitIoLine(`${IO_PREFIX} input`);
    emitIoLine(request.input ?? "");
  }
};

const renderIoChunk = (chunk: InvocationResult): void => {
  if (chunk.output) {
    emitIoLine(`${IO_PREFIX} output ${chunk.output}`);
  }
};

const renderIoEnd = (): void => {
  emitIoLine(`${IO_PREFIX} end`);
};

const readGatewayHandoff = async (): Promise<string | undefined> => {
  const inline = process.env[HANDOFF_ENV_INLINE];
  if (inline && inline.trim()) {
    return inline.trim().slice(0, MAX_HANDOFF_CHARS);
  }
  const filePath = process.env[HANDOFF_ENV_PATH];
  if (!filePath) return undefined;
  try {
    const content = await fs.readFile(filePath, "utf8");
    const trimmed = content.trim();
    if (!trimmed) return undefined;
    return trimmed.slice(0, MAX_HANDOFF_CHARS);
  } catch {
    return undefined;
  }
};

export class AgentService {
  constructor(private repo: GlobalRepository) {}

  static async create(): Promise<AgentService> {
    const repo = await GlobalRepository.create();
    return new AgentService(repo);
  }

  async close(): Promise<void> {
    await this.repo.close();
  }

  async resolveAgent(identifier: string): Promise<Agent> {
    const byId = await this.repo.getAgentById(identifier);
    if (byId) return byId;
    const bySlug = await this.repo.getAgentBySlug(identifier);
    if (!bySlug) {
      throw new Error(`Agent ${identifier} not found`);
    }
    return bySlug;
  }

  async getPrompts(agentId: string): Promise<AgentPromptManifest | undefined> {
    return this.repo.getAgentPrompts(agentId);
  }

  async getCapabilities(agentId: string): Promise<string[]> {
    return this.repo.getAgentCapabilities(agentId);
  }

  async getAuthMetadata(agentId: string): Promise<AgentAuthMetadata> {
    return this.repo.getAgentAuthMetadata(agentId);
  }

  private async getDecryptedSecret(agentId: string): Promise<string | undefined> {
    const secret = await this.repo.getAgentAuthSecret(agentId);
    if (!secret?.encryptedSecret) return undefined;
    return CryptoHelper.decryptSecret(secret.encryptedSecret);
  }

  private async buildAdapterConfig(agent: Agent) {
    const [capabilities, prompts, authMetadata] = await Promise.all([
      this.getCapabilities(agent.id),
      this.getPrompts(agent.id),
      this.getAuthMetadata(agent.id),
    ]);
    const secret = await this.getDecryptedSecret(agent.id);
    const adapterConfig = (agent.config ?? {}) as Record<string, unknown>;

    const mergedPrompts: AgentPromptManifest = {
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

  private resolveAdapterType(agent: Agent, apiKey?: string): string {
    const hasSecret = Boolean(apiKey);
    const config = agent.config as any;
    const cliAdapter = config?.cliAdapter as string | undefined;
    const localAdapter = config?.localAdapter as string | undefined;
    let adapterType = agent.adapter;

    if (!SUPPORTED_ADAPTERS.has(adapterType)) {
      throw new Error(`Unsupported adapter type: ${adapterType}`);
    }

    if (adapterType.endsWith("-api")) {
      if (hasSecret) return adapterType;
      if (adapterType === "codex-api" || adapterType === "openai-api") {
        // Default to the codex CLI when API creds are missing.
        adapterType = "codex-cli";
      } else if (adapterType === "gemini-api") {
        adapterType = "gemini-cli";
      } else if (cliAdapter && CLI_BASED_ADAPTERS.has(cliAdapter)) {
        adapterType = cliAdapter;
      } else if (localAdapter) {
        throw new Error(
          `AUTH_REQUIRED: API credentials missing for adapter ${adapterType}; configure cliAdapter (${localAdapter}) or provide credentials.`,
        );
      } else {
        throw new Error(`AUTH_REQUIRED: API credentials missing for adapter ${adapterType}`);
      }
    }
    return adapterType;
  }

  async getAdapter(agent: Agent): Promise<AgentAdapter> {
    const config = await this.buildAdapterConfig(agent);
    const adapterType = this.resolveAdapterType(agent, config.apiKey);
    const configWithAdapter = { ...config, adapter: adapterType };

    if (adapterType === "openai-api") {
      return new OpenAiAdapter(configWithAdapter);
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
    if (adapterType === "local-model" || LOCAL_ADAPTERS.has(adapterType)) {
      return new LocalAdapter(configWithAdapter);
    }
    if (adapterType === "ollama-remote") {
      return new OllamaRemoteAdapter(configWithAdapter);
    }
    if (adapterType === "ollama-cli") {
      return new OllamaCliAdapter(configWithAdapter);
    }
    if (adapterType === "gemini-cli") {
      return new GeminiAdapter(configWithAdapter);
    }
    if (adapterType === "qa-cli") {
      return new QaAdapter(configWithAdapter);
    }
    throw new Error(`Unsupported adapter type: ${adapterType}`);
  }

  async healthCheck(agentId: string): Promise<AgentHealth> {
    const agent = await this.resolveAgent(agentId);
    try {
      const adapter = await this.getAdapter(agent);
      const result = await adapter.healthCheck();
      await this.repo.setAgentHealth(result);
      return result;
    } catch (error) {
      const failure: AgentHealth = {
        agentId: agent.id,
        status: "unreachable",
        lastCheckedAt: new Date().toISOString(),
        details: { error: (error as Error).message },
      };
      await this.repo.setAgentHealth(failure);
      return failure;
    }
  }

  async invoke(agentId: string, request: InvocationRequest): Promise<InvocationResult> {
    const agent = await this.resolveAgent(agentId);
    const adapter = await this.getAdapter(agent);
    if (!adapter.invoke) {
      throw new Error("Adapter does not support invoke");
    }
    const enriched = await this.applyGatewayHandoff(request);
    const ioEnabled = isIoEnabled();
    if (ioEnabled) {
      renderIoHeader(agent, enriched, "invoke");
    }
    const result = await adapter.invoke(enriched);
    if (ioEnabled) {
      renderIoChunk(result);
      renderIoEnd();
    }
    return result;
  }

  async invokeStream(agentId: string, request: InvocationRequest): Promise<AsyncGenerator<InvocationResult>> {
    const agent = await this.resolveAgent(agentId);
    const adapter = await this.getAdapter(agent);
    if (!adapter.invokeStream) {
      throw new Error("Adapter does not support streaming");
    }
    const enriched = await this.applyGatewayHandoff(request);
    const ioEnabled = isIoEnabled();
    const generator = await adapter.invokeStream(enriched);
    async function* wrap(): AsyncGenerator<InvocationResult, void, unknown> {
      if (ioEnabled) {
        renderIoHeader(agent, enriched, "stream");
      }
      for await (const chunk of generator) {
        if (ioEnabled) {
          renderIoChunk(chunk);
        }
        yield chunk;
      }
      if (ioEnabled) {
        renderIoEnd();
      }
    }
    return wrap();
  }

  private async applyGatewayHandoff(request: InvocationRequest): Promise<InvocationRequest> {
    if ((request.metadata as any)?.command === "gateway-agent") {
      return request;
    }
    const handoff = await readGatewayHandoff();
    if (!handoff) return request;
    const suffix = `\n\n${HANDOFF_HEADER}\n${handoff}`;
    return { ...request, input: `${request.input ?? ""}${suffix}` };
  }
}
