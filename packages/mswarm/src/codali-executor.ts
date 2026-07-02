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

export type CodaliGatewayMode = "fast" | "balanced" | "deep" | "cheap" | "image";

export type CodaliGatewayStatus =
  | "succeeded"
  | "failed"
  | "partial"
  | "needs_clarification";

export interface MswarmCodaliGatewayPolicy {
  [key: string]: unknown;
  allowedTools?: string[];
  deniedTools?: string[];
  appToolContracts?: Record<string, unknown> | Array<Record<string, unknown>>;
  appVirtualTools?: string[];
  appToolGateway?: Record<string, unknown>;
  okacamToolContracts?: Record<string, unknown> | Array<Record<string, unknown>>;
  okacamVirtualTools?: string[];
  maxIterations?: number;
  maxRuntimeMs?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
  maxEvidenceItems?: number;
  maxContextPackTokens?: number;
  allowWrites?: false;
  allowShell?: false;
  allowDestructiveOperations?: false;
  allowOutsideWorkspace?: false;
  requireFinalLargeModel?: boolean;
  allowDegradedFinalAnswer?: boolean;
  allowImageWorker?: boolean;
}

export interface MswarmCodaliGateway {
  id?: string;
  query: string;
  mode?: CodaliGatewayMode;
  product?: Record<string, unknown>;
  tenant?: Record<string, unknown>;
  requester?: Record<string, unknown>;
  conversation?: {
    id?: string;
    messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  };
  docdex?: CodaliRuntimeInput["docdex"];
  tools?: Record<string, unknown>;
  policy?: MswarmCodaliGatewayPolicy;
  agentPolicy?: Record<string, unknown>;
  response?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayTrace {
  runId: string;
  mode: CodaliGatewayMode;
  status: CodaliGatewayStatus;
  iterations: number;
  toolCallCount: number;
  modelCallCount: number;
  consideredTools: string[];
  calledTools: string[];
  warnings: string[];
  errors: string[];
  toolCalls: Array<Record<string, unknown>>;
  modelCalls: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayResult {
  runId: string;
  status: CodaliGatewayStatus;
  answer: string;
  sources: Array<Record<string, unknown>>;
  confidence: "high" | "medium" | "low";
  evidence: Array<Record<string, unknown>>;
  contextPack?: Record<string, unknown>;
  finalModel?: Record<string, unknown>;
  trace: CodaliGatewayTrace;
  telemetry: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CodaliGatewayProviderRequest {
  messages: ProviderMessage[];
  tools?: unknown[];
  toolChoice?: unknown;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: {
    type: "json" | "json_schema" | "text" | "gbnf";
    schema?: Record<string, unknown>;
    grammar?: string;
  };
  stream?: boolean;
  onToken?: (token: string) => void;
  onEvent?: (event: unknown) => void;
  streamFlushMs?: number;
}

export interface CodaliGatewayProvider {
  name: string;
  generate(request: CodaliGatewayProviderRequest): Promise<{
    message: ProviderMessage;
    toolCalls?: unknown[];
    usage?: ProviderUsage;
    raw?: unknown;
  }>;
}

export interface CodaliGatewayOptions {
  provider: CodaliGatewayProvider;
  taskRunner?: {
    run(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  agentInventory?: unknown[];
  workerOptions?: Record<string, unknown>;
  finalSynthesizerOptions?: Record<string, unknown>;
}

export interface CodaliGatewayEvent {
  type: string;
  at?: string;
  runId?: string;
  status?: CodaliGatewayStatus;
  mode?: CodaliGatewayMode;
  [key: string]: unknown;
}

interface CodaliModule {
  runCodaliTask(input: CodaliRuntimeInput): Promise<CodaliRuntimeResult>;
  runCodaliJob?(input: CodaliJobRuntimeInput): Promise<CodaliJobRuntimeResult>;
  runCodaliGateway?(
    request: MswarmCodaliGateway,
    options: CodaliGatewayOptions,
  ): Promise<CodaliGatewayResult>;
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
  codaliGateway?: MswarmCodaliGateway;
  codaliJob?: MswarmCodaliJob;
  onOpenAIChunk?: (chunk: Record<string, unknown>) => void | Promise<void>;
  onRuntimeEvent?: (event: CodaliRuntimeEvent) => void | Promise<void>;
  onJobEvent?: (event: CodaliJobEvent) => void | Promise<void>;
  onGatewayEvent?: (event: CodaliGatewayEvent) => void | Promise<void>;
  runCodali?: (input: CodaliRuntimeInput) => Promise<CodaliRuntimeResult>;
  runCodaliJob?: (input: CodaliJobRuntimeInput) => Promise<CodaliJobRuntimeResult>;
  runCodaliGateway?: (
    request: MswarmCodaliGateway,
    options: CodaliGatewayOptions,
  ) => Promise<CodaliGatewayResult>;
}

export interface MswarmCodaliInvocationResult {
  output: string;
  usage?: ProviderUsage;
  runtimeResult: CodaliRuntimeResult | CodaliJobRuntimeResult | CodaliGatewayResult;
  jobResult?: CodaliJobRuntimeResult;
  gatewayResult?: CodaliGatewayResult;
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
    telemetry?: CodaliRuntimeTelemetry | CodaliJobTelemetry | Record<string, unknown>;
    codali_job_id?: string;
    codali_job_type?: string;
    codali_job_status?: CodaliJobRuntimeResult["status"];
    codali_job_stage_count?: number;
    codali_job_stages?: CodaliJobTelemetry["stages"];
    codali_job_errors?: CodaliJobRuntimeError[];
    codali_gateway_id?: string;
    codali_gateway_status?: CodaliGatewayStatus;
    codali_gateway_mode?: CodaliGatewayMode;
    codali_gateway_task_count?: number;
    codali_gateway_tool_call_count?: number;
    codali_gateway_model_call_count?: number;
    codali_gateway_source_count?: number;
    codali_gateway_evidence_count?: number;
    codali_gateway_warnings?: string[];
    codali_gateway_errors?: string[];
    codali_gateway_trace?: CodaliGatewayTrace;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function optionalBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value
    .map((entry) => optionalText(entry))
    .filter((entry): entry is string => Boolean(entry));
  return output.length ? output : undefined;
}

function uniqueStrings(...groups: Array<string[] | undefined>): string[] | undefined {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const group of groups) {
    for (const value of group ?? []) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output.length ? output : undefined;
}

function policyAlias(
  policy: MswarmCodaliGatewayPolicy | undefined,
  camel: string,
  snake: string,
): unknown {
  if (!policy) return undefined;
  return policy[camel] ?? policy[snake];
}

function policyStringArray(
  policy: MswarmCodaliGatewayPolicy | undefined,
  camel: string,
  snake: string,
): string[] | undefined {
  return stringArray(policyAlias(policy, camel, snake));
}

function policyRecord(
  policy: MswarmCodaliGatewayPolicy | undefined,
  camel: string,
  snake: string,
): Record<string, unknown> | undefined {
  const value = policyAlias(policy, camel, snake);
  return isRecord(value) ? value : undefined;
}

function policyToolContracts(
  policy: MswarmCodaliGatewayPolicy | undefined,
  camel: string,
  snake: string,
): Record<string, unknown> | Array<Record<string, unknown>> | undefined {
  const value = policyAlias(policy, camel, snake);
  if (Array.isArray(value)) {
    const entries = value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
    return entries.length ? entries : undefined;
  }
  return isRecord(value) ? value : undefined;
}

function contractArrayFromObject(record: Record<string, unknown>): Array<Record<string, unknown>> {
  return Object.entries(record)
    .map(([name, contract]) =>
      isRecord(contract) ? { name, ...contract } : { name, value: contract },
    );
}

function mergeToolContracts(
  ...values: Array<Record<string, unknown> | Array<Record<string, unknown>> | undefined>
): Record<string, unknown> | Array<Record<string, unknown>> | undefined {
  const present = values.filter(
    (value): value is Record<string, unknown> | Array<Record<string, unknown>> =>
      Boolean(value),
  );
  if (present.length === 0) return undefined;
  if (present.every((value) => !Array.isArray(value))) {
    return Object.assign({}, ...present) as Record<string, unknown>;
  }
  const output: Array<Record<string, unknown>> = [];
  for (const value of present) {
    if (Array.isArray(value)) {
      output.push(...value);
    } else {
      output.push(...contractArrayFromObject(value));
    }
  }
  return output.length ? output : undefined;
}

function buildGatewayPolicy(
  gatewayPolicy: MswarmCodaliGatewayPolicy | undefined,
  runtimePolicy: CodaliRuntimePolicy,
): MswarmCodaliGatewayPolicy {
  const appToolContracts = mergeToolContracts(
    policyToolContracts(gatewayPolicy, "appToolContracts", "app_tool_contracts"),
    policyToolContracts(gatewayPolicy, "okacamToolContracts", "okacam_tool_contracts"),
    runtimePolicy.appToolContracts,
    runtimePolicy.okacamToolContracts,
  );
  const appVirtualTools = uniqueStrings(
    policyStringArray(gatewayPolicy, "appVirtualTools", "app_virtual_tools"),
    policyStringArray(gatewayPolicy, "okacamVirtualTools", "okacam_virtual_tools"),
    runtimePolicy.appVirtualTools,
    runtimePolicy.okacamVirtualTools,
  );
  const policy: MswarmCodaliGatewayPolicy = {
    ...(gatewayPolicy ?? {}),
    allowedTools:
      policyStringArray(gatewayPolicy, "allowedTools", "allowed_tools") ??
      runtimePolicy.allowedTools ??
      [],
    deniedTools:
      policyStringArray(gatewayPolicy, "deniedTools", "denied_tools") ??
      runtimePolicy.deniedTools,
    appToolContracts,
    appVirtualTools,
    appToolGateway:
      policyRecord(gatewayPolicy, "appToolGateway", "app_tool_gateway") ??
      runtimePolicy.appToolGateway,
    maxIterations: optionalNumber(
      policyAlias(gatewayPolicy, "maxIterations", "max_iterations"),
    ) ?? 3,
    maxRuntimeMs: optionalNumber(
      policyAlias(gatewayPolicy, "maxRuntimeMs", "max_runtime_ms"),
    ) ?? runtimePolicy.timeoutMs,
    maxToolCalls: optionalNumber(
      policyAlias(gatewayPolicy, "maxToolCalls", "max_tool_calls"),
    ) ?? runtimePolicy.maxToolCalls,
    maxModelCalls: optionalNumber(
      policyAlias(gatewayPolicy, "maxModelCalls", "max_model_calls"),
    ) ?? 10,
    maxEvidenceItems: optionalNumber(
      policyAlias(gatewayPolicy, "maxEvidenceItems", "max_evidence_items"),
    ) ?? 80,
    maxContextPackTokens: optionalNumber(
      policyAlias(gatewayPolicy, "maxContextPackTokens", "max_context_pack_tokens"),
    ) ?? 20_000,
    allowWrites: false,
    allowShell: false,
    allowDestructiveOperations: false,
    allowOutsideWorkspace: false,
    requireFinalLargeModel:
      optionalBoolean(
        policyAlias(gatewayPolicy, "requireFinalLargeModel", "require_final_large_model"),
      ) ?? true,
  };
  const allowDegradedFinalAnswer = optionalBoolean(
    policyAlias(gatewayPolicy, "allowDegradedFinalAnswer", "allow_degraded_final_answer"),
  );
  if (typeof allowDegradedFinalAnswer === "boolean") {
    policy.allowDegradedFinalAnswer = allowDegradedFinalAnswer;
  }
  const allowImageWorker = optionalBoolean(
    policyAlias(gatewayPolicy, "allowImageWorker", "allow_image_worker"),
  );
  if (typeof allowImageWorker === "boolean") {
    policy.allowImageWorker = allowImageWorker;
  }
  return policy;
}

function responseFormatToGateway(
  responseFormat: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const runtimeResponse = responseFormatToCodali(responseFormat);
  if (!runtimeResponse) return undefined;
  return {
    format: runtimeResponse.format === "json_schema"
      ? "json_schema"
      : runtimeResponse.format === "json"
        ? "json"
        : "text",
    ...(runtimeResponse.schema ? { schema: runtimeResponse.schema } : {}),
  };
}

function providerResponseFormatToCodali(
  responseFormat: CodaliGatewayProviderRequest["responseFormat"],
): CodaliRuntimeInput["response"] | undefined {
  if (!responseFormat) return undefined;
  if (responseFormat.type === "json") {
    return { format: "json" };
  }
  if (responseFormat.type === "json_schema") {
    return { format: "json_schema", schema: responseFormat.schema };
  }
  if (responseFormat.type === "gbnf") {
    return { format: "gbnf", grammar: responseFormat.grammar };
  }
  return { format: "text" };
}

function providerMessagesToTask(messages: ProviderMessage[]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === "string" ? message.content.trim() : "";
      return content ? `${message.role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function buildGatewayConversation(
  input: MswarmCodaliInvocationInput,
): MswarmCodaliGateway["conversation"] | undefined {
  if (!input.session?.id && input.messages.length === 0) return undefined;
  return {
    ...(input.session?.id ? { id: input.session.id } : {}),
    messages: toProviderMessages(input.messages)
      .filter((message) => message.role === "system" || message.role === "user" || message.role === "assistant")
      .map((message) => ({
        role: message.role as "system" | "user" | "assistant",
        content: message.content,
      })),
  };
}

function buildGatewayRequest(
  input: MswarmCodaliInvocationInput,
  runtimeInput: CodaliRuntimeInput,
): MswarmCodaliGateway {
  const gateway = input.codaliGateway;
  if (!gateway) {
    throw new Error("codaliGateway payload is required");
  }
  return {
    ...gateway,
    id: gateway.id ?? input.jobId,
    query: optionalText(gateway.query) ?? messagesToTask(input.messages),
    mode: gateway.mode ?? "balanced",
    conversation: gateway.conversation ?? buildGatewayConversation(input),
    docdex: gateway.docdex ?? runtimeInput.docdex,
    tools: gateway.tools ?? input.docdex?.toolManifest,
    policy: buildGatewayPolicy(gateway.policy, runtimeInput.policy),
    agentPolicy: gateway.agentPolicy ?? {
      resolver: "mcoda_inventory",
      roles: {
        final_synthesizer: {
          tier: "large",
          requiresTools: false,
        },
      },
    },
    response: gateway.response ?? responseFormatToGateway(input.responseFormat),
    metadata: {
      ...(gateway.metadata ?? {}),
      mswarm: {
        jobId: input.jobId,
        requestId: input.requestId,
        agentSlug: input.agent.slug,
      },
      ...(input.session?.id ? { sessionId: input.session.id } : {}),
    },
  };
}

function buildGatewayAgentInventory(agent: MswarmCodaliAgent): Record<string, unknown>[] {
  return [
    {
      slug: agent.slug,
      adapter: agent.adapter,
      provider: providerNameForAgent(agent),
      model: agent.model,
      baseUrl: agent.baseUrl,
      supportsTools: agent.supportsTools,
      supportsJsonSchema: agent.supportsJsonSchema,
      supportsStreaming: agent.supportsStreaming,
      contextWindow: agent.contextWindow,
      maxOutputTokens: agent.maxOutputTokens,
      capabilities: agent.capabilities,
      health_status: "healthy",
      source: "self_hosted",
    },
  ];
}

function createGatewayProvider(input: {
  providerName: string;
  runtimeInput: CodaliRuntimeInput;
  runCodali: (runtimeInput: CodaliRuntimeInput) => Promise<CodaliRuntimeResult>;
}): CodaliGatewayProvider {
  return {
    name: input.providerName,
    async generate(request) {
      const result = await input.runCodali({
        ...input.runtimeInput,
        task: providerMessagesToTask(request.messages),
        messages: request.messages,
        policy: {
          ...input.runtimeInput.policy,
          allowWrites: false,
          allowShell: false,
          allowDestructiveOperations: false,
          allowOutsideWorkspace: false,
          allowedTools: [],
          maxSteps: 2,
          maxToolCalls: 0,
          maxTokens: request.maxTokens ?? input.runtimeInput.policy.maxTokens,
          mode: "freeform",
        },
        response: providerResponseFormatToCodali(request.responseFormat),
        streaming: { enabled: false },
        onEvent: undefined,
      });
      return {
        message: { role: "assistant", content: result.finalMessage },
        usage: result.usage,
        raw: {
          runId: result.runId,
          warnings: result.warnings,
        },
      };
    },
  };
}

function runtimeToolCallsToGatewayToolCalls(
  telemetry: CodaliRuntimeTelemetry | undefined,
): Array<Record<string, unknown>> {
  const output = new Map<string, Record<string, unknown>>();
  for (const call of telemetry?.dynamicToolCalls ?? []) {
    output.set(call.name, {
      tool: call.name,
      status: call.status,
      latencyMs: call.latencyMs,
      errorCode: call.errorCode,
      errorMessage: call.errorMessage,
      metadata: {
        backingTool: call.backingTool,
      },
    });
  }
  for (const tool of telemetry?.calledTools ?? []) {
    if (!output.has(tool)) {
      output.set(tool, {
        tool,
        status: "success",
      });
    }
  }
  return [...output.values()];
}

function createGatewayTaskRunner(input: {
  runtimeInput: CodaliRuntimeInput;
  runCodali: (runtimeInput: CodaliRuntimeInput) => Promise<CodaliRuntimeResult>;
}): NonNullable<CodaliGatewayOptions["taskRunner"]> {
  return {
    async run(taskInput) {
      const prompt = optionalText(taskInput.prompt) ?? "";
      const allowedTools = stringArray(taskInput.allowedTools) ?? [];
      const remainingToolCalls = optionalNumber(taskInput.remainingToolCalls) ??
        input.runtimeInput.policy.maxToolCalls;
      const timeoutMs = optionalNumber(taskInput.timeoutMs) ?? input.runtimeInput.policy.timeoutMs;
      const result = await input.runCodali({
        ...input.runtimeInput,
        task: prompt,
        messages: [{ role: "user", content: prompt }],
        policy: {
          ...input.runtimeInput.policy,
          allowedTools,
          maxToolCalls: Math.max(0, remainingToolCalls),
          timeoutMs,
        },
        streaming: { enabled: false },
        onEvent: undefined,
      });
      return {
        status: "succeeded",
        output: result.finalMessage,
        toolCalls: runtimeToolCallsToGatewayToolCalls(result.telemetry),
        modelCalls: [
          {
            role: "worker",
            status: "success",
            agentSlug: input.runtimeInput.agent?.slug,
            model: input.runtimeInput.provider.model,
            provider: input.runtimeInput.provider.name,
            output: result.finalMessage,
            metadata: {
              runId: result.runId,
              usage: result.usage,
              warnings: result.warnings,
            },
          },
        ],
        metadata: {
          runtimeRunId: result.runId,
          toolCallsExecuted: result.toolCallsExecuted,
          warnings: result.warnings,
        },
      };
    },
  };
}

function openAITextChunk(input: MswarmCodaliInvocationInput, content: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      { index: 0, delta: { content }, finish_reason: null },
    ],
  };
}

function openAIStopChunk(input: MswarmCodaliInvocationInput): Record<string, unknown> {
  return {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      { index: 0, delta: {}, finish_reason: "stop" },
    ],
  };
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

    const runCodali = input.runCodali ?? codali.runCodaliTask;
    let runtimeResult: CodaliRuntimeResult | undefined;
    let jobResult: CodaliJobRuntimeResult | undefined;
    let gatewayResult: CodaliGatewayResult | undefined;
    if (input.codaliGateway) {
      const runCodaliGateway = input.runCodaliGateway ?? codali.runCodaliGateway;
      if (!runCodaliGateway) {
        throw new Error("Codali module does not expose runCodaliGateway for codali_gateway payloads");
      }
      const gatewayRequest = buildGatewayRequest(input, runtimeInput);
      await input.onGatewayEvent?.({
        type: "gateway_start",
        at: new Date().toISOString(),
        runId: gatewayRequest.id,
        mode: gatewayRequest.mode,
      });
      gatewayResult = await runCodaliGateway(gatewayRequest, {
        provider: createGatewayProvider({ providerName, runtimeInput, runCodali }),
        taskRunner: createGatewayTaskRunner({ runtimeInput, runCodali }),
        agentInventory: buildGatewayAgentInventory(input.agent),
        workerOptions: {
          maxRuntimeMs: gatewayRequest.policy?.maxRuntimeMs,
          maxToolCalls: gatewayRequest.policy?.maxToolCalls,
        },
        finalSynthesizerOptions: {
          maxTokens: input.policy?.maxOutputTokens ?? input.agent.maxOutputTokens,
        },
      });
      await input.onGatewayEvent?.({
        type: "gateway_result",
        at: new Date().toISOString(),
        runId: gatewayResult.runId,
        status: gatewayResult.status,
        mode: gatewayResult.trace.mode,
        tool_call_count: gatewayResult.trace.toolCallCount,
        model_call_count: gatewayResult.trace.modelCallCount,
        source_count: gatewayResult.sources.length,
        evidence_count: gatewayResult.evidence.length,
      });
      if (input.stream) {
        if (gatewayResult.answer) {
          await emitChunk(openAITextChunk(input, gatewayResult.answer));
        }
        await emitChunk(openAIStopChunk(input));
      }
    } else if (input.codaliJob) {
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
      runtimeResult = await runCodali(runtimeInput);
    }

    if (gatewayResult) {
      const gatewayTrace = gatewayResult.trace;
      const gatewayTaskCount = gatewayTrace.modelCalls.filter((call) => {
        const role = typeof call.role === "string" ? call.role : "";
        return role !== "classifier" && role !== "planner" && role !== "final_synthesizer";
      }).length;
      const gatewayWarnings = gatewayTrace.warnings ?? [];
      const gatewayErrors = gatewayTrace.errors ?? [];
      return {
        output: gatewayResult.answer,
        runtimeResult: gatewayResult,
        gatewayResult,
        openAIChunks,
        metadata: {
          provider: providerName,
          adapter: input.agent.adapter,
          local_model: optionalText(input.agent.model) ?? input.model,
          agent_slug: input.agent.slug,
          runtime: "codali",
          run_id: gatewayResult.runId,
          tool_calls_executed: gatewayTrace.toolCallCount,
          called_tools: gatewayTrace.calledTools ?? [],
          dynamic_tools_considered: gatewayTrace.consideredTools ?? [],
          dynamic_tools_registered: [],
          dynamic_tools_skipped: [],
          tool_call_details: [],
          telemetry: {
            ...gatewayResult.telemetry,
            runId: gatewayResult.runId,
            runtime: "codali",
            mode: "gateway",
            status: gatewayResult.status,
            toolCallCount: gatewayTrace.toolCallCount,
            modelCallCount: gatewayTrace.modelCallCount,
            taskCount: gatewayTaskCount,
            calledTools: gatewayTrace.calledTools,
            consideredTools: gatewayTrace.consideredTools,
            warnings: gatewayWarnings,
            errors: gatewayErrors,
            sourceCount: gatewayResult.sources.length,
            evidenceCount: gatewayResult.evidence.length,
          },
          codali_gateway_id: gatewayResult.runId,
          codali_gateway_status: gatewayResult.status,
          codali_gateway_mode: gatewayTrace.mode,
          codali_gateway_task_count: gatewayTaskCount,
          codali_gateway_tool_call_count: gatewayTrace.toolCallCount,
          codali_gateway_model_call_count: gatewayTrace.modelCallCount,
          codali_gateway_source_count: gatewayResult.sources.length,
          codali_gateway_evidence_count: gatewayResult.evidence.length,
          codali_gateway_warnings: gatewayWarnings,
          codali_gateway_errors: gatewayErrors,
          codali_gateway_trace: gatewayTrace,
          touched_files: [],
          warnings: gatewayWarnings,
          mode: runtimePolicy.mode,
          session_id: input.session?.id,
        },
      };
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
