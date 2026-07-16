import { randomUUID } from "node:crypto";
import type {
  LocalOpenAiCompatibleRunnerConfig,
  LocalRunnerAuthMode,
  LocalRunnerKind,
  LocalRunnerResponseFormatStrategy,
} from "@mcoda/shared";
import {
  normalizeAgentRequest,
  parseAgentRequest,
  type CodaliResponse,
  type CodaliResponseResult,
  type NormalizedNeed,
} from "../agents/AgentProtocol.js";
import { createProvider } from "../providers/ProviderRegistry.js";
import { OpenAiCompatibleProvider } from "../providers/OpenAiCompatibleProvider.js";
import { OllamaRemoteProvider } from "../providers/OllamaRemoteProvider.js";
import { CodexCliProvider } from "../providers/CodexCliProvider.js";
import { MswarmWorkerProvider } from "../providers/MswarmWorkerProvider.js";
import type {
  AgentEvent,
  AgentStatusPhase,
  Provider,
  ProviderConfig,
  ProviderMessage,
  ProviderResponseFormat,
  ProviderUsage,
} from "../providers/ProviderTypes.js";
import {
  DocdexClient,
  normalizeDocdexRuntimeOperation,
  type DocdexRuntimeOperation,
} from "../docdex/DocdexClient.js";
import {
  AppToolGatewayDispatchError,
  dispatchAppToolGateway,
  type CodaliAppToolGatewayRequesterScope,
  type CodaliAppToolGatewayScope,
} from "../gateway/AppToolGatewayDispatcher.js";
import { createDiffTool } from "../tools/diff/DiffTool.js";
import { createDocdexTools } from "../tools/docdex/DocdexTools.js";
import { createFileTools } from "../tools/filesystem/FileTools.js";
import { createSearchTool } from "../tools/search/SearchTool.js";
import { createShellTool } from "../tools/shell/ShellTool.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import {
  ToolExecutionError,
  type ToolContext,
  type ToolDefinition,
  type ToolErrorCode,
  type ToolExecutionResult,
  type ToolInputSchema,
} from "../tools/ToolTypes.js";
import { formatInstructionBlocks, loadInstructionBlocks, type InstructionBlock } from "../session/InstructionLoader.js";
import { SessionStore, type CodaliResumeBundle, type CodaliSessionMetadata } from "../session/SessionStore.js";
import {
  SubagentOrchestrator,
  type SubagentResult,
  type SubagentRole,
  type SubagentSpec,
} from "../subagents/SubagentOrchestrator.js";
import type { RunLogger } from "./RunLogger.js";
import { Runner, RunnerBudgetError, type RunnerBudgetReasonCode } from "./Runner.js";

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
  clientIdentity?: string;
  credentialSource?: "attached_mswarm_api_key" | string;
  required?: boolean;
  allowedOperations?: string[];
  capabilities?: Record<string, boolean | undefined>;
  immutableRuntimeContext?: boolean;
  initialize?: boolean;
  allowWeb?: boolean;
  allowMemoryWrite?: boolean;
  allowProfileWrite?: boolean;
  allowIndexRebuild?: boolean;
  toolManifest?: CodaliRuntimeToolManifest;
}

export interface CodaliRuntimeToolManifest extends Record<string, unknown> {
  actualTools?: unknown[];
  virtualTools?: unknown[];
  actual_tools?: unknown[];
  virtual_tools?: unknown[];
}

export interface CodaliRuntimeAppToolGatewayContract extends Record<string, unknown> {
  endpoint?: string;
  readOnly?: boolean;
  read_only?: boolean;
  signatureRequired?: boolean;
  signature_required?: boolean;
  signature?: string;
  signatureSecret?: string;
  signature_secret?: string;
  signingSecret?: string;
  signing_secret?: string;
  secret?: string;
}

export interface CodaliRuntimeAppToolContract extends Record<string, unknown> {
  name?: string;
  tool?: string;
  toolName?: string;
  tool_name?: string;
  description?: string;
  enabled?: boolean;
  readOnly?: boolean;
  read_only?: boolean;
  executionMode?: string;
  execution_mode?: string;
  callSchema?: Record<string, unknown>;
  call_schema?: Record<string, unknown>;
  resultContract?: string;
  result_contract?: string;
  resultSources?: string[];
  result_sources?: string[];
  backingTools?: string[];
  backing_tools?: string[];
  sourcePaths?: string[];
  source_paths?: string[];
  sourceTypes?: string[];
  source_types?: string[];
  suppliedSnapshots?: string[];
  supplied_snapshots?: string[];
  gateway?: CodaliRuntimeAppToolGatewayContract;
  metadata?: Record<string, unknown>;
}

export type CodaliRuntimeAppToolContracts =
  | Record<string, CodaliRuntimeAppToolContract | unknown>
  | CodaliRuntimeAppToolContract[];

export interface CodaliRuntimeToolTelemetryEntry {
  name: string;
  backingTool?: string;
  status: "success" | "failed" | "blocked";
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface CodaliRuntimeDynamicToolSkip {
  name: string;
  reason: string;
}

export interface CodaliRuntimeTelemetry {
  runId: string;
  runtime: "codali";
  mode: CodaliRuntimePolicy["mode"];
  toolCallCount: number;
  calledTools: string[];
  consideredTools: string[];
  registeredDynamicTools: string[];
  skippedDynamicTools: CodaliRuntimeDynamicToolSkip[];
  dynamicToolCalls: CodaliRuntimeToolTelemetryEntry[];
  warnings: string[];
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
  supportsTools?: boolean;
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
  appToolContracts?: CodaliRuntimeAppToolContracts;
  appVirtualTools?: string[];
  appToolGateway?: CodaliRuntimeAppToolGatewayContract;
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
  | { type: "status"; phase: AgentStatusPhase; message?: string; at: string }
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
  providerInstance?: Provider;
  toolRegistry?: ToolRegistry;
  tools?: ToolDefinition[];
  toolContext?: Partial<ToolContext>;
  logger?: RunLogger;
}

export interface CodaliOpenAIChunkOptions {
  id?: string;
  requestId?: string;
  model: string;
  created?: number;
  includeInternalEvents?: boolean;
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
  telemetry: CodaliRuntimeTelemetry;
  session?: {
    id: string;
    summaryRefs: string[];
    instructionSources: string[];
  };
}

const DEFAULT_DOCDEX_BASE_URL = "http://127.0.0.1:28491";

const WRITE_TOOL_NAMES = new Set([
  "write_file",
  "docdex_memory_save",
  "docdex_save_preference",
  "docdex_index_rebuild",
  "docdex_index_ingest",
  "docdex_delegate",
  "docdex_hooks_validate",
]);

const WEB_TOOL_NAMES = new Set(["docdex_web_research"]);
const MEMORY_WRITE_TOOL_NAMES = new Set(["docdex_memory_save"]);
const PROFILE_WRITE_TOOL_NAMES = new Set(["docdex_save_preference"]);
const INDEX_REBUILD_TOOL_NAMES = new Set(["docdex_index_rebuild", "docdex_index_ingest"]);
const READ_ONLY_DYNAMIC_BACKING_TOOLS = new Set([
  "docdex_search",
  "docdex_batch_search",
  "docdex_open",
  "docdex_files",
  "docdex_tree",
  "docdex_stats",
]);
const FORBIDDEN_DYNAMIC_ARG_KEYS = new Set([
  "authorization",
  "apiKey",
  "api_key",
  "baseUrl",
  "base_url",
  "credential",
  "credentials",
  "credentialSource",
  "credential_source",
  "repoId",
  "repo_id",
  "repoRoot",
  "repo_root",
  "tenantId",
  "tenant_id",
  "workspaceRoot",
  "workspace_root",
]);
const DOCDEX_TOOL_OPERATIONS = new Map<string, DocdexRuntimeOperation[]>([
  ["docdex_health", ["health"]],
  ["docdex_initialize", ["initialize"]],
  ["docdex_search", ["search"]],
  ["docdex_open", ["open", "snippet"]],
  ["docdex_open_file", ["open"]],
  ["docdex_symbols", ["symbols"]],
  ["docdex_ast", ["ast"]],
  ["docdex_impact_graph", ["impact_graph"]],
  ["docdex_impact_diagnostics", ["impact_diagnostics"]],
  ["docdex_dag_export", ["dag_export"]],
  ["docdex_tree", ["tree"]],
  ["docdex_memory_save", ["memory_save"]],
  ["docdex_memory_recall", ["memory_recall"]],
  ["docdex_get_profile", ["profile_read"]],
  ["docdex_save_preference", ["profile_write"]],
  ["docdex_web_research", ["web_research"]],
  ["docdex_chat_context", ["chat_context"]],
  ["docdex_rerank", ["rerank"]],
  ["docdex_batch_search", ["batch_search"]],
  ["docdex_capabilities", ["capabilities"]],
  ["docdex_stats", ["stats"]],
  ["docdex_files", ["files"]],
  ["docdex_repo_inspect", ["repo_inspect"]],
  ["docdex_index_rebuild", ["index_rebuild"]],
  ["docdex_index_ingest", ["index_ingest"]],
  ["docdex_delegate", ["delegate"]],
  ["docdex_hooks_validate", ["hooks_validate"]],
]);

const RUNTIME_TO_PROTOCOL_NEEDS = new Map<string, string[]>([
  ["docdex_search", ["docdex.search"]],
  ["docdex_open", ["docdex.open", "docdex.snippet"]],
  ["docdex_open_file", ["docdex.open"]],
  ["docdex_symbols", ["docdex.symbols"]],
  ["docdex_ast", ["docdex.ast"]],
  ["docdex_web_research", ["docdex.web"]],
  ["docdex_chat_context", ["docdex.chat_context"]],
  ["docdex_impact_graph", ["docdex.impact"]],
  ["docdex_impact_diagnostics", ["docdex.impact_diagnostics"]],
  ["docdex_tree", ["docdex.tree"]],
  ["docdex_dag_export", ["docdex.dag_export"]],
  ["read_file", ["file.read"]],
  ["list_files", ["file.list"]],
  ["diff_summary", ["file.diff"]],
]);

const PROTOCOL_TO_RUNTIME_TOOL_NAMES = new Map<string, string[]>([
  ["docdex.search", ["docdex_search"]],
  ["docdex.open", ["docdex_open", "docdex_open_file"]],
  ["docdex.snippet", ["docdex_open"]],
  ["docdex.symbols", ["docdex_symbols"]],
  ["docdex.ast", ["docdex_ast"]],
  ["docdex.web", ["docdex_web_research"]],
  ["docdex.chat_context", ["docdex_chat_context"]],
  ["docdex.impact", ["docdex_impact_graph"]],
  ["docdex.impact_diagnostics", ["docdex_impact_diagnostics"]],
  ["docdex.tree", ["docdex_tree"]],
  ["docdex.dag_export", ["docdex_dag_export"]],
  ["file.read", ["read_file"]],
  ["file.list", ["list_files"]],
  ["file.diff", ["diff_summary"]],
]);

const PROTOCOL_REQUEST_HEADER = "AGENT_REQUEST v1";

const stripUndefined = (input: Record<string, unknown>): Record<string, unknown> => {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value;
  }
  return output;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

interface DynamicToolRegistryState {
  consideredTools: string[];
  registeredDynamicTools: string[];
  skippedDynamicTools: CodaliRuntimeDynamicToolSkip[];
  dynamicToolCalls: CodaliRuntimeToolTelemetryEntry[];
}

interface RuntimeToolContractCandidate {
  name: string;
  contract?: CodaliRuntimeAppToolContract;
}

const createDynamicToolRegistryState = (): DynamicToolRegistryState => ({
  consideredTools: [],
  registeredDynamicTools: [],
  skippedDynamicTools: [],
  dynamicToolCalls: [],
});

const pushUnique = (target: string[], value: string): void => {
  if (!target.includes(value)) target.push(value);
};

const recordSkippedDynamicTool = (
  state: DynamicToolRegistryState,
  name: string,
  reason: string,
): void => {
  if (!state.skippedDynamicTools.some((entry) => entry.name === name && entry.reason === reason)) {
    state.skippedDynamicTools.push({ name, reason });
  }
};

const stringArrayFromUnknown = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
};

const toolNameFromRecord = (value: Record<string, unknown>): string | undefined => {
  for (const key of ["name", "tool", "toolName", "tool_name", "id"]) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) return entry.trim();
  }
  return undefined;
};

const toolNamesFromManifestEntries = (entries: unknown): string[] => {
  if (!Array.isArray(entries)) return [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      pushUnique(names, entry.trim());
      continue;
    }
    if (isRecord(entry)) {
      const name = toolNameFromRecord(entry);
      if (name) pushUnique(names, name);
    }
  }
  return names;
};

const toolNamesFromManifest = (manifest: CodaliRuntimeToolManifest | undefined): string[] => {
  if (!manifest) return [];
  const names: string[] = [];
  for (const list of [
    manifest.actualTools,
    manifest.virtualTools,
    manifest.actual_tools,
    manifest.virtual_tools,
  ]) {
    for (const name of toolNamesFromManifestEntries(list)) pushUnique(names, name);
  }
  return names;
};

const normalizeRuntimeToolContractEntries = (
  contracts: CodaliRuntimeAppToolContracts | undefined,
): Array<[string, CodaliRuntimeAppToolContract]> => {
  if (!contracts) return [];
  if (Array.isArray(contracts)) {
    const entries: Array<[string, CodaliRuntimeAppToolContract]> = [];
    for (const contract of contracts) {
      if (!isRecord(contract)) continue;
      const name = toolNameFromRecord(contract);
      if (name) entries.push([name, contract as CodaliRuntimeAppToolContract]);
    }
    return entries;
  }
  if (!isRecord(contracts)) return [];
  const entries: Array<[string, CodaliRuntimeAppToolContract]> = [];
  for (const [key, value] of Object.entries(contracts)) {
    if (!key.trim()) continue;
    const contract = isRecord(value)
      ? ({ name: key, ...value } as CodaliRuntimeAppToolContract)
      : ({ name: key, metadata: { valueType: typeof value } } as CodaliRuntimeAppToolContract);
    entries.push([key, contract]);
  }
  return entries;
};

const contractString = (
  contract: CodaliRuntimeAppToolContract,
  camelKey: keyof CodaliRuntimeAppToolContract,
  snakeKey: keyof CodaliRuntimeAppToolContract,
): string | undefined => {
  const value = contract[camelKey] ?? contract[snakeKey];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const contractBoolean = (
  contract: CodaliRuntimeAppToolContract,
  camelKey: keyof CodaliRuntimeAppToolContract,
  snakeKey: keyof CodaliRuntimeAppToolContract,
): boolean | undefined => {
  const value = contract[camelKey] ?? contract[snakeKey];
  return typeof value === "boolean" ? value : undefined;
};

const contractStringArray = (
  contract: CodaliRuntimeAppToolContract,
  camelKey: keyof CodaliRuntimeAppToolContract,
  snakeKey: keyof CodaliRuntimeAppToolContract,
): string[] => {
  return stringArrayFromUnknown(contract[camelKey] ?? contract[snakeKey]);
};

const contractCallSchema = (contract: CodaliRuntimeAppToolContract): ToolInputSchema => {
  const schema = contract.callSchema ?? contract.call_schema;
  if (isRecord(schema) && (schema.type === undefined || schema.type === "object")) {
    return {
      ...schema,
      type: "object",
    } as ToolInputSchema;
  }
  return { type: "object", additionalProperties: true };
};

const findForbiddenDynamicArgKeys = (
  value: unknown,
  path = "$",
  matches: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenDynamicArgKeys(entry, `${path}[${index}]`, matches));
    return matches;
  }
  if (!isRecord(value)) return matches;
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_DYNAMIC_ARG_KEYS.has(key)) {
      matches.push(childPath);
    }
    findForbiddenDynamicArgKeys(entry, childPath, matches);
  }
  return matches;
};

const assertDynamicArgsStayInScope = (toolName: string, args: unknown): void => {
  const forbidden = findForbiddenDynamicArgKeys(args);
  if (forbidden.length) {
    throw new ToolExecutionError("tool_permission_denied", "Dynamic tool arguments cannot override tenant or repo scope", {
      retryable: false,
      details: { tool: toolName, forbidden },
    });
  }
};

const readStringArg = (args: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const readStringArrayArg = (args: Record<string, unknown>, keys: string[]): string[] => {
  for (const key of keys) {
    const values = stringArrayFromUnknown(args[key]);
    if (values.length) return values;
  }
  return [];
};

const readNumberArg = (args: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

const readBooleanArg = (args: Record<string, unknown>, keys: string[]): boolean | undefined => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
};

const selectDocdexBackingCall = (
  toolName: string,
  backingTools: string[],
  args: unknown,
): { toolName: string; args: Record<string, unknown> } => {
  const record = isRecord(args) ? args : {};
  const limit = readNumberArg(record, ["limit", "maxResults", "max_results"]);
  const queries = readStringArrayArg(record, ["queries"]);
  if (queries.length && backingTools.includes("docdex_batch_search")) {
    return {
      toolName: "docdex_batch_search",
      args: stripUndefined({
        queries,
        limit,
        includeLibs: readBooleanArg(record, ["includeLibs", "include_libs"]),
      }),
    };
  }

  const query = readStringArg(record, ["query", "q", "search", "question", "prompt", "text"]);
  if (query && backingTools.includes("docdex_search")) {
    return { toolName: "docdex_search", args: stripUndefined({ query, limit }) };
  }

  const path = readStringArg(record, ["path", "relPath", "rel_path", "file", "sourcePath", "source_path"]);
  const docId = readStringArg(record, ["docId", "doc_id"]);
  if ((path || docId) && backingTools.includes("docdex_open")) {
    return {
      toolName: "docdex_open",
      args: stripUndefined({
        path,
        docId,
        window: readNumberArg(record, ["window"]),
        textOnly: readBooleanArg(record, ["textOnly", "text_only"]),
        startLine: readNumberArg(record, ["startLine", "start_line"]),
        endLine: readNumberArg(record, ["endLine", "end_line"]),
        head: readNumberArg(record, ["head"]),
        clamp: readBooleanArg(record, ["clamp"]),
      }),
    };
  }

  if (backingTools.includes("docdex_tree")) {
    return {
      toolName: "docdex_tree",
      args: stripUndefined({
        path,
        maxDepth: readNumberArg(record, ["maxDepth", "max_depth"]),
        dirsOnly: readBooleanArg(record, ["dirsOnly", "dirs_only"]),
        includeHidden: readBooleanArg(record, ["includeHidden", "include_hidden"]),
      }),
    };
  }

  if (backingTools.includes("docdex_files")) {
    return {
      toolName: "docdex_files",
      args: stripUndefined({
        limit,
        offset: readNumberArg(record, ["offset"]),
      }),
    };
  }

  if (backingTools.includes("docdex_stats")) {
    return { toolName: "docdex_stats", args: {} };
  }

  throw new ToolExecutionError("tool_invalid_args", "Dynamic tool arguments do not match its read-only backing tools", {
    retryable: false,
    details: { tool: toolName, backingTools },
  });
};

const createDocdexBackedDynamicTool = (options: {
  name: string;
  contract: CodaliRuntimeAppToolContract;
  registry: ToolRegistry;
  backingTools: string[];
  state: DynamicToolRegistryState;
}): ToolDefinition => {
  const { name, contract, registry, backingTools, state } = options;
  const executionMode =
    contractString(contract, "executionMode", "execution_mode") ?? "server_supplied_snapshot_plus_docdex";
  return {
    name,
    description:
      contract.description ??
      `Read-only runtime tool. Uses ${backingTools.join(", ")} and returns ${contract.resultContract ?? contract.result_contract ?? "contracted app context"}.`,
    inputSchema: contractCallSchema(contract),
    handler: async (args, context) => {
      const startedAt = Date.now();
      let backingTool: string | undefined;
      let recorded = false;
      try {
        assertDynamicArgsStayInScope(name, args);
        const backingCall = selectDocdexBackingCall(name, backingTools, args);
        backingTool = backingCall.toolName;
        const result = await registry.execute(backingCall.toolName, backingCall.args, context);
        if (!result.ok) {
          state.dynamicToolCalls.push({
            name,
            backingTool,
            status: "failed",
            latencyMs: Date.now() - startedAt,
            errorCode: result.error?.code,
            errorMessage: result.error?.message,
          });
          recorded = true;
          throw new ToolExecutionError(result.error?.code ?? "tool_execution_failed", result.error?.message ?? "Backing tool failed", {
            retryable: result.error?.retryable,
            details: { tool: name, backingTool, backingError: result.error?.details },
          });
        }
        const data = {
          tool: name,
          executionMode,
          resultContract: contract.resultContract ?? contract.result_contract,
          resultSources: contractStringArray(contract, "resultSources", "result_sources"),
          sourcePaths: contractStringArray(contract, "sourcePaths", "source_paths"),
          sourceTypes: contractStringArray(contract, "sourceTypes", "source_types"),
          suppliedSnapshots: contractStringArray(contract, "suppliedSnapshots", "supplied_snapshots"),
          backingTool,
          result: payloadForToolResult(result),
        };
        state.dynamicToolCalls.push({
          name,
          backingTool,
          status: "success",
          latencyMs: Date.now() - startedAt,
        });
        recorded = true;
        return {
          output: JSON.stringify(data, null, 2),
          data,
        };
      } catch (error) {
        if (!recorded) {
          state.dynamicToolCalls.push({
            name,
            backingTool,
            status: "failed",
            latencyMs: Date.now() - startedAt,
            errorCode: error instanceof ToolExecutionError ? error.code : "tool_execution_failed",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    },
  };
};

const resolveGatewayContract = (
  contract: CodaliRuntimeAppToolContract,
  policyGateway: CodaliRuntimeAppToolGatewayContract | undefined,
): CodaliRuntimeAppToolGatewayContract | undefined => {
  const gateway = contract.gateway;
  if (!gateway && !policyGateway) return undefined;
  return { ...(policyGateway ?? {}), ...(gateway ?? {}) };
};

const gatewayString = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
  keys: readonly string[],
): string | undefined => {
  if (!gateway) return undefined;
  for (const key of keys) {
    const value = gateway[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const gatewayBoolean = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
  keys: readonly string[],
): boolean | undefined => {
  if (!gateway) return undefined;
  for (const key of keys) {
    const value = gateway[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
};

const gatewayEndpoint = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
): string | undefined => gatewayString(gateway, ["endpoint"]);

const gatewaySigningSecret = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
): string | undefined =>
  gatewayString(gateway, [
    "signatureSecret",
    "signature_secret",
    "signingSecret",
    "signing_secret",
    "secret",
    "signature",
  ]);

const appToolGatewayTenantScope = (
  input: CodaliRuntimeInput,
): CodaliAppToolGatewayScope =>
  stripUndefined({
    tenant_id: input.metadata?.tenantId,
    docdex_repo_id: input.docdex?.repoId,
  }) as CodaliAppToolGatewayScope;

const appToolGatewayRequesterScope = (
  input: CodaliRuntimeInput,
): CodaliAppToolGatewayRequesterScope =>
  stripUndefined({
    request_id: input.metadata?.requestId,
    owner_user_id: input.metadata?.ownerUserId,
    api_key_id: input.metadata?.apiKeyId,
    agent_slug: input.metadata?.agentSlug,
  }) as CodaliAppToolGatewayRequesterScope;

const gatewayDispatchToolErrorCode = (
  error: AppToolGatewayDispatchError,
): ToolErrorCode => {
  if (error.code === "GATEWAY_INVALID_ARGS") return "tool_invalid_args";
  if (
    error.code === "GATEWAY_HTTP_FAILED" ||
    error.code === "GATEWAY_RESPONSE_MALFORMED"
  ) {
    return "tool_execution_failed";
  }
  return "tool_permission_denied";
};

const createGatewayDynamicTool = (options: {
  name: string;
  contract: CodaliRuntimeAppToolContract;
  gateway: CodaliRuntimeAppToolGatewayContract;
  input: CodaliRuntimeInput;
  state: DynamicToolRegistryState;
}): ToolDefinition => {
  const { name, contract, gateway, input, state } = options;
  return {
    name,
    description:
      contract.description ??
      `Read-only app tool dispatched through the runtime app_tool_gateway for ${name}.`,
    inputSchema: contractCallSchema(contract),
    handler: async (args, context) => {
      const startedAt = Date.now();
      try {
        assertDynamicArgsStayInScope(name, args);
        const dispatched = await dispatchAppToolGateway({
          runId: context.runId ?? input.metadata?.requestId ?? input.metadata?.jobId ?? "codali-runtime",
          sessionId: input.session?.id,
          requestId: input.metadata?.requestId,
          tenantScope: appToolGatewayTenantScope(input),
          requesterScope: appToolGatewayRequesterScope(input),
          toolName: name,
          args,
          contract,
          gateway,
          allowedTools: input.policy.allowedTools,
          deniedTools: input.policy.deniedTools,
        });
        state.dynamicToolCalls.push({
          name,
          backingTool: "app_tool_gateway",
          status: "success",
          latencyMs: Date.now() - startedAt,
        });
        return {
          output: JSON.stringify(dispatched.evidencePayload, null, 2),
          data: dispatched.evidencePayload,
        };
      } catch (error) {
        const toolError =
          error instanceof AppToolGatewayDispatchError
            ? new ToolExecutionError(gatewayDispatchToolErrorCode(error), error.message, {
                retryable: error.retryable,
                details: stripUndefined({
                  tool: name,
                  gatewayErrorCode: error.code,
                  gatewayDetails: error.details,
                }),
              })
            : error;
        state.dynamicToolCalls.push({
          name,
          backingTool: "app_tool_gateway",
          status: "failed",
          latencyMs: Date.now() - startedAt,
          errorCode: toolError instanceof ToolExecutionError ? toolError.code : "tool_execution_failed",
          errorMessage: toolError instanceof Error ? toolError.message : String(toolError),
        });
        throw toolError;
      }
    },
  };
};

const parseJsonPayload = (output: string): unknown | undefined => {
  const trimmed = output.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

const payloadForToolResult = (result: ToolExecutionResult): unknown => {
  if (!result.ok) {
    return undefined;
  }
  return result.data ?? parseJsonPayload(result.output) ?? result.output;
};

const toolResultContent = (result: ToolExecutionResult): string => {
  if (result.ok) {
    return result.output;
  }
  return `ERROR[${result.error?.code ?? "tool_execution_failed"}]: ${
    result.error?.message ?? "tool failed"
  }`;
};

const arrayFromPayload = (payload: unknown, keys: string[]): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload)) {
    for (const key of keys) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
    }
  }
  return payload === undefined ? [] : [payload];
};

const stringFromPayload = (payload: unknown, keys: string[], fallback: string): string => {
  if (typeof payload === "string") return payload;
  if (isRecord(payload)) {
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === "string") return value;
    }
  }
  return fallback;
};

const truncateProtocolString = (value: string, maxLength = 1_200): string => {
  return value.length > maxLength ? `${value.slice(0, maxLength)}... [truncated]` : value;
};

const compactProtocolPayload = (value: unknown, depth = 0): unknown => {
  if (typeof value === "string") return truncateProtocolString(value);
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.slice(0, 5).map((entry) => compactProtocolPayload(entry, depth + 1));
  }
  if (depth > 2) return "[object truncated]";
  const input = value as Record<string, unknown>;
  const preferredKeys = [
    "type",
    "query",
    "doc_id",
    "rel_path",
    "path",
    "title",
    "url",
    "line_start",
    "line_end",
    "score",
    "summary",
    "snippet",
    "content",
    "status",
    "id",
    "role",
    "goal",
    "toolCallsExecuted",
    "touchedFiles",
    "warnings",
    "error",
    "metadata",
  ];
  const keys = preferredKeys.some((key) => key in input)
    ? preferredKeys.filter((key) => key in input)
    : Object.keys(input).slice(0, 12);
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    output[key] = compactProtocolPayload(input[key], depth + 1);
  }
  const omitted = Object.keys(input).length - keys.length;
  if (omitted > 0) output._omitted_keys = omitted;
  return output;
};

const compactSubagentResultForProtocol = (result: SubagentResult): Record<string, unknown> => ({
  id: result.id,
  role: result.role,
  goal: result.goal,
  status: result.status,
  summary: truncateProtocolString(result.summary, 600),
  toolCallsExecuted: result.toolCallsExecuted,
  touchedFiles: result.touchedFiles,
  warnings: result.warnings.slice(0, 5),
  error: result.error,
  metadata: result.metadata,
});

const matchesSimplePattern = (entry: string, pattern: string): boolean => {
  if (!pattern.includes("*")) return entry.includes(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(entry);
};

const extractAgentRequestText = (content: string): string | undefined => {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith("{") &&
    /"request_id"\s*:/.test(trimmed) &&
    /"needs"\s*:/.test(trimmed)
  ) {
    return trimmed;
  }
  const markerMatch = /^AGENT_REQUEST\s+v1$/im.exec(trimmed);
  if (!markerMatch || markerMatch.index === undefined) return undefined;
  let requestText = trimmed.slice(markerMatch.index).trim();
  const fenceEnd = requestText.indexOf("```", PROTOCOL_REQUEST_HEADER.length);
  if (fenceEnd !== -1) {
    requestText = requestText.slice(0, fenceEnd).trim();
  }
  return requestText;
};

const allowedProtocolNeedTypes = (registry: ToolRegistry, allowDelegation: boolean): string[] => {
  const needs = new Set<string>();
  for (const tool of registry.list()) {
    for (const need of RUNTIME_TO_PROTOCOL_NEEDS.get(tool.name) ?? []) {
      needs.add(need);
    }
  }
  if (allowDelegation) needs.add("agent.delegate");
  return Array.from(needs).sort();
};

const buildProtocolSystemPrompt = (
  registry: ToolRegistry,
  options: {
    allowDelegation?: boolean;
    resumeBundle?: CodaliResumeBundle;
    instructionBlocks?: InstructionBlock[];
  } = {},
): string => {
  const needs = allowedProtocolNeedTypes(registry, options.allowDelegation === true);
  const needList = needs.length ? needs.join(", ") : "none";
  const lines = [
    "You are running inside Codali, a local orchestration client that can execute tools for you between model turns.",
    "You cannot call tools directly. When you need repo files, Docdex index data, local graph context, web research, or workspace state, respond with exactly one AGENT_REQUEST v1 message and no prose.",
    `Allowed need types for this run: ${needList}.`,
    "After Codali replies with CODALI_RESPONSE v1, use those results, decide whether another AGENT_REQUEST is needed, and continue until you can answer the user.",
    "Do not invent tool results. Use docdex.search/open/symbols/ast/tree/impact for repo truth, docdex.web for external/current facts, and file.read/list/diff for workspace state.",
    "Request format:",
    "AGENT_REQUEST v1",
    "role: agent",
    "request_id: short-unique-id",
    "needs:",
    "  - type: docdex.search",
    '    query: "search query"',
    "    limit: 5",
    "context:",
    '  summary: "why this context is needed"',
    ...(options.allowDelegation
      ? [
          "Delegation format:",
          "AGENT_REQUEST v1",
          "role: agent",
          "request_id: delegate-1",
          "needs:",
          "  - type: agent.delegate",
          "    role: explorer",
          '    goal: "inspect the repo context needed for this task"',
          "    tools: docdex.search, docdex.open, file.read",
          "    allowed_paths: packages/codali/src",
        ]
      : []),
    "When you have enough information, answer normally without AGENT_REQUEST.",
  ];
  const instructionText = formatInstructionBlocks(options.instructionBlocks ?? []);
  if (instructionText) {
    lines.push("Loaded project instructions:", instructionText);
  }
  if (options.resumeBundle) {
    lines.push(
      "Resume context:",
      JSON.stringify(
        {
          session_id: options.resumeBundle.metadata.sessionId,
          task: options.resumeBundle.metadata.task,
          latest_summary: options.resumeBundle.latestSummary?.summary,
          recent_events: options.resumeBundle.recentEvents.map((event) => ({
            type: event.type,
            run_id: event.runId,
            data: event.data,
          })),
        },
        null,
        2,
      ),
    );
  }
  return lines.join("\n");
};

interface ProtocolToolExecution {
  need: NormalizedNeed;
  toolName: string;
  args: Record<string, unknown>;
}

const protocolToolExecutionForNeed = (
  need: NormalizedNeed,
  input: CodaliRuntimeInput,
  runId: string,
): ProtocolToolExecution => {
  if (need.tool === "docdex.search") {
    return { need, toolName: "docdex_search", args: stripUndefined(need.params) };
  }
  if (need.tool === "docdex.open") {
    return {
      need,
      toolName: "docdex_open",
      args: stripUndefined({
        path: need.params.path,
        startLine: need.params.start_line,
        endLine: need.params.end_line,
        head: need.params.head,
        clamp: need.params.clamp,
      }),
    };
  }
  if (need.tool === "docdex.snippet") {
    return {
      need,
      toolName: "docdex_open",
      args: stripUndefined({ docId: need.params.doc_id, window: need.params.window, textOnly: true }),
    };
  }
  if (need.tool === "docdex.symbols") {
    return { need, toolName: "docdex_symbols", args: { path: need.params.file } };
  }
  if (need.tool === "docdex.ast") {
    return {
      need,
      toolName: "docdex_ast",
      args: stripUndefined({ path: need.params.file, maxNodes: need.params.max_nodes }),
    };
  }
  if (need.tool === "docdex.web") {
    return {
      need,
      toolName: "docdex_web_research",
      args: stripUndefined({
        query: need.params.query,
        forceWeb: need.params.force_web ?? true,
      }),
    };
  }
  if (need.tool === "docdex.impact") {
    return { need, toolName: "docdex_impact_graph", args: { file: need.params.file } };
  }
  if (need.tool === "docdex.impact_diagnostics") {
    return {
      need,
      toolName: "docdex_impact_diagnostics",
      args: stripUndefined(need.params),
    };
  }
  if (need.tool === "docdex.tree") {
    return {
      need,
      toolName: "docdex_tree",
      args: stripUndefined({
        path: need.params.path,
        maxDepth: need.params.max_depth,
        dirsOnly: need.params.dirs_only,
        includeHidden: need.params.include_hidden,
      }),
    };
  }
  if (need.tool === "docdex.dag_export") {
    return {
      need,
      toolName: "docdex_dag_export",
      args: stripUndefined({
        sessionId: need.params.session_id ?? input.docdex?.dagSessionId ?? input.metadata?.requestId ?? runId,
        format: need.params.format,
        maxNodes: need.params.max_nodes,
      }),
    };
  }
  if (need.tool === "file.list") {
    return { need, toolName: "list_files", args: { path: need.params.root, maxDepth: 3 } };
  }
  if (need.tool === "file.diff") {
    return { need, toolName: "diff_summary", args: { maxLines: 200 } };
  }
  if (need.tool === "file.read") {
    return { need, toolName: "read_file", args: { path: need.params.path } };
  }
  throw new Error(`Unsupported protocol need for tool execution: ${need.tool}`);
};

const protocolResultFromToolResult = (
  execution: ProtocolToolExecution,
  result: ToolExecutionResult,
  warnings: string[],
): CodaliResponseResult => {
  const payload = payloadForToolResult(result);
  const content = toolResultContent(result);
  if (!result.ok) {
    warnings.push(
      `${execution.need.tool} via ${execution.toolName} failed: ${
        result.error?.message ?? "tool failed"
      }`,
    );
  }

  const need = execution.need;
  if (need.tool === "docdex.search") {
    return {
      type: "docdex.search",
      query: need.params.query,
      hits: result.ok
        ? arrayFromPayload(payload, ["results", "hits"]).map((entry) => compactProtocolPayload(entry))
        : [{ error: content }],
    };
  }
  if (need.tool === "docdex.open") {
    return {
      type: "docdex.open",
      path: need.params.path,
      content: truncateProtocolString(stringFromPayload(payload, ["content", "text", "snippet"], content), 4_000),
    };
  }
  if (need.tool === "docdex.snippet") {
    return {
      type: "docdex.snippet",
      doc_id: need.params.doc_id,
      content: truncateProtocolString(stringFromPayload(payload, ["content", "text", "snippet"], content), 4_000),
    };
  }
  if (need.tool === "docdex.symbols") {
    return {
      type: "docdex.symbols",
      file: need.params.file,
      symbols: result.ok ? compactProtocolPayload(payload) : { error: content },
    };
  }
  if (need.tool === "docdex.ast") {
    return {
      type: "docdex.ast",
      file: need.params.file,
      nodes: result.ok
        ? compactProtocolPayload(isRecord(payload) && payload.nodes ? payload.nodes : payload)
        : { error: content },
    };
  }
  if (need.tool === "docdex.web") {
    return {
      type: "docdex.web",
      query: need.params.query,
      results: result.ok
        ? arrayFromPayload(payload, ["results", "web_results", "hits"]).map((entry) =>
            compactProtocolPayload(entry),
          )
        : [{ error: content }],
    };
  }
  if (need.tool === "docdex.impact") {
    return {
      type: "docdex.impact",
      file: need.params.file,
      inbound: result.ok ? arrayFromPayload(payload, ["inbound"]).map((entry) => compactProtocolPayload(entry)) : [],
      outbound: result.ok ? arrayFromPayload(payload, ["outbound"]).map((entry) => compactProtocolPayload(entry)) : [],
    };
  }
  if (need.tool === "docdex.impact_diagnostics") {
    return {
      type: "docdex.impact_diagnostics",
      file: need.params.file,
      diagnostics: result.ok ? compactProtocolPayload(payload) : { error: content },
    };
  }
  if (need.tool === "docdex.tree") {
    return {
      type: "docdex.tree",
      tree: stringFromPayload(payload, ["tree"], content),
    };
  }
  if (need.tool === "docdex.dag_export") {
    return {
      type: "docdex.dag_export",
      session_id: String(execution.args.sessionId ?? need.params.session_id ?? ""),
      format: need.params.format,
      content: result.ok ? compactProtocolPayload(payload) : { error: content },
    };
  }
  if (need.tool === "file.list") {
    const entries = arrayFromPayload(payload, ["entries", "files"]).filter(
      (entry): entry is string => typeof entry === "string",
    );
    const files = need.params.pattern
      ? entries.filter((entry) => matchesSimplePattern(entry, need.params.pattern!))
      : entries;
    return { type: "file.list", root: need.params.root, files };
  }
  if (need.tool === "file.diff") {
    return { type: "file.diff", paths: need.params.paths, diff: content };
  }
  if (need.tool === "file.read") {
    return {
      type: "file.read",
      path: need.params.path,
      content,
    };
  }
  return {
    type: "agent.delegate",
    role: "unknown",
    goal: "unsupported",
    results: [{ error: `Unsupported protocol result: ${need.tool}` }],
  };
};

const formatCodaliResponse = (response: CodaliResponse): string => {
  return `CODALI_RESPONSE v1\n${JSON.stringify(response, null, 2)}`;
};

const mergeUsage = (current: ProviderUsage | undefined, next: ProviderUsage | undefined): ProviderUsage | undefined => {
  if (!next) return current;
  const merged: ProviderUsage = current ? { ...current } : {};
  if (next.inputTokens !== undefined) {
    merged.inputTokens = (merged.inputTokens ?? 0) + next.inputTokens;
  }
  if (next.outputTokens !== undefined) {
    merged.outputTokens = (merged.outputTokens ?? 0) + next.outputTokens;
  }
  if (next.totalTokens !== undefined) {
    merged.totalTokens = (merged.totalTokens ?? 0) + next.totalTokens;
  }
  return merged;
};

const createRuntimeProvider = (input: CodaliRuntimeProviderInput): Provider => {
  const config: ProviderConfig = {
    model: input.model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    localRunner: input.localRunner,
    runnerKind: input.runnerKind,
    authMode: input.authMode,
    dummyBearerToken: input.dummyBearerToken,
    headers: input.headers,
    extraBody: input.extraBody,
    responseFormatStrategy: input.responseFormatStrategy,
    healthPath: input.healthPath,
    modelsPath: input.modelsPath,
    requireModelInRequest: input.requireModelInRequest,
    supportsStreaming: input.supportsStreaming,
    supportsTools: input.supportsTools,
    supportsJsonSchema: input.supportsJsonSchema,
    supportsGbnf: input.supportsGbnf,
  };
  if (input.name === "openai-compatible") {
    return new OpenAiCompatibleProvider(config);
  }
  if (input.name === "ollama-remote") {
    return new OllamaRemoteProvider(config);
  }
  if (input.name === "codex-cli") {
    return new CodexCliProvider(config);
  }
  if (input.name === "mswarm-worker") {
    return new MswarmWorkerProvider(config);
  }
  return createProvider(input.name, config);
};

const isRuntimeToolAllowed = (toolName: string, policy: CodaliRuntimePolicy): boolean => {
  if (policy.deniedTools?.includes(toolName)) {
    return false;
  }
  if (policy.allowedTools && !policy.allowedTools.includes(toolName)) {
    return false;
  }
  if (!policy.allowShell && toolName === "run_shell") {
    return false;
  }
  if (!policy.allowWrites && WRITE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  return true;
};

const allowedDocdexOperations = (
  docdex: CodaliRuntimeDocdexInput | undefined,
): Set<DocdexRuntimeOperation> | undefined => {
  if (!docdex?.allowedOperations?.length) return undefined;
  const operations = docdex.allowedOperations
    .map((entry) => normalizeDocdexRuntimeOperation(entry))
    .filter((entry): entry is DocdexRuntimeOperation => Boolean(entry));
  return operations.length ? new Set(operations) : new Set();
};

const docdexCapabilityAllows = (
  docdex: CodaliRuntimeDocdexInput | undefined,
  operation: DocdexRuntimeOperation,
): boolean => {
  if (!docdex?.capabilities) return true;
  for (const [key, value] of Object.entries(docdex.capabilities)) {
    if (normalizeDocdexRuntimeOperation(key) === operation && value === false) {
      return false;
    }
  }
  return true;
};

const isDocdexRuntimeOperationAllowed = (
  toolName: string,
  docdex: CodaliRuntimeDocdexInput | undefined,
): boolean => {
  const operations = DOCDEX_TOOL_OPERATIONS.get(toolName);
  if (!operations?.length) return true;
  const allowedOperations = allowedDocdexOperations(docdex);
  return operations.some((operation) => {
    if (allowedOperations && !allowedOperations.has(operation)) {
      return false;
    }
    return docdexCapabilityAllows(docdex, operation);
  });
};

const isDocdexToolAllowed = (
  toolName: string,
  docdex: CodaliRuntimeDocdexInput | undefined,
): boolean => {
  if (!toolName.startsWith("docdex_")) {
    return true;
  }
  if (docdex?.enabled === false) {
    return false;
  }
  if (docdex?.allowWeb === false && WEB_TOOL_NAMES.has(toolName)) {
    return false;
  }
  if (docdex?.allowMemoryWrite === false && MEMORY_WRITE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  if (docdex?.allowProfileWrite === false && PROFILE_WRITE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  if (docdex?.allowIndexRebuild === false && INDEX_REBUILD_TOOL_NAMES.has(toolName)) {
    return false;
  }
  if (!isDocdexRuntimeOperationAllowed(toolName, docdex)) {
    return false;
  }
  return true;
};

const isImmutableDocdexRuntimeContext = (
  docdex: CodaliRuntimeDocdexInput | undefined,
): boolean =>
  docdex?.immutableRuntimeContext === true ||
  docdex?.credentialSource === "attached_mswarm_api_key";

const registerRuntimeTool = (
  registry: ToolRegistry,
  tool: ToolDefinition,
  policy: CodaliRuntimePolicy,
  docdex?: CodaliRuntimeDocdexInput,
): void => {
  if (isRuntimeToolAllowed(tool.name, policy) && isDocdexToolAllowed(tool.name, docdex)) {
    registry.register(tool);
  }
};

const collectRuntimeToolContractCandidates = (input: CodaliRuntimeInput): RuntimeToolContractCandidate[] => {
  const contracts = new Map<string, CodaliRuntimeAppToolContract>();
  for (const [name, contract] of normalizeRuntimeToolContractEntries(input.policy.appToolContracts)) {
    contracts.set(name, contract);
  }

  const names = new Set<string>();
  for (const name of toolNamesFromManifest(input.docdex?.toolManifest)) names.add(name);
  for (const name of stringArrayFromUnknown(input.policy.appVirtualTools)) names.add(name);
  for (const name of contracts.keys()) names.add(name);

  return Array.from(names)
    .sort()
    .map((name) => ({ name, contract: contracts.get(name) }));
};

const registerRuntimeContractTools = (
  registry: ToolRegistry,
  input: CodaliRuntimeInput,
  state: DynamicToolRegistryState,
  warnings: string[],
): void => {
  const candidates = collectRuntimeToolContractCandidates(input);
  if (!candidates.length) return;

  const registryNames = new Set(registry.list().map((tool) => tool.name));
  for (const candidate of candidates) {
    const name = candidate.name.trim();
    if (!name) continue;
    pushUnique(state.consideredTools, name);

    if (!candidate.contract) {
      if (!registryNames.has(name)) recordSkippedDynamicTool(state, name, "missing_contract");
      continue;
    }
    if (candidate.contract.enabled === false) {
      recordSkippedDynamicTool(state, name, "contract_disabled");
      continue;
    }
    if (!isRuntimeToolAllowed(name, input.policy) || !isDocdexToolAllowed(name, input.docdex)) {
      recordSkippedDynamicTool(state, name, "policy_disallowed");
      continue;
    }
    if (registryNames.has(name)) {
      recordSkippedDynamicTool(state, name, "already_registered");
      continue;
    }

    const readOnly = contractBoolean(candidate.contract, "readOnly", "read_only");
    if (readOnly === false) {
      recordSkippedDynamicTool(state, name, "not_read_only");
      continue;
    }

    const executionMode =
      contractString(candidate.contract, "executionMode", "execution_mode") ??
      "server_supplied_snapshot_plus_docdex";
    const gateway = resolveGatewayContract(candidate.contract, input.policy.appToolGateway);
    const resolvedGatewayEndpoint = gatewayEndpoint(gateway);
    if (executionMode === "app_tool_gateway" || resolvedGatewayEndpoint) {
      if (!gateway) {
        recordSkippedDynamicTool(state, name, "gateway_not_configured");
        continue;
      }
      if (readOnly !== true) {
        recordSkippedDynamicTool(state, name, "not_read_only");
        continue;
      }
      if (gatewayBoolean(gateway, ["readOnly", "read_only"]) !== true) {
        recordSkippedDynamicTool(state, name, "gateway_not_read_only");
        continue;
      }
      if (!resolvedGatewayEndpoint) {
        recordSkippedDynamicTool(state, name, "gateway_endpoint_missing");
        continue;
      }
      if (!gatewaySigningSecret(gateway)) {
        recordSkippedDynamicTool(state, name, "gateway_signature_missing");
        continue;
      }
      registerRuntimeTool(
        registry,
        createGatewayDynamicTool({
          name,
          contract: candidate.contract,
          gateway: { ...gateway, endpoint: resolvedGatewayEndpoint },
          input,
          state,
        }),
        input.policy,
        input.docdex,
      );
      registryNames.add(name);
      pushUnique(state.registeredDynamicTools, name);
      continue;
    }

    const declaredBackingTools = contractStringArray(
      candidate.contract,
      "backingTools",
      "backing_tools",
    );
    if (!declaredBackingTools.length) {
      recordSkippedDynamicTool(state, name, "missing_backing_tools");
      continue;
    }
    const unsafeBackingTool = declaredBackingTools.find((toolName) => !READ_ONLY_DYNAMIC_BACKING_TOOLS.has(toolName));
    if (unsafeBackingTool) {
      recordSkippedDynamicTool(state, name, `unsafe_backing_tool:${unsafeBackingTool}`);
      continue;
    }
    const availableBackingTools = declaredBackingTools.filter((toolName) => registryNames.has(toolName));
    if (!availableBackingTools.length) {
      recordSkippedDynamicTool(state, name, "backing_tool_unavailable");
      continue;
    }

    registerRuntimeTool(
      registry,
      createDocdexBackedDynamicTool({
        name,
        contract: candidate.contract,
        registry,
        backingTools: availableBackingTools,
        state,
      }),
      input.policy,
      input.docdex,
    );
    registryNames.add(name);
    pushUnique(state.registeredDynamicTools, name);
  }

  const warningSkips = state.skippedDynamicTools.filter((entry) => entry.reason !== "already_registered");
  if (warningSkips.length) {
    warnings.push(
      `Runtime tool contracts skipped: ${warningSkips
        .map((entry) => `${entry.name}:${entry.reason}`)
        .join(", ")}`,
    );
  }
};

const buildRuntimeToolRegistry = (
  input: CodaliRuntimeInput,
  dynamicToolState: DynamicToolRegistryState,
  warnings: string[],
): ToolRegistry => {
  if (input.toolRegistry) {
    registerRuntimeContractTools(input.toolRegistry, input, dynamicToolState, warnings);
    return input.toolRegistry;
  }
  const registry = new ToolRegistry();
  const register = (tool: ToolDefinition) => registerRuntimeTool(registry, tool, input.policy, input.docdex);
  const explicitTools = input.tools;
  if (explicitTools) {
    for (const tool of explicitTools) register(tool);
    registerRuntimeContractTools(registry, input, dynamicToolState, warnings);
    return registry;
  }

  for (const tool of createFileTools()) register(tool);
  register(createDiffTool());
  register(createSearchTool());
  if (input.policy.allowShell) {
    register(createShellTool());
  }

  const immutableDocdexContext = isImmutableDocdexRuntimeContext(input.docdex);
  const docdexClient = new DocdexClient({
    baseUrl: immutableDocdexContext
      ? input.docdex?.baseUrl ?? ""
      : input.docdex?.baseUrl ?? DEFAULT_DOCDEX_BASE_URL,
    repoId: input.docdex?.repoId,
    repoRoot: immutableDocdexContext
      ? undefined
      : input.docdex?.repoRoot ?? input.workspace.root,
    dagSessionId: input.docdex?.dagSessionId ?? input.metadata?.requestId,
    apiKey: input.docdex?.apiKey,
    clientIdentity: input.docdex?.clientIdentity,
    credentialSource: input.docdex?.credentialSource,
    required: input.docdex?.required,
    allowedOperations: input.docdex?.allowedOperations,
    capabilities: input.docdex?.capabilities,
    immutableRuntimeContext: immutableDocdexContext,
  });
  for (const tool of createDocdexTools(docdexClient)) register(tool);
  registerRuntimeContractTools(registry, input, dynamicToolState, warnings);
  return registry;
};

const buildResponseFormat = (
  response: CodaliRuntimeInput["response"],
): ProviderResponseFormat | undefined => {
  if (!response?.format) return undefined;
  return {
    type: response.format,
    schema: response.schema,
    grammar: response.grammar,
  };
};

interface RuntimeSessionState {
  store: SessionStore;
  metadata: CodaliSessionMetadata;
  resumeBundle?: CodaliResumeBundle;
  instructionBlocks: InstructionBlock[];
}

const initializeRuntimeSession = async (
  input: CodaliRuntimeInput,
  runId: string,
  warnings: string[],
): Promise<RuntimeSessionState | undefined> => {
  if (!input.session) return undefined;
  const store = new SessionStore({
    workspaceRoot: input.workspace.root,
    storageDir: input.session.storageDir,
  });
  const instructionBlocks =
    input.session.loadInstructions === false
      ? []
      : await loadInstructionBlocks({
          workspaceRoot: input.workspace.root,
          focusPaths: input.session.focusPaths,
          includeLocal: input.session.includeLocalInstructions,
        }).catch((error) => {
          warnings.push(`Instruction loading failed: ${error instanceof Error ? error.message : String(error)}`);
          return [];
        });
  const instructionSources = instructionBlocks.map((block) => block.sourcePath);
  const metadata = await store.getOrCreateSession({
    sessionId: input.session.id,
    repoRoot: input.workspace.root,
    task: input.task,
    instructionSources,
  });
  const updatedSources = Array.from(new Set([...metadata.instructionSources, ...instructionSources]));
  const updated = await store.updateSession(metadata.sessionId, {
    status: "active",
    instructionSources: updatedSources,
  });
  await store.addRun(updated.sessionId, runId);
  await store.appendTranscript(updated.sessionId, {
    type: "run_started",
    runId,
    data: {
      task: input.task,
      mode: input.policy.mode,
      agent: input.agent?.slug,
      model: input.provider.model,
    },
  });
  return {
    store,
    metadata: await store.readSession(updated.sessionId),
    resumeBundle:
      input.session.resume && input.session.id
        ? await store.buildResumeBundle(updated.sessionId, { recentEvents: 12 })
        : undefined,
    instructionBlocks,
  };
};

const appendSessionEvent = async (
  session: RuntimeSessionState | undefined,
  runId: string,
  type: Parameters<SessionStore["appendTranscript"]>[1]["type"],
  data: Record<string, unknown>,
  warnings: string[],
): Promise<void> => {
  if (!session) return;
  try {
    await session.store.appendTranscript(session.metadata.sessionId, { type, runId, data });
  } catch (error) {
    warnings.push(`Session transcript write failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const compactRuntimeSession = async (
  session: RuntimeSessionState | undefined,
  finalStatus: CodaliSessionMetadata["status"],
  warnings: string[],
): Promise<CodaliSessionMetadata | undefined> => {
  if (!session) return undefined;
  try {
    if (session.store && session.metadata.sessionId) {
      if (session.metadata.status !== finalStatus) {
        await session.store.updateSession(session.metadata.sessionId, { status: finalStatus });
      }
      if (finalStatus !== "active") {
        await session.store.compactSession(session.metadata.sessionId);
      }
      return session.store.readSession(session.metadata.sessionId);
    }
  } catch (error) {
    warnings.push(`Session compaction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return session.metadata;
};

const runtimeToolNamesForProtocolTools = (tools: string[] | undefined): string[] | undefined => {
  if (!tools?.length) return undefined;
  const names = new Set<string>();
  for (const tool of tools) {
    const trimmed = tool.trim();
    if (!trimmed) continue;
    for (const runtimeName of PROTOCOL_TO_RUNTIME_TOOL_NAMES.get(trimmed) ?? [trimmed]) {
      names.add(runtimeName);
    }
  }
  return Array.from(names).sort();
};

const isSubagentDelegationEnabled = (input: CodaliRuntimeInput): boolean => {
  return input.subagents?.enabled !== false;
};

const subagentSpecFromNeed = (need: Extract<NormalizedNeed, { tool: "agent.delegate" }>): SubagentSpec => ({
  role: need.params.role as SubagentRole,
  goal: need.params.goal,
  tools: need.params.tools,
  permissions: {
    readOnly: need.params.read_only ?? need.params.role !== "worker",
    allowedPaths: need.params.allowed_paths,
    writePaths: need.params.write_paths,
  },
  maxSteps: need.params.max_steps,
  maxToolCalls: need.params.max_tool_calls,
  timeoutMs: need.params.timeout_ms,
});

const toSessionSummary = (
  session: CodaliSessionMetadata | undefined,
): CodaliRuntimeResult["session"] | undefined => {
  if (!session) return undefined;
  return {
    id: session.sessionId,
    summaryRefs: session.summaryRefs,
    instructionSources: session.instructionSources,
  };
};

const normalizeAgentEvent = (event: AgentEvent, id: string, at: string): CodaliRuntimeEvent => {
  if (event.type === "token") {
    return { type: "token", content: event.content, at };
  }
  if (event.type === "status") {
    return { type: "status", phase: event.phase, message: event.message, at };
  }
  if (event.type === "tool_call") {
    return { type: "tool_call", id, name: event.name, args: event.args, at };
  }
  if (event.type === "tool_result") {
    return {
      type: "tool_result",
      id,
      name: event.name,
      ok: event.ok ?? true,
      output: event.output,
      errorCode: event.errorCode,
      retryable: event.retryable,
      at,
    };
  }
  return { type: "error", message: event.message, at };
};

export const codaliEventToOpenAIChatCompletionChunk = (
  event: CodaliRuntimeEvent,
  options: CodaliOpenAIChunkOptions,
): Record<string, unknown> | null => {
  const id = options.id ?? `chatcmpl-${options.requestId ?? "codali"}`;
  const created = options.created ?? Math.floor(Date.now() / 1000);
  if (event.type === "token") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          delta: { content: event.content },
          finish_reason: null,
        },
      ],
    };
  }
  if (event.type === "final") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };
  }
  if (!options.includeInternalEvents) {
    return null;
  }
  if (event.type === "status") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      metadata: {
        event: "status",
        phase: event.phase,
        message: event.message,
        at: event.at,
      },
    };
  }
  if (event.type === "tool_call" || event.type === "tool_result") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      metadata: {
        event: event.type,
        id: event.id,
        name: event.name,
        ok: event.type === "tool_result" ? event.ok : undefined,
        error_code: event.type === "tool_result" ? event.errorCode : undefined,
        at: event.at,
      },
    };
  }
  if (event.type === "subagent_start" || event.type === "subagent_result") {
    return {
      id,
      object: "chat.completion.chunk",
      created,
      model: options.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: null,
        },
      ],
      metadata: {
        event: event.type,
        id: event.id,
        role: event.role,
        status: event.type === "subagent_result" ? event.status : undefined,
        summary: event.type === "subagent_result" ? event.summary : undefined,
        at: event.at,
      },
    };
  }
  return null;
};

export const codaliEventToOpenAISseData = (
  event: CodaliRuntimeEvent,
  options: CodaliOpenAIChunkOptions,
): string | null => {
  const chunk = codaliEventToOpenAIChatCompletionChunk(event, options);
  return chunk ? `data: ${JSON.stringify(chunk)}\n\n` : null;
};

const emitRuntimeEvent = (
  event: CodaliRuntimeEvent,
  sink: CodaliRuntimeInput["onEvent"],
  warnings: string[],
): void => {
  try {
    const maybePromise = sink?.(event);
    if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
      (maybePromise as Promise<void>).catch((error) => {
        warnings.push(error instanceof Error ? error.message : String(error));
      });
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
};

const buildRuntimeTelemetry = (options: {
  input: CodaliRuntimeInput;
  runId: string;
  toolCallsExecuted: number;
  events: CodaliRuntimeEvent[];
  warnings: string[];
  dynamicToolState: DynamicToolRegistryState;
}): CodaliRuntimeTelemetry => {
  const calledTools: string[] = [];
  for (const event of options.events) {
    if (event.type === "tool_call") pushUnique(calledTools, event.name);
  }
  return {
    runId: options.runId,
    runtime: "codali",
    mode: options.input.policy.mode,
    toolCallCount: options.toolCallsExecuted,
    calledTools,
    consideredTools: [...options.dynamicToolState.consideredTools],
    registeredDynamicTools: [...options.dynamicToolState.registeredDynamicTools],
    skippedDynamicTools: [...options.dynamicToolState.skippedDynamicTools],
    dynamicToolCalls: [...options.dynamicToolState.dynamicToolCalls],
    warnings: [...options.warnings],
  };
};

const createSubagentRunner = (options: {
  input: CodaliRuntimeInput;
  registry: ToolRegistry;
  toolContext: ToolContext;
  runId: string;
  remainingToolBudget: number;
}): ConstructorParameters<typeof SubagentOrchestrator>[0]["runner"] => {
  const { input, registry, toolContext, runId, remainingToolBudget } = options;
  return async ({ spec }) => {
    const readOnly = spec.permissions?.readOnly ?? spec.role !== "worker";
    const allowedTools = runtimeToolNamesForProtocolTools(
      spec.tools ?? input.subagents?.defaultTools,
    );
    const maxToolCalls = Math.max(
      0,
      Math.min(spec.maxToolCalls ?? remainingToolBudget, remainingToolBudget),
    );
    const childRunId = `${runId}:${spec.id}`;
    const mode =
      input.policy.mode === "freeform"
        ? "freeform"
        : input.agent?.supportsTools === false
          ? "protocol_loop"
          : "tool_loop";
    const result = await runCodaliTask({
      ...input,
      task: spec.goal,
      messages: [
        {
          role: "user",
          content: [
            `You are a Codali ${spec.role} subagent.`,
            `Goal: ${spec.goal}`,
            readOnly
              ? "Work read-only. Do not request writes or destructive operations."
              : `Write scope: ${(spec.permissions?.writePaths ?? []).join(", ") || "none declared"}`,
            "Use available tools when needed and return a concise handoff with findings, evidence, and blockers.",
          ].join("\n"),
        },
      ],
      policy: {
        ...input.policy,
        mode,
        allowWrites:
          input.policy.allowWrites &&
          input.subagents?.allowWrites === true &&
          !readOnly &&
          (spec.permissions?.writePaths?.length ?? 0) > 0,
        allowShell: false,
        allowDestructiveOperations: false,
        allowOutsideWorkspace: false,
        allowedTools,
        maxSteps: Math.max(1, Math.min(spec.maxSteps ?? 6, input.policy.maxSteps)),
        maxToolCalls,
        timeoutMs: spec.timeoutMs ?? input.subagents?.defaultTimeoutMs ?? Math.min(input.policy.timeoutMs, 120_000),
      },
      metadata: {
        ...input.metadata,
        requestId: childRunId,
      },
      providerInstance: input.providerInstance,
      toolRegistry: undefined,
      tools: registry.list(),
      toolContext: {
        ...toolContext,
        runId: childRunId,
        allowedReadPaths: spec.permissions?.allowedPaths,
        allowedWritePaths: spec.permissions?.writePaths,
      },
      subagents: { enabled: false },
      session: undefined,
      onEvent: undefined,
      logger: input.logger,
    });
    return {
      output: result.finalMessage,
      toolCallsExecuted: result.toolCallsExecuted,
      touchedFiles: result.touchedFiles,
      warnings: result.warnings,
      metadata: { runId: result.runId },
    };
  };
};

const executeDelegatedNeed = async (options: {
  need: Extract<NormalizedNeed, { tool: "agent.delegate" }>;
  input: CodaliRuntimeInput;
  registry: ToolRegistry;
  toolContext: ToolContext;
  runId: string;
  remainingToolBudget: number;
  emit: (event: CodaliRuntimeEvent) => void;
}): Promise<{ result: CodaliResponseResult; subagentResults: SubagentResult[] }> => {
  const { need, input, registry, toolContext, runId, remainingToolBudget, emit } = options;
  const spec = subagentSpecFromNeed(need);
  if (!isSubagentDelegationEnabled(input)) {
    const result: SubagentResult = {
      id: "delegation-disabled",
      role: spec.role ?? "explorer",
      goal: spec.goal,
      status: "failed",
      summary: "Subagent delegation is disabled for this run.",
      output: "",
      toolCallsExecuted: 0,
      touchedFiles: [],
      warnings: [],
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
      error: "subagent_delegation_disabled",
    };
    return {
      result: {
        type: "agent.delegate",
        role: spec.role ?? "explorer",
        goal: spec.goal,
        results: [compactSubagentResultForProtocol(result)],
      },
      subagentResults: [result],
    };
  }
  const orchestrator = new SubagentOrchestrator({
    parentRunId: runId,
    maxParallel: input.subagents?.maxParallel ?? 2,
    maxSubagents: input.subagents?.maxSubagents ?? 4,
    defaultTimeoutMs: input.subagents?.defaultTimeoutMs ?? Math.min(input.policy.timeoutMs, 120_000),
    runner: createSubagentRunner({ input, registry, toolContext, runId, remainingToolBudget }),
    onEvent: (event) => {
      if (event.type === "subagent_start" && event.spec) {
        emit({
          type: "subagent_start",
          id: event.spec.id ?? event.spec.role,
          role: event.spec.role,
          goal: event.spec.goal,
          at: new Date().toISOString(),
        });
      }
      if (event.type === "subagent_result" && event.result) {
        emit({
          type: "subagent_result",
          id: event.result.id,
          role: event.result.role,
          status: event.result.status,
          summary: event.result.summary,
          at: new Date().toISOString(),
        });
      }
    },
  });
  const subagentResults = await orchestrator.run([spec]);
  return {
    result: {
      type: "agent.delegate",
      role: spec.role ?? "explorer",
      goal: spec.goal,
      results: subagentResults.map((result) => compactSubagentResultForProtocol(result)),
    },
    subagentResults,
  };
};

interface ProtocolLoopResult {
  finalMessage: ProviderMessage;
  messages: ProviderMessage[];
  toolCallsExecuted: number;
  usage?: ProviderUsage;
}

const runProtocolLoop = async (options: {
  input: CodaliRuntimeInput;
  provider: Provider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  runId: string;
  session?: RuntimeSessionState;
  warnings: string[];
  emit: (event: CodaliRuntimeEvent) => void;
  emitAgentEvent: (event: AgentEvent) => void;
}): Promise<ProtocolLoopResult> => {
  const { input, provider, registry, toolContext, runId, session, warnings, emit, emitAgentEvent } =
    options;
  const messages: ProviderMessage[] = [
    {
      role: "system",
      content: buildProtocolSystemPrompt(registry, {
        allowDelegation: isSubagentDelegationEnabled(input),
        resumeBundle: session?.resumeBundle,
        instructionBlocks: session?.instructionBlocks,
      }),
    },
    ...(input.messages ?? [{ role: "user", content: input.task }]),
  ];
  let toolCallsExecuted = 0;
  let usageTotals: ProviderUsage | undefined;
  const deadline = input.policy.timeoutMs ? Date.now() + input.policy.timeoutMs : undefined;

  if (input.response?.format) {
    warnings.push("protocol_loop does not enforce provider response_format because it must allow AGENT_REQUEST text turns");
  }

  const timeRemaining = (): number | undefined => {
    if (!deadline) return undefined;
    return deadline - Date.now();
  };

  const throwBudgetError = async (
    code: RunnerBudgetReasonCode,
    step: number,
  ): Promise<never> => {
    const error = new RunnerBudgetError(code, {
      step,
      tool_calls_executed: toolCallsExecuted,
      max_steps: input.policy.maxSteps,
      max_tool_calls: input.policy.maxToolCalls,
      timeout_ms: input.policy.timeoutMs,
    });
    if (input.logger) {
      await input.logger.log("runner_budget_failure", error.metadata);
    }
    throw error;
  };

  const withTimeout = async <T>(promise: Promise<T>, step: number): Promise<T> => {
    const remaining = timeRemaining();
    if (remaining === undefined) return promise;
    if (remaining <= 0) {
      await throwBudgetError("runner_timeout_exceeded", step);
    }
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Runner timeout exceeded")), remaining);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } catch (error) {
      if (error instanceof Error && /Runner timeout exceeded/i.test(error.message)) {
        await throwBudgetError("runner_timeout_exceeded", step);
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  };

  for (let step = 0; step < input.policy.maxSteps; step += 1) {
    if (deadline && timeRemaining()! <= 0) {
      await throwBudgetError("runner_timeout_exceeded", step);
    }
    emit({ type: "status", phase: "thinking", at: new Date().toISOString() });
    if (input.logger) {
      await input.logger.log("provider_request", {
        provider: provider.name,
        protocolLoop: true,
        messages,
        tools: [],
        toolChoice: "none",
        temperature: undefined,
        maxTokens: input.policy.maxTokens,
        stream: input.streaming?.enabled ?? false,
      });
    }
    await appendSessionEvent(
      session,
      runId,
      "provider_request",
      {
        provider: provider.name,
        protocolLoop: true,
        messages,
        maxTokens: input.policy.maxTokens,
      },
      warnings,
    );
    const response = await withTimeout(
      provider.generate({
        messages: [...messages],
        maxTokens: input.policy.maxTokens,
        stream: input.streaming?.enabled,
        onEvent: emitAgentEvent,
        onToken: (token) => emitAgentEvent({ type: "token", content: token }),
        streamFlushMs: input.streaming?.flushEveryMs,
      }),
      step,
    );

    usageTotals = mergeUsage(usageTotals, response.usage);
    messages.push(response.message);
    if (input.logger) {
      await input.logger.log("provider_response", {
        protocolLoop: true,
        message: response.message,
        usage: response.usage,
      });
    }
    await appendSessionEvent(
      session,
      runId,
      "provider_response",
      { protocolLoop: true, message: response.message, usage: response.usage },
      warnings,
    );

    const requestText = extractAgentRequestText(response.message.content);
    if (!requestText) {
      return {
        finalMessage: response.message,
        messages,
        toolCallsExecuted,
        usage: usageTotals,
      };
    }

    let request;
    try {
      request = parseAgentRequest(requestText, { defaultRequestId: `${runId}:step-${step}` });
    } catch (error) {
      const warning = `Invalid AGENT_REQUEST: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(warning);
      messages.push({
        role: "user",
        content: formatCodaliResponse({
          version: "v1",
          request_id: "invalid",
          results: [],
          meta: {
            repo_root: input.workspace.root,
            warnings: [warning, "Return a valid AGENT_REQUEST v1 or answer normally."],
          },
        }),
      });
      continue;
    }

    const responseWarnings: string[] = [];
    const results: CodaliResponseResult[] = [];
    const needs = normalizeAgentRequest(request);
    for (let index = 0; index < needs.length; index += 1) {
      if (toolCallsExecuted >= input.policy.maxToolCalls) {
        await throwBudgetError("runner_tool_call_limit_exceeded", step);
      }
      const normalizedNeed = needs[index]!;
      if (normalizedNeed.tool === "agent.delegate") {
        const callId = `${request.request_id}:${index + 1}`;
        toolCallsExecuted += 1;
        emit({
          type: "tool_call",
          id: callId,
          name: "agent.delegate",
          args: normalizedNeed.params,
          at: new Date().toISOString(),
        });
        const delegation = await withTimeout(
          executeDelegatedNeed({
            need: normalizedNeed,
            input,
            registry,
            toolContext,
            runId,
            remainingToolBudget: Math.max(0, input.policy.maxToolCalls - toolCallsExecuted),
            emit,
          }),
          step,
        );
        const nestedToolCalls = delegation.subagentResults.reduce(
          (sum, result) => sum + result.toolCallsExecuted,
          0,
        );
        toolCallsExecuted += nestedToolCalls;
        if (toolCallsExecuted > input.policy.maxToolCalls) {
          await throwBudgetError("runner_tool_call_limit_exceeded", step);
        }
        emit({
          type: "tool_result",
          id: callId,
          name: "agent.delegate",
          ok: delegation.subagentResults.every((result) => result.status === "completed"),
          output: JSON.stringify(delegation.subagentResults, null, 2),
          at: new Date().toISOString(),
        });
        await appendSessionEvent(
          session,
          runId,
          "subagent_result",
          {
            role: normalizedNeed.params.role,
            goal: normalizedNeed.params.goal,
            results: delegation.subagentResults,
          },
          warnings,
        );
        results.push(delegation.result);
        continue;
      }
      const execution = protocolToolExecutionForNeed(needs[index]!, input, runId);
      const callId = `${request.request_id}:${index + 1}`;
      toolCallsExecuted += 1;
      emit({
        type: "status",
        phase: "executing",
        message: execution.toolName,
        at: new Date().toISOString(),
      });
      emit({
        type: "tool_call",
        id: callId,
        name: execution.toolName,
        args: execution.args,
        at: new Date().toISOString(),
      });
      const toolResult = await withTimeout(
        registry.execute(execution.toolName, execution.args, toolContext),
        step,
      );
      const content = toolResultContent(toolResult);
      emit({
        type: "tool_result",
        id: callId,
        name: execution.toolName,
        ok: toolResult.ok,
        output: content,
        errorCode: toolResult.error?.code,
        retryable: toolResult.error?.retryable,
        at: new Date().toISOString(),
      });
      if (input.logger) {
        await input.logger.log("tool_call", {
          protocolLoop: true,
          name: execution.toolName,
          logical_tool: execution.need.tool,
          ok: toolResult.ok,
          error: toolResult.error?.message,
          error_code: toolResult.error?.code,
          error_category: toolResult.error?.category,
          error_retryable: toolResult.error?.retryable,
          error_details: toolResult.error?.details,
        });
      }
      await appendSessionEvent(
        session,
        runId,
        "tool_result",
        {
          name: execution.toolName,
          logical_tool: execution.need.tool,
          ok: toolResult.ok,
          error: toolResult.error?.message,
          output: content,
        },
        warnings,
      );
      results.push(protocolResultFromToolResult(execution, toolResult, responseWarnings));
    }

    const codaliResponse: CodaliResponse = {
      version: "v1",
      request_id: request.request_id,
      results,
      meta: responseWarnings.length
        ? { repo_root: input.workspace.root, warnings: responseWarnings }
        : { repo_root: input.workspace.root },
    };
    warnings.push(...responseWarnings);
    await appendSessionEvent(
      session,
      runId,
      "codali_response",
      { request_id: request.request_id, results, warnings: responseWarnings },
      warnings,
    );
    messages.push({ role: "user", content: formatCodaliResponse(codaliResponse) });
  }

  await throwBudgetError("runner_step_limit_exceeded", input.policy.maxSteps);
  throw new Error("unreachable_protocol_loop_budget_path");
};

export interface CodaliRuntime {
  run(): Promise<CodaliRuntimeResult>;
}

export const createCodaliRuntime = (input: CodaliRuntimeInput): CodaliRuntime => ({
  run: () => runCodaliTask(input),
});

export const runCodaliTask = async (input: CodaliRuntimeInput): Promise<CodaliRuntimeResult> => {
  const runId = input.metadata?.requestId ?? randomUUID();
  const touchedFiles = new Set<string>();
  const warnings: string[] = [];
  const events: CodaliRuntimeEvent[] = [];
  const dynamicToolState = createDynamicToolRegistryState();
  let eventSequence = 0;
  const session = await initializeRuntimeSession(input, runId, warnings);

  const emit = (event: CodaliRuntimeEvent) => {
    events.push(event);
    emitRuntimeEvent(event, input.onEvent, warnings);
  };

  const provider = input.providerInstance ?? createRuntimeProvider(input.provider);
  const registry = buildRuntimeToolRegistry(input, dynamicToolState, warnings);
  const originalRecordTouchedFile = input.toolContext?.recordTouchedFile;
  const toolContext: ToolContext = {
    ...input.toolContext,
    workspaceRoot: input.workspace.root,
    runId: input.toolContext?.runId ?? runId,
    allowOutsideWorkspace: input.policy.allowOutsideWorkspace,
    allowShell: input.policy.allowShell,
    allowDestructiveOperations: input.policy.allowDestructiveOperations,
    recordTouchedFile: (filePath: string) => {
      touchedFiles.add(filePath);
      originalRecordTouchedFile?.(filePath);
    },
  };

  if (input.policy.mode === "smart_pipeline") {
    warnings.push("CodaliRuntime smart_pipeline mode is not implemented in the direct runtime wrapper yet");
  }
  if (input.policy.mode === "patch_json") {
    warnings.push("CodaliRuntime patch_json mode is running as a direct no-tool provider call");
  }

  const emitAgentEvent = (event: AgentEvent) => {
    eventSequence += 1;
    emit(normalizeAgentEvent(event, `event-${eventSequence}`, new Date().toISOString()));
  };

  if (input.policy.mode === "protocol_loop") {
    try {
      const result = await runProtocolLoop({
        input,
        provider,
        registry,
        toolContext,
        runId,
        session,
        warnings,
        emit,
        emitAgentEvent,
      });
      if (result.usage) {
        emit({ type: "usage", usage: result.usage, at: new Date().toISOString() });
      }
      emit({
        type: "final",
        content: result.finalMessage.content,
        at: new Date().toISOString(),
      });
      await appendSessionEvent(session, runId, "final", { content: result.finalMessage.content }, warnings);
      const finalSession = await compactRuntimeSession(session, "completed", warnings);
      return {
        finalMessage: result.finalMessage.content,
        messages: result.messages,
        toolCallsExecuted: result.toolCallsExecuted,
        usage: result.usage,
        touchedFiles: Array.from(touchedFiles),
        warnings,
        events,
        runId,
        telemetry: buildRuntimeTelemetry({
          input,
          runId,
          toolCallsExecuted: result.toolCallsExecuted,
          events,
          warnings,
          dynamicToolState,
        }),
        session: toSessionSummary(finalSession),
      };
    } catch (error) {
      emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error ? error.name : undefined,
        at: new Date().toISOString(),
      });
      await appendSessionEvent(
        session,
        runId,
        "error",
        { message: error instanceof Error ? error.message : String(error) },
        warnings,
      );
      await compactRuntimeSession(session, "failed", warnings);
      throw error;
    }
  }

  const runner = new Runner({
    provider,
    tools: registry,
    context: toolContext,
    maxSteps: input.policy.maxSteps,
    maxToolCalls: input.policy.maxToolCalls,
    maxTokens: input.policy.maxTokens,
    timeoutMs: input.policy.timeoutMs,
    stream: input.streaming?.enabled,
    streamFlushMs: input.streaming?.flushEveryMs,
    responseFormat: buildResponseFormat(input.response),
    toolChoice: input.policy.mode === "tool_loop" ? "auto" : "none",
    logger: input.logger,
    onEvent: emitAgentEvent,
  });

  try {
    const result = await runner.run(input.messages ?? [{ role: "user", content: input.task }]);
    if (result.usage) {
      emit({ type: "usage", usage: result.usage, at: new Date().toISOString() });
    }
    emit({
      type: "final",
      content: result.finalMessage.content,
      at: new Date().toISOString(),
    });
    await appendSessionEvent(session, runId, "final", { content: result.finalMessage.content }, warnings);
    const finalSession = await compactRuntimeSession(session, "completed", warnings);
    return {
      finalMessage: result.finalMessage.content,
      messages: result.messages,
      toolCallsExecuted: result.toolCallsExecuted,
      usage: result.usage,
      touchedFiles: Array.from(touchedFiles),
      warnings,
      events,
      runId,
      telemetry: buildRuntimeTelemetry({
        input,
        runId,
        toolCallsExecuted: result.toolCallsExecuted,
        events,
        warnings,
        dynamicToolState,
      }),
      session: toSessionSummary(finalSession),
    };
  } catch (error) {
    emit({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof Error ? error.name : undefined,
      at: new Date().toISOString(),
    });
    await appendSessionEvent(
      session,
      runId,
      "error",
      { message: error instanceof Error ? error.message : String(error) },
      warnings,
    );
    await compactRuntimeSession(session, "failed", warnings);
    throw error;
  }
};
