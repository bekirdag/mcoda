import {
  codaliEventToOpenAIChatCompletionChunk,
  runCodaliTask,
  type CodaliRuntimeAgentInput,
  type CodaliRuntimeEvent,
  type CodaliRuntimeInput,
  type CodaliRuntimeResult,
  type CodaliRuntimeSessionInput,
  type CodaliRuntimeSubagentsInput,
  type ProviderMessage,
  type ProviderUsage,
} from "@mcoda/codali";

export interface MswarmCodaliChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

export interface MswarmCodaliAgent {
  slug: string;
  adapter: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  supportsTools?: boolean;
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface MswarmCodaliWorkspace {
  root: string;
  readOnly?: boolean;
}

export interface MswarmCodaliDocdex {
  baseUrl?: string;
  repoRoot?: string;
  repoId?: string;
  dagSessionId?: string;
  initialize?: boolean;
  allowWeb?: boolean;
  allowMemoryWrite?: boolean;
  allowProfileWrite?: boolean;
  allowIndexRebuild?: boolean;
}

export interface MswarmCodaliPolicy {
  allowTools?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  allowShell?: boolean;
  allowWrites?: boolean;
  allowDestructiveOperations?: boolean;
  allowOutsideWorkspace?: boolean;
  maxRuntimeMs?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
}

export interface MswarmCodaliSession extends CodaliRuntimeSessionInput {}

export interface MswarmCodaliSubagents extends CodaliRuntimeSubagentsInput {}

export interface MswarmCodaliInvocationInput {
  jobId: string;
  requestId: string;
  model: string;
  messages: MswarmCodaliChatMessage[];
  agent: MswarmCodaliAgent;
  workspace?: MswarmCodaliWorkspace;
  docdex?: MswarmCodaliDocdex;
  policy?: MswarmCodaliPolicy;
  session?: MswarmCodaliSession;
  subagents?: MswarmCodaliSubagents;
  temperature?: number;
  responseFormat?: Record<string, unknown> | null;
  stream?: boolean;
  onOpenAIChunk?: (chunk: Record<string, unknown>) => void | Promise<void>;
  onRuntimeEvent?: (event: CodaliRuntimeEvent) => void | Promise<void>;
  runCodali?: (input: CodaliRuntimeInput) => Promise<CodaliRuntimeResult>;
}

export interface MswarmCodaliInvocationResult {
  output: string;
  usage?: ProviderUsage;
  runtimeResult: CodaliRuntimeResult;
  openAIChunks: Record<string, unknown>[];
  metadata: {
    provider: string;
    adapter: string;
    local_model: string;
    agent_slug: string;
    run_id: string;
    tool_calls_executed: number;
    touched_files: string[];
    warnings: string[];
    mode: CodaliRuntimeInput["policy"]["mode"];
    session_id?: string;
  };
}

const DEFAULT_RUNTIME_MS = 3_600_000;
const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_TOOL_CALLS = 40;
const DEFAULT_DOCDEX_BASE_URL = "http://127.0.0.1:28491";

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function textFromMessageContent(content: MswarmCodaliChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function toProviderMessages(messages: MswarmCodaliChatMessage[]): ProviderMessage[] {
  return messages.map((message) => {
    const role =
      message.role === "system" ||
      message.role === "assistant" ||
      message.role === "tool" ||
      message.role === "user"
        ? message.role
        : "user";
    return {
      role,
      content: textFromMessageContent(message.content),
    };
  });
}

function messagesToTask(messages: MswarmCodaliChatMessage[]): string {
  return messages
    .map((message) => {
      const content = textFromMessageContent(message.content).trim();
      return content ? `${message.role || "user"}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function responseFormatToCodali(
  responseFormat: Record<string, unknown> | null | undefined,
): CodaliRuntimeInput["response"] | undefined {
  if (!responseFormat) return undefined;
  if (responseFormat.type === "json_object") {
    return { format: "json" };
  }
  if (responseFormat.type === "json_schema") {
    const jsonSchema =
      responseFormat.json_schema && typeof responseFormat.json_schema === "object"
        ? (responseFormat.json_schema as Record<string, unknown>)
        : undefined;
    const schema =
      jsonSchema?.schema && typeof jsonSchema.schema === "object"
        ? (jsonSchema.schema as Record<string, unknown>)
        : jsonSchema ?? responseFormat;
    return { format: "json_schema", schema };
  }
  if (responseFormat.type === "text") {
    return { format: "text" };
  }
  return undefined;
}

function providerNameForAgent(agent: MswarmCodaliAgent): string {
  if (agent.provider) {
    return agent.provider;
  }
  if (agent.adapter === "ollama-remote" || agent.adapter === "ollama") {
    return "ollama-remote";
  }
  if (
    agent.adapter === "openai" ||
    agent.adapter === "openai-compatible" ||
    agent.adapter === "openai-cli"
  ) {
    return "openai-compatible";
  }
  if (agent.adapter === "codex-cli") {
    return "codex-cli";
  }
  return agent.adapter;
}

function runtimeModeForAgent(
  agent: MswarmCodaliAgent,
  policy: MswarmCodaliPolicy | undefined,
): CodaliRuntimeInput["policy"]["mode"] {
  if (policy?.allowTools === false) {
    return "freeform";
  }
  if (agent.supportsTools === false) {
    return "protocol_loop";
  }
  return "tool_loop";
}

function buildRuntimePolicy(
  agent: MswarmCodaliAgent,
  policy: MswarmCodaliPolicy | undefined,
): CodaliRuntimeInput["policy"] {
  const allowTools = policy?.allowTools !== false;
  const mode = runtimeModeForAgent(agent, policy);
  const allowRuntimeTools = allowTools && (mode === "tool_loop" || mode === "protocol_loop");
  const maxOutputTokens =
    policy?.maxOutputTokens ?? agent.maxOutputTokens ?? undefined;
  return {
    allowWrites: policy?.allowWrites === true,
    allowShell: policy?.allowShell === true,
    allowDestructiveOperations: policy?.allowDestructiveOperations === true,
    allowOutsideWorkspace: policy?.allowOutsideWorkspace === true,
    allowedTools: allowTools ? policy?.allowedTools : [],
    deniedTools: policy?.deniedTools,
    maxSteps: allowRuntimeTools ? DEFAULT_MAX_STEPS : 2,
    maxToolCalls:
      allowRuntimeTools
        ? policy?.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS
        : 0,
    maxTokens: maxOutputTokens,
    timeoutMs: policy?.maxRuntimeMs ?? DEFAULT_RUNTIME_MS,
    mode,
  };
}

function buildRuntimeDocdex(
  workspace: MswarmCodaliWorkspace,
  docdex: MswarmCodaliDocdex | undefined,
  requestId: string,
): CodaliRuntimeInput["docdex"] {
  return {
    baseUrl: docdex?.baseUrl ?? DEFAULT_DOCDEX_BASE_URL,
    repoRoot: docdex?.repoRoot ?? workspace.root,
    repoId: docdex?.repoId,
    dagSessionId: docdex?.dagSessionId ?? requestId,
    initialize: docdex?.initialize,
    allowWeb: docdex?.allowWeb ?? false,
    allowMemoryWrite: docdex?.allowMemoryWrite ?? false,
    allowProfileWrite: docdex?.allowProfileWrite ?? false,
    allowIndexRebuild: docdex?.allowIndexRebuild ?? false,
  };
}

function runtimeAgent(agent: MswarmCodaliAgent): CodaliRuntimeAgentInput {
  return {
    slug: agent.slug,
    adapter: agent.adapter,
    provider: providerNameForAgent(agent),
    model: agent.model,
    baseUrl: agent.baseUrl,
    supportsTools: agent.supportsTools,
    capabilities: agent.capabilities,
    contextWindow: agent.contextWindow,
    maxOutputTokens: agent.maxOutputTokens,
  };
}

function openAIChunkOptions(input: MswarmCodaliInvocationInput): {
  requestId: string;
  model: string;
} {
  return { requestId: input.requestId, model: input.model };
}

export class MswarmCodaliExecutor {
  async invoke(input: MswarmCodaliInvocationInput): Promise<MswarmCodaliInvocationResult> {
    const workspace: MswarmCodaliWorkspace = input.workspace ?? {
      root: process.cwd(),
      readOnly: true,
    };
    const providerName = providerNameForAgent(input.agent);
    const runtimePolicy = buildRuntimePolicy(input.agent, input.policy);
    const openAIChunks: Record<string, unknown>[] = [];
    const emitChunk = async (chunk: Record<string, unknown>) => {
      openAIChunks.push(chunk);
      await input.onOpenAIChunk?.(chunk);
    };
    const runCodali = input.runCodali ?? runCodaliTask;
    const runtimeResult = await runCodali({
      task: messagesToTask(input.messages),
      messages: toProviderMessages(input.messages),
      workspace,
      provider: {
        name: providerName,
        model: input.agent.model,
        baseUrl: input.agent.baseUrl,
        apiKey: input.agent.apiKey,
        timeoutMs: runtimePolicy.timeoutMs,
      },
      agent: runtimeAgent(input.agent),
      docdex: buildRuntimeDocdex(workspace, input.docdex, input.requestId),
      policy: runtimePolicy,
      response: responseFormatToCodali(input.responseFormat),
      streaming: { enabled: input.stream === true, flushEveryMs: 250 },
      session: input.session,
      subagents: input.subagents,
      metadata: {
        jobId: input.jobId,
        requestId: input.requestId,
        agentSlug: input.agent.slug,
      },
      onEvent: async (event: CodaliRuntimeEvent) => {
        await input.onRuntimeEvent?.(event);
        if (input.stream) {
          const chunk = codaliEventToOpenAIChatCompletionChunk(event, openAIChunkOptions(input));
          if (chunk) {
            await emitChunk(chunk);
          }
        }
      },
    });

    return {
      output: runtimeResult.finalMessage,
      usage: runtimeResult.usage,
      runtimeResult,
      openAIChunks,
      metadata: {
        provider: providerName,
        adapter: input.agent.adapter,
        local_model: optionalText(input.agent.model) ?? input.model,
        agent_slug: input.agent.slug,
        run_id: runtimeResult.runId,
        tool_calls_executed: runtimeResult.toolCallsExecuted,
        touched_files: runtimeResult.touchedFiles,
        warnings: runtimeResult.warnings,
        mode: runtimePolicy.mode,
        session_id: runtimeResult.session?.id,
      },
    };
  }
}
