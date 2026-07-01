export type ProviderRole = "system" | "user" | "assistant" | "tool";

export type LocalRunnerKind =
  | "vllm"
  | "llama-cpp"
  | "llama-cpp-python"
  | "lm-studio"
  | "localai"
  | "sglang"
  | "tgi"
  | "custom";

export type LocalRunnerAuthMode = "none" | "bearer" | "dummy-bearer";

export type LocalRunnerResponseFormatStrategy =
  | "openai"
  | "json-object"
  | "json-schema"
  | "gbnf"
  | "prompt-only"
  | "none";

export interface LocalOpenAiCompatibleRunnerConfig {
  baseUrl?: string;
  endpoint?: string;
  apiBaseUrl?: string;
  runnerKind?: LocalRunnerKind;
  authMode?: LocalRunnerAuthMode;
  dummyBearerToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatStrategy?: LocalRunnerResponseFormatStrategy;
  healthPath?: string;
  modelsPath?: string;
  requireModelInRequest?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsGbnf?: boolean;
}

const LOCAL_OPENAI_COMPATIBLE_ADAPTERS = new Set([
  "openai-compatible-local",
  "vllm-local",
  "llama-cpp-local",
  "llamacpp-local"
]);

function isLocalOpenAiCompatibleAdapter(adapter: unknown): boolean {
  return typeof adapter === "string" && LOCAL_OPENAI_COMPATIBLE_ADAPTERS.has(adapter.trim().toLowerCase());
}

function normalizeCodaliProviderName(providerOrAdapter: unknown): string | undefined {
  const value = optionalText(providerOrAdapter);
  if (!value) return undefined;
  if (isLocalOpenAiCompatibleAdapter(value)) return "openai-compatible";
  if (["ollama-remote", "ollama-cli", "ollama", "local-model"].includes(value)) return "ollama-remote";
  if (value === "openai" || value === "openai-api" || value === "openai-compatible" || value === "openai-cli") {
    return "openai-compatible";
  }
  if (value === "codex-cli") return "codex-cli";
  return value;
}

export interface ProviderMessage {
  role: ProviderRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface CodaliRuntimeWorkspace {
  root: string;
  readOnly?: boolean;
}

export interface CodaliRuntimeProviderInput {
  name: "openai-compatible" | "ollama-remote" | "codex-cli" | string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  localRunner?: LocalOpenAiCompatibleRunnerConfig;
  runnerKind?: LocalRunnerKind;
  authMode?: LocalRunnerAuthMode;
  dummyBearerToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatStrategy?: LocalRunnerResponseFormatStrategy;
  healthPath?: string;
  modelsPath?: string;
  requireModelInRequest?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsGbnf?: boolean;
}

export interface CodaliRuntimeDocdexInput {
  enabled?: boolean;
  baseUrl?: string;
  repoRoot?: string;
  repoId?: string;
  dagSessionId?: string;
  apiKey?: string;
  credentialSource?: "attached_mswarm_api_key" | string;
  required?: boolean;
  allowedOperations?: string[];
  capabilities?: Record<string, boolean | undefined>;
  initialize?: boolean;
  allowWeb?: boolean;
  allowMemoryWrite?: boolean;
  allowProfileWrite?: boolean;
  allowIndexRebuild?: boolean;
  toolManifest?: Record<string, unknown>;
}

export interface CodaliRuntimeAgentInput {
  slug: string;
  adapter: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  localRunner?: LocalOpenAiCompatibleRunnerConfig;
  runnerKind?: LocalRunnerKind;
  authMode?: LocalRunnerAuthMode;
  dummyBearerToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatStrategy?: LocalRunnerResponseFormatStrategy;
  healthPath?: string;
  modelsPath?: string;
  requireModelInRequest?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsGbnf?: boolean;
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface CodaliRuntimePolicy {
  allowWrites: boolean;
  allowShell: boolean;
  allowDestructiveOperations: boolean;
  allowOutsideWorkspace: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  appToolContracts?: Record<string, unknown> | Array<Record<string, unknown>>;
  appVirtualTools?: string[];
  appToolGateway?: Record<string, unknown>;
  okacamToolContracts?: Record<string, unknown> | Array<Record<string, unknown>>;
  okacamVirtualTools?: string[];
  maxSteps: number;
  maxToolCalls: number;
  maxTokens?: number;
  timeoutMs: number;
  mode: "tool_loop" | "protocol_loop" | "smart_pipeline" | "patch_json" | "freeform";
}

export interface CodaliRuntimeSubagentsInput {
  enabled?: boolean;
  maxParallel?: number;
  maxSubagents?: number;
  defaultTimeoutMs?: number;
  allowWrites?: boolean;
  defaultTools?: string[];
}

export interface CodaliRuntimeSessionInput {
  id?: string;
  storageDir?: string;
  resume?: boolean;
  compactOnFinish?: boolean;
  loadInstructions?: boolean;
  includeLocalInstructions?: boolean;
  focusPaths?: string[];
}

export type CodaliRuntimeEvent =
  | { type: "status"; phase: string; message?: string; at: string }
  | { type: "token"; content: string; at: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; at: string }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      output: string;
      errorCode?: string;
      retryable?: boolean;
      at: string;
    }
  | { type: "usage"; usage: ProviderUsage; at: string }
  | { type: "subagent_start"; id: string; role: string; goal: string; at: string }
  | {
      type: "subagent_result";
      id: string;
      role: string;
      status: string;
      summary: string;
      at: string;
    }
  | { type: "final"; content: string; at: string }
  | { type: "error"; message: string; code?: string; retryable?: boolean; at: string };

export interface CodaliRuntimeInput {
  task: string;
  messages?: ProviderMessage[];
  workspace: CodaliRuntimeWorkspace;
  provider: CodaliRuntimeProviderInput;
  agent?: CodaliRuntimeAgentInput;
  docdex?: CodaliRuntimeDocdexInput;
  policy: CodaliRuntimePolicy;
  response?: {
    format?: "text" | "json" | "json_schema" | "gbnf";
    schema?: Record<string, unknown>;
    grammar?: string;
  };
  streaming?: {
    enabled: boolean;
    flushEveryMs?: number;
  };
  metadata?: {
    jobId?: string;
    requestId?: string;
    tenantId?: string;
    ownerUserId?: string;
    apiKeyId?: string;
    agentSlug?: string;
  };
  subagents?: CodaliRuntimeSubagentsInput;
  session?: CodaliRuntimeSessionInput;
  onEvent?: (event: CodaliRuntimeEvent) => void | Promise<void>;
  providerInstance?: unknown;
  toolRegistry?: unknown;
  tools?: unknown[];
  toolContext?: Record<string, unknown>;
  logger?: unknown;
}

export interface CodaliRuntimeResult {
  finalMessage: string;
  messages: ProviderMessage[];
  toolCallsExecuted: number;
  usage?: ProviderUsage;
  touchedFiles: string[];
  warnings: string[];
  events: CodaliRuntimeEvent[];
  runId: string;
  telemetry?: CodaliRuntimeTelemetry;
  session?: {
    id: string;
    summaryRefs: string[];
    instructionSources: string[];
  };
}

export interface CodaliRuntimeTelemetry {
  runId: string;
  runtime: "codali";
  mode: CodaliRuntimePolicy["mode"];
  toolCallCount: number;
  calledTools: string[];
  consideredTools: string[];
  registeredDynamicTools: string[];
  skippedDynamicTools: Array<{ name: string; reason: string }>;
  dynamicToolCalls: Array<{
    name: string;
    backingTool?: string;
    status: "success" | "failed" | "blocked";
    latencyMs: number;
    errorCode?: string;
    errorMessage?: string;
  }>;
  warnings: string[];
}

export interface CodaliJobStageDefinition {
  id: string;
  kind: string;
  role?: string;
  title?: string;
  goal?: string;
  prompt?: string;
  dependsOn?: string[];
  optional?: boolean;
  maxSteps?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  mode?: CodaliRuntimePolicy["mode"];
  agent?: CodaliRuntimeAgentInput;
  provider?: CodaliRuntimeProviderInput;
  response?: CodaliRuntimeInput["response"];
  outputSchema?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CodaliJobBudgets {
  maxRuntimeMs?: number;
  maxToolCalls?: number;
  maxFollowups?: number;
  maxParallelStages?: number;
}

export interface CodaliJobAgentPolicy {
  defaultAgent?: CodaliRuntimeAgentInput;
  defaultProvider?: CodaliRuntimeProviderInput;
  stageAgents?: Record<string, CodaliRuntimeAgentInput>;
  stageProviders?: Record<string, CodaliRuntimeProviderInput>;
  preferSmallLocal?: boolean;
  allowCloudFallback?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MswarmCodaliJob {
  id?: string;
  jobType: string;
  input?: unknown;
  context?: Record<string, unknown>;
  tenant?: Record<string, unknown>;
  requester?: Record<string, unknown>;
  toolManifest?: Record<string, unknown>;
  stages?: CodaliJobStageDefinition[];
  budgets?: CodaliJobBudgets;
  agentPolicy?: CodaliJobAgentPolicy;
  response?: {
    format?: "text" | "json" | "json_schema";
    schema?: Record<string, unknown>;
    requireEvidence?: boolean;
    metadata?: Record<string, unknown>;
  };
  metadata?: Record<string, unknown>;
}

export interface CodaliJobEvent {
  type: string;
  at?: string;
  runId?: string;
  jobId?: string;
  stageId?: string;
  kind?: string;
  status?: string;
  [key: string]: unknown;
}

export interface CodaliJobRuntimeInput {
  request: MswarmCodaliJob;
  runtime: Omit<CodaliRuntimeInput, "task" | "messages" | "metadata" | "onEvent"> & {
    messages?: ProviderMessage[];
    metadata?: CodaliRuntimeInput["metadata"];
    onEvent?: CodaliRuntimeInput["onEvent"];
  };
  onEvent?: (event: CodaliJobEvent) => void | Promise<void>;
}

export interface CodaliJobRuntimeError {
  stageId?: string;
  code: string;
  message: string;
  retryable?: boolean;
}

export interface CodaliJobStageResult {
  id: string;
  kind: string;
  status: "completed" | "failed" | "skipped";
  attempt: number;
  output: string;
  toolCallsExecuted: number;
  warnings: string[];
  durationMs: number;
  agentSlug?: string;
  model?: string;
  error?: CodaliJobRuntimeError;
}

export interface CodaliJobTelemetry {
  runId: string;
  runtime: "codali";
  mode: "job";
  jobId: string;
  jobType: string;
  status: "succeeded" | "failed" | "partial" | "needs_clarification";
  stageCount: number;
  toolCallCount: number;
  calledTools: string[];
  consideredTools: string[];
  warnings: string[];
  errors: CodaliJobRuntimeError[];
  stages: Array<{
    id: string;
    kind: string;
    status: string;
    attempt: number;
    durationMs: number;
    toolCallsExecuted: number;
    agentSlug?: string;
    model?: string;
    errorCode?: string;
  }>;
}

export interface CodaliJobRuntimeResult {
  output: string;
  status: CodaliJobTelemetry["status"];
  runId: string;
  jobId: string;
  jobType: string;
  stages: CodaliJobStageResult[];
  usage?: ProviderUsage;
  toolCallsExecuted: number;
  touchedFiles: string[];
  warnings: string[];
  errors: CodaliJobRuntimeError[];
  telemetry: CodaliJobTelemetry;
  messages?: ProviderMessage[];
  events?: CodaliJobEvent[];
}

interface CodaliModule {
  runCodaliTask(input: CodaliRuntimeInput): Promise<CodaliRuntimeResult>;
  runCodaliJob?(input: CodaliJobRuntimeInput): Promise<CodaliJobRuntimeResult>;
  codaliEventToOpenAIChatCompletionChunk(
    event: CodaliRuntimeEvent,
    options: { requestId: string; model: string },
  ): Record<string, unknown> | undefined;
}

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
  localRunner?: LocalOpenAiCompatibleRunnerConfig;
  runnerKind?: LocalRunnerKind;
  authMode?: LocalRunnerAuthMode;
  dummyBearerToken?: string;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  responseFormatStrategy?: LocalRunnerResponseFormatStrategy;
  healthPath?: string;
  modelsPath?: string;
  requireModelInRequest?: boolean;
  supportsStreaming?: boolean;
  supportsTools?: boolean;
  supportsJsonSchema?: boolean;
  supportsGbnf?: boolean;
  capabilities?: string[];
  contextWindow?: number;
  maxOutputTokens?: number;
}

export interface MswarmCodaliWorkspace {
  root: string;
  readOnly?: boolean;
}

export interface MswarmCodaliDocdex {
  enabled?: boolean;
  baseUrl?: string;
  repoRoot?: string;
  repoId?: string;
  dagSessionId?: string;
  credentialSource?: "attached_mswarm_api_key" | string;
  required?: boolean;
  allowedOperations?: string[];
  capabilities?: Record<string, boolean | undefined>;
  initialize?: boolean;
  allowWeb?: boolean;
  allowMemoryWrite?: boolean;
  allowProfileWrite?: boolean;
  allowIndexRebuild?: boolean;
  toolManifest?: Record<string, unknown>;
}

export interface MswarmCodaliPolicy {
  allowTools?: boolean;
  allowedTools?: string[];
  deniedTools?: string[];
  appToolContracts?: Record<string, unknown> | Array<Record<string, unknown>>;
  appVirtualTools?: string[];
  appToolGateway?: Record<string, unknown>;
  okacamToolContracts?: Record<string, unknown> | Array<Record<string, unknown>>;
  okacamVirtualTools?: string[];
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
  attachedMswarmApiKey?: string;
  temperature?: number;
  responseFormat?: Record<string, unknown> | null;
  stream?: boolean;
  codaliJob?: MswarmCodaliJob;
  onOpenAIChunk?: (chunk: Record<string, unknown>) => void | Promise<void>;
  onRuntimeEvent?: (event: CodaliRuntimeEvent) => void | Promise<void>;
  onJobEvent?: (event: CodaliJobEvent) => void | Promise<void>;
  runCodali?: (input: CodaliRuntimeInput) => Promise<CodaliRuntimeResult>;
  runCodaliJob?: (input: CodaliJobRuntimeInput) => Promise<CodaliJobRuntimeResult>;
}

export interface MswarmCodaliInvocationResult {
  output: string;
  usage?: ProviderUsage;
  runtimeResult: CodaliRuntimeResult | CodaliJobRuntimeResult;
  jobResult?: CodaliJobRuntimeResult;
  openAIChunks: Record<string, unknown>[];
  metadata: {
    provider: string;
    adapter: string;
    local_model: string;
    agent_slug: string;
    runtime: "codali";
    run_id: string;
    tool_calls_executed: number;
    called_tools: string[];
    dynamic_tools_considered: string[];
    dynamic_tools_registered: string[];
    dynamic_tools_skipped: Array<{ name: string; reason: string }>;
    tool_call_details: CodaliRuntimeTelemetry["dynamicToolCalls"];
    telemetry?: CodaliRuntimeTelemetry | CodaliJobTelemetry;
    codali_job_id?: string;
    codali_job_type?: string;
    codali_job_status?: CodaliJobRuntimeResult["status"];
    codali_job_stage_count?: number;
    codali_job_stages?: CodaliJobTelemetry["stages"];
    codali_job_errors?: CodaliJobRuntimeError[];
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
const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;
let codaliModulePromise: Promise<CodaliModule> | undefined;

async function importCodaliModule(specifier: string): Promise<CodaliModule> {
  return (await dynamicImport(specifier)) as CodaliModule;
}

async function loadCodaliModule(): Promise<CodaliModule> {
  if (!codaliModulePromise) {
    codaliModulePromise = (async () => {
      if (process.env.MSWARM_CODALI_VENDOR_ONLY !== "1") {
        try {
          return await importCodaliModule("@mcoda/codali");
        } catch {
          // Fall through to the vendored copy included in the published mswarm tarball.
        }
      }
      const vendorUrl = new URL("./vendor/codali/index.js", import.meta.url).href;
      return importCodaliModule(vendorUrl);
    })();
  }
  return codaliModulePromise;
}

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
    return normalizeCodaliProviderName(agent.provider) || agent.provider;
  }
  return normalizeCodaliProviderName(agent.adapter) || agent.adapter;
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
    appToolContracts: policy?.appToolContracts,
    appVirtualTools: policy?.appVirtualTools,
    appToolGateway: policy?.appToolGateway,
    okacamToolContracts: policy?.okacamToolContracts,
    okacamVirtualTools: policy?.okacamVirtualTools,
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
  attachedMswarmApiKey?: string,
): CodaliRuntimeInput["docdex"] {
  if (!docdex) {
    return {
      enabled: false,
      baseUrl: DEFAULT_DOCDEX_BASE_URL,
      repoRoot: workspace.root,
      dagSessionId: requestId,
    };
  }
  return {
    enabled: docdex.enabled,
    baseUrl: docdex?.baseUrl ?? DEFAULT_DOCDEX_BASE_URL,
    repoRoot: docdex?.repoRoot ?? workspace.root,
    repoId: docdex?.repoId,
    dagSessionId: docdex?.dagSessionId ?? requestId,
    apiKey: docdex?.credentialSource === "attached_mswarm_api_key"
      ? attachedMswarmApiKey
      : undefined,
    credentialSource: docdex?.credentialSource,
    required: docdex?.required,
    allowedOperations: docdex?.allowedOperations,
    capabilities: docdex?.capabilities,
    initialize: docdex?.initialize,
    allowWeb: docdex?.allowWeb ?? false,
    allowMemoryWrite: docdex?.allowMemoryWrite ?? false,
    allowProfileWrite: docdex?.allowProfileWrite ?? false,
    allowIndexRebuild: docdex?.allowIndexRebuild ?? false,
    toolManifest: docdex?.toolManifest,
  };
}

function runtimeAgent(agent: MswarmCodaliAgent): CodaliRuntimeAgentInput {
  return {
    slug: agent.slug,
    adapter: agent.adapter,
    provider: providerNameForAgent(agent),
    model: agent.model,
    baseUrl: agent.baseUrl,
    localRunner: agent.localRunner,
    runnerKind: agent.runnerKind,
    authMode: agent.authMode,
    dummyBearerToken: agent.dummyBearerToken,
    headers: agent.headers,
    extraBody: agent.extraBody,
    responseFormatStrategy: agent.responseFormatStrategy,
    healthPath: agent.healthPath,
    modelsPath: agent.modelsPath,
    requireModelInRequest: agent.requireModelInRequest,
    supportsStreaming: agent.supportsStreaming,
    supportsTools: agent.supportsTools,
    supportsJsonSchema: agent.supportsJsonSchema,
    supportsGbnf: agent.supportsGbnf,
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
    const codali = await loadCodaliModule();
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
    const handleRuntimeEvent = async (event: CodaliRuntimeEvent) => {
      await input.onRuntimeEvent?.(event);
      if (input.stream) {
        const chunk = codali.codaliEventToOpenAIChatCompletionChunk(
          event,
          openAIChunkOptions(input),
        );
        if (chunk) {
          await emitChunk(chunk);
        }
      }
    };
    const runtimeInput: CodaliRuntimeInput = {
      task: messagesToTask(input.messages),
      messages: toProviderMessages(input.messages),
      workspace,
      provider: {
        name: providerName,
        model: input.agent.model,
        baseUrl: input.agent.baseUrl,
        apiKey: input.agent.apiKey,
        timeoutMs: runtimePolicy.timeoutMs,
        localRunner: input.agent.localRunner,
        runnerKind: input.agent.runnerKind,
        authMode: input.agent.authMode,
        dummyBearerToken: input.agent.dummyBearerToken,
        headers: input.agent.headers,
        extraBody: input.agent.extraBody,
        responseFormatStrategy: input.agent.responseFormatStrategy,
        healthPath: input.agent.healthPath,
        modelsPath: input.agent.modelsPath,
        requireModelInRequest: input.agent.requireModelInRequest,
        supportsStreaming: input.agent.supportsStreaming,
        supportsTools: input.agent.supportsTools,
        supportsJsonSchema: input.agent.supportsJsonSchema,
        supportsGbnf: input.agent.supportsGbnf,
      },
      agent: runtimeAgent(input.agent),
      docdex: buildRuntimeDocdex(
        workspace,
        input.docdex,
        input.requestId,
        input.attachedMswarmApiKey,
      ),
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
      onEvent: handleRuntimeEvent,
    };

    let runtimeResult: CodaliRuntimeResult | undefined;
    let jobResult: CodaliJobRuntimeResult | undefined;
    if (input.codaliJob) {
      const runCodaliJob = input.runCodaliJob ?? codali.runCodaliJob;
      if (!runCodaliJob) {
        throw new Error("Codali module does not expose runCodaliJob for codali_job payloads");
      }
      jobResult = await runCodaliJob({
        request: {
          ...input.codaliJob,
          id: input.codaliJob.id ?? input.jobId,
          toolManifest: input.codaliJob.toolManifest ?? input.docdex?.toolManifest,
        },
        runtime: runtimeInput,
        onEvent: input.onJobEvent,
      });
    } else {
      const runCodali = input.runCodali ?? codali.runCodaliTask;
      runtimeResult = await runCodali(runtimeInput);
    }

    const invocationResult = jobResult ?? runtimeResult;
    if (!invocationResult) {
      throw new Error("Codali invocation produced no result");
    }
    const telemetry = invocationResult.telemetry;
    const runtimeTelemetry = runtimeResult?.telemetry;

    return {
      output: jobResult?.output ?? runtimeResult?.finalMessage ?? "",
      usage: invocationResult.usage,
      runtimeResult: invocationResult,
      jobResult,
      openAIChunks,
      metadata: {
        provider: providerName,
        adapter: input.agent.adapter,
        local_model: optionalText(input.agent.model) ?? input.model,
        agent_slug: input.agent.slug,
        runtime: "codali",
        run_id: invocationResult.runId,
        tool_calls_executed: invocationResult.toolCallsExecuted,
        called_tools: telemetry?.calledTools ?? [],
        dynamic_tools_considered: telemetry?.consideredTools ?? [],
        dynamic_tools_registered: runtimeTelemetry?.registeredDynamicTools ?? [],
        dynamic_tools_skipped: runtimeTelemetry?.skippedDynamicTools ?? [],
        tool_call_details: runtimeTelemetry?.dynamicToolCalls ?? [],
        telemetry,
        codali_job_id: jobResult?.jobId,
        codali_job_type: jobResult?.jobType,
        codali_job_status: jobResult?.status,
        codali_job_stage_count: jobResult?.stages.length,
        codali_job_stages: jobResult?.telemetry.stages,
        codali_job_errors: jobResult?.errors,
        touched_files: invocationResult.touchedFiles,
        warnings: invocationResult.warnings,
        mode: runtimePolicy.mode,
        session_id: runtimeResult?.session?.id,
      },
    };
  }
}
