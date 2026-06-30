import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { cpus, freemem, hostname, homedir, loadavg, platform, totalmem, userInfo } from "node:os";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { GlobalRepository } from "@mcoda/db";
import {
  MswarmCodaliExecutor,
  type LocalOpenAiCompatibleRunnerConfig,
  type MswarmCodaliAgent,
  type MswarmCodaliDocdex,
  type MswarmCodaliPolicy,
  type MswarmCodaliWorkspace
} from "./codali-executor.js";
import {
  MSWARM_CAPABILITY_SCHEMA_VERSION,
  CryptoHelper,
  assertMswarmSafeRelativePath,
  validateMswarmArchiveEntry,
  buildMswarmCapabilityNames,
  buildMswarmPrivateCapabilityCatalogEntry,
  buildMswarmLocalArtifactUri,
  buildMswarmSandboxProfile,
  defaultMswarmArtifactAccessPolicy,
  defaultMswarmArtifactRetentionPolicy,
  projectMswarmPublicCapabilities,
  validateMswarmGenericJobRequest,
  type MswarmArtifactStoreDescriptor,
  type MswarmGpuCapabilityProbe,
  type MswarmGpuDeviceCapability,
  type MswarmGenericJobValidationIssue,
  type MswarmJobType,
  type MswarmJobEvent,
  type MswarmJobPolicy,
  type MswarmJobRequest,
  type MswarmJobResult,
  type MswarmNodeCapabilitySnapshot,
  type MswarmOutputSpec,
  type MswarmPublicCapabilityProjection,
  type MswarmRegisteredArtifact,
  type MswarmRegisteredJobCatalogEntry,
  type MswarmRunnerCatalogCapability,
  type MswarmSandboxProfile,
  type MswarmSignedCapabilityPayload,
  type MswarmSoftwareProbeName,
  type MswarmSoftwareProbeResult
} from "@mcoda/shared";

export type FetchLike = typeof fetch;
export type SelfHostedDiscoveryMode = "mcoda" | "ollama";
export type SelfHostedRelayMode = "outbound" | "direct";
export type SelfHostedExposurePolicy = "all" | "none";
export type SelfHostedNodeClientKind = "domain" | "ip" | "uuid";
export type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number; input?: string; signal?: AbortSignal }
) => Promise<{ stdout: string; stderr: string }>;
export type SelfHostedModelHealthStatus = "healthy" | "degraded" | "unreachable" | "unknown" | "blocked";

export interface SelfHostedNodeClientIdentity {
  kind: SelfHostedNodeClientKind;
  value: string;
  added_at?: string;
}

export interface SelfHostedModelInput {
  name: string;
  provider?: "mcoda" | "ollama";
  adapter?: string | null;
  model?: string | null;
  source_agent_id?: string | null;
  source_agent_slug?: string | null;
  model_id?: string | null;
  base_url?: string | null;
  runner_kind?: string | null;
  auth_mode?: string | null;
  response_format_strategy?: string | null;
  health_path?: string | null;
  models_path?: string | null;
  display_name?: string | null;
  digest?: string | null;
  exposed?: boolean;
  family?: string | null;
  parameter_size?: string | null;
  quantization_level?: string | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  supports_tools?: boolean;
  supports_streaming?: boolean;
  supports_vision?: boolean;
  supports_json_schema?: boolean;
  supports_gbnf?: boolean;
  openai_compatible?: boolean;
  best_usage?: string | null;
  capabilities?: string[];
  cost_per_million?: number | null;
  rating?: number | null;
  rating_source?: string | null;
  reasoning_rating?: number | null;
  max_complexity?: number | null;
  health_status?: SelfHostedModelHealthStatus;
  metadata_quality?: string | null;
}

export interface SelfHostedNodeConfig {
  gatewayBaseUrl: string;
  jobsPollPath?: string | null;
  jobsStartPathTemplate?: string | null;
  jobsEventsPathTemplate?: string | null;
  jobsResultPathTemplate?: string | null;
  nodeId: string;
  serverName?: string | null;
  relayMode?: SelfHostedRelayMode;
  machineFingerprint?: string | null;
  directBaseUrl?: string | null;
  enrollmentToken?: string | null;
  runtimeToken?: string | null;
  discoveryMode: SelfHostedDiscoveryMode;
  mcodaBin: string;
  mcodaListArgs: string[];
  ollamaBaseUrl: string;
  statePath: string;
  runtimeTokenPath: string;
  artifactStorePath?: string;
  invocationSigningSecret?: string | null;
  listenHost: string;
  listenPort: number;
  nodeVersion: string;
  heartbeatIntervalSeconds: number;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  maxConcurrentJobs?: number;
  maxConcurrentLlmJobs?: number;
  genericJobsEnabled: boolean;
  genericJobTimeoutMs: number;
  genericJobMaxConcurrency: number;
  capabilityProbeTimeoutMs?: number;
  drainMode?: boolean;
  loadReportingEnabled?: boolean;
  hardwareTelemetryEnabled?: boolean;
  exposeAllModels: boolean;
  modelAllowlist: string[];
  modelBlocklist: string[];
  clientAllowlist: SelfHostedNodeClientIdentity[];
}

export interface SelfHostedNodeState {
  node_id?: string;
  server_name?: string;
  relay_mode?: SelfHostedRelayMode;
  machine_fingerprint?: string;
  direct_base_url?: string | null;
  runtime_token?: string;
  artifact_store_path?: string;
  config_version?: number;
  heartbeat_interval_seconds?: number;
  heartbeat_timeout_seconds?: number;
  enrolled_at?: string;
  updated_at?: string;
  gateway_base_url?: string;
  jobs_poll_path?: string;
  jobs_start_path_template?: string;
  jobs_events_path_template?: string;
  jobs_result_path_template?: string;
  lifecycle_health_status?: "healthy" | "degraded" | "unreachable";
  lifecycle_health_reason?: string;
  lifecycle_health_message?: string;
  lifecycle_health_updated_at?: string;
  ollama_base_url?: string;
  discovery_mode?: SelfHostedDiscoveryMode;
  mcoda_bin?: string;
  mcoda_list_args?: string[];
  node_version?: string;
  request_timeout_ms?: number;
  job_timeout_ms?: number;
  max_concurrent_jobs?: number;
  max_concurrent_llm_jobs?: number;
  generic_jobs_enabled?: boolean;
  generic_job_timeout_ms?: number;
  generic_job_max_concurrency?: number;
  capability_probe_timeout_ms?: number;
  drain_mode?: boolean;
  load_reporting_enabled?: boolean;
  hardware_telemetry_enabled?: boolean;
  expose_all_models?: boolean;
  exposure_policy?: SelfHostedExposurePolicy;
  model_allowlist?: string[];
  model_blocklist?: string[];
  client_allowlist?: SelfHostedNodeClientIdentity[];
}

export interface SelfHostedOwnerSetupConfig {
  apiKey: string;
  gatewayBaseUrl: string;
  serverName: string;
  relayMode: SelfHostedRelayMode;
  directBaseUrl?: string | null;
  discoveryMode: SelfHostedDiscoveryMode;
  statePath: string;
  runtimeTokenPath: string;
  artifactStorePath?: string;
  machineIdPath: string;
  mcodaBin: string;
  mcodaListArgs: string[];
  ollamaBaseUrl: string;
  nodeVersion: string;
  heartbeatIntervalSeconds: number;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  maxConcurrentJobs: number;
  maxConcurrentLlmJobs: number;
  genericJobsEnabled: boolean;
  genericJobTimeoutMs: number;
  genericJobMaxConcurrency: number;
  capabilityProbeTimeoutMs?: number;
  drainMode: boolean;
  loadReportingEnabled: boolean;
  hardwareTelemetryEnabled: boolean;
  exposeAllModels: boolean;
  modelAllowlist: string[];
  modelBlocklist: string[];
  clientAllowlist: SelfHostedNodeClientIdentity[];
  start: boolean;
}

export interface GatewayBootstrapResponse {
  created?: boolean;
  enrolled?: boolean;
  node?: {
    node_id?: string;
    server_name?: string;
    relay_mode?: SelfHostedRelayMode;
  };
  runtime_token?: string;
  heartbeat_interval_seconds?: number;
  heartbeat_timeout_seconds?: number;
  config_version?: number;
  relay?: {
    mode?: SelfHostedRelayMode;
    gateway_base_url?: string;
    jobs_poll_path?: string;
    jobs_start_path_template?: string;
    jobs_events_path_template?: string;
    jobs_result_path_template?: string;
  };
}

export interface SelfHostedNodeSetupResult {
  created: boolean;
  nodeId: string;
  serverName: string;
  modelCount: number;
  status: "online" | "degraded";
  statePath: string;
  runtimeTokenPath: string;
  start: boolean;
}

export interface SelfHostedNodeUninstallNotificationResult {
  notified: boolean;
  response?: unknown;
  error?: string;
}

export interface SelfHostedOpenAIChatMessage {
  role: string;
  content: string | Array<{ type: string; text?: string }>;
}

export interface SelfHostedNodeInvocationJob {
  job_id: string;
  request_id: string;
  node_id: string;
  agent_slug: string;
  remote_slug?: string;
  provider?: "mcoda" | "ollama";
  execution_runtime?: "codali" | "raw" | string;
  adapter?: string | null;
  source_agent_slug?: string | null;
  model?: string | null;
  workspace?: {
    root?: string;
    read_only?: boolean;
  };
  docdex?: {
    base_url?: string;
    repo_root?: string;
    repo_id?: string;
    dag_session_id?: string;
    required?: boolean;
    allowed_operations?: string[];
    credential_source?: "attached_mswarm_api_key" | string;
    capabilities?: Record<string, boolean | undefined>;
    initialize?: boolean;
    allow_web?: boolean;
    allow_memory_write?: boolean;
    allow_profile_write?: boolean;
    allow_index_rebuild?: boolean;
  };
  openai_request: {
    model: string;
    messages: SelfHostedOpenAIChatMessage[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stop?: string | string[];
    response_format?: Record<string, unknown> | null;
  };
  policy?: {
    max_runtime_ms?: number;
    max_output_tokens?: number;
    allow_tools?: boolean;
    allow_images?: boolean;
    allowed_tools?: string[];
    denied_tools?: string[];
    allow_shell?: boolean;
    allow_writes?: boolean;
    allow_outside_workspace?: boolean;
    allow_destructive_operations?: boolean;
    max_tool_calls?: number;
  };
}

export interface SelfHostedGenericNodeJob {
  job_id: string;
  request_id: string;
  node_id: string;
  job: MswarmJobRequest;
}

export interface SelfHostedNodeInvocationResult {
  job_id: string;
  request_id: string;
  status: "success" | "failed";
  pre_start_failure?: boolean;
  openai_response?: Record<string, unknown>;
  stream_events?: Record<string, unknown>[];
  progress_events?: Record<string, unknown>[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: {
    code: string;
    message: string;
  };
  timing?: {
    local_latency_ms: number;
  };
}

export interface SelfHostedJobExecutionOptions {
  onOpenAIChunk?: (chunk: Record<string, unknown>) => void | Promise<void>;
  onProgress?: (event: Record<string, unknown>) => void | Promise<void>;
  onStarted?: (event: {
    job_id: string;
    request_id: string;
    node_id: string;
    agent_slug: string;
    source_agent_slug?: string | null;
    model?: string | null;
  }) => void | Promise<void>;
  /**
   * Per-invocation owner key attached by the mswarm execution envelope for
   * encrypted Docdex access. This must never be read from local model/provider
   * agent config or serialized into job/result payloads.
   */
  attachedMswarmApiKey?: string;
}

export interface MswarmGenericJobRunnerContext {
  job: MswarmJobRequest;
  signal: AbortSignal;
  emitEvent: (event: Omit<MswarmJobEvent, "job_id" | "sequence" | "timestamp">) => Promise<void>;
  artifacts: MswarmGenericJobArtifactContext;
  sandbox: MswarmSandboxProfile;
}

export interface MswarmGenericJobRunner {
  readonly id: string;
  run(context: MswarmGenericJobRunnerContext): Promise<MswarmJobResult>;
}

export interface MswarmGenericJobArtifactContext {
  store: MswarmArtifactStoreDescriptor;
  workDir: string;
  inputDir: string;
  outputDir: string;
  registeredInputs: MswarmRegisteredArtifact[];
  outputSpecs: MswarmOutputSpec[];
  sandbox: MswarmSandboxProfile;
}

export interface MswarmGenericJobArtifactStore {
  prepareJobWorkspace(jobId: string, job: MswarmJobRequest): Promise<MswarmGenericJobArtifactContext>;
  collectOutputs(context: MswarmGenericJobArtifactContext, jobId: string): Promise<MswarmRegisteredArtifact[]>;
}

export interface MswarmGenericJobExecutionOptions {
  signal?: AbortSignal;
  onEvent?: (event: MswarmJobEvent) => void | Promise<void>;
}

export interface MswarmGenericJobExecutionResult {
  job_id: string;
  request_id: string;
  status: MswarmJobResult["status"];
  result: MswarmJobResult;
  events: MswarmJobEvent[];
  validation_issues?: MswarmGenericJobValidationIssue[];
  timing: {
    local_latency_ms: number;
  };
}

export type SelfHostedRuntimeExecutionClass = "chat" | "agentic" | "generic_job";

export interface SelfHostedRuntimeExecutionClassCapacity {
  max_concurrency: number;
  active_jobs: number;
  queued_jobs: number;
  free_slots: number;
}

export interface SelfHostedRuntimeLoadTelemetry {
  runtime_protocol_version: number;
  load_balancer_protocol_version: number;
  catalog_metadata_version: number;
  catalog_fingerprint: string;
  max_concurrency: number;
  max_concurrent_llm_jobs: number;
  max_concurrent_generic_jobs: number;
  active_jobs: number;
  queued_jobs: number;
  free_slots: number;
  drain_mode: boolean;
  execution_class_capacity: Record<SelfHostedRuntimeExecutionClass, SelfHostedRuntimeExecutionClassCapacity>;
  avg_latency_ms: number | null;
  recent_failure_count: number;
  recent_failures: Array<{ execution_class: SelfHostedRuntimeExecutionClass; code: string; at: string }>;
  hardware_pressure?: Record<string, unknown>;
}

export interface SelfHostedNodeHeartbeatResult {
  enrolled: boolean;
  status: "online" | "degraded";
  model_count: number;
  discovery_source: "mcoda" | "ollama";
  mcoda_agent_count?: number;
  ollama_version?: string | null;
  capacity?: SelfHostedRuntimeLoadTelemetry;
  heartbeat_response: unknown;
}

export interface SelfHostedNodeDaemonHandle {
  stop: () => void;
}

export interface SelfHostedNodeDoctorResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; message?: string }>;
}

export interface SelfHostedNodeServiceInstallOptions {
  commandPath: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
}

export type SelfHostedNodeServiceManager = "launchd" | "systemd" | "windows-task-scheduler";
export type SelfHostedNodeServiceControlAction = "start" | "stop" | "restart" | "status";

export interface SelfHostedNodeServiceInstallResult {
  manager: SelfHostedNodeServiceManager;
  serviceName: string;
  servicePath: string;
  wrapperPath: string;
  logPath: string;
  errorLogPath: string;
  started: boolean;
}

export interface SelfHostedNodeServiceControlOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  runner?: CommandRunner;
  requestTimeoutMs?: number;
}

export interface SelfHostedNodeServiceControlResult {
  manager: SelfHostedNodeServiceManager;
  serviceName: string;
  servicePath: string;
  logPath: string;
  errorLogPath: string;
  action: SelfHostedNodeServiceControlAction | "uninstall";
  ok: boolean;
  stdout: string;
  stderr: string;
  message?: string;
}

export interface SelfHostedNodeServiceLayout {
  platform: NodeJS.Platform;
  manager: SelfHostedNodeServiceManager;
  serviceName: string;
  servicePath: string;
  wrapperPath: string;
  logPath: string;
  errorLogPath: string;
}

interface OllamaTagModel {
  name?: string;
  digest?: string | null;
  details?: {
    family?: string | null;
    parameter_size?: string | null;
    quantization_level?: string | null;
  } | null;
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

interface OllamaVersionResponse {
  version?: string;
}

interface McodaAgentListEntry {
  id?: string | null;
  slug?: string | null;
  adapter?: string | null;
  defaultModel?: string | null;
  default_model?: string | null;
  openaiCompatible?: boolean | null;
  openai_compatible?: boolean | null;
  contextWindow?: number | null;
  context_window?: number | null;
  maxOutputTokens?: number | null;
  max_output_tokens?: number | null;
  supportsTools?: boolean | null;
  supports_tools?: boolean | null;
  rating?: number | null;
  reasoningRating?: number | null;
  reasoning_rating?: number | null;
  bestUsage?: string | null;
  best_usage?: string | null;
  costPerMillion?: number | null;
  cost_per_million?: number | null;
  maxComplexity?: number | null;
  max_complexity?: number | null;
  capabilities?: unknown;
  health?: {
    status?: string | null;
  } | null;
  config?: Record<string, unknown> | null;
  models?: Array<{
    modelName?: string | null;
    model_name?: string | null;
    isDefault?: boolean | null;
    is_default?: boolean | null;
  }> | null;
}

type McodaAgentAuthResolver = (agent: McodaAgentListEntry) => Promise<string | undefined>;

interface GatewayEnrollmentResponse {
  runtime_token?: string;
  heartbeat_interval_seconds?: number;
  heartbeat_timeout_seconds?: number;
  config_version?: number;
  relay?: {
    mode?: SelfHostedRelayMode;
    gateway_base_url?: string;
    jobs_poll_path?: string;
    jobs_start_path_template?: string;
    jobs_events_path_template?: string;
    jobs_result_path_template?: string;
  };
}

const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_SETUP_GATEWAY_BASE_URL = "https://api.mswarm.org";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 18083;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
const DEFAULT_SELF_HOSTED_NODE_VERSION = "0.1.70";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_JOB_TIMEOUT_MS = 3_600_000;
const DEFAULT_SERVICE_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS = 2_000;
const SELF_HOSTED_RUNTIME_PROTOCOL_VERSION = 1;
const SELF_HOSTED_LOAD_BALANCER_PROTOCOL_VERSION = 1;
const SELF_HOSTED_CATALOG_METADATA_VERSION = 1;
const MAX_TELEMETRY_LATENCY_SAMPLES = 50;
const MAX_TELEMETRY_FAILURES = 20;
const DEFAULT_MCODA_BIN = "mcoda";
const DEFAULT_MCODA_LIST_ARGS = ["agent", "list", "--json", "--refresh-health"];
const DEFAULT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_LOCAL_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_JOB_POLL_WAIT_MS = 2_000;
const DEFAULT_SELF_HOSTED_JOBS_POLL_PATH = "/v1/swarm/self-hosted/node/jobs/poll";
const DEFAULT_SELF_HOSTED_JOBS_START_PATH_TEMPLATE = "/v1/swarm/self-hosted/node/jobs/:jobId/start";
const DEFAULT_SELF_HOSTED_JOBS_EVENTS_PATH_TEMPLATE = "/v1/swarm/self-hosted/node/jobs/:jobId/events";
const DEFAULT_SELF_HOSTED_JOBS_RESULT_PATH_TEMPLATE = "/v1/swarm/self-hosted/node/jobs/:jobId/result";
const DEFAULT_STREAM_EVENT_BATCH_SIZE = 8;
const SELF_HOSTED_PROTOCOL_MISMATCH_CODE = "self_hosted_protocol_mismatch";
const OWNER_LOCAL_TEST_ECHO_JOB_TYPE = "tenant.test-echo";
const TEST_ECHO_RUNNER_ID = "test.echo";
const RENDER_BLENDER_JOB_TYPE = "render.blender";
const BLENDER_RENDER_RUNNER_ID = "blender.render";
const CUDA_RUN_JOB_TYPE = "cuda.run";
const CUDA_PACKAGE_RUNNER_ID = "cuda.package";
const APPROVED_NVIDIA_CUDA_IMAGES = new Set([
  "nvidia/cuda:12.4.1-devel-ubuntu22.04"
]);
type OwnerLocalGenericJobCatalogEntry = Omit<MswarmRegisteredJobCatalogEntry, "job_type"> & {
  job_type: MswarmJobType;
  required_capabilities?: string[];
};
const OWNER_LOCAL_GENERIC_JOB_CATALOG: OwnerLocalGenericJobCatalogEntry[] = [
  {
    job_type: OWNER_LOCAL_TEST_ECHO_JOB_TYPE,
    args_schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        message: { type: "string" },
        delay_ms: { type: "number", minimum: 0 },
        repeat: { type: "number", minimum: 1 },
        fail: { type: "boolean" }
      }
    },
    policy: {
      trust_mode: "owner-local",
      network: "none",
      allow_raw_command: false
    },
    runner: TEST_ECHO_RUNNER_ID
  },
  {
    job_type: RENDER_BLENDER_JOB_TYPE,
    args_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        frames: { type: ["string", "number"] },
        engine: { enum: ["cycles", "eevee", "workbench"] },
        resolution: { type: "string", pattern: "^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$" },
        output_format: { enum: ["png", "jpeg", "open_exr"] },
        scene: { type: "string" },
        camera: { type: "string" }
      }
    },
    policy: {
      trust_mode: "owner-local",
      network: "none",
      allow_raw_command: false
    },
    runner: BLENDER_RENDER_RUNNER_ID,
    required_capabilities: ["software.blender"]
  },
  {
    job_type: CUDA_RUN_JOB_TYPE,
    args_schema: {
      type: "object",
      additionalProperties: false,
      required: ["manifest_path", "profile", "target"],
      properties: {
        manifest_path: { type: "string" },
        profile: { type: "string" },
        target: { type: "string" }
      }
    },
    policy: {
      trust_mode: "owner-local",
      network: "none",
      allow_raw_command: false,
      allowed_images: Array.from(APPROVED_NVIDIA_CUDA_IMAGES)
    },
    runner: CUDA_PACKAGE_RUNNER_ID,
    required_capabilities: ["gpu.nvidia", "software.docker", "docker.nvidia"]
  }
];
const SERVICE_LABEL = "com.mcoda.mswarm.self-hosted-node";
const SYSTEMD_SERVICE_NAME = "mswarm-self-hosted-node.service";
const WINDOWS_TASK_NAME = "MswarmSelfHostedNode";
const DAEMON_PROCESS_NAME = "mswarm-node";
const POSIX_WRAPPER_SCRIPT_NAME = DAEMON_PROCESS_NAME;
const WINDOWS_WRAPPER_SCRIPT_NAME = "mswarm-self-hosted-node.ps1";
const DEFAULT_EXPOSE_ALL_MODELS = true;
const LOCAL_OPENAI_COMPATIBLE_ADAPTERS = new Set([
  "openai-compatible-local",
  "vllm-local",
  "llama-cpp-local",
  "llamacpp-local"
]);
const SECRET_LOCAL_RUNNER_HEADER_KEYS = new Set(["authorization", "proxy-authorization", "x-api-key", "api-key"]);
const RESERVED_LOCAL_RUNNER_EXTRA_BODY_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "tools",
  "tool_choice",
  "response_format",
  "max_tokens",
  "temperature"
]);
const LOCAL_RUNNER_KIND_ALIASES: Record<string, NonNullable<LocalOpenAiCompatibleRunnerConfig["runnerKind"]>> = {
  vllm: "vllm",
  "llama-cpp": "llama-cpp",
  "llama.cpp": "llama-cpp",
  llamacpp: "llama-cpp",
  llama_cpp: "llama-cpp",
  "llama-cpp-python": "llama-cpp-python",
  "llama.cpp-python": "llama-cpp-python",
  llamacpppython: "llama-cpp-python",
  llama_cpp_python: "llama-cpp-python",
  "lm-studio": "lm-studio",
  lmstudio: "lm-studio",
  lm_studio: "lm-studio",
  localai: "localai",
  "local-ai": "localai",
  local_ai: "localai",
  sglang: "sglang",
  tgi: "tgi",
  "text-generation-inference": "tgi",
  text_generation_inference: "tgi",
  custom: "custom"
};
const LOCAL_RUNNER_AUTH_MODE_ALIASES: Record<string, NonNullable<LocalOpenAiCompatibleRunnerConfig["authMode"]>> = {
  none: "none",
  bearer: "bearer",
  "dummy-bearer": "dummy-bearer",
  dummy_bearer: "dummy-bearer",
  dummybearer: "dummy-bearer",
  dummy: "dummy-bearer"
};
const LOCAL_RUNNER_RESPONSE_FORMAT_ALIASES: Record<
  string,
  NonNullable<LocalOpenAiCompatibleRunnerConfig["responseFormatStrategy"]>
> = {
  openai: "openai",
  "json-object": "json-object",
  json_object: "json-object",
  jsonobject: "json-object",
  "json-schema": "json-schema",
  json_schema: "json-schema",
  jsonschema: "json-schema",
  gbnf: "gbnf",
  "prompt-only": "prompt-only",
  prompt_only: "prompt-only",
  promptonly: "prompt-only",
  none: "none"
};

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function isLocalOpenAiCompatibleAdapter(adapter: unknown): boolean {
  const normalized = optionalText(adapter);
  return normalized ? LOCAL_OPENAI_COMPATIBLE_ADAPTERS.has(normalizeLookupKey(normalized)) : false;
}

function defaultLocalRunnerKindForAdapter(adapter: unknown): LocalOpenAiCompatibleRunnerConfig["runnerKind"] {
  const normalized = optionalText(adapter);
  if (!normalized) return undefined;
  const lookupKey = normalizeLookupKey(normalized);
  if (lookupKey === "vllm-local") return "vllm";
  if (lookupKey === "llama-cpp-local" || lookupKey === "llamacpp-local") return "llama-cpp";
  return undefined;
}

function readConfigString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = optionalText(record[key]);
    if (value) return value;
  }
  return undefined;
}

function readConfigBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === "boolean") return record[key] as boolean;
  }
  return undefined;
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const mapped: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const stringValue = optionalText(rawValue);
    if (!stringValue || SECRET_LOCAL_RUNNER_HEADER_KEYS.has(normalizeLookupKey(key))) {
      continue;
    }
    mapped[key] = stringValue;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function normalizeExtraBody(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const mapped: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (RESERVED_LOCAL_RUNNER_EXTRA_BODY_KEYS.has(normalizeLookupKey(key))) {
      continue;
    }
    mapped[key] = rawValue;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function normalizeLocalRunnerKind(value: unknown): LocalOpenAiCompatibleRunnerConfig["runnerKind"] {
  const normalized = optionalText(value);
  return normalized ? LOCAL_RUNNER_KIND_ALIASES[normalizeLookupKey(normalized)] : undefined;
}

function normalizeLocalRunnerAuthMode(value: unknown): LocalOpenAiCompatibleRunnerConfig["authMode"] {
  const normalized = optionalText(value);
  return normalized ? LOCAL_RUNNER_AUTH_MODE_ALIASES[normalizeLookupKey(normalized)] : undefined;
}

function normalizeLocalRunnerResponseFormatStrategy(
  value: unknown
): LocalOpenAiCompatibleRunnerConfig["responseFormatStrategy"] {
  const normalized = optionalText(value);
  return normalized ? LOCAL_RUNNER_RESPONSE_FORMAT_ALIASES[normalizeLookupKey(normalized)] : undefined;
}

function normalizeMcodaLocalRunnerConfig(
  adapter: string,
  config: Record<string, unknown> | null | undefined
): LocalOpenAiCompatibleRunnerConfig | undefined {
  if (!isLocalOpenAiCompatibleAdapter(adapter)) return undefined;
  const configRecord = config ?? {};
  const localRunnerRecord = isRecord(configRecord.localRunner) ? configRecord.localRunner : {};
  const merged = { ...localRunnerRecord, ...configRecord };
  const authMode = normalizeLocalRunnerAuthMode(merged.authMode) ?? "none";
  const dummyBearerToken = readConfigString(merged, ["dummyBearerToken", "dummyApiKey"]);
  return {
    baseUrl: readConfigString(merged, ["baseUrl", "base_url", "endpoint", "apiBaseUrl", "api_base_url"]),
    endpoint: readConfigString(merged, ["endpoint"]),
    apiBaseUrl: readConfigString(merged, ["apiBaseUrl", "api_base_url"]),
    runnerKind: normalizeLocalRunnerKind(merged.runnerKind) ?? defaultLocalRunnerKindForAdapter(adapter),
    authMode,
    dummyBearerToken: authMode === "dummy-bearer" ? dummyBearerToken ?? "local" : dummyBearerToken,
    headers: normalizeStringMap(merged.headers),
    extraBody: normalizeExtraBody(merged.extraBody),
    responseFormatStrategy: normalizeLocalRunnerResponseFormatStrategy(merged.responseFormatStrategy),
    healthPath: readConfigString(merged, ["healthPath", "health_path"]),
    modelsPath: readConfigString(merged, ["modelsPath", "models_path"]),
    requireModelInRequest: readConfigBoolean(merged, ["requireModelInRequest", "require_model_in_request"]),
    supportsStreaming: readConfigBoolean(merged, ["supportsStreaming", "supports_streaming"]),
    supportsTools: readConfigBoolean(merged, ["supportsTools", "supports_tools"]),
    supportsJsonSchema: readConfigBoolean(merged, ["supportsJsonSchema", "supports_json_schema"]),
    supportsGbnf: readConfigBoolean(merged, ["supportsGbnf", "supports_gbnf"])
  };
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return fallback;
}

function parseExposurePolicy(value: unknown): SelfHostedExposurePolicy | null {
  const normalized = optionalText(value)?.toLowerCase().replace(/_/g, "-");
  if (!normalized) return null;
  if (["all", "expose-all", "exposed", "true", "1", "yes"].includes(normalized)) return "all";
  if (["none", "off", "disabled", "false", "0", "no"].includes(normalized)) return "none";
  return null;
}

function exposurePolicyToBoolean(policy: SelfHostedExposurePolicy | null): boolean | null {
  if (policy === "all") return true;
  if (policy === "none") return false;
  return null;
}

function resolveDaemonExposeAllModels(env: NodeJS.ProcessEnv, state: SelfHostedNodeState): boolean {
  const policy = exposurePolicyToBoolean(
    parseExposurePolicy(env.MSWARM_SELF_HOSTED_EXPOSURE_POLICY) || parseExposurePolicy(state.exposure_policy)
  );
  if (policy !== null) {
    return policy;
  }

  if (parseBoolean(env.MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS, false) === true) {
    return true;
  }

  if (state.expose_all_models === true) {
    return true;
  }

  return DEFAULT_EXPOSE_ALL_MODELS;
}

function resolveOwnerSetupExposeAllModels(
  options: Record<string, string | boolean>,
  env: NodeJS.ProcessEnv
): boolean {
  if (options["no-expose-all"] === true) {
    return false;
  }

  const optionPolicy = exposurePolicyToBoolean(parseExposurePolicy(options["exposure-policy"]));
  if (optionPolicy !== null) {
    return optionPolicy;
  }

  if (options["expose-all"] === true) {
    return true;
  }

  const envPolicy = exposurePolicyToBoolean(parseExposurePolicy(env.MSWARM_SELF_HOSTED_EXPOSURE_POLICY));
  if (envPolicy !== null) {
    return envPolicy;
  }

  return parseBoolean(env.MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS, DEFAULT_EXPOSE_ALL_MODELS);
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => optionalText(entry)).filter((entry): entry is string => Boolean(entry));
  }
  if (typeof value !== "string") {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeSelfHostedDomainClient(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.+$/g, "");
  if (!normalized || normalized.length > 253 || normalized.includes("..")) {
    return null;
  }
  const labels = normalized.split(".");
  if (!labels.every((label) => DOMAIN_LABEL_PATTERN.test(label))) {
    return null;
  }
  return normalized;
}

export function normalizeSelfHostedNodeClientIdentity(value: unknown): SelfHostedNodeClientIdentity | null {
  if (isRecord(value)) {
    const kind = optionalText(value.kind)?.toLowerCase();
    const rawValue = optionalText(value.value);
    const normalized = normalizeSelfHostedNodeClientIdentity(rawValue);
    if (!normalized) {
      return null;
    }
    if (kind && kind !== normalized.kind) {
      return null;
    }
    const addedAt = optionalText(value.added_at);
    return addedAt ? { ...normalized, added_at: addedAt } : normalized;
  }
  const raw = optionalText(value);
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (isIP(trimmed) !== 0) {
    return { kind: "ip", value: trimmed.toLowerCase() };
  }
  if (UUID_PATTERN.test(trimmed)) {
    return { kind: "uuid", value: trimmed.toLowerCase() };
  }
  const domain = normalizeSelfHostedDomainClient(trimmed);
  if (domain) {
    return { kind: "domain", value: domain };
  }
  return null;
}

export function normalizeSelfHostedNodeClientAllowlist(value: unknown): SelfHostedNodeClientIdentity[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? parseList(value)
      : value == null || value === false
        ? []
        : [value];
  const byKey = new Map<string, SelfHostedNodeClientIdentity>();
  for (const entry of entries) {
    const identity = normalizeSelfHostedNodeClientIdentity(entry);
    if (!identity) {
      throw new Error(
        typeof entry === "string"
          ? `Invalid mswarm node client identifier: ${entry}`
          : "Invalid mswarm node client identifier"
      );
    }
    byKey.set(`${identity.kind}:${identity.value}`, identity);
  }
  return [...byKey.values()];
}

export function addSelfHostedNodeClients(
  current: SelfHostedNodeClientIdentity[],
  additions: SelfHostedNodeClientIdentity[],
  now = new Date().toISOString()
): SelfHostedNodeClientIdentity[] {
  const byKey = new Map<string, SelfHostedNodeClientIdentity>();
  for (const entry of current) {
    const normalized = normalizeSelfHostedNodeClientIdentity(entry);
    if (normalized) {
      byKey.set(`${normalized.kind}:${normalized.value}`, normalized);
    }
  }
  for (const entry of additions) {
    byKey.set(`${entry.kind}:${entry.value}`, { ...entry, added_at: entry.added_at || now });
  }
  return [...byKey.values()];
}

export function removeSelfHostedNodeClients(
  current: SelfHostedNodeClientIdentity[],
  removals: SelfHostedNodeClientIdentity[]
): SelfHostedNodeClientIdentity[] {
  const removeKeys = new Set(removals.map((entry) => `${entry.kind}:${entry.value}`));
  return current
    .map((entry) => normalizeSelfHostedNodeClientIdentity(entry))
    .filter((entry): entry is SelfHostedNodeClientIdentity => Boolean(entry))
    .filter((entry) => !removeKeys.has(`${entry.kind}:${entry.value}`));
}

function parseArgs(value: unknown, fallback: string[]): string[] {
  const parsed = parseList(value);
  return parsed.length > 0 ? parsed : fallback;
}

function parseDiscoveryMode(value: unknown): SelfHostedDiscoveryMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "ollama" ? "ollama" : "mcoda";
}

function parseRelayMode(value: unknown): SelfHostedRelayMode {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "direct" ? "direct" : "outbound";
}

function normalizeLocalName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "local-node"
  );
}

export function resolveDefaultServerName(): string {
  return normalizeLocalName(hostname() || "local-node");
}

function defaultMachineIdPath(): string {
  return join(homedir(), ".mswarm", "self-hosted-node", "machine.id");
}

function parseCliOptions(argv: string[]): Record<string, string | boolean> {
  const options: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 0) {
      options[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function lifecyclePath(value: unknown, fallback: string): string {
  return optionalText(value) || fallback;
}

function resolveLifecycleUrl(gatewayBaseUrl: string, pathOrUrl: string): string {
  try {
    return new URL(pathOrUrl).toString();
  } catch {
    return new URL(pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`, `${trimTrailingSlash(gatewayBaseUrl)}/`).toString();
  }
}

function resolveLifecycleTemplate(template: string, jobId: string): string {
  const encoded = encodeURIComponent(jobId);
  return template
    .replace(/:jobId\b/g, encoded)
    .replace(/:job_id\b/g, encoded)
    .replace(/\{jobId\}/g, encoded)
    .replace(/\{job_id\}/g, encoded);
}

function usageFromTokenCounts(
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined
): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const prompt = positiveInteger(promptTokens) ?? 0;
  const completion = positiveInteger(completionTokens) ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function openAiUsage(response: Record<string, unknown> | undefined): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
} {
  const usage = isRecord(response?.usage) ? response.usage : undefined;
  const prompt = positiveInteger(usage?.prompt_tokens) ?? 0;
  const completion = positiveInteger(usage?.completion_tokens) ?? 0;
  const total = positiveInteger(usage?.total_tokens) ?? prompt + completion;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function defaultStatePath(): string {
  return join(homedir(), ".mswarm", "self-hosted-node", "config.json");
}

function defaultRuntimeTokenPath(): string {
  return join(homedir(), ".mswarm", "self-hosted-node", "node.key");
}

function defaultArtifactStorePath(): string {
  return join(homedir(), ".mswarm", "self-hosted-node", "artifacts");
}

export async function readOrCreateSelfHostedMachineId(machineIdPath = defaultMachineIdPath()): Promise<string> {
  try {
    const existing = (await readFile(machineIdPath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const machineId = randomUUID();
  await mkdir(dirname(machineIdPath), { recursive: true });
  await writeFile(machineIdPath, `${machineId}\n`, { encoding: "utf8", mode: 0o600 });
  return machineId;
}

export function machineFingerprintFromId(machineId: string): string {
  return `sha256:${createHash("sha256").update(machineId.trim()).digest("hex")}`;
}

function isVisionModel(modelName: string, family?: string | null): boolean {
  const normalized = `${modelName} ${family || ""}`.toLowerCase();
  return normalized.includes("llava") || normalized.includes("vision") || normalized.includes("bakllava");
}

function isEmbeddingModel(modelName: string, family?: string | null): boolean {
  const normalized = `${modelName} ${family || ""}`.toLowerCase();
  return (
    normalized.includes("embed") ||
    normalized.includes("embedding") ||
    normalized.includes("nomic-bert") ||
    normalized.includes("bert")
  );
}

function isEmbeddingUsage(value: string | null): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return normalized.includes("embedding") || normalized.includes("embed") || normalized.includes("vector");
}

function optionalNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function optionalBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") {
      return value;
    }
  }
  return null;
}

function roundedTelemetryNumber(value: number, digits = 3): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nonNegativeTelemetryInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildCatalogFingerprint(models: SelfHostedModelInput[]): string {
  const projection = models
    .map((model) => ({
      name: optionalText(model.name) || "",
      provider: optionalText(model.provider) || null,
      adapter: optionalText(model.adapter) || null,
      source_agent_slug: optionalText(model.source_agent_slug) || null,
      model_id: optionalText(model.model_id) || optionalText(model.model) || null,
      exposed: model.exposed !== false,
      capabilities: normalizeCapabilities(model.capabilities).sort(),
      health_status: normalizeHealthStatus(model.health_status)
    }))
    .sort((left, right) => `${left.provider || ""}:${left.name}`.localeCompare(`${right.provider || ""}:${right.name}`));
  return `sha256:${sha256Json(projection)}`;
}

function executionClassCapacity(input: {
  maxConcurrency: number;
  activeJobs: number;
  queuedJobs: number;
  drainMode: boolean;
}): SelfHostedRuntimeExecutionClassCapacity {
  const maxConcurrency = Math.max(1, Math.floor(input.maxConcurrency));
  const activeJobs = nonNegativeTelemetryInteger(input.activeJobs);
  const queuedJobs = nonNegativeTelemetryInteger(input.queuedJobs);
  return {
    max_concurrency: maxConcurrency,
    active_jobs: activeJobs,
    queued_jobs: queuedJobs,
    free_slots: input.drainMode ? 0 : Math.max(0, maxConcurrency - activeJobs - queuedJobs)
  };
}

function totalHostMemoryBucket(): string {
  const gib = totalmem() / (1024 ** 3);
  if (!Number.isFinite(gib) || gib <= 0) return "unknown";
  if (gib <= 8) return "<=8GiB";
  if (gib <= 16) return "<=16GiB";
  if (gib <= 32) return "<=32GiB";
  if (gib <= 64) return "<=64GiB";
  if (gib <= 128) return "<=128GiB";
  return ">128GiB";
}

function coarsePublicVramTier(value: unknown, gpuCount: number): string {
  if (
    value === "none" ||
    value === "lt8" ||
    value === "8-15" ||
    value === "16-31" ||
    value === "32plus"
  ) {
    return value;
  }
  return gpuCount > 0 ? "unknown" : "none";
}

function buildCoarseHardwarePressure(capabilityPayload: MswarmSignedCapabilityPayload | null): Record<string, unknown> {
  const cpuCount = Math.max(1, cpus().length || 1);
  const totalMemory = totalmem();
  const freeMemory = freemem();
  const projection = (capabilityPayload as unknown as Record<string, unknown> | null)?.public_projection;
  const projectionRecord = projection && typeof projection === "object" && !Array.isArray(projection)
    ? projection as Record<string, unknown>
    : {};
  const accelerators = projectionRecord.accelerators && typeof projectionRecord.accelerators === "object"
    ? projectionRecord.accelerators as Record<string, unknown>
    : {};
  const gpu = accelerators.gpu && typeof accelerators.gpu === "object" && !Array.isArray(accelerators.gpu)
    ? accelerators.gpu as Record<string, unknown>
    : null;
  const rawGpuCount = gpu?.["count"];
  const gpuCount = typeof rawGpuCount === "number" && Number.isFinite(rawGpuCount)
    ? Math.max(0, Math.floor(rawGpuCount))
    : 0;
  const vramTier = coarsePublicVramTier(gpu?.["vram_tier"], gpuCount);
  return {
    schema_version: 1,
    collected_at: new Date().toISOString(),
    cpu: {
      core_count: cpuCount,
      load_1m_ratio: roundedTelemetryNumber((loadavg()[0] || 0) / cpuCount)
    },
    ram: {
      used_ratio: totalMemory > 0 ? roundedTelemetryNumber((totalMemory - freeMemory) / totalMemory) : null,
      total_bucket: totalHostMemoryBucket()
    },
    gpu: {
      available: Boolean(gpu?.["available"]),
      count: gpuCount,
      cuda: Boolean(gpu?.["cuda"] || gpu?.["has_cuda"]),
      vram: {
        total_tier: vramTier,
        used_ratio: null
      }
    }
  };
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .map((entry) => optionalText(entry))
        .filter((entry): entry is string => Boolean(entry))
    )
  );
}

function normalizeHealthStatus(value: unknown): SelfHostedModelInput["health_status"] {
  const normalized = optionalText(value)?.toLowerCase();
  if (normalized === "healthy") return "healthy";
  if (normalized === "degraded") return "degraded";
  if (normalized === "unreachable" || normalized === "unhealthy" || normalized === "offline") {
    return "unreachable";
  }
  if (normalized === "blocked") return "blocked";
  return "unknown";
}

function isMswarmManagedAgent(agent: McodaAgentListEntry): boolean {
  const config = agent.config && typeof agent.config === "object" ? agent.config : {};
  const managedConfigs = [config.mswarmCloud, config.mswarmSelfHosted, config.mswarmWorker];
  if (
    managedConfigs.some(
      (managedConfig) =>
        Boolean(managedConfig) &&
        typeof managedConfig === "object" &&
        (managedConfig as Record<string, unknown>).managed === true
    )
  ) {
    return true;
  }
  const slug = optionalText(agent.slug)?.toLowerCase();
  return Boolean(
    slug &&
      (slug.startsWith("mswarm-cloud-") ||
        slug.startsWith("mswarm-self-hosted-") ||
        slug.startsWith("mswarm-worker-"))
  );
}

function isModelExposed(
  modelName: string,
  family: string | null,
  config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">
): boolean {
  if (config.modelBlocklist.includes(modelName)) {
    return false;
  }
  if (isEmbeddingModel(modelName, family)) {
    return false;
  }
  if (config.modelAllowlist.length > 0) {
    return config.modelAllowlist.includes(modelName);
  }
  return config.exposeAllModels;
}

function isAgentExposed(
  agentSlug: string,
  defaultModel: string | null,
  bestUsage: string | null,
  config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">
): boolean {
  const identities = [agentSlug, defaultModel].filter((value): value is string => Boolean(value));
  if (identities.some((identity) => config.modelBlocklist.includes(identity))) {
    return false;
  }
  if (isEmbeddingUsage(bestUsage) || identities.some((identity) => isEmbeddingModel(identity))) {
    return false;
  }
  if (config.modelAllowlist.length > 0) {
    return identities.some((identity) => config.modelAllowlist.includes(identity));
  }
  return config.exposeAllModels;
}

class HttpStatusError extends Error {
  readonly url: string;
  readonly status: number;
  readonly responseText: string;

  constructor(url: string, status: number, responseText: string) {
    super(`request_failed:${status}:${responseText.slice(0, 200)}`);
    this.name = "HttpStatusError";
    this.url = url;
    this.status = status;
    this.responseText = responseText;
  }
}

function isHttpStatusError(error: unknown, status?: number): error is HttpStatusError {
  return error instanceof HttpStatusError && (status === undefined || error.status === status);
}

const RELAY_RESULT_POST_RETRY_DELAYS_MS = [250, 1_000, 2_500] as const;

function runtimeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new HttpStatusError(url, response.status, text);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readSelfHostedNodeState(statePath: string): Promise<SelfHostedNodeState> {
  try {
    const content = await readFile(statePath, "utf8");
    const parsed = JSON.parse(content) as SelfHostedNodeState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeSelfHostedNodeState(
  statePath: string,
  state: SelfHostedNodeState
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function readSelfHostedRuntimeToken(tokenPath: string): Promise<string | null> {
  try {
    const content = await readFile(tokenPath, "utf8");
    const trimmed = content.trim();
    return trimmed || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeSelfHostedRuntimeToken(tokenPath: string, runtimeToken: string): Promise<void> {
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${runtimeToken.trim()}\n`, { encoding: "utf8", mode: 0o600 });
}

let resolvedPackageNodeVersion: Promise<string> | null = null;

async function readPackageNodeVersion(): Promise<string> {
  resolvedPackageNodeVersion ??= (async () => {
    try {
      const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      return optionalText(parsed.version) || DEFAULT_SELF_HOSTED_NODE_VERSION;
    } catch {
      return DEFAULT_SELF_HOSTED_NODE_VERSION;
    }
  })();
  return resolvedPackageNodeVersion;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function quoteSystemdValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quotePosixShellValue(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteEnvAssignment(key: string, value: string): string {
  return `${key}=${value}`;
}

function serviceLogDir(homeDir: string): string {
  return join(homeDir, ".mswarm", "self-hosted-node");
}

function serviceUserEnvironment(env: NodeJS.ProcessEnv): Record<string, string | null | undefined> {
  const fallbackUsername = userInfo().username;
  const username = env.USER || env.LOGNAME || env.USERNAME || fallbackUsername;
  return {
    USER: env.USER || username,
    LOGNAME: env.LOGNAME || username,
    USERNAME: env.USERNAME || username,
    SHELL: env.SHELL,
    TMPDIR: env.TMPDIR || env.TMP || env.TEMP
  };
}

function serviceEnvironment(config: SelfHostedNodeConfig, env: NodeJS.ProcessEnv, homeDir: string): Record<string, string> {
  const values: Record<string, string | null | undefined> = {
    HOME: env.HOME || homeDir,
    PATH: env.PATH || env.Path || env.path || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    ...serviceUserEnvironment(env),
    MSWARM_SELF_HOSTED_PROCESS_TITLE: DAEMON_PROCESS_NAME,
    MSWARM_GATEWAY_BASE_URL: config.gatewayBaseUrl,
    MSWARM_SELF_HOSTED_NODE_STATE_PATH: config.statePath,
    MSWARM_SELF_HOSTED_NODE_KEY_PATH: config.runtimeTokenPath,
    MSWARM_SELF_HOSTED_ARTIFACT_STORE_PATH: config.artifactStorePath || null,
    MSWARM_SELF_HOSTED_RELAY_MODE: config.relayMode || "outbound",
    MSWARM_SELF_HOSTED_DIRECT_BASE_URL: config.directBaseUrl || null,
    MSWARM_SELF_HOSTED_DISCOVERY_MODE: config.discoveryMode,
    MSWARM_SELF_HOSTED_MCODA_BIN: config.mcodaBin,
    MSWARM_SELF_HOSTED_MCODA_LIST_ARGS: config.mcodaListArgs.join(","),
    MSWARM_SELF_HOSTED_OLLAMA_BASE_URL: config.ollamaBaseUrl,
    MSWARM_SELF_HOSTED_NODE_VERSION: config.nodeVersion,
    MSWARM_SELF_HOSTED_EXPOSURE_POLICY: config.exposeAllModels ? "all" : "none",
    MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS: config.exposeAllModels ? "true" : "false",
    MSWARM_SELF_HOSTED_MODEL_ALLOWLIST: config.modelAllowlist.join(","),
    MSWARM_SELF_HOSTED_MODEL_BLOCKLIST: config.modelBlocklist.join(","),
    MSWARM_SELF_HOSTED_HEARTBEAT_INTERVAL_SECONDS: String(config.heartbeatIntervalSeconds),
    MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS: String(config.requestTimeoutMs),
    MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS: String(config.jobTimeoutMs),
    MSWARM_SELF_HOSTED_MAX_CONCURRENT_JOBS: String(config.maxConcurrentJobs || 1),
    MSWARM_SELF_HOSTED_MAX_CONCURRENT_LLM_JOBS: String(config.maxConcurrentLlmJobs || config.maxConcurrentJobs || 1),
    MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED: config.genericJobsEnabled ? "true" : "false",
    MSWARM_SELF_HOSTED_GENERIC_JOB_TIMEOUT_MS: String(config.genericJobTimeoutMs),
    MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY: String(config.genericJobMaxConcurrency),
    MSWARM_SELF_HOSTED_DRAIN_MODE: config.drainMode ? "true" : "false",
    MSWARM_SELF_HOSTED_LOAD_REPORTING_ENABLED: config.loadReportingEnabled === false ? "false" : "true",
    MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY_ENABLED: config.hardwareTelemetryEnabled ? "true" : "false",
    MSWARM_SELF_HOSTED_CAPABILITY_PROBE_TIMEOUT_MS: config.capabilityProbeTimeoutMs
      ? String(config.capabilityProbeTimeoutMs)
      : null
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
  );
}

function buildLaunchdPlist(input: {
  label: string;
  wrapperPath: string;
  logPath: string;
  errorLogPath: string;
}): string {
  const args = [input.wrapperPath]
    .map((value) => `    <string>${escapeXml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(input.errorLogPath)}</string>
</dict>
</plist>
`;
}

function buildSystemdUserService(input: {
  wrapperPath: string;
  logPath: string;
  errorLogPath: string;
}): string {
  return `[Unit]
Description=mswarm self-hosted node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemdValue(input.wrapperPath)}
Restart=always
RestartSec=5
StandardOutput=append:${input.logPath}
StandardError=append:${input.errorLogPath}

[Install]
WantedBy=default.target
`;
}

function buildPosixDaemonWrapperScript(input: {
  nodePath: string;
  commandPath: string;
  env: Record<string, string>;
}): string {
  const args = [
    ...Object.entries(input.env).map(([key, value]) => quotePosixShellValue(quoteEnvAssignment(key, value))),
    quotePosixShellValue(input.nodePath),
    quotePosixShellValue(input.commandPath),
    quotePosixShellValue("start")
  ].join(" \\\n  ");
  return `#!/bin/sh
exec /usr/bin/env -i \\
  ${args}
`;
}

function quotePowerShellValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteWindowsCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function buildWindowsTaskWrapperScript(input: {
  nodePath: string;
  commandPath: string;
  logPath: string;
  errorLogPath: string;
  env: Record<string, string>;
}): string {
  const env = Object.entries(input.env)
    .map(([key, value]) => `$env:${key} = ${quotePowerShellValue(value)}`)
    .join("\n");
  return `$ErrorActionPreference = 'Continue'

$logPath = ${quotePowerShellValue(input.logPath)}
$errorLogPath = ${quotePowerShellValue(input.errorLogPath)}
$nodePath = ${quotePowerShellValue(input.nodePath)}
$commandArguments = @(${quotePowerShellValue(input.commandPath)}, 'start')
$allowedInheritedEnvironment = @('SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'PSModulePath', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'TEMP', 'TMP')

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $logPath) | Out-Null

Get-ChildItem Env: | Where-Object { $allowedInheritedEnvironment -notcontains $_.Name } | ForEach-Object {
  Remove-Item -Path ("Env:" + $_.Name) -ErrorAction SilentlyContinue
}

${env}

while ($true) {
  $startedAt = Get-Date -Format o
  Add-Content -Path $logPath -Value "[$startedAt] starting mswarm self-hosted node"
  try {
    & $nodePath @commandArguments >> $logPath 2>> $errorLogPath
    $exitCode = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    $endedAt = Get-Date -Format o
    Add-Content -Path $errorLogPath -Value "[$endedAt] mswarm self-hosted node exited with code $exitCode; restarting in 5 seconds"
  } catch {
    $failedAt = Get-Date -Format o
    Add-Content -Path $errorLogPath -Value "[$failedAt] mswarm self-hosted node wrapper error: $_"
  }
  Start-Sleep -Seconds 5
}
`;
}

function buildWindowsTaskRegistrationCommand(wrapperPath: string): string {
  const actionArguments = `-NoProfile -ExecutionPolicy Bypass -File ${quoteWindowsCommandArg(wrapperPath)}`;
  const settings =
    "New-ScheduledTaskSettingsSet " +
    "-AllowStartIfOnBatteries " +
    "-DontStopIfGoingOnBatteries " +
    "-StartWhenAvailable " +
    "-MultipleInstances IgnoreNew " +
    "-RestartCount 999 " +
    "-RestartInterval (New-TimeSpan -Minutes 1) " +
    "-ExecutionTimeLimit (New-TimeSpan -Seconds 0)";
  return [
    `Stop-ScheduledTask -TaskName ${quotePowerShellValue(WINDOWS_TASK_NAME)} -ErrorAction SilentlyContinue`,
    `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ${quotePowerShellValue(actionArguments)}`,
    "$trigger = New-ScheduledTaskTrigger -AtLogOn",
    `$settings = ${settings}`,
    `Register-ScheduledTask -TaskName ${quotePowerShellValue(WINDOWS_TASK_NAME)} -Action $action -Trigger $trigger -Settings $settings -Description 'mswarm self-hosted node daemon' -Force | Out-Null`
  ].join("; ");
}

function windowsTaskCommand(command: string): string {
  return `${command} -TaskName ${quotePowerShellValue(WINDOWS_TASK_NAME)}`;
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : userInfo().uid;
  return `gui/${uid}`;
}

export function resolveSelfHostedNodeServiceLayout(input: {
  platform?: NodeJS.Platform;
  homeDir?: string;
} = {}): SelfHostedNodeServiceLayout {
  const targetPlatform = input.platform || platform();
  const homeDir = input.homeDir || homedir();
  const logDir = serviceLogDir(homeDir);
  const logPath = join(logDir, "daemon.log");
  const errorLogPath = join(logDir, "daemon.err.log");
  const posixWrapperPath = join(logDir, POSIX_WRAPPER_SCRIPT_NAME);
  if (targetPlatform === "darwin") {
    return {
      platform: targetPlatform,
      manager: "launchd",
      serviceName: SERVICE_LABEL,
      servicePath: join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
      wrapperPath: posixWrapperPath,
      logPath,
      errorLogPath
    };
  }
  if (targetPlatform === "linux") {
    return {
      platform: targetPlatform,
      manager: "systemd",
      serviceName: SYSTEMD_SERVICE_NAME,
      servicePath: join(homeDir, ".config", "systemd", "user", SYSTEMD_SERVICE_NAME),
      wrapperPath: posixWrapperPath,
      logPath,
      errorLogPath
    };
  }
  if (targetPlatform === "win32") {
    const wrapperPath = join(logDir, WINDOWS_WRAPPER_SCRIPT_NAME);
    return {
      platform: targetPlatform,
      manager: "windows-task-scheduler",
      serviceName: WINDOWS_TASK_NAME,
      servicePath: wrapperPath,
      wrapperPath,
      logPath,
      errorLogPath
    };
  }
  throw new Error(`Persistent service control is not supported on ${targetPlatform}`);
}

function serviceControlResult(
  layout: SelfHostedNodeServiceLayout,
  action: SelfHostedNodeServiceControlResult["action"],
  result: { stdout: string; stderr: string },
  ok = true,
  message?: string
): SelfHostedNodeServiceControlResult {
  return {
    manager: layout.manager,
    serviceName: layout.serviceName,
    servicePath: layout.servicePath,
    logPath: layout.logPath,
    errorLogPath: layout.errorLogPath,
    action,
    ok,
    stdout: redactServiceManagerOutput(result.stdout),
    stderr: redactServiceManagerOutput(result.stderr),
    ...(message ? { message } : {})
  };
}

function serviceCommandTimeoutMs(timeoutMs?: number): number {
  return Math.max(
    Number.isFinite(timeoutMs) && typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 0,
    DEFAULT_SERVICE_COMMAND_TIMEOUT_MS
  );
}

function redactServiceManagerOutput(value: string): string {
  return value.replace(
    /^(\s*[\w.-]*(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[\w.-]*\s*(?:=>|=|:)\s*).*$/gim,
    "$1[redacted]"
  );
}

async function runServiceCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return runner(command, args, { timeoutMs, maxBuffer: DEFAULT_COMMAND_MAX_BUFFER });
}

async function waitForLaunchdSettle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function ensureLaunchdServiceBootstrapped(
  runner: CommandRunner,
  domain: string,
  serviceTarget: string,
  servicePath: string,
  timeoutMs: number
): Promise<void> {
  let lastBootstrapError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await runServiceCommand(runner, "launchctl", ["bootstrap", domain, servicePath], timeoutMs);
      return;
    } catch (error) {
      lastBootstrapError = error;
      try {
        await runServiceCommand(runner, "launchctl", ["print", serviceTarget], timeoutMs);
        return;
      } catch {
        if (attempt === 0) {
          await waitForLaunchdSettle();
        }
      }
    }
  }
  throw lastBootstrapError instanceof Error ? lastBootstrapError : new Error(String(lastBootstrapError));
}

export async function installSelfHostedNodeService(
  config: SelfHostedNodeConfig,
  options: SelfHostedNodeServiceInstallOptions
): Promise<SelfHostedNodeServiceInstallResult> {
  const homeDir = options.homeDir || homedir();
  const layout = resolveSelfHostedNodeServiceLayout({ platform: options.platform, homeDir });
  const logDir = serviceLogDir(homeDir);
  const env = serviceEnvironment(config, options.env || process.env, homeDir);
  const nodePath = options.nodePath || process.execPath;
  const runner = options.runner || defaultCommandRunner;
  const serviceTimeoutMs = serviceCommandTimeoutMs(config.requestTimeoutMs);
  await mkdir(logDir, { recursive: true });

  if (layout.platform === "darwin") {
    await mkdir(dirname(layout.servicePath), { recursive: true });
    await writeFile(
      layout.wrapperPath,
      buildPosixDaemonWrapperScript({
        nodePath,
        commandPath: options.commandPath,
        env
      }),
      "utf8"
    );
    await chmod(layout.wrapperPath, 0o755);
    await writeFile(
      layout.servicePath,
      buildLaunchdPlist({
        label: SERVICE_LABEL,
        wrapperPath: layout.wrapperPath,
        logPath: layout.logPath,
        errorLogPath: layout.errorLogPath
      }),
      "utf8"
    );
    const domain = launchdDomain();
    const serviceTarget = `${domain}/${SERVICE_LABEL}`;
    await runner("launchctl", ["bootout", serviceTarget], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    }).catch(() => undefined);
    await runner("launchctl", ["bootout", domain, layout.servicePath], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    }).catch(() => undefined);
    await ensureLaunchdServiceBootstrapped(runner, domain, serviceTarget, layout.servicePath, serviceTimeoutMs);
    await runner("launchctl", ["enable", serviceTarget], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    }).catch(() => undefined);
    await runner("launchctl", ["kickstart", "-k", serviceTarget], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    });
    return { ...layout, started: true };
  }

  if (layout.platform === "linux") {
    await mkdir(dirname(layout.servicePath), { recursive: true });
    await writeFile(
      layout.wrapperPath,
      buildPosixDaemonWrapperScript({
        nodePath,
        commandPath: options.commandPath,
        env
      }),
      "utf8"
    );
    await chmod(layout.wrapperPath, 0o755);
    await writeFile(
      layout.servicePath,
      buildSystemdUserService({
        wrapperPath: layout.wrapperPath,
        logPath: layout.logPath,
        errorLogPath: layout.errorLogPath
      }),
      "utf8"
    );
    await runner("systemctl", ["--user", "daemon-reload"], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    });
    await runner("systemctl", ["--user", "enable", SYSTEMD_SERVICE_NAME], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    });
    await runner("loginctl", ["enable-linger", options.env?.USER || options.env?.USERNAME || userInfo().username], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    }).catch(() => undefined);
    await runner("systemctl", ["--user", "restart", SYSTEMD_SERVICE_NAME], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    });
    return { ...layout, started: true };
  }

  if (layout.platform === "win32") {
    await writeFile(
      layout.servicePath,
      buildWindowsTaskWrapperScript({
        nodePath,
        commandPath: options.commandPath,
        logPath: layout.logPath,
        errorLogPath: layout.errorLogPath,
        env
      }),
      "utf8"
    );
    await runner(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildWindowsTaskRegistrationCommand(layout.servicePath)],
      {
        timeoutMs: serviceTimeoutMs,
        maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
      }
    );
    await runner(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", windowsTaskCommand("Start-ScheduledTask")],
      {
        timeoutMs: serviceTimeoutMs,
        maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
      }
    );
    return { ...layout, started: true };
  }

  throw new Error(`Persistent service install is not supported on ${layout.platform}`);
}

export async function controlSelfHostedNodeService(
  action: SelfHostedNodeServiceControlAction,
  options: SelfHostedNodeServiceControlOptions = {}
): Promise<SelfHostedNodeServiceControlResult> {
  const layout = resolveSelfHostedNodeServiceLayout(options);
  const runner = options.runner || defaultCommandRunner;
  const timeoutMs = serviceCommandTimeoutMs(options.requestTimeoutMs);
  try {
    if (layout.manager === "launchd") {
      const domain = launchdDomain();
      const serviceTarget = `${domain}/${SERVICE_LABEL}`;
      if (action === "stop") {
        const result = await runServiceCommand(runner, "launchctl", ["bootout", serviceTarget], timeoutMs);
        return serviceControlResult(layout, action, result);
      }
      if (action === "status") {
        const result = await runServiceCommand(runner, "launchctl", ["print", serviceTarget], timeoutMs);
        return serviceControlResult(layout, action, result);
      }
      if (action === "restart") {
        await runServiceCommand(runner, "launchctl", ["bootout", serviceTarget], timeoutMs).catch(() => undefined);
      }
      await ensureLaunchdServiceBootstrapped(runner, domain, serviceTarget, layout.servicePath, timeoutMs);
      await runServiceCommand(runner, "launchctl", ["enable", serviceTarget], timeoutMs).catch(() => undefined);
      const result = await runServiceCommand(runner, "launchctl", ["kickstart", "-k", serviceTarget], timeoutMs);
      return serviceControlResult(layout, action, result);
    }

    if (layout.manager === "systemd") {
      const systemdAction = action === "status" ? "status" : action;
      const args =
        action === "status"
          ? ["--user", "status", "--no-pager", SYSTEMD_SERVICE_NAME]
          : ["--user", systemdAction, SYSTEMD_SERVICE_NAME];
      const result = await runServiceCommand(runner, "systemctl", args, timeoutMs);
      return serviceControlResult(layout, action, result);
    }

    if (layout.manager === "windows-task-scheduler") {
      const command =
        action === "status"
          ? [
              `$task = Get-ScheduledTask -TaskName ${quotePowerShellValue(WINDOWS_TASK_NAME)} -ErrorAction Stop`,
              `$info = Get-ScheduledTaskInfo -TaskName ${quotePowerShellValue(WINDOWS_TASK_NAME)} -ErrorAction Stop`,
              "[pscustomobject]@{TaskName=$task.TaskName;State=$task.State;LastRunTime=$info.LastRunTime;LastTaskResult=$info.LastTaskResult} | ConvertTo-Json -Compress"
            ].join("; ")
          : action === "restart"
            ? `${windowsTaskCommand("Stop-ScheduledTask")} -ErrorAction SilentlyContinue; ${windowsTaskCommand("Start-ScheduledTask")}`
            : windowsTaskCommand(action === "start" ? "Start-ScheduledTask" : "Stop-ScheduledTask");
      const result = await runServiceCommand(
        runner,
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
        timeoutMs
      );
      return serviceControlResult(layout, action, result);
    }
  } catch (error) {
    if (action === "status") {
      return serviceControlResult(layout, action, { stdout: "", stderr: "" }, false, error instanceof Error ? error.message : String(error));
    }
    throw error;
  }
  throw new Error(`Persistent service control is not supported on ${layout.platform}`);
}

export async function uninstallSelfHostedNodeService(
  options: SelfHostedNodeServiceControlOptions = {}
): Promise<SelfHostedNodeServiceControlResult> {
  const layout = resolveSelfHostedNodeServiceLayout(options);
  const runner = options.runner || defaultCommandRunner;
  const timeoutMs = serviceCommandTimeoutMs(options.requestTimeoutMs);
  if (layout.manager === "launchd") {
    await runServiceCommand(runner, "launchctl", ["bootout", `${launchdDomain()}/${SERVICE_LABEL}`], timeoutMs).catch(() => undefined);
    await rm(layout.servicePath, { force: true });
    return serviceControlResult(layout, "uninstall", { stdout: "", stderr: "" });
  }
  if (layout.manager === "systemd") {
    await runServiceCommand(runner, "systemctl", ["--user", "disable", "--now", SYSTEMD_SERVICE_NAME], timeoutMs).catch(() => undefined);
    await rm(layout.servicePath, { force: true });
    await runServiceCommand(runner, "systemctl", ["--user", "daemon-reload"], timeoutMs).catch(() => undefined);
    return serviceControlResult(layout, "uninstall", { stdout: "", stderr: "" });
  }
  if (layout.manager === "windows-task-scheduler") {
    const command = `${windowsTaskCommand("Stop-ScheduledTask")} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${quotePowerShellValue(WINDOWS_TASK_NAME)} -Confirm:$false -ErrorAction SilentlyContinue`;
    await runServiceCommand(runner, "powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], timeoutMs).catch(() => undefined);
    await rm(layout.servicePath, { force: true });
    return serviceControlResult(layout, "uninstall", { stdout: "", stderr: "" });
  }
  throw new Error(`Persistent service uninstall is not supported on ${layout.platform}`);
}

export async function readSelfHostedNodeConfig(
  env: NodeJS.ProcessEnv = process.env
): Promise<SelfHostedNodeConfig> {
  const statePath = optionalText(env.MSWARM_SELF_HOSTED_NODE_STATE_PATH) || defaultStatePath();
  const runtimeTokenPath = optionalText(env.MSWARM_SELF_HOSTED_NODE_KEY_PATH) || defaultRuntimeTokenPath();
  const state = await readSelfHostedNodeState(statePath);
  const persistedRuntimeToken = await readSelfHostedRuntimeToken(runtimeTokenPath);
  const nodeId = optionalText(env.MSWARM_SELF_HOSTED_NODE_ID) || state.node_id || "";
  if (!nodeId) {
    throw new Error("MSWARM_SELF_HOSTED_NODE_ID is required");
  }
  const gatewayBaseUrl =
    optionalText(env.MSWARM_GATEWAY_BASE_URL) || state.gateway_base_url || DEFAULT_GATEWAY_BASE_URL;
  const ollamaBaseUrl =
    optionalText(env.MSWARM_SELF_HOSTED_OLLAMA_BASE_URL) ||
    state.ollama_base_url ||
    optionalText(env.OLLAMA_HOST) ||
    DEFAULT_OLLAMA_BASE_URL;
  const packageNodeVersion = await readPackageNodeVersion();
  const maxConcurrentJobs = parsePositiveInteger(
    env.MSWARM_SELF_HOSTED_MAX_CONCURRENT_JOBS,
    state.max_concurrent_jobs || 1
  );
  const maxConcurrentLlmJobs = parsePositiveInteger(
    env.MSWARM_SELF_HOSTED_MAX_CONCURRENT_LLM_JOBS,
    state.max_concurrent_llm_jobs || maxConcurrentJobs
  );
  return {
    gatewayBaseUrl: trimTrailingSlash(gatewayBaseUrl),
    jobsPollPath:
      optionalText(env.MSWARM_SELF_HOSTED_JOBS_POLL_PATH) ||
      state.jobs_poll_path ||
      DEFAULT_SELF_HOSTED_JOBS_POLL_PATH,
    jobsStartPathTemplate:
      optionalText(env.MSWARM_SELF_HOSTED_JOBS_START_PATH_TEMPLATE) ||
      state.jobs_start_path_template ||
      DEFAULT_SELF_HOSTED_JOBS_START_PATH_TEMPLATE,
    jobsEventsPathTemplate:
      optionalText(env.MSWARM_SELF_HOSTED_JOBS_EVENTS_PATH_TEMPLATE) ||
      state.jobs_events_path_template ||
      DEFAULT_SELF_HOSTED_JOBS_EVENTS_PATH_TEMPLATE,
    jobsResultPathTemplate:
      optionalText(env.MSWARM_SELF_HOSTED_JOBS_RESULT_PATH_TEMPLATE) ||
      state.jobs_result_path_template ||
      DEFAULT_SELF_HOSTED_JOBS_RESULT_PATH_TEMPLATE,
    nodeId,
    serverName: optionalText(env.MSWARM_SELF_HOSTED_SERVER_NAME) || state.server_name || null,
    relayMode: parseRelayMode(env.MSWARM_SELF_HOSTED_RELAY_MODE || state.relay_mode),
    machineFingerprint: state.machine_fingerprint || null,
    directBaseUrl:
      optionalText(env.MSWARM_SELF_HOSTED_DIRECT_BASE_URL) || state.direct_base_url || null,
    enrollmentToken: optionalText(env.MSWARM_SELF_HOSTED_ENROLLMENT_TOKEN),
    runtimeToken:
      optionalText(env.MSWARM_SELF_HOSTED_RUNTIME_TOKEN) || persistedRuntimeToken || state.runtime_token || null,
    discoveryMode: parseDiscoveryMode(env.MSWARM_SELF_HOSTED_DISCOVERY_MODE || state.discovery_mode),
    mcodaBin: optionalText(env.MSWARM_SELF_HOSTED_MCODA_BIN) || state.mcoda_bin || DEFAULT_MCODA_BIN,
    mcodaListArgs: parseArgs(env.MSWARM_SELF_HOSTED_MCODA_LIST_ARGS || state.mcoda_list_args, DEFAULT_MCODA_LIST_ARGS),
    ollamaBaseUrl: trimTrailingSlash(ollamaBaseUrl),
    statePath,
    runtimeTokenPath,
    artifactStorePath:
      optionalText(env.MSWARM_SELF_HOSTED_ARTIFACT_STORE_PATH) ||
      state.artifact_store_path ||
      defaultArtifactStorePath(),
    invocationSigningSecret:
      optionalText(env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET) ||
      optionalText(env.MSWARM_SELF_HOSTED_RELAY_SIGNING_SECRET),
    listenHost: optionalText(env.MSWARM_SELF_HOSTED_LISTEN_HOST) || DEFAULT_LISTEN_HOST,
    listenPort: parsePositiveInteger(env.MSWARM_SELF_HOSTED_LISTEN_PORT, DEFAULT_LISTEN_PORT),
    nodeVersion:
      packageNodeVersion ||
      optionalText(env.MSWARM_SELF_HOSTED_NODE_VERSION) ||
      state.node_version ||
      DEFAULT_SELF_HOSTED_NODE_VERSION,
    heartbeatIntervalSeconds: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_HEARTBEAT_INTERVAL_SECONDS,
      state.heartbeat_interval_seconds || DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    ),
    requestTimeoutMs: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS,
      state.request_timeout_ms || DEFAULT_REQUEST_TIMEOUT_MS
    ),
    jobTimeoutMs: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS,
      state.job_timeout_ms || DEFAULT_JOB_TIMEOUT_MS
    ),
    maxConcurrentJobs,
    maxConcurrentLlmJobs,
    genericJobsEnabled: parseBoolean(
      env.MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED ?? env.MSWARM_SELF_HOSTED_GENERIC_JOBS,
      state.generic_jobs_enabled === true
    ),
    genericJobTimeoutMs: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_GENERIC_JOB_TIMEOUT_MS,
      state.generic_job_timeout_ms || state.job_timeout_ms || DEFAULT_JOB_TIMEOUT_MS
    ),
    genericJobMaxConcurrency: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY,
      state.generic_job_max_concurrency || 1
    ),
    capabilityProbeTimeoutMs: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_CAPABILITY_PROBE_TIMEOUT_MS,
      state.capability_probe_timeout_ms || DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS
    ),
    drainMode: parseBoolean(env.MSWARM_SELF_HOSTED_DRAIN_MODE, state.drain_mode === true),
    loadReportingEnabled: parseBoolean(
      env.MSWARM_SELF_HOSTED_LOAD_REPORTING_ENABLED ?? env.MSWARM_SELF_HOSTED_LOAD_REPORTING,
      state.load_reporting_enabled !== false
    ),
    hardwareTelemetryEnabled: parseBoolean(
      env.MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY_ENABLED ?? env.MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY,
      state.hardware_telemetry_enabled === true
    ),
    exposeAllModels: resolveDaemonExposeAllModels(env, state),
    modelAllowlist: parseList(env.MSWARM_SELF_HOSTED_MODEL_ALLOWLIST || state.model_allowlist),
    modelBlocklist: parseList(env.MSWARM_SELF_HOSTED_MODEL_BLOCKLIST || state.model_blocklist),
    clientAllowlist: normalizeSelfHostedNodeClientAllowlist(
      env.MSWARM_SELF_HOSTED_CLIENT_ALLOWLIST ||
        env.MSWARM_SELF_HOSTED_CLIENTS ||
        state.client_allowlist
    )
  };
}

export async function readOwnerSetupConfig(
  argv: string[] = process.argv.slice(3),
  env: NodeJS.ProcessEnv = process.env
): Promise<SelfHostedOwnerSetupConfig> {
  const options = parseCliOptions(argv);
  const statePath = optionalText(env.MSWARM_SELF_HOSTED_NODE_STATE_PATH) || defaultStatePath();
  const runtimeTokenPath = optionalText(env.MSWARM_SELF_HOSTED_NODE_KEY_PATH) || defaultRuntimeTokenPath();
  const gatewayBaseUrl =
    optionalText(options.gateway) ||
    optionalText(env.MSWARM_GATEWAY_BASE_URL) ||
    DEFAULT_SETUP_GATEWAY_BASE_URL;
  const apiKey = optionalText(options["api-key"]) || optionalText(env.MSWARM_API_KEY) || "";
  if (!apiKey) {
    throw new Error("--api-key or MSWARM_API_KEY is required");
  }
  const relayMode = parseRelayMode(options.mode || env.MSWARM_SELF_HOSTED_RELAY_MODE);
  const directBaseUrl = optionalText(options["direct-url"]) || optionalText(env.MSWARM_SELF_HOSTED_DIRECT_BASE_URL);
  if (relayMode === "direct" && !directBaseUrl) {
    throw new Error("--direct-url is required when --mode direct is used");
  }
  if (relayMode === "outbound" && directBaseUrl) {
    throw new Error("--direct-url can only be used with --mode direct");
  }
  const ollamaBaseUrl =
    optionalText(env.MSWARM_SELF_HOSTED_OLLAMA_BASE_URL) ||
    optionalText(env.OLLAMA_HOST) ||
    DEFAULT_OLLAMA_BASE_URL;
  const allowlist = parseList(options.allow || env.MSWARM_SELF_HOSTED_MODEL_ALLOWLIST);
  const blocklist = parseList(options.block || env.MSWARM_SELF_HOSTED_MODEL_BLOCKLIST);
  const clientAllowlist = normalizeSelfHostedNodeClientAllowlist(
    options.clients ||
      options.client ||
      env.MSWARM_SELF_HOSTED_CLIENT_ALLOWLIST ||
      env.MSWARM_SELF_HOSTED_CLIENTS
  );
  const packageNodeVersion = await readPackageNodeVersion();
  const maxConcurrentJobs = parsePositiveInteger(
    options["max-concurrent-jobs"] || env.MSWARM_SELF_HOSTED_MAX_CONCURRENT_JOBS,
    1
  );
  const maxConcurrentLlmJobs = parsePositiveInteger(
    options["max-concurrent-llm-jobs"] || env.MSWARM_SELF_HOSTED_MAX_CONCURRENT_LLM_JOBS,
    maxConcurrentJobs
  );
  return {
    apiKey,
    gatewayBaseUrl: trimTrailingSlash(gatewayBaseUrl),
    serverName: normalizeLocalName(
      optionalText(options["server-name"]) ||
        optionalText(env.MSWARM_SELF_HOSTED_SERVER_NAME) ||
        resolveDefaultServerName()
    ),
    relayMode,
    directBaseUrl,
    discoveryMode: parseDiscoveryMode(env.MSWARM_SELF_HOSTED_DISCOVERY_MODE),
    statePath,
    runtimeTokenPath,
    artifactStorePath:
      optionalText(options["artifact-store-path"]) ||
      optionalText(env.MSWARM_SELF_HOSTED_ARTIFACT_STORE_PATH) ||
      defaultArtifactStorePath(),
    machineIdPath: optionalText(env.MSWARM_SELF_HOSTED_MACHINE_ID_PATH) || defaultMachineIdPath(),
    mcodaBin: optionalText(env.MSWARM_SELF_HOSTED_MCODA_BIN) || DEFAULT_MCODA_BIN,
    mcodaListArgs: parseArgs(env.MSWARM_SELF_HOSTED_MCODA_LIST_ARGS, DEFAULT_MCODA_LIST_ARGS),
    ollamaBaseUrl: trimTrailingSlash(ollamaBaseUrl),
    nodeVersion: optionalText(env.MSWARM_SELF_HOSTED_NODE_VERSION) || packageNodeVersion,
    heartbeatIntervalSeconds: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_HEARTBEAT_INTERVAL_SECONDS,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    ),
    requestTimeoutMs: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS
    ),
    jobTimeoutMs: parsePositiveInteger(
      options["job-timeout-ms"] || env.MSWARM_SELF_HOSTED_JOB_TIMEOUT_MS,
      DEFAULT_JOB_TIMEOUT_MS
    ),
    maxConcurrentJobs,
    maxConcurrentLlmJobs,
    genericJobsEnabled: parseBoolean(
      options["enable-generic-jobs"] || env.MSWARM_SELF_HOSTED_GENERIC_JOBS_ENABLED || env.MSWARM_SELF_HOSTED_GENERIC_JOBS,
      false
    ),
    genericJobTimeoutMs: parsePositiveInteger(
      options["generic-job-timeout-ms"] || env.MSWARM_SELF_HOSTED_GENERIC_JOB_TIMEOUT_MS,
      DEFAULT_JOB_TIMEOUT_MS
    ),
    genericJobMaxConcurrency: parsePositiveInteger(
      options["generic-job-max-concurrency"] || env.MSWARM_SELF_HOSTED_GENERIC_JOB_MAX_CONCURRENCY,
      1
    ),
    capabilityProbeTimeoutMs: parsePositiveInteger(
      env.MSWARM_SELF_HOSTED_CAPABILITY_PROBE_TIMEOUT_MS,
      DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS
    ),
    drainMode: parseBoolean(options.drain || env.MSWARM_SELF_HOSTED_DRAIN_MODE, false),
    loadReportingEnabled: parseBoolean(
      options["disable-load-reporting"] === true
        ? false
        : (env.MSWARM_SELF_HOSTED_LOAD_REPORTING_ENABLED ?? env.MSWARM_SELF_HOSTED_LOAD_REPORTING),
      true
    ),
    hardwareTelemetryEnabled: parseBoolean(
      options["enable-hardware-telemetry"] || env.MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY_ENABLED || env.MSWARM_SELF_HOSTED_HARDWARE_TELEMETRY,
      false
    ),
    exposeAllModels: resolveOwnerSetupExposeAllModels(options, env),
    modelAllowlist: allowlist,
    modelBlocklist: blocklist,
    clientAllowlist,
    start: options.start === true
  };
}

export function mapOllamaModelToSelfHostedModel(
  model: OllamaTagModel,
  config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">
): SelfHostedModelInput | null {
  const name = optionalText(model.name);
  if (!name) {
    return null;
  }
  const family = optionalText(model.details?.family);
  const parameterSize = optionalText(model.details?.parameter_size);
  const quantizationLevel = optionalText(model.details?.quantization_level);
  const embeddingOnly = isEmbeddingModel(name, family);
  return {
    name,
    provider: "ollama",
    adapter: "ollama",
    model_id: name,
    digest: optionalText(model.digest),
    family,
    parameter_size: parameterSize,
    quantization_level: quantizationLevel,
    supports_tools: false,
    supports_vision: isVisionModel(name, family),
    openai_compatible: false,
    exposed: isModelExposed(name, family, config),
    best_usage: embeddingOnly
      ? "embedding"
      : family === "codellama" || name.toLowerCase().includes("code")
        ? "code_writer"
        : "general_chat",
    rating: 5,
    reasoning_rating: 4,
    max_complexity: 3,
    health_status: "healthy",
    metadata_quality: model.details ? "discovered" : "unknown"
  };
}

export function mapMcodaAgentToSelfHostedModel(
  agent: McodaAgentListEntry,
  config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">
): SelfHostedModelInput | null {
  if (isMswarmManagedAgent(agent)) {
    return null;
  }
  const slug = optionalText(agent.slug);
  if (!slug) {
    return null;
  }
  const adapter = optionalText(agent.adapter) || "unknown";
  const defaultModel =
    optionalText(agent.defaultModel) ||
    optionalText(agent.default_model) ||
    optionalText(agent.models?.find((model) => model.isDefault === true || model.is_default === true)?.modelName) ||
    optionalText(agent.models?.find((model) => model.isDefault === true || model.is_default === true)?.model_name) ||
    null;
  const bestUsage = optionalText(agent.bestUsage) || optionalText(agent.best_usage) || "general_chat";
  const healthStatus = normalizeHealthStatus(agent.health?.status);
  const capabilities = normalizeCapabilities(agent.capabilities);
  const localRunner = normalizeMcodaLocalRunnerConfig(adapter, agent.config);
  const supportsTools = optionalBoolean(agent.supportsTools, agent.supports_tools, localRunner?.supportsTools) === true;
  const openaiCompatible =
    localRunner !== undefined || optionalBoolean(agent.openaiCompatible, agent.openai_compatible) === true;
  const model = defaultModel || slug;
  return {
    name: slug,
    provider: "mcoda",
    adapter,
    source_agent_id: optionalText(agent.id),
    source_agent_slug: slug,
    model,
    model_id: model,
    base_url: localRunner?.baseUrl,
    runner_kind: localRunner?.runnerKind,
    auth_mode: localRunner?.authMode,
    response_format_strategy: localRunner?.responseFormatStrategy,
    health_path: localRunner?.healthPath,
    models_path: localRunner?.modelsPath,
    display_name: slug,
    context_window: optionalNumber(agent.contextWindow, agent.context_window),
    max_output_tokens: optionalNumber(agent.maxOutputTokens, agent.max_output_tokens),
    supports_tools: supportsTools,
    supports_streaming: localRunner?.supportsStreaming,
    supports_vision:
      capabilities.some((capability) => capability.toLowerCase().includes("vision")) ||
      capabilities.some((capability) => capability.toLowerCase().includes("visual")),
    supports_json_schema: localRunner?.supportsJsonSchema,
    supports_gbnf: localRunner?.supportsGbnf,
    openai_compatible: openaiCompatible,
    exposed:
      healthStatus !== "blocked" &&
      isAgentExposed(slug, defaultModel, bestUsage, config),
    best_usage: bestUsage,
    capabilities,
    cost_per_million: optionalNumber(agent.costPerMillion, agent.cost_per_million),
    rating: optionalNumber(agent.rating),
    reasoning_rating: optionalNumber(agent.reasoningRating, agent.reasoning_rating),
    max_complexity: optionalNumber(agent.maxComplexity, agent.max_complexity),
    health_status: healthStatus,
    metadata_quality: "discovered"
  };
}

function parseMcodaAgentListOutput(stdout: string): McodaAgentListEntry[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (Array.isArray(parsed)) {
    return parsed as McodaAgentListEntry[];
  }
  if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.agents)) {
      return record.agents as McodaAgentListEntry[];
    }
  }
  throw new Error("mcoda agent list returned unsupported JSON");
}

async function defaultCommandRunner(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number; input?: string; signal?: AbortSignal }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const abort = () => {
      if (settled) return;
      child.kill("SIGTERM");
      finish(new Error("command aborted"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${options.timeoutMs}ms: ${command}`));
    }, options.timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > options.maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error(`command stdout exceeded ${options.maxBuffer} bytes: ${command}`));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > options.maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error(`command stderr exceeded ${options.maxBuffer} bytes: ${command}`));
      }
    });
    child.on("error", finish);
    child.on("close", (code) => {
      if (code && code !== 0) {
        finish(new Error(`command failed (${code}): ${command} ${args.join(" ")} ${stderr}`.trim()));
        return;
      }
      finish();
    });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

export class McodaAgentInventoryClient {
  private readonly command: string;
  private readonly args: string[];
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;

  constructor(input: {
    command?: string;
    args?: string[];
    timeoutMs?: number;
    runner?: CommandRunner;
  }) {
    this.command = input.command || DEFAULT_MCODA_BIN;
    this.args = input.args?.length ? input.args : DEFAULT_MCODA_LIST_ARGS;
    this.timeoutMs = input.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.runner = input.runner || defaultCommandRunner;
  }

  async listRawAgents(): Promise<McodaAgentListEntry[]> {
    let stdout: string;
    try {
      stdout = (await this.runner(this.command, this.args, {
        timeoutMs: this.timeoutMs,
        maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
      })).stdout;
    } catch (error) {
      if (!this.args.includes("--refresh-health")) {
        throw error;
      }
      stdout = (await this.runner(this.command, ["agent", "list", "--json"], {
        timeoutMs: this.timeoutMs,
        maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
      })).stdout;
    }
    return parseMcodaAgentListOutput(stdout);
  }

  async listAgents(
    config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">
  ): Promise<SelfHostedModelInput[]> {
    return (await this.listRawAgents())
      .map((agent) => mapMcodaAgentToSelfHostedModel(agent, config))
      .filter((model): model is SelfHostedModelInput => Boolean(model));
  }
}

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(input: { baseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
    this.baseUrl = trimTrailingSlash(input.baseUrl);
    this.fetchImpl = input.fetchImpl || fetch;
    this.timeoutMs = input.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async getVersion(): Promise<string | null> {
    const response = await fetchJson<OllamaVersionResponse>(
      this.fetchImpl,
      `${this.baseUrl}/api/version`,
      { method: "GET" },
      this.timeoutMs
    );
    return optionalText(response.version);
  }

  async listModels(config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">): Promise<SelfHostedModelInput[]> {
    const response = await fetchJson<OllamaTagsResponse>(
      this.fetchImpl,
      `${this.baseUrl}/api/tags`,
      { method: "GET" },
      this.timeoutMs
    );
    return (response.models || [])
      .map((model) => mapOllamaModelToSelfHostedModel(model, config))
      .filter((model): model is SelfHostedModelInput => Boolean(model));
  }

  async chat(input: {
    model: string;
    messages: SelfHostedOpenAIChatMessage[];
    options?: Record<string, unknown>;
    format?: unknown;
  }): Promise<{ content: string; promptTokens: number | null; completionTokens: number | null; raw: unknown }> {
    const response = await fetchJson<{
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    }>(
      this.fetchImpl,
      `${this.baseUrl}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages.map((message) => ({
            role: message.role,
            content: openAIMessageContentToText(message.content)
          })),
          stream: false,
          ...(input.format !== undefined ? { format: input.format } : {}),
          ...(input.options && Object.keys(input.options).length > 0 ? { options: input.options } : {})
        })
      },
      this.timeoutMs
    );
    return {
      content: typeof response.message?.content === "string" ? response.message.content : "",
      promptTokens: typeof response.prompt_eval_count === "number" ? response.prompt_eval_count : null,
      completionTokens: typeof response.eval_count === "number" ? response.eval_count : null,
      raw: response
    };
  }
}

function openAIMessageContentToText(content: SelfHostedOpenAIChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function messagesToPrompt(messages: SelfHostedOpenAIChatMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role || "user";
      const content = openAIMessageContentToText(message.content).trim();
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resolveOllamaResponseFormat(responseFormat: unknown): unknown {
  const format = objectRecord(responseFormat);
  if (!format) {
    return undefined;
  }
  if (format.type === "json_object") {
    return "json";
  }
  if (format.type === "json_schema") {
    const jsonSchema = objectRecord(format.json_schema);
    const schema = objectRecord(jsonSchema?.schema) || objectRecord(format.schema) || jsonSchema;
    return schema || "json";
  }
  return undefined;
}

function applyResponseFormatInstruction(prompt: string, responseFormat: unknown): string {
  const format = resolveOllamaResponseFormat(responseFormat);
  if (format === undefined) {
    return prompt;
  }
  const baseInstruction = [
    "Output format constraint:",
    "Return exactly one valid JSON object.",
    "Do not include markdown fences, reasoning, commentary, or any text outside the JSON object."
  ];
  if (format !== "json") {
    baseInstruction.splice(2, 0, `The JSON object must match this schema: ${JSON.stringify(format)}`);
  }
  return `${prompt}\n\n${baseInstruction.join("\n")}`;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function buildOpenAIChatCompletion(input: {
  requestId: string;
  model: string;
  content: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const promptTokens = positiveInteger(input.promptTokens);
  const completionTokens = positiveInteger(input.completionTokens);
  const totalTokens =
    promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null;
  return {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cost_cents: 0
    },
    metadata: input.metadata
  };
}

function configText(config: Record<string, unknown> | null | undefined, ...keys: string[]): string | undefined {
  if (!config) return undefined;
  for (const key of keys) {
    const value = optionalText(config[key]);
    if (value) return value;
  }
  return undefined;
}

async function defaultMcodaAgentAuthResolver(agent: McodaAgentListEntry): Promise<string | undefined> {
  const agentId = optionalText(agent.id);
  if (!agentId) {
    return undefined;
  }
  const repo = await GlobalRepository.create();
  try {
    const secret = await repo.getAgentAuthSecret(agentId);
    return secret?.encryptedSecret ? CryptoHelper.decryptSecret(secret.encryptedSecret) : undefined;
  } finally {
    await repo.close();
  }
}

function mcodaAgentDefaultModel(agent: McodaAgentListEntry): string | null {
  return (
    optionalText(agent.defaultModel) ||
    optionalText(agent.default_model) ||
    optionalText(agent.models?.find((model) => model.isDefault === true || model.is_default === true)?.modelName) ||
    optionalText(agent.models?.find((model) => model.isDefault === true || model.is_default === true)?.model_name) ||
    null
  );
}

function resolveCodaliProviderForAgent(agent: McodaAgentListEntry): string | undefined {
  const adapter = optionalText(agent.adapter);
  if (isLocalOpenAiCompatibleAdapter(adapter)) {
    return "openai-compatible";
  }
  if (["ollama-remote", "ollama-cli", "ollama", "local-model"].includes(adapter || "")) {
    return "ollama-remote";
  }
  if (
    adapter === "openai" ||
    adapter === "openai-api" ||
    adapter === "openai-compatible" ||
    adapter === "openai-cli"
  ) {
    return "openai-compatible";
  }
  if (adapter === "codex-cli") return "codex-cli";
  return adapter || undefined;
}

function mcodaAgentRequiresApiKey(agent: McodaAgentListEntry, mapped: MswarmCodaliAgent): boolean {
  if (mapped.provider !== "openai-compatible") {
    return false;
  }
  if (mapped.localRunner) {
    return mapped.authMode === "bearer";
  }
  const adapter = optionalText(agent.adapter) || "";
  if (["openai", "openai-api", "openai-compatible"].includes(adapter)) {
    return mapped.authMode !== "none";
  }
  return mapped.authMode === "bearer";
}

function mapMcodaAgentToCodaliAgent(agent: McodaAgentListEntry, fallbackSlug: string): MswarmCodaliAgent {
  const adapter = optionalText(agent.adapter) || "unknown";
  const model = mcodaAgentDefaultModel(agent) || fallbackSlug;
  const config = agent.config ?? null;
  const localRunner = normalizeMcodaLocalRunnerConfig(adapter, config);
  const configAuthMode = normalizeLocalRunnerAuthMode(config?.authMode);
  const supportsTools = optionalBoolean(agent.supportsTools, agent.supports_tools, localRunner?.supportsTools) === true;
  return {
    slug: optionalText(agent.slug) || fallbackSlug,
    adapter,
    provider: resolveCodaliProviderForAgent(agent),
    model,
    baseUrl: localRunner?.baseUrl ?? configText(config, "baseUrl", "base_url", "apiBaseUrl", "api_base_url"),
    apiKey: localRunner
      ? localRunner.authMode === "bearer"
        ? configText(config, "apiKey", "api_key")
        : undefined
      : configText(config, "apiKey", "api_key"),
    localRunner,
    runnerKind: localRunner?.runnerKind,
    authMode: localRunner?.authMode ?? configAuthMode,
    dummyBearerToken: localRunner?.dummyBearerToken,
    headers: localRunner?.headers,
    extraBody: localRunner?.extraBody,
    responseFormatStrategy: localRunner?.responseFormatStrategy,
    healthPath: localRunner?.healthPath,
    modelsPath: localRunner?.modelsPath,
    requireModelInRequest: localRunner?.requireModelInRequest,
    supportsStreaming: localRunner?.supportsStreaming,
    supportsTools,
    supportsJsonSchema: localRunner?.supportsJsonSchema,
    supportsGbnf: localRunner?.supportsGbnf,
    capabilities: normalizeCapabilities(agent.capabilities),
    contextWindow: optionalNumber(agent.contextWindow, agent.context_window) ?? undefined,
    maxOutputTokens: optionalNumber(agent.maxOutputTokens, agent.max_output_tokens) ?? undefined,
  };
}

function buildCodaliWorkspace(job: SelfHostedNodeInvocationJob): MswarmCodaliWorkspace | undefined {
  const root = optionalText(job.workspace?.root);
  if (!root) {
    return undefined;
  }
  return {
    root,
    readOnly: job.workspace?.read_only !== false,
  };
}

const ATTACHED_MSWARM_API_KEY_CREDENTIAL_SOURCE = "attached_mswarm_api_key";
const DOCDEX_JOB_ERROR_CODES = new Set([
  "docdex_context_missing",
  "docdex_api_key_missing",
  "docdex_operation_not_allowed",
  "docdex_auth_failed",
  "docdex_repo_access_denied",
  "docdex_unavailable",
]);

const PRE_START_JOB_ERROR_CODES = new Set([
  "selected_agent_unavailable",
  "selected_agent_auth_unavailable",
  "selected_agent_unhealthy",
  "validation_failed",
  "docdex_context_missing",
  "docdex_api_key_missing",
  SELF_HOSTED_PROTOCOL_MISMATCH_CODE,
]);

class SelfHostedDocdexJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

class SelfHostedPreStartJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

class SelfHostedProtocolMismatchError extends Error {
  readonly code = SELF_HOSTED_PROTOCOL_MISMATCH_CODE;
  readonly endpoint: string;
  readonly gatewayBaseUrl: string;
  readonly runtimePackageVersion: string;

  constructor(input: { endpoint: string; gatewayBaseUrl: string; runtimePackageVersion: string }) {
    super(
      `Gateway is missing lifecycle endpoint ${input.endpoint} at ${input.gatewayBaseUrl} ` +
        `(runtime package version ${input.runtimePackageVersion}). ` +
        "Run a direct local agent/model instead, for example qwen3.6-llama.cpp."
    );
    this.name = SELF_HOSTED_PROTOCOL_MISMATCH_CODE;
    this.endpoint = input.endpoint;
    this.gatewayBaseUrl = input.gatewayBaseUrl;
    this.runtimePackageVersion = input.runtimePackageVersion;
  }
}

function normalizeDocdexCapabilityMap(value: unknown): Record<string, boolean | undefined> | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const output: Record<string, boolean | undefined> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "boolean") {
      output[key] = entry;
    }
  }
  return Object.keys(output).length ? output : undefined;
}

function buildCodaliDocdex(job: SelfHostedNodeInvocationJob): MswarmCodaliDocdex | undefined {
  if (!job.docdex) {
    return undefined;
  }
  const allowedOperations = normalizeCapabilities(job.docdex.allowed_operations);
  return {
    baseUrl: optionalText(job.docdex.base_url) || undefined,
    repoRoot: optionalText(job.docdex.repo_root) || optionalText(job.workspace?.root) || undefined,
    repoId: optionalText(job.docdex.repo_id) || undefined,
    dagSessionId: optionalText(job.docdex.dag_session_id) || job.request_id,
    required: job.docdex.required === true,
    allowedOperations: allowedOperations.length ? allowedOperations : undefined,
    credentialSource: optionalText(job.docdex.credential_source) || undefined,
    capabilities: normalizeDocdexCapabilityMap(job.docdex.capabilities),
    initialize: job.docdex.initialize,
    allowWeb: job.docdex.allow_web === true,
    allowMemoryWrite: job.docdex.allow_memory_write === true,
    allowProfileWrite: job.docdex.allow_profile_write === true,
    allowIndexRebuild: job.docdex.allow_index_rebuild === true,
  };
}

function attachedMswarmApiKeyForDocdex(
  job: SelfHostedNodeInvocationJob,
  attachedMswarmApiKey: string | undefined,
): string | undefined {
  if (job.docdex?.credential_source !== ATTACHED_MSWARM_API_KEY_CREDENTIAL_SOURCE) {
    return undefined;
  }
  return optionalText(attachedMswarmApiKey) || undefined;
}

function validateRequiredDocdexContext(
  job: SelfHostedNodeInvocationJob,
  attachedMswarmApiKey: string | undefined,
): void {
  if (job.docdex?.required !== true) {
    return;
  }
  if (!optionalText(job.docdex.base_url) || !optionalText(job.docdex.repo_id)) {
    throw new SelfHostedDocdexJobError(
      "docdex_context_missing",
      "Required Docdex runtime context must include base_url and repo_id.",
    );
  }
  if (job.docdex.credential_source !== ATTACHED_MSWARM_API_KEY_CREDENTIAL_SOURCE) {
    throw new SelfHostedDocdexJobError(
      "docdex_context_missing",
      "Required Docdex runtime context must use credential_source attached_mswarm_api_key.",
    );
  }
  if (!attachedMswarmApiKeyForDocdex(job, attachedMswarmApiKey)) {
    throw new SelfHostedDocdexJobError(
      "docdex_api_key_missing",
      "Required Docdex runtime context did not receive an attached mswarm API key.",
    );
  }
}

function selfHostedErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  if (
    typeof code === "string" &&
    (DOCDEX_JOB_ERROR_CODES.has(code) || PRE_START_JOB_ERROR_CODES.has(code))
  ) {
    return code;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && (DOCDEX_JOB_ERROR_CODES.has(name) || PRE_START_JOB_ERROR_CODES.has(name))
    ? name
    : undefined;
}

function redactRuntimeSecretValues(value: string, secrets: Array<string | undefined>): string {
  let output = value;
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4) {
      output = output.split(secret).join("[redacted]");
    }
  }
  return output.replace(
    /((?:x-api-key|authorization|api[_-]?key|token|secret)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;}]+/gi,
    "$1[redacted]"
  );
}

function buildCodaliPolicy(job: SelfHostedNodeInvocationJob): MswarmCodaliPolicy {
  return {
    allowTools: job.policy?.allow_tools !== false,
    allowedTools: job.policy?.allowed_tools,
    deniedTools: job.policy?.denied_tools,
    allowShell: job.policy?.allow_shell === true,
    allowWrites: job.policy?.allow_writes === true,
    allowDestructiveOperations: job.policy?.allow_destructive_operations === true,
    allowOutsideWorkspace: job.policy?.allow_outside_workspace === true,
    maxRuntimeMs: job.policy?.max_runtime_ms,
    maxToolCalls: job.policy?.max_tool_calls,
    maxOutputTokens: job.policy?.max_output_tokens ?? job.openai_request.max_tokens,
  };
}

function numberArg(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedMilliseconds(value: unknown, fallback: number, max: number): number {
  return Math.max(0, Math.min(max, Math.floor(numberArg(value, fallback))));
}

function abortErrorCode(signal: AbortSignal): "cancelled" | "timeout" {
  return signal.reason === "timeout" ? "timeout" : "cancelled";
}

function abortErrorMessage(signal: AbortSignal): string {
  return abortErrorCode(signal) === "timeout" ? "generic job timed out" : "generic job cancelled";
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal.aborted) {
    throw new Error(abortErrorMessage(signal));
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error(abortErrorMessage(signal)));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function safeLocalArtifactJobId(jobId: string): string {
  const normalized = jobId.replace(/[^a-zA-Z0-9_.-]/g, "_") || "job";
  return assertMswarmSafeRelativePath(normalized, "job_id");
}

function safeLocalArtifactName(value: string, fallback: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]/g, "_") || fallback;
  return assertMswarmSafeRelativePath(normalized, "artifact_name");
}

function resolveWithinRoot(root: string, relativePath: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  const delta = relative(rootPath, target);
  if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) {
    return target;
  }
  throw new Error("path_escape_not_allowed");
}

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function positiveByteLimit(...values: Array<number | undefined>): number {
  const positive = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : DEFAULT_LOCAL_ARTIFACT_MAX_BYTES;
}

function parseLocalArtifactUri(uri: string): { jobId: string; path: string } | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "artifact:" || parsed.hostname !== "local") {
      return null;
    }
    const parts = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const [jobId, ...artifactPath] = parts;
    return {
      jobId: assertMswarmSafeRelativePath(jobId, "artifact_job_id"),
      path: assertMswarmSafeRelativePath(artifactPath.join("/"), "artifact_path")
    };
  } catch {
    return null;
  }
}

export class MswarmLocalArtifactStore implements MswarmGenericJobArtifactStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(input: { rootDir?: string; now?: () => Date } = {}) {
    this.rootDir = input.rootDir || defaultArtifactStorePath();
    this.now = input.now || (() => new Date());
  }

  async prepareJobWorkspace(jobId: string, job: MswarmJobRequest): Promise<MswarmGenericJobArtifactContext> {
    const safeJobId = safeLocalArtifactJobId(jobId);
    const workDir = resolveWithinRoot(this.rootDir, safeJobId);
    const inputDir = resolveWithinRoot(workDir, "inputs");
    const outputDir = resolveWithinRoot(workDir, "outputs");
    await rm(workDir, { recursive: true, force: true });
    await mkdir(inputDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    const store = {
      backend: "local-dev" as const,
      root_uri: `artifact://local/${safeJobId}`
    };
    const registeredInputs = await Promise.all(
      (job.inputs || []).map((input, index) => this.registerInput(jobId, job, input, index, inputDir, store))
    );
    const outputSpecs = (job.outputs || []).map((output) => ({
      ...output,
      path: assertMswarmSafeRelativePath(output.path, "output_path")
    }));
    const sandbox = buildMswarmSandboxProfile({
      policy: job.policy,
      limits: job.limits,
      containerized: job.policy.trust_mode === "tenant-owned" || job.job_type === CUDA_RUN_JOB_TYPE,
      gpu: job.resources?.gpu ? "nvidia" : "none"
    });
    return {
      store,
      workDir,
      inputDir,
      outputDir,
      registeredInputs,
      outputSpecs,
      sandbox
    };
  }

  async collectOutputs(context: MswarmGenericJobArtifactContext, jobId: string): Promise<MswarmRegisteredArtifact[]> {
    const artifacts: MswarmRegisteredArtifact[] = [];
    let totalBytes = 0;
    for (const output of context.outputSpecs) {
      const collected = await this.collectDeclaredOutput(context, jobId, output);
      for (const artifact of collected) {
        totalBytes += artifact.size_bytes || 0;
        const totalLimit = positiveByteLimit(context.sandbox.limits.max_output_bytes);
        if (totalBytes > totalLimit) {
          throw new Error("output_size_limit_exceeded");
        }
        artifacts.push(artifact);
      }
    }
    return artifacts;
  }

  private async registerInput(
    jobId: string,
    job: MswarmJobRequest,
    input: NonNullable<MswarmJobRequest["inputs"]>[number],
    index: number,
    inputDir: string,
    store: MswarmGenericJobArtifactContext["store"]
  ): Promise<MswarmRegisteredArtifact> {
    const mountPath = input.mount_path
      ? assertMswarmSafeRelativePath(input.mount_path, "input_mount_path")
      : safeLocalArtifactName(input.name, `input-${index}`);
    const targetPath = resolveWithinRoot(inputDir, mountPath);
    const maxArtifactBytes = positiveByteLimit(job.policy.max_artifact_bytes);
    if (Number.isFinite(input.artifact.size_bytes) && input.artifact.size_bytes !== undefined) {
      if (input.artifact.size_bytes > maxArtifactBytes) {
        throw new Error("input_artifact_size_limit_exceeded");
      }
    }
    const source = parseLocalArtifactUri(input.artifact.uri);
    let localPath: string | undefined;
    if (source) {
      const sourcePath = resolveWithinRoot(resolveWithinRoot(this.rootDir, source.jobId), join("outputs", source.path));
      try {
        const sourceStat = await lstat(sourcePath);
        if (!sourceStat.isFile()) {
          throw new Error("input_artifact_must_be_file");
        }
        if (sourceStat.size > maxArtifactBytes) {
          throw new Error("input_artifact_size_limit_exceeded");
        }
        const bytes = await readFile(sourcePath);
        if (input.artifact.sha256 && input.artifact.sha256 !== sha256Hex(bytes)) {
          throw new Error("input_artifact_checksum_mismatch");
        }
        await mkdir(dirname(targetPath), { recursive: true });
        await writeFile(targetPath, bytes);
        localPath = targetPath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || input.required === true) {
          throw error;
        }
      }
    } else if (input.required === true) {
      throw new Error("input_artifact_unavailable");
    }
    const registeredAt = this.now().toISOString();
    return {
      ...input.artifact,
      id: input.artifact.id || `input_${sha256Hex(Buffer.from(`${jobId}:${input.name}:${input.artifact.uri}`)).slice(0, 16)}`,
      job_id: jobId,
      name: input.name,
      scope: "input",
      registered_at: registeredAt,
      store,
      access: defaultMswarmArtifactAccessPolicy(
        job.policy.trust_mode === "tenant-owned" ? "tenant-scoped" : "owner-local"
      ),
      retention: defaultMswarmArtifactRetentionPolicy(),
      ...(localPath ? { local_path: localPath } : {})
    };
  }

  private async collectDeclaredOutput(
    context: MswarmGenericJobArtifactContext,
    jobId: string,
    output: MswarmOutputSpec
  ): Promise<MswarmRegisteredArtifact[]> {
    const normalizedPath = assertMswarmSafeRelativePath(output.path, "output_path");
    const targetPath = resolveWithinRoot(context.outputDir, normalizedPath);
    try {
      const targetStat = await lstat(targetPath);
      if (targetStat.isSymbolicLink()) {
        throw new Error("output_symlink_not_allowed");
      }
      if (targetStat.isDirectory()) {
        return this.collectOutputDirectory(context, jobId, output, normalizedPath);
      }
      if (targetStat.isFile()) {
        return [await this.collectOutputFile(context, jobId, output, normalizedPath, targetPath)];
      }
      throw new Error("output_entry_type_not_allowed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && output.required !== true) {
        return [];
      }
      throw error;
    }
  }

  private async collectOutputDirectory(
    context: MswarmGenericJobArtifactContext,
    jobId: string,
    output: MswarmOutputSpec,
    relativeDir: string
  ): Promise<MswarmRegisteredArtifact[]> {
    const dirPath = resolveWithinRoot(context.outputDir, relativeDir);
    const entries = await readdir(dirPath, { withFileTypes: true });
    const artifacts: MswarmRegisteredArtifact[] = [];
    for (const entry of entries) {
      const childRelativePath = assertMswarmSafeRelativePath(`${relativeDir}/${entry.name}`, "output_path");
      const childPath = resolveWithinRoot(context.outputDir, childRelativePath);
      if (entry.isSymbolicLink()) {
        throw new Error("output_symlink_not_allowed");
      }
      if (entry.isDirectory()) {
        artifacts.push(...(await this.collectOutputDirectory(context, jobId, output, childRelativePath)));
      } else if (entry.isFile()) {
        artifacts.push(await this.collectOutputFile(context, jobId, output, childRelativePath, childPath));
      } else {
        throw new Error("output_entry_type_not_allowed");
      }
    }
    return artifacts;
  }

  private async collectOutputFile(
    context: MswarmGenericJobArtifactContext,
    jobId: string,
    output: MswarmOutputSpec,
    relativePath: string,
    filePath: string
  ): Promise<MswarmRegisteredArtifact> {
    const stat = await lstat(filePath);
    if (!stat.isFile()) {
      throw new Error("output_entry_type_not_allowed");
    }
    const perArtifactLimit = positiveByteLimit(context.sandbox.limits.max_artifact_bytes, context.sandbox.limits.max_output_bytes);
    if (stat.size > perArtifactLimit) {
      throw new Error("output_artifact_size_limit_exceeded");
    }
    const bytes = await readFile(filePath);
    return {
      id: `output_${sha256Hex(Buffer.from(`${jobId}:${relativePath}`)).slice(0, 16)}`,
      job_id: jobId,
      name: output.path === relativePath ? output.name : `${output.name}/${relativePath}`,
      uri: buildMswarmLocalArtifactUri(jobId, relativePath),
      content_type: output.content_type,
      size_bytes: stat.size,
      sha256: sha256Hex(bytes),
      scope: "output",
      registered_at: this.now().toISOString(),
      store: context.store,
      access: defaultMswarmArtifactAccessPolicy(
        context.sandbox.trust_mode === "tenant-owned" ? "tenant-scoped" : "owner-local"
      ),
      retention: defaultMswarmArtifactRetentionPolicy()
    };
  }
}

export class MswarmTestEchoRunner implements MswarmGenericJobRunner {
  readonly id = TEST_ECHO_RUNNER_ID;

  async run(context: MswarmGenericJobRunnerContext): Promise<MswarmJobResult> {
    const args = context.job.args || {};
    const message = optionalText(args.message) || "ok";
    const repeat = Math.max(1, Math.min(20, Math.floor(numberArg(args.repeat, 1))));
    const delayMs = boundedMilliseconds(args.delay_ms, 0, 30_000);
    if (args.fail === true) {
      throw new Error(message);
    }
    for (let index = 0; index < repeat; index += 1) {
      if (context.signal.aborted) {
        throw new Error(abortErrorMessage(context.signal));
      }
      if (delayMs > 0) {
        await sleepWithAbort(delayMs, context.signal);
      }
      await context.emitEvent({
        type: "stdout",
        message,
        data: {
          runner: this.id,
          index,
          repeat
        }
      });
    }
    await context.emitEvent({
      type: "progress",
      message: "echo complete",
      data: {
        completed: repeat,
        total: repeat
      }
    });
    return {
      job_id: context.job.idempotency_key || "local-generic-job",
      status: "succeeded",
      exit_code: 0,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      metrics: {
        runner: this.id,
        echoed: repeat,
        message
      }
    };
  }
}

type BlenderFrameSelection =
  | { mode: "frame"; frame: number; label: string; total: number }
  | { mode: "range"; start: number; end: number; label: string; total: number };

const BLENDER_ENGINE_ARGS: Record<string, string> = {
  cycles: "CYCLES",
  eevee: "BLENDER_EEVEE_NEXT",
  workbench: "BLENDER_WORKBENCH"
};

const BLENDER_OUTPUT_FORMAT_ARGS: Record<string, string> = {
  png: "PNG",
  jpeg: "JPEG",
  open_exr: "OPEN_EXR"
};

function positiveSafeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function parseBlenderFrameSelection(value: unknown): BlenderFrameSelection {
  const defaultFrame = 1;
  if (value === undefined || value === null) {
    return { mode: "frame", frame: defaultFrame, label: String(defaultFrame), total: 1 };
  }
  const numericFrame = positiveSafeInteger(value);
  if (numericFrame !== null) {
    return { mode: "frame", frame: numericFrame, label: String(numericFrame), total: 1 };
  }
  const raw = optionalText(value);
  const match = raw?.match(/^([1-9]\d{0,6})(?:-([1-9]\d{0,6}))?$/);
  if (!match) {
    throw new Error("render.blender args.frames must be a positive frame number or start-end range");
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : start;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end <= 0 || end < start) {
    throw new Error("render.blender args.frames must use a valid positive frame range");
  }
  if (end - start > 10_000) {
    throw new Error("render.blender args.frames range exceeds the maximum supported 10001 frames");
  }
  if (start === end) {
    return { mode: "frame", frame: start, label: String(start), total: 1 };
  }
  return { mode: "range", start, end, label: `${start}-${end}`, total: end - start + 1 };
}

function normalizeBlenderEngine(value: unknown): { label: string; blender: string } | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;
  const key = raw.toLowerCase();
  const blender = BLENDER_ENGINE_ARGS[key];
  if (!blender) {
    throw new Error("render.blender args.engine must be cycles, eevee, or workbench");
  }
  return { label: key, blender };
}

function normalizeBlenderOutputFormat(value: unknown): { label: string; blender: string; extension: string } {
  const key = (optionalText(value) || "png").toLowerCase();
  const blender = BLENDER_OUTPUT_FORMAT_ARGS[key];
  if (!blender) {
    throw new Error("render.blender args.output_format must be png, jpeg, or open_exr");
  }
  return { label: key, blender, extension: key === "open_exr" ? "exr" : key === "jpeg" ? "jpg" : "png" };
}

function parseBlenderResolution(value: unknown): { width: number; height: number; label: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = optionalText(value);
  const match = raw?.match(/^([1-9]\d{0,4})x([1-9]\d{0,4})$/i);
  if (!match) {
    throw new Error("render.blender args.resolution must use WIDTHxHEIGHT");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width > 16_384 || height > 16_384) {
    throw new Error("render.blender args.resolution exceeds 16384x16384");
  }
  return { width, height, label: `${width}x${height}` };
}

function safeBlenderSceneName(value: unknown, label: "scene" | "camera"): string | undefined {
  const raw = optionalText(value);
  if (!raw) return undefined;
  if (raw.length > 128 || /[\0\r\n]/.test(raw)) {
    throw new Error(`render.blender args.${label} is not a safe Blender object name`);
  }
  return raw;
}

function blenderSceneInputPath(context: MswarmGenericJobRunnerContext): string {
  const scene = context.artifacts.registeredInputs.find((input) => input.name === "scene") || context.artifacts.registeredInputs[0];
  if (!scene?.local_path) {
    throw new Error("render.blender requires a materialized scene input artifact");
  }
  return scene.local_path;
}

function blenderOutputPattern(context: MswarmGenericJobRunnerContext): string {
  const output = context.artifacts.outputSpecs[0];
  if (!output) {
    throw new Error("render.blender requires a declared output directory");
  }
  const normalizedPath = assertMswarmSafeRelativePath(output.path, "render_blender_output_path");
  const leaf = normalizedPath.split("/").filter(Boolean).at(-1) || normalizedPath;
  if (/\.[a-zA-Z0-9]{1,8}$/.test(leaf)) {
    throw new Error("render.blender output path must be a directory, not a file path");
  }
  return resolveWithinRoot(context.artifacts.outputDir, `${normalizedPath}/frame_####`);
}

function redactBlenderLocalPaths(context: MswarmGenericJobRunnerContext, value: string): string {
  const replacements: Array<[string | undefined, string]> = [
    [context.artifacts.workDir, "[job-workdir]"],
    [context.artifacts.inputDir, "[job-inputs]"],
    [context.artifacts.outputDir, "[job-outputs]"],
    ...context.artifacts.registeredInputs.map((input): [string | undefined, string] => [input.local_path, "[job-input]"])
  ];
  let output = value;
  for (const [source, replacement] of replacements) {
    if (source) {
      output = output.split(source).join(replacement);
    }
  }
  return output;
}

async function emitBlenderOutput(
  context: MswarmGenericJobRunnerContext,
  type: "stdout" | "stderr",
  value: string
): Promise<void> {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 200);
  for (const line of lines) {
    await context.emitEvent({
      type,
      message: redactBlenderLocalPaths(context, line),
      data: { runner: BLENDER_RENDER_RUNNER_ID }
    });
  }
}

async function emitBlenderProgress(
  context: MswarmGenericJobRunnerContext,
  output: string,
  frames: BlenderFrameSelection
): Promise<void> {
  const seen = new Set<number>();
  const lowerBound = frames.mode === "range" ? frames.start : frames.frame;
  const upperBound = frames.mode === "range" ? frames.end : frames.frame;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\bFra:(\d+)\b/i) || line.match(/\bFrame\s+(\d+)\b/i);
    if (!match) continue;
    const frame = Number(match[1]);
    if (!Number.isSafeInteger(frame) || frame < lowerBound || frame > upperBound || seen.has(frame)) {
      continue;
    }
    seen.add(frame);
    await context.emitEvent({
      type: "progress",
      message: `rendered frame ${frame}`,
      data: {
        runner: BLENDER_RENDER_RUNNER_ID,
        frame,
        completed: seen.size,
        total: frames.total
      }
    });
  }
}

function blenderFailureResult(job: MswarmJobRequest, code: string, message: string, startedAt: string): MswarmJobResult {
  return {
    job_id: job.idempotency_key || "render.blender",
    status: "failed",
    exit_code: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    error: {
      code,
      message,
      retryable: false
    }
  };
}

function blenderGpuComputeDeviceType(): "CUDA" {
  // The current GPU probe only marks NVIDIA devices as available, so CUDA is
  // the only concrete Blender compute backend this runner can safely request.
  return "CUDA";
}

export class MswarmBlenderRenderRunner implements MswarmGenericJobRunner {
  readonly id = BLENDER_RENDER_RUNNER_ID;
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = defaultCommandRunner) {
    this.runner = runner;
  }

  async run(context: MswarmGenericJobRunnerContext): Promise<MswarmJobResult> {
    const startedAt = new Date().toISOString();
    if (context.signal.aborted) {
      throw new Error(abortErrorMessage(context.signal));
    }
    if (context.job.policy.trust_mode !== "owner-local") {
      return blenderFailureResult(
        context.job,
        "policy_denied",
        "render.blender is owner-local only until containerized Blender execution is available",
        startedAt
      );
    }
    let scenePath: string;
    let frames: BlenderFrameSelection;
    let engine: { label: string; blender: string } | undefined;
    let outputFormat: { label: string; blender: string; extension: string };
    let resolution: { width: number; height: number; label: string } | undefined;
    let sceneName: string | undefined;
    let cameraName: string | undefined;
    let outputPattern: string;
    const gpuRequested = Boolean(context.job.resources?.gpu);
    try {
      const args = context.job.args || {};
      scenePath = blenderSceneInputPath(context);
      frames = parseBlenderFrameSelection(args.frames);
      engine = normalizeBlenderEngine(args.engine);
      outputFormat = normalizeBlenderOutputFormat(args.output_format);
      resolution = parseBlenderResolution(args.resolution);
      sceneName = safeBlenderSceneName(args.scene, "scene");
      cameraName = safeBlenderSceneName(args.camera, "camera");
      outputPattern = blenderOutputPattern(context);
      await mkdir(dirname(outputPattern), { recursive: true });
    } catch (error) {
      return blenderFailureResult(
        context.job,
        "validation_failed",
        error instanceof Error ? error.message : String(error || "render.blender validation failed"),
        startedAt
      );
    }

    const pythonStatements: string[] = [];
    if (resolution) {
      pythonStatements.push(`bpy.context.scene.render.resolution_x=${resolution.width}`);
      pythonStatements.push(`bpy.context.scene.render.resolution_y=${resolution.height}`);
    }
    if (cameraName) {
      pythonStatements.push(`camera=bpy.data.objects.get(${JSON.stringify(cameraName)})`);
      pythonStatements.push("bpy.context.scene.camera=camera if camera is not None else bpy.context.scene.camera");
    }
    if (gpuRequested) {
      const computeDeviceType = blenderGpuComputeDeviceType();
      pythonStatements.push("cycles_addon=bpy.context.preferences.addons.get('cycles')");
      pythonStatements.push("cycles_prefs=cycles_addon.preferences if cycles_addon is not None else None");
      pythonStatements.push(
        `setattr(cycles_prefs,'compute_device_type',${JSON.stringify(computeDeviceType)}) if cycles_prefs is not None and hasattr(cycles_prefs,'compute_device_type') else None`
      );
      pythonStatements.push("getattr(cycles_prefs,'get_devices',lambda: None)() if cycles_prefs is not None else None");
      pythonStatements.push("setattr(bpy.context.scene.cycles,'device','GPU') if hasattr(bpy.context.scene,'cycles') else None");
      pythonStatements.push(
        "[setattr(device,'use',True) for device in getattr(cycles_prefs,'devices',[]) if hasattr(device,'use')] if cycles_prefs is not None else None"
      );
    }

    const blenderArgs = ["-b", scenePath];
    if (sceneName) {
      blenderArgs.push("--scene", sceneName);
    }
    if (engine) {
      blenderArgs.push("--engine", engine.blender);
    }
    if (pythonStatements.length > 0) {
      blenderArgs.push("--python-expr", `import bpy; ${pythonStatements.join("; ")}`);
    }
    blenderArgs.push("--render-output", outputPattern, "--render-format", outputFormat.blender);
    if (frames.mode === "range") {
      blenderArgs.push("-s", String(frames.start), "-e", String(frames.end), "-a");
    } else {
      blenderArgs.push("--render-frame", String(frames.frame));
    }

    await context.emitEvent({
      type: "progress",
      message: "blender render starting",
      data: {
        runner: this.id,
        frames: frames.label,
        engine: engine?.label || "scene-default",
        output_format: outputFormat.label,
        ...(resolution ? { resolution: resolution.label } : {}),
        gpu_requested: gpuRequested,
        render_device: gpuRequested ? "gpu" : "scene-default"
      }
    });

    const timeoutMs = Math.max(
      1_000,
      Math.min(DEFAULT_JOB_TIMEOUT_MS, Math.floor((context.sandbox.limits.timeout_sec || DEFAULT_JOB_TIMEOUT_MS / 1000) * 1000))
    );
    const maxBuffer = Math.min(
      DEFAULT_COMMAND_MAX_BUFFER,
      Math.max(1024 * 1024, context.job.limits?.max_stdout_bytes || 0, context.job.limits?.max_stderr_bytes || 0)
    );
    try {
      const result = await this.runner("blender", blenderArgs, {
        timeoutMs,
        maxBuffer,
        signal: context.signal
      });
      await emitBlenderOutput(context, "stdout", result.stdout);
      await emitBlenderOutput(context, "stderr", result.stderr);
      await emitBlenderProgress(context, `${result.stdout}\n${result.stderr}`, frames);
      return {
        job_id: context.job.idempotency_key || "render.blender",
        status: "succeeded",
        exit_code: 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        metrics: {
          runner: this.id,
          frames: frames.label,
          engine: engine?.label || "scene-default",
          output_format: outputFormat.label,
          ...(resolution ? { resolution: resolution.label } : {}),
          gpu_requested: gpuRequested,
          render_device: gpuRequested ? "gpu" : "scene-default"
        }
      };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return blenderFailureResult(
        context.job,
        "runner_failed",
        redactBlenderLocalPaths(context, error instanceof Error ? error.message : String(error || "Blender render failed")),
        startedAt
      );
    }
  }
}

interface CudaRunArgs {
  manifestPath: string;
  profile: string;
  target: string;
}

interface CudaPackageManifestSelection {
  schemaVersion: string;
  packageName?: string;
  publisher?: string;
  image: string;
  compiler: "nvcc";
  source: string;
  output: string;
  flags: string[];
  runArgs: string[];
}

const SAFE_CUDA_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const SAFE_CUDA_TOKEN = /^[a-zA-Z0-9_@%+=:,./-]{1,200}$/;
const UNSAFE_CUDA_MANIFEST_KEYS = new Set([
  "command",
  "cmd",
  "shell",
  "entrypoint",
  "docker_args",
  "mount",
  "mounts",
  "volumes",
  "binds",
  "device",
  "devices",
  "privileged",
  "network",
  "host_network"
]);

function cudaFailureResult(job: MswarmJobRequest, code: string, message: string, startedAt: string): MswarmJobResult {
  return {
    job_id: job.idempotency_key || "cuda.run",
    status: "failed",
    exit_code: 1,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    error: {
      code,
      message,
      retryable: false
    }
  };
}

function safeCudaIdentifier(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text || !SAFE_CUDA_IDENTIFIER.test(text)) {
    throw new Error(`${label}_invalid`);
  }
  return text;
}

function safeCudaRelativePath(value: unknown, label: string): string {
  return assertMswarmSafeRelativePath(optionalText(value), label);
}

function safeCudaToken(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text || !SAFE_CUDA_TOKEN.test(text) || /[`$;&|<>\r\n]/.test(text)) {
    throw new Error(`${label}_invalid`);
  }
  return text;
}

function safeCudaTokenList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label}_must_be_array`);
  }
  return value.map((entry, index) => safeCudaToken(entry, `${label}_${index}`));
}

function assertNoUnsafeCudaManifestKeys(record: Record<string, unknown>, label: string): void {
  for (const key of Object.keys(record)) {
    if (UNSAFE_CUDA_MANIFEST_KEYS.has(key)) {
      throw new Error(`${label}_${key}_not_allowed`);
    }
  }
}

function parseCudaRunArgs(job: MswarmJobRequest): CudaRunArgs {
  const args = job.args || {};
  return {
    manifestPath: safeCudaRelativePath(args.manifest_path, "cuda_manifest_path"),
    profile: safeCudaIdentifier(args.profile, "cuda_profile"),
    target: safeCudaIdentifier(args.target, "cuda_target")
  };
}

function cudaPackageArchive(context: MswarmGenericJobRunnerContext): { hostPath: string; inputPath: string } {
  const registeredInput =
    context.artifacts.registeredInputs.find((input) => input.name === "package" && input.local_path) ||
    context.artifacts.registeredInputs.find((input) => input.local_path && input.name !== "manifest");
  if (!registeredInput?.local_path) {
    throw new Error("cuda_package_artifact_required");
  }
  const inputPath = assertMswarmSafeRelativePath(
    relative(context.artifacts.inputDir, registeredInput.local_path),
    "cuda_package_input_path"
  );
  if (!/(\.tar\.gz|\.tgz)$/i.test(inputPath)) {
    throw new Error("cuda_package_archive_must_be_targz");
  }
  return { hostPath: registeredInput.local_path, inputPath };
}

function cudaArchiveValidationError(reason: string | undefined): Error {
  return new Error(`cuda_package_archive_${reason || "invalid"}`);
}

function cudaTarVerboseEntryType(line: string): "file" | "directory" | "symlink" | "hardlink" | "device" | "other" {
  const marker = line.trimStart()[0];
  if (marker === "d") return "directory";
  if (marker === "-") return "file";
  if (marker === "l") return "symlink";
  if (marker === "h") return "hardlink";
  if (marker === "b" || marker === "c") return "device";
  return marker ? "other" : "file";
}

async function validateCudaPackageArchive(
  context: MswarmGenericJobRunnerContext,
  runner: CommandRunner,
  archive: { hostPath: string }
): Promise<void> {
  const listOptions = {
    timeoutMs: 5_000,
    maxBuffer: 512 * 1024,
    signal: context.signal
  };
  const names = await runner("tar", ["-tzf", archive.hostPath], listOptions);
  let entryCount = 0;
  for (const rawLine of names.stdout.split(/\r?\n/)) {
    const entryPath = rawLine.trim();
    if (!entryPath) continue;
    entryCount += 1;
    const result = validateMswarmArchiveEntry({
      path: entryPath,
      type: entryPath.endsWith("/") ? "directory" : "file"
    });
    if (!result.ok) {
      throw cudaArchiveValidationError(result.reason);
    }
  }
  if (entryCount === 0) {
    throw cudaArchiveValidationError("empty");
  }
  const verbose = await runner("tar", ["-tvzf", archive.hostPath], listOptions);
  for (const rawLine of verbose.stdout.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const type = cudaTarVerboseEntryType(rawLine);
    if (type === "file" || type === "directory") continue;
    const result = validateMswarmArchiveEntry({ path: "entry", type });
    throw cudaArchiveValidationError(result.reason);
  }
}

async function readCudaManifestText(
  context: MswarmGenericJobRunnerContext,
  runner: CommandRunner,
  args: CudaRunArgs
): Promise<string> {
  const directManifestPath = resolveWithinRoot(context.artifacts.inputDir, args.manifestPath);
  try {
    const directStat = await lstat(directManifestPath);
    if (directStat.isFile()) {
      return await readFile(directManifestPath, "utf8");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const archive = cudaPackageArchive(context);
  const extracted = await runner("tar", ["-xOf", archive.hostPath, args.manifestPath], {
    timeoutMs: 5_000,
    maxBuffer: 256 * 1024,
    signal: context.signal
  });
  return extracted.stdout;
}

function parseCudaPackageManifest(
  text: string,
  args: CudaRunArgs,
  policy: MswarmJobPolicy
): CudaPackageManifestSelection {
  const parsed = JSON.parse(text) as unknown;
  const manifest = objectRecord(parsed);
  if (!manifest) {
    throw new Error("cuda_manifest_must_be_object");
  }
  assertNoUnsafeCudaManifestKeys(manifest, "cuda_manifest");
  const schemaVersion = optionalText(manifest.schema_version);
  if (schemaVersion !== "2026-06-14") {
    throw new Error("cuda_manifest_schema_version_invalid");
  }
  const packageInfo = objectRecord(manifest.package);
  const publisher = optionalText(packageInfo?.publisher);
  if (policy.allowed_package_publishers?.length) {
    if (!publisher || !policy.allowed_package_publishers.includes(publisher)) {
      throw new Error("cuda_manifest_publisher_not_allowed");
    }
  }
  const profiles = objectRecord(manifest.profiles);
  const targets = objectRecord(manifest.targets);
  const profile = objectRecord(profiles?.[args.profile]);
  const target = objectRecord(targets?.[args.target]);
  if (!profile) {
    throw new Error("cuda_manifest_profile_not_found");
  }
  if (!target) {
    throw new Error("cuda_manifest_target_not_found");
  }
  assertNoUnsafeCudaManifestKeys(profile, "cuda_manifest_profile");
  assertNoUnsafeCudaManifestKeys(target, "cuda_manifest_target");
  const image = optionalText(profile.image);
  if (!image || !APPROVED_NVIDIA_CUDA_IMAGES.has(image)) {
    throw new Error("cuda_image_not_approved");
  }
  if (!policy.allowed_images?.includes(image)) {
    throw new Error("cuda_image_not_allowed_by_policy");
  }
  const compiler = optionalText(profile.compiler) || "nvcc";
  if (compiler !== "nvcc") {
    throw new Error("cuda_compiler_not_allowed");
  }
  const source = safeCudaRelativePath(target.source, "cuda_target_source");
  if (!source.endsWith(".cu")) {
    throw new Error("cuda_target_source_must_be_cu");
  }
  const output = safeCudaRelativePath(optionalText(target.output) || `bin/${args.target}`, "cuda_target_output");
  return {
    schemaVersion,
    packageName: optionalText(packageInfo?.name) ?? undefined,
    publisher: publisher ?? undefined,
    image,
    compiler,
    source,
    output,
    flags: [...safeCudaTokenList(profile.flags, "cuda_profile_flags"), ...safeCudaTokenList(target.flags, "cuda_target_flags")],
    runArgs: safeCudaTokenList(target.args, "cuda_target_args")
  };
}

function redactCudaLocalPaths(context: MswarmGenericJobRunnerContext, value: string): string {
  const replacements: Array<[string | undefined, string]> = [
    ...context.artifacts.registeredInputs.map((input): [string | undefined, string] => [input.local_path, "[job-input]"]),
    [context.artifacts.inputDir, "[job-inputs]"],
    [context.artifacts.outputDir, "[job-outputs]"],
    [context.artifacts.workDir, "[job-workdir]"]
  ];
  replacements.sort((left, right) => (right[0]?.length || 0) - (left[0]?.length || 0));
  let output = value;
  for (const [source, replacement] of replacements) {
    if (source) {
      output = output.split(source).join(replacement);
    }
  }
  return output;
}

async function emitCudaOutput(
  context: MswarmGenericJobRunnerContext,
  type: "stdout" | "stderr",
  value: string
): Promise<void> {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 200);
  for (const line of lines) {
    await context.emitEvent({
      type,
      message: redactCudaLocalPaths(context, line),
      data: { runner: CUDA_PACKAGE_RUNNER_ID }
    });
  }
}

function buildCudaRunnerScript(input: {
  archiveInputPath: string;
  selection: CudaPackageManifestSelection;
}): string {
  const srcDir = "/workspace/work/src";
  const buildOutput = `/workspace/work/${input.selection.output}`;
  const compile = [
    "/usr/local/cuda/bin/nvcc",
    ...input.selection.flags,
    "-o",
    buildOutput,
    `${srcDir}/${input.selection.source}`
  ].map(quotePosixShellValue).join(" ");
  const run = [
    buildOutput,
    ...input.selection.runArgs
  ].map(quotePosixShellValue).join(" ");
  return [
    "set -euo pipefail",
    "mkdir -p /workspace/work/src /workspace/outputs",
    `tar -xzf ${quotePosixShellValue(`/workspace/inputs/${input.archiveInputPath}`)} -C /workspace/work/src`,
    `mkdir -p ${quotePosixShellValue(dirname(buildOutput))}`,
    "cd /workspace/work/src",
    compile,
    run
  ].join("\n");
}

function dockerBindMount(hostPath: string, containerPath: string, mode: "ro" | "rw"): string {
  return `${hostPath}:${containerPath}:${mode}`;
}

function buildCudaDockerArgs(input: {
  context: MswarmGenericJobRunnerContext;
  selection: CudaPackageManifestSelection;
  archiveInputPath: string;
  scriptPath: string;
  workPath: string;
}): string[] {
  const gpuCount = Math.max(1, input.context.job.resources?.gpu?.count || 1);
  const args = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    "none",
    "--runtime",
    "nvidia",
    "--gpus",
    `count=${gpuCount}`,
    "--user",
    input.context.sandbox.container.user,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--workdir",
    "/workspace",
    "--env",
    "CUDA_CACHE_PATH=/workspace/work/.cuda-cache",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m"
  ];
  if (Number.isFinite(input.context.job.resources?.memory_gb) && input.context.job.resources?.memory_gb) {
    args.push("--memory", `${Math.floor(input.context.job.resources.memory_gb)}g`);
  }
  if (Number.isFinite(input.context.job.resources?.disk_gb) && input.context.job.resources?.disk_gb) {
    args.push("--storage-opt", `size=${Math.floor(input.context.job.resources.disk_gb)}G`);
  }
  args.push(
    "-v",
    dockerBindMount(input.context.artifacts.inputDir, "/workspace/inputs", "ro"),
    "-v",
    dockerBindMount(input.context.artifacts.outputDir, "/workspace/outputs", "rw"),
    "-v",
    dockerBindMount(input.workPath, "/workspace/work", "rw"),
    "-v",
    dockerBindMount(input.scriptPath, "/workspace/__mcoda_cuda_run.sh", "ro"),
    input.selection.image,
    "/bin/bash",
    "/workspace/__mcoda_cuda_run.sh"
  );
  return args;
}

export class MswarmCudaPackageRunner implements MswarmGenericJobRunner {
  readonly id = CUDA_PACKAGE_RUNNER_ID;
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner = defaultCommandRunner) {
    this.runner = runner;
  }

  async run(context: MswarmGenericJobRunnerContext): Promise<MswarmJobResult> {
    const startedAt = new Date().toISOString();
    if (context.signal.aborted) {
      throw new Error(abortErrorMessage(context.signal));
    }
    if (context.job.policy.network !== "none") {
      return cudaFailureResult(context.job, "policy_denied", "cuda.run requires network policy none", startedAt);
    }
    if (context.job.policy.allow_raw_command !== false) {
      return cudaFailureResult(context.job, "policy_denied", "cuda.run does not allow raw commands", startedAt);
    }
    if (!context.job.resources?.gpu) {
      return cudaFailureResult(context.job, "validation_failed", "cuda.run requires GPU resources", startedAt);
    }
    if (!context.job.outputs?.length) {
      return cudaFailureResult(context.job, "validation_failed", "cuda.run requires declared outputs", startedAt);
    }
    let args: CudaRunArgs;
    let archive: { hostPath: string; inputPath: string };
    let selection: CudaPackageManifestSelection;
    let scriptPath: string;
    let workPath: string;
    try {
      args = parseCudaRunArgs(context.job);
      archive = cudaPackageArchive(context);
      await validateCudaPackageArchive(context, this.runner, archive);
      const manifestText = await readCudaManifestText(context, this.runner, args);
      selection = parseCudaPackageManifest(manifestText, args, context.job.policy);
      scriptPath = resolveWithinRoot(context.artifacts.workDir, "__mcoda_cuda_run.sh");
      workPath = resolveWithinRoot(context.artifacts.workDir, "cuda-work");
      await mkdir(workPath, { recursive: true });
      await chmod(workPath, 0o777);
      await chmod(context.artifacts.outputDir, 0o777);
      await writeFile(scriptPath, buildCudaRunnerScript({ archiveInputPath: archive.inputPath, selection }), { mode: 0o644 });
    } catch (error) {
      return cudaFailureResult(
        context.job,
        "validation_failed",
        redactCudaLocalPaths(context, error instanceof Error ? error.message : String(error || "cuda.run validation failed")),
        startedAt
      );
    }

    const dockerArgs = buildCudaDockerArgs({
      context,
      selection,
      archiveInputPath: archive.inputPath,
      scriptPath,
      workPath
    });
    await context.emitEvent({
      type: "progress",
      message: "cuda package container starting",
      data: {
        runner: this.id,
        image: selection.image,
        profile: args.profile,
        target: args.target,
        gpu_count: Math.max(1, context.job.resources.gpu.count || 1),
        network: "none",
        container_user: context.sandbox.container.user
      }
    });

    const timeoutMs = Math.max(
      1_000,
      Math.min(DEFAULT_JOB_TIMEOUT_MS, Math.floor((context.sandbox.limits.timeout_sec || DEFAULT_JOB_TIMEOUT_MS / 1000) * 1000))
    );
    const maxBuffer = Math.min(
      DEFAULT_COMMAND_MAX_BUFFER,
      Math.max(1024 * 1024, context.job.limits?.max_stdout_bytes || 0, context.job.limits?.max_stderr_bytes || 0)
    );
    try {
      const result = await this.runner("docker", dockerArgs, {
        timeoutMs,
        maxBuffer,
        signal: context.signal
      });
      await emitCudaOutput(context, "stdout", result.stdout);
      await emitCudaOutput(context, "stderr", result.stderr);
      await context.emitEvent({
        type: "progress",
        message: "cuda package container completed",
        data: {
          runner: this.id,
          profile: args.profile,
          target: args.target
        }
      });
      return {
        job_id: context.job.idempotency_key || "cuda.run",
        status: "succeeded",
        exit_code: 0,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        metrics: {
          runner: this.id,
          image: selection.image,
          profile: args.profile,
          target: args.target,
          package: selection.packageName,
          publisher: selection.publisher,
          gpu_count: Math.max(1, context.job.resources.gpu.count || 1),
          network: "none",
          container_user: context.sandbox.container.user
        }
      };
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return cudaFailureResult(
        context.job,
        "runner_failed",
        redactCudaLocalPaths(context, error instanceof Error ? error.message : String(error || "cuda.run failed")),
        startedAt
      );
    }
  }
}

function createDefaultGenericJobRunners(runner: CommandRunner = defaultCommandRunner): MswarmGenericJobRunner[] {
  return [new MswarmTestEchoRunner(), new MswarmBlenderRenderRunner(runner), new MswarmCudaPackageRunner(runner)];
}

function uniqueSortedStrings<T extends string>(values: Array<T | undefined | null>): T[] {
  return Array.from(
    new Set(values.filter((value): value is T => typeof value === "string" && value.length > 0))
  ).sort();
}

function capabilityProbeTimeoutMs(config: SelfHostedNodeConfig): number {
  return parsePositiveInteger(config.capabilityProbeTimeoutMs, DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS);
}

function capabilityCommandFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || "capability probe failed");
}

function isMissingCapabilityCommand(error: unknown, stderr = ""): boolean {
  const message = `${capabilityCommandFailureMessage(error)}\n${stderr}`.toLowerCase();
  return /enoent|not found|command not found|no such file|executable file not found/.test(message);
}

async function runCapabilityCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; missing: boolean; message: string }> {
  try {
    const result = await runner(command, args, {
      timeoutMs,
      maxBuffer: Math.min(DEFAULT_COMMAND_MAX_BUFFER, 512 * 1024)
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      missing: isMissingCapabilityCommand(error),
      message: capabilityCommandFailureMessage(error)
    };
  }
}

function parseNvidiaSmiMemoryGb(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.round((parsed / 1024) * 10) / 10;
}

function parseNvidiaGpuProbe(stdout: string): MswarmGpuCapabilityProbe {
  const devices: MswarmGpuDeviceCapability[] = [];
  const cudaVersions = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [index, name, memoryMb, driverVersion, computeCapability, cudaVersion] = trimmed
      .split(",")
      .map((part) => part.trim());
    const id = index ? `gpu-${index}` : `gpu-${devices.length}`;
    if (cudaVersion) {
      cudaVersions.add(cudaVersion);
    }
    devices.push({
      id,
      vendor: "nvidia",
      ...(name ? { name } : {}),
      ...(parseNvidiaSmiMemoryGb(memoryMb) ? { vram_gb: parseNvidiaSmiMemoryGb(memoryMb) } : {}),
      ...(driverVersion ? { driver_version: driverVersion } : {}),
      ...(cudaVersion ? { cuda_version: cudaVersion } : {}),
      ...(computeCapability ? { compute_capability: computeCapability } : {}),
      capabilities: ["cuda"]
    });
  }
  const maxVramGb = devices.reduce<number | undefined>((max, device) => {
    if (!Number.isFinite(device.vram_gb)) return max;
    return max === undefined ? device.vram_gb : Math.max(max, device.vram_gb || 0);
  }, undefined);
  return {
    status: devices.length > 0 ? "available" : "missing",
    count: devices.length,
    vendors: devices.length > 0 ? ["nvidia"] : [],
    devices,
    ...(cudaVersions.size > 0 ? { cuda_versions: Array.from(cudaVersions).sort() } : {}),
    ...(maxVramGb !== undefined ? { max_vram_gb: maxVramGb } : {}),
    ...(devices.length === 0 ? { message: "nvidia-smi returned no GPU rows" } : {})
  };
}

function parseNvidiaSmiCudaVersion(stdout: string): string | undefined {
  return stdout.match(/CUDA\s+Version:\s*([0-9]+(?:\.[0-9]+)?)/i)?.[1];
}

async function probeNvidiaGpuCapabilities(
  runner: CommandRunner,
  timeoutMs: number
): Promise<MswarmGpuCapabilityProbe> {
  const result = await runCapabilityCommand(
    runner,
    "nvidia-smi",
    ["--query-gpu=index,name,memory.total,driver_version,compute_cap", "--format=csv,noheader,nounits"],
    timeoutMs
  );
  if (!result.ok) {
    return {
      status: result.missing ? "missing" : "error",
      count: 0,
      vendors: [],
      devices: [],
      message: result.message
    };
  }
  const probe = parseNvidiaGpuProbe(result.stdout);
  const versionResult = await runCapabilityCommand(runner, "nvidia-smi", [], timeoutMs);
  if (!versionResult.ok) {
    return probe;
  }
  const cudaVersion = parseNvidiaSmiCudaVersion(versionResult.stdout || versionResult.stderr);
  if (!cudaVersion) {
    return probe;
  }
  const cudaVersions = Array.from(new Set([...(probe.cuda_versions || []), cudaVersion])).sort();
  return {
    ...probe,
    cuda_versions: cudaVersions,
    devices: probe.devices.map((device) => ({
      ...device,
      cuda_version: device.cuda_version || cudaVersion
    }))
  };
}

function missingSoftwareProbe(name: MswarmSoftwareProbeName, message?: string): MswarmSoftwareProbeResult {
  return {
    name,
    status: "missing",
    ...(message ? { message } : {})
  };
}

function errorSoftwareProbe(name: MswarmSoftwareProbeName, message: string): MswarmSoftwareProbeResult {
  return {
    name,
    status: "error",
    message
  };
}

function extractToolVersion(stdout: string, tool: MswarmSoftwareProbeName): string | undefined {
  const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() || "";
  if (tool === "blender") {
    return firstLine.match(/Blender\s+([^\s]+)/i)?.[1];
  }
  if (tool === "ffmpeg") {
    return firstLine.match(/ffmpeg\s+version\s+([^\s]+)/i)?.[1];
  }
  return firstLine || undefined;
}

async function probeVersionedSoftware(
  runner: CommandRunner,
  name: Extract<MswarmSoftwareProbeName, "blender" | "ffmpeg">,
  command: string,
  args: string[],
  timeoutMs: number
): Promise<MswarmSoftwareProbeResult> {
  const result = await runCapabilityCommand(runner, command, args, timeoutMs);
  if (!result.ok) {
    return result.missing
      ? missingSoftwareProbe(name, result.message)
      : errorSoftwareProbe(name, result.message);
  }
  return {
    name,
    status: "available",
    ...(extractToolVersion(result.stdout || result.stderr, name) ? { version: extractToolVersion(result.stdout || result.stderr, name) } : {})
  };
}

async function probeDockerCapabilities(
  runner: CommandRunner,
  timeoutMs: number
): Promise<{
  docker: MswarmSoftwareProbeResult;
  dockerNvidia: MswarmSoftwareProbeResult;
}> {
  const result = await runCapabilityCommand(
    runner,
    "docker",
    ["info", "--format", "{{json .Runtimes}}"],
    timeoutMs
  );
  if (!result.ok) {
    const docker = result.missing
      ? missingSoftwareProbe("docker", result.message)
      : errorSoftwareProbe("docker", result.message);
    return {
      docker,
      dockerNvidia: { name: "docker-nvidia", status: docker.status, message: result.message }
    };
  }
  try {
    const runtimes = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
    const runtimeNames = Object.keys(runtimes);
    const hasNvidiaRuntime = runtimeNames.some((name) => name.toLowerCase() === "nvidia");
    return {
      docker: { name: "docker", status: "available" },
      dockerNvidia: hasNvidiaRuntime
        ? { name: "docker-nvidia", status: "available", version: "nvidia" }
        : missingSoftwareProbe("docker-nvidia", "Docker is available but the nvidia runtime is not registered")
    };
  } catch (error) {
    const message = capabilityCommandFailureMessage(error);
    return {
      docker: errorSoftwareProbe("docker", `Unable to parse docker runtime inventory: ${message}`),
      dockerNvidia: errorSoftwareProbe("docker-nvidia", `Unable to parse docker runtime inventory: ${message}`)
    };
  }
}

function capabilityDiagnostics(snapshot: MswarmNodeCapabilitySnapshot): MswarmNodeCapabilitySnapshot["diagnostics"] {
  const diagnostics: NonNullable<MswarmNodeCapabilitySnapshot["diagnostics"]> = [];
  if (snapshot.gpu.status !== "available") {
    diagnostics.push({
      name: "gpu",
      status: snapshot.gpu.status,
      message: snapshot.gpu.message
    });
  }
  for (const result of Object.values(snapshot.software)) {
    if (result.status !== "available") {
      diagnostics.push({
        name: result.name,
        status: result.status,
        message: result.message
      });
    }
  }
  return diagnostics.length ? diagnostics : undefined;
}

function buildCapabilitySnapshotId(snapshot: Omit<MswarmNodeCapabilitySnapshot, "snapshot_id">): string {
  const digest = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16);
  return `caps_${digest}`;
}

function buildRunnerCapabilityCatalog(
  config: SelfHostedNodeConfig,
  runners: Map<string, MswarmGenericJobRunner>
): MswarmRunnerCatalogCapability[] {
  if (!config.genericJobsEnabled) {
    return [];
  }
  return OWNER_LOCAL_GENERIC_JOB_CATALOG
    .filter((entry) => runners.has(entry.runner))
    .map((entry) => ({
      job_type: entry.job_type,
      runner: entry.runner,
      trust_modes: uniqueSortedStrings([entry.policy.trust_mode]),
      required_capabilities: entry.required_capabilities || []
    }));
}

function runnerCapabilityRequirementsAvailable(
  entry: MswarmRunnerCatalogCapability,
  input: {
    gpu: MswarmGpuCapabilityProbe;
    software: Record<MswarmSoftwareProbeName, MswarmSoftwareProbeResult>;
    genericJobsEnabled: boolean;
  }
): boolean {
  if (!input.genericJobsEnabled) return false;
  if (!entry.required_capabilities?.length) return true;
  const snapshot: MswarmNodeCapabilitySnapshot = {
    schema_version: MSWARM_CAPABILITY_SCHEMA_VERSION,
    snapshot_id: "caps_requirement_check",
    captured_at: new Date(0).toISOString(),
    generic_jobs_enabled: input.genericJobsEnabled,
    job_types: [],
    trust_modes: [],
    gpu: input.gpu,
    software: input.software,
    runner_catalog: []
  };
  const capabilities = new Set(buildMswarmCapabilityNames(snapshot));
  return entry.required_capabilities.every((capability) => capabilities.has(capability));
}

function registeredOwnerLocalGenericJobCatalog(): MswarmRegisteredJobCatalogEntry[] {
  return OWNER_LOCAL_GENERIC_JOB_CATALOG.filter(
    (entry): entry is MswarmRegisteredJobCatalogEntry =>
      entry.job_type.startsWith("tenant.") || entry.job_type.startsWith("package.")
  );
}

function base64UrlEncodeRuntime(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signCapabilityPayload(input: {
  privateCatalogEntry: ReturnType<typeof buildMswarmPrivateCapabilityCatalogEntry>;
  runtimeToken: string;
}): MswarmSignedCapabilityPayload {
  const unsignedPayload = {
    schema_version: MSWARM_CAPABILITY_SCHEMA_VERSION,
    snapshot_id: input.privateCatalogEntry.snapshot_id,
    private_catalog_entry: input.privateCatalogEntry,
    scheduler_match: input.privateCatalogEntry.scheduler_match,
    public_projection: input.privateCatalogEntry.public_projection
  };
  const signature = base64UrlEncodeRuntime(
    createHmac("sha256", input.runtimeToken).update(JSON.stringify(unsignedPayload)).digest()
  );
  return {
    ...unsignedPayload,
    signature: {
      alg: "HS256",
      value: signature,
      signed_at: new Date().toISOString(),
      key_id: "self_hosted_runtime_token"
    }
  };
}

function runnerForGenericJob(
  job: MswarmJobRequest,
  runners: Map<string, MswarmGenericJobRunner>
): MswarmGenericJobRunner | null {
  const catalogEntry = OWNER_LOCAL_GENERIC_JOB_CATALOG.find((entry) => entry.job_type === job.job_type);
  return catalogEntry ? runners.get(catalogEntry.runner) || null : null;
}

function compareDottedVersion(left: string | undefined, right: string | undefined): number {
  if (!left || !right) return 0;
  const leftParts = left.split(".").map((part) => Number(part.replace(/[^\d]/g, "")) || 0);
  const rightParts = right.split(".").map((part) => Number(part.replace(/[^\d]/g, "")) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function snapshotHasCudaVersion(snapshot: MswarmNodeCapabilitySnapshot, minVersion: string | undefined): boolean {
  if (!minVersion) return true;
  const versions = [
    ...(snapshot.gpu.cuda_versions || []),
    ...snapshot.gpu.devices.map((device) => device.cuda_version).filter((value): value is string => Boolean(value))
  ];
  return versions.some((version) => compareDottedVersion(version, minVersion) >= 0);
}

export function genericJobCapabilityMismatch(
  job: MswarmJobRequest,
  snapshot: MswarmNodeCapabilitySnapshot
): { code: string; message: string } | null {
  if (!snapshot.generic_jobs_enabled) {
    return { code: "no_capable_node", message: "Generic jobs are disabled on this node." };
  }
  if (job.job_type === RENDER_BLENDER_JOB_TYPE && snapshot.software.blender.status !== "available") {
    return {
      code: "no_capable_node",
      message: "Blender is not available on this node."
    };
  }
  if (job.job_type === CUDA_RUN_JOB_TYPE) {
    if (snapshot.gpu.status !== "available" || !snapshot.gpu.vendors.includes("nvidia")) {
      return {
        code: "no_capable_node",
        message: "No NVIDIA GPU is available on this node."
      };
    }
    if (snapshot.software.docker.status !== "available" || snapshot.software["docker-nvidia"].status !== "available") {
      return {
        code: "no_capable_node",
        message: "Docker with the NVIDIA runtime is not available on this node."
      };
    }
  }
  if (!snapshot.job_types.includes(job.job_type)) {
    return {
      code: "no_capable_node",
      message: `No capable owner-local node is available for ${job.job_type}.`
    };
  }
  if (job.resources?.gpu) {
    const requestedCount = Math.max(1, job.resources.gpu.count || 1);
    if (snapshot.gpu.status !== "available" || snapshot.gpu.count < requestedCount) {
      return {
        code: "no_capable_node",
        message: `Requested ${requestedCount} GPU(s), but this node reports ${snapshot.gpu.count}.`
      };
    }
    if (job.resources.gpu.vendor && !snapshot.gpu.vendors.includes(job.resources.gpu.vendor)) {
      return {
        code: "no_capable_node",
        message: `Requested GPU vendor ${job.resources.gpu.vendor} is not available on this node.`
      };
    }
    if (
      Number.isFinite(job.resources.gpu.min_vram_gb) &&
      job.resources.gpu.min_vram_gb !== undefined &&
      (!Number.isFinite(snapshot.gpu.max_vram_gb) || (snapshot.gpu.max_vram_gb || 0) < job.resources.gpu.min_vram_gb)
    ) {
      return {
        code: "no_capable_node",
        message: `Requested GPU VRAM ${job.resources.gpu.min_vram_gb}GB exceeds this node capability.`
      };
    }
    if (!snapshotHasCudaVersion(snapshot, job.resources.gpu.cuda_min_version)) {
      return {
        code: "no_capable_node",
        message: `Requested CUDA ${job.resources.gpu.cuda_min_version} is not available on this node.`
      };
    }
  }
  return null;
}

function genericJobTimeoutMs(job: MswarmJobRequest, fallbackMs: number): number {
  const limitSeconds = positiveInteger(job.limits?.timeout_sec);
  if (!limitSeconds) {
    return fallbackMs;
  }
  return Math.max(1, Math.min(fallbackMs, limitSeconds * 1000));
}

function isGenericAbortError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(error instanceof Error)) return false;
  return /cancelled|canceled|aborted|timed out|timeout/i.test(error.message);
}

function usageTokens(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined): {
  promptTokens: number | null;
  completionTokens: number | null;
} {
  return {
    promptTokens: positiveInteger(usage?.inputTokens),
    completionTokens: positiveInteger(usage?.outputTokens),
  };
}

export class McodaLocalAgentExecutor {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;

  constructor(input: { command?: string; timeoutMs?: number; runner?: CommandRunner }) {
    this.command = input.command || DEFAULT_MCODA_BIN;
    this.timeoutMs = input.timeoutMs || DEFAULT_JOB_TIMEOUT_MS;
    this.runner = input.runner || defaultCommandRunner;
  }

  async invoke(agentSlug: string, prompt: string): Promise<{
    output: string;
    adapter?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }> {
    const stdout = (await this.runner(this.command, ["agent-run", agentSlug, "--json", "--stdin"], {
      timeoutMs: this.timeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER,
      input: prompt
    })).stdout;
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as Record<string, unknown>).responses)) {
      throw new Error("mcoda agent-run returned unsupported JSON");
    }
    const response = ((parsed as Record<string, unknown>).responses as Array<Record<string, unknown>>)[0] || {};
    const output = optionalText(response.output);
    if (!output) {
      throw new Error("mcoda agent-run response did not include output");
    }
    return {
      output,
      adapter: optionalText(response.adapter) || undefined,
      model: optionalText(response.model) || undefined,
      metadata: response.metadata && typeof response.metadata === "object" ? (response.metadata as Record<string, unknown>) : undefined
    };
  }
}

export class MswarmSelfHostedNodeClient {
  private readonly gatewayBaseUrl: string;
  private readonly jobsPollPath: string;
  private readonly jobsStartPathTemplate: string;
  private readonly jobsEventsPathTemplate: string;
  private readonly jobsResultPathTemplate: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(input: {
    gatewayBaseUrl: string;
    jobsPollPath?: string | null;
    jobsStartPathTemplate?: string | null;
    jobsEventsPathTemplate?: string | null;
    jobsResultPathTemplate?: string | null;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
  }) {
    this.gatewayBaseUrl = trimTrailingSlash(input.gatewayBaseUrl);
    this.jobsPollPath = lifecyclePath(input.jobsPollPath, DEFAULT_SELF_HOSTED_JOBS_POLL_PATH);
    this.jobsStartPathTemplate = lifecyclePath(
      input.jobsStartPathTemplate,
      DEFAULT_SELF_HOSTED_JOBS_START_PATH_TEMPLATE
    );
    this.jobsEventsPathTemplate = lifecyclePath(
      input.jobsEventsPathTemplate,
      DEFAULT_SELF_HOSTED_JOBS_EVENTS_PATH_TEMPLATE
    );
    this.jobsResultPathTemplate = lifecyclePath(
      input.jobsResultPathTemplate,
      DEFAULT_SELF_HOSTED_JOBS_RESULT_PATH_TEMPLATE
    );
    this.fetchImpl = input.fetchImpl || fetch;
    this.timeoutMs = input.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  }

  lifecycleEndpoint(kind: "poll" | "start" | "events" | "result"): string {
    const path =
      kind === "poll"
        ? this.jobsPollPath
        : kind === "start"
          ? this.jobsStartPathTemplate
          : kind === "events"
            ? this.jobsEventsPathTemplate
            : this.jobsResultPathTemplate;
    return `POST ${path}`;
  }

  lifecycleGatewayBaseUrl(): string {
    return this.gatewayBaseUrl;
  }

  private lifecycleUrl(kind: "poll" | "start" | "events" | "result", jobId?: string): string {
    const path =
      kind === "poll"
        ? this.jobsPollPath
        : kind === "start"
          ? this.jobsStartPathTemplate
          : kind === "events"
            ? this.jobsEventsPathTemplate
            : this.jobsResultPathTemplate;
    return resolveLifecycleUrl(this.gatewayBaseUrl, jobId ? resolveLifecycleTemplate(path, jobId) : path);
  }

  async enroll(nodeId: string, enrollmentToken: string): Promise<GatewayEnrollmentResponse> {
    return fetchJson<GatewayEnrollmentResponse>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/enroll`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ node_id: nodeId, enrollment_token: enrollmentToken })
      },
      this.timeoutMs
    );
  }

  async bootstrap(apiKey: string, payload: Record<string, unknown>): Promise<GatewayBootstrapResponse> {
    return fetchJson<GatewayBootstrapResponse>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/bootstrap`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }

  async health(): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/healthz`,
      { method: "GET" },
      this.timeoutMs
    );
  }

  async heartbeat(runtimeToken: string, payload: Record<string, unknown>): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/heartbeat`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }

  async uninstall(runtimeToken: string, payload: Record<string, unknown>): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/uninstall`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }

  async pushModels(runtimeToken: string, payload: { node_id: string; models: SelfHostedModelInput[] }): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/models`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }

  async pollJob(
    runtimeToken: string,
    payload: { node_id: string; capacity?: Record<string, unknown>; wait_ms?: number }
  ): Promise<{ job?: SelfHostedNodeInvocationJob | null; attached_mswarm_api_key?: string | null }> {
    return fetchJson<{ job?: SelfHostedNodeInvocationJob | null; attached_mswarm_api_key?: string | null }>(
      this.fetchImpl,
      this.lifecycleUrl("poll"),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      Math.max(this.timeoutMs, (payload.wait_ms || 0) + 5_000)
    );
  }

  async postJobResult(
    runtimeToken: string,
    jobId: string,
    payload: SelfHostedNodeInvocationResult & { node_id: string }
  ): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      this.lifecycleUrl("result", jobId),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }

  async postJobStart(
    runtimeToken: string,
    jobId: string,
    payload: {
      node_id: string;
      agent_slug?: string | null;
      source_agent_slug?: string | null;
      model?: string | null;
    }
  ): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      this.lifecycleUrl("start", jobId),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }

  async postJobEvents(
    runtimeToken: string,
    jobId: string,
    payload: { node_id: string; stream_events?: Record<string, unknown>[]; progress_events?: Record<string, unknown>[] }
  ): Promise<unknown> {
    return fetchJson<unknown>(
      this.fetchImpl,
      this.lifecycleUrl("events", jobId),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${runtimeToken}`
        },
        body: JSON.stringify(payload)
      },
      this.timeoutMs
    );
  }
}

export class SelfHostedNodeRuntime {
  private readonly config: SelfHostedNodeConfig;
  private readonly gateway: MswarmSelfHostedNodeClient;
  private readonly mcoda: McodaAgentInventoryClient;
  private readonly mcodaAgentAuthResolver: McodaAgentAuthResolver;
  private readonly mcodaExecutor: McodaLocalAgentExecutor;
  private readonly codaliExecutor: MswarmCodaliExecutor;
  private readonly ollama: OllamaClient;
  private readonly jobOllama: OllamaClient;
  private readonly genericRunners: Map<string, MswarmGenericJobRunner>;
  private readonly artifactStore: MswarmGenericJobArtifactStore;
  private readonly capabilityRunner: CommandRunner;
  private activeLlmJobs = 0;
  private activeGenericJobs = 0;
  private queuedLlmJobs = 0;
  private queuedGenericJobs = 0;
  private readonly latencySamplesMs: number[] = [];
  private readonly recentFailures: Array<{ execution_class: SelfHostedRuntimeExecutionClass; code: string; at: string }> = [];
  private lifecyclePollingDisabled = false;

  constructor(
    config: SelfHostedNodeConfig,
    deps?: {
      gateway?: MswarmSelfHostedNodeClient;
      mcoda?: McodaAgentInventoryClient;
      mcodaAgentAuthResolver?: McodaAgentAuthResolver;
      mcodaExecutor?: McodaLocalAgentExecutor;
      codaliExecutor?: MswarmCodaliExecutor;
      ollama?: OllamaClient;
      fetchImpl?: FetchLike;
      genericRunners?: MswarmGenericJobRunner[];
      artifactStore?: MswarmGenericJobArtifactStore;
      capabilityRunner?: CommandRunner;
    }
  ) {
    this.config = config;
    this.gateway =
      deps?.gateway ||
      new MswarmSelfHostedNodeClient({
        gatewayBaseUrl: config.gatewayBaseUrl,
        jobsPollPath: config.jobsPollPath,
        jobsStartPathTemplate: config.jobsStartPathTemplate,
        jobsEventsPathTemplate: config.jobsEventsPathTemplate,
        jobsResultPathTemplate: config.jobsResultPathTemplate,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: config.requestTimeoutMs
      });
    this.mcoda =
      deps?.mcoda ||
      new McodaAgentInventoryClient({
        command: config.mcodaBin,
        args: config.mcodaListArgs,
          timeoutMs: config.requestTimeoutMs
        });
    this.mcodaAgentAuthResolver = deps?.mcodaAgentAuthResolver || defaultMcodaAgentAuthResolver;
    this.mcodaExecutor =
      deps?.mcodaExecutor ||
      new McodaLocalAgentExecutor({
        command: config.mcodaBin,
        timeoutMs: config.jobTimeoutMs
      });
    this.codaliExecutor = deps?.codaliExecutor || new MswarmCodaliExecutor();
    this.ollama =
      deps?.ollama ||
      new OllamaClient({
        baseUrl: config.ollamaBaseUrl,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: config.requestTimeoutMs
      });
    this.jobOllama =
      deps?.ollama ||
      new OllamaClient({
        baseUrl: config.ollamaBaseUrl,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: config.jobTimeoutMs
      });
    this.capabilityRunner = deps?.capabilityRunner || defaultCommandRunner;
    this.genericRunners = new Map(
      (deps?.genericRunners || createDefaultGenericJobRunners(this.capabilityRunner)).map((runner) => [runner.id, runner])
    );
    this.artifactStore =
      deps?.artifactStore ||
      new MswarmLocalArtifactStore({
        rootDir: config.artifactStorePath || defaultArtifactStorePath()
      });
  }

  updateLocalQueueTelemetry(input: { llmQueuedJobs?: number; genericQueuedJobs?: number }): void {
    if (input.llmQueuedJobs !== undefined) {
      this.queuedLlmJobs = nonNegativeTelemetryInteger(input.llmQueuedJobs);
    }
    if (input.genericQueuedJobs !== undefined) {
      this.queuedGenericJobs = nonNegativeTelemetryInteger(input.genericQueuedJobs);
    }
  }

  private beginExecutionTelemetry(executionClass: "llm" | "generic_job"): void {
    if (executionClass === "generic_job") {
      this.activeGenericJobs += 1;
      return;
    }
    this.activeLlmJobs += 1;
  }

  private finishExecutionTelemetry(input: {
    executionClass: "llm" | "generic_job";
    startedAt: number;
    ok: boolean;
    code?: string | null;
  }): void {
    if (input.executionClass === "generic_job") {
      this.activeGenericJobs = Math.max(0, this.activeGenericJobs - 1);
    } else {
      this.activeLlmJobs = Math.max(0, this.activeLlmJobs - 1);
    }
    this.latencySamplesMs.push(Math.max(0, Date.now() - input.startedAt));
    while (this.latencySamplesMs.length > MAX_TELEMETRY_LATENCY_SAMPLES) {
      this.latencySamplesMs.shift();
    }
    if (!input.ok) {
      this.recentFailures.unshift({
        execution_class: input.executionClass === "generic_job" ? "generic_job" : "agentic",
        code: optionalText(input.code) || "upstream_error",
        at: new Date().toISOString()
      });
      this.recentFailures.splice(MAX_TELEMETRY_FAILURES);
    }
  }

  private lifecycleProtocolMismatch(
    kind: "poll" | "start" | "events" | "result",
    error: unknown
  ): SelfHostedProtocolMismatchError | undefined {
    if (!isHttpStatusError(error, 404)) {
      return undefined;
    }
    return new SelfHostedProtocolMismatchError({
      endpoint: this.gateway.lifecycleEndpoint(kind),
      gatewayBaseUrl: this.gateway.lifecycleGatewayBaseUrl(),
      runtimePackageVersion: this.config.nodeVersion
    });
  }

  private isLifecycleProtocolDegradedState(state: SelfHostedNodeState | undefined): boolean {
    return state?.lifecycle_health_reason === SELF_HOSTED_PROTOCOL_MISMATCH_CODE;
  }

  private async readLifecycleState(): Promise<SelfHostedNodeState> {
    try {
      return await readSelfHostedNodeState(this.config.statePath);
    } catch {
      return {};
    }
  }

  private async markLifecycleProtocolDegraded(error: SelfHostedProtocolMismatchError): Promise<void> {
    this.lifecyclePollingDisabled = true;
    this.recentFailures.unshift({
      execution_class: "agentic",
      code: SELF_HOSTED_PROTOCOL_MISMATCH_CODE,
      at: new Date().toISOString()
    });
    this.recentFailures.splice(MAX_TELEMETRY_FAILURES);
    const state = await this.readLifecycleState();
    await writeSelfHostedNodeState(this.config.statePath, {
      ...state,
      lifecycle_health_status: "degraded",
      lifecycle_health_reason: SELF_HOSTED_PROTOCOL_MISMATCH_CODE,
      lifecycle_health_message: error.message,
      lifecycle_health_updated_at: new Date().toISOString()
    });
  }

  private jobResultPayload(result: SelfHostedNodeInvocationResult): SelfHostedNodeInvocationResult & { node_id: string } {
    return {
      ...result,
      node_id: this.config.nodeId,
      ...(result.status === "success"
        ? { usage: result.usage || openAiUsage(result.openai_response) }
        : {})
    };
  }

  private averageLatencyMs(fallback: number | null = null): number | null {
    if (this.latencySamplesMs.length === 0) {
      return fallback;
    }
    const total = this.latencySamplesMs.reduce((sum, value) => sum + value, 0);
    return Math.round(total / this.latencySamplesMs.length);
  }

  private buildLoadTelemetry(input: {
    models: SelfHostedModelInput[];
    discoveryLatencyMs?: number;
    discoveryFailureCount?: number;
    capabilityPayload?: MswarmSignedCapabilityPayload | null;
  }): SelfHostedRuntimeLoadTelemetry {
    const drainMode = this.config.drainMode === true;
    const llmMaxConcurrency = Math.max(1, Math.floor(this.config.maxConcurrentLlmJobs || this.config.maxConcurrentJobs || 1));
    const genericMaxConcurrency = Math.max(1, Math.floor(this.config.genericJobMaxConcurrency || 1));
    const maxConcurrency = Math.max(
      1,
      Math.floor(this.config.maxConcurrentJobs || 1),
      llmMaxConcurrency,
      this.config.genericJobsEnabled ? genericMaxConcurrency : 1
    );
    const activeLlmJobs = nonNegativeTelemetryInteger(this.activeLlmJobs);
    const activeGenericJobs = nonNegativeTelemetryInteger(this.activeGenericJobs);
    const queuedLlmJobs = nonNegativeTelemetryInteger(this.queuedLlmJobs);
    const queuedGenericJobs = nonNegativeTelemetryInteger(this.queuedGenericJobs);
    const llmCapacity = executionClassCapacity({
      maxConcurrency: llmMaxConcurrency,
      activeJobs: activeLlmJobs,
      queuedJobs: queuedLlmJobs,
      drainMode
    });
    const genericCapacity = executionClassCapacity({
      maxConcurrency: genericMaxConcurrency,
      activeJobs: activeGenericJobs,
      queuedJobs: queuedGenericJobs,
      drainMode: drainMode || !this.config.genericJobsEnabled
    });
    const activeJobs = activeLlmJobs + activeGenericJobs;
    const queuedJobs = queuedLlmJobs + queuedGenericJobs;
    const freeSlots = drainMode ? 0 : Math.max(0, maxConcurrency - activeJobs - queuedJobs);
    const failures = this.recentFailures.slice(0, 10);
    const discoveryFailureCount = nonNegativeTelemetryInteger(input.discoveryFailureCount);
    const telemetry: SelfHostedRuntimeLoadTelemetry = {
      runtime_protocol_version: SELF_HOSTED_RUNTIME_PROTOCOL_VERSION,
      load_balancer_protocol_version: SELF_HOSTED_LOAD_BALANCER_PROTOCOL_VERSION,
      catalog_metadata_version: SELF_HOSTED_CATALOG_METADATA_VERSION,
      catalog_fingerprint: buildCatalogFingerprint(input.models),
      max_concurrency: maxConcurrency,
      max_concurrent_llm_jobs: llmMaxConcurrency,
      max_concurrent_generic_jobs: this.config.genericJobsEnabled ? genericMaxConcurrency : 0,
      active_jobs: activeJobs,
      queued_jobs: queuedJobs,
      free_slots: freeSlots,
      drain_mode: drainMode,
      execution_class_capacity: {
        chat: llmCapacity,
        agentic: llmCapacity,
        generic_job: genericCapacity
      },
      avg_latency_ms: this.averageLatencyMs(input.discoveryLatencyMs ?? null),
      recent_failure_count: failures.length + discoveryFailureCount,
      recent_failures: failures
    };
    if (this.config.hardwareTelemetryEnabled === true) {
      telemetry.hardware_pressure = buildCoarseHardwarePressure(input.capabilityPayload || null);
    }
    return telemetry;
  }

  static async setup(
    setupConfig: SelfHostedOwnerSetupConfig,
    deps?: {
      gateway?: MswarmSelfHostedNodeClient;
      mcoda?: McodaAgentInventoryClient;
      mcodaExecutor?: McodaLocalAgentExecutor;
      codaliExecutor?: MswarmCodaliExecutor;
      ollama?: OllamaClient;
      fetchImpl?: FetchLike;
      genericRunners?: MswarmGenericJobRunner[];
      artifactStore?: MswarmGenericJobArtifactStore;
      capabilityRunner?: CommandRunner;
    }
  ): Promise<SelfHostedNodeSetupResult> {
    const gateway =
      deps?.gateway ||
      new MswarmSelfHostedNodeClient({
        gatewayBaseUrl: setupConfig.gatewayBaseUrl,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: setupConfig.requestTimeoutMs
      });
    const machineId = await readOrCreateSelfHostedMachineId(setupConfig.machineIdPath);
    const machineFingerprint = machineFingerprintFromId(machineId);
    const bootstrap = await gateway.bootstrap(setupConfig.apiKey, {
      machine_fingerprint: machineFingerprint,
      server_name: setupConfig.serverName,
      label: setupConfig.serverName,
      relay_mode: setupConfig.relayMode,
      direct_base_url: setupConfig.directBaseUrl || null,
      node_version: setupConfig.nodeVersion,
      discovery_mode: setupConfig.discoveryMode,
      expose_all_models: setupConfig.exposeAllModels,
      model_allowlist: setupConfig.modelAllowlist,
      model_blocklist: setupConfig.modelBlocklist,
      client_allowlist: setupConfig.clientAllowlist,
      heartbeat_interval_seconds: setupConfig.heartbeatIntervalSeconds,
      max_concurrent_jobs: setupConfig.maxConcurrentJobs,
      max_concurrent_llm_jobs: setupConfig.maxConcurrentLlmJobs,
      drain_mode: setupConfig.drainMode,
      load_reporting_enabled: setupConfig.loadReportingEnabled,
      hardware_telemetry_enabled: setupConfig.hardwareTelemetryEnabled,
      generic_job_max_concurrency: setupConfig.genericJobMaxConcurrency
    });
    const nodeId = optionalText(bootstrap.node?.node_id);
    const runtimeToken = optionalText(bootstrap.runtime_token);
    if (!nodeId || !runtimeToken) {
      throw new Error("Bootstrap response did not include node_id and runtime_token");
    }
    const heartbeatInterval =
      bootstrap.heartbeat_interval_seconds || setupConfig.heartbeatIntervalSeconds;
    const relay = bootstrap.relay || {};
    const relayGatewayBaseUrl = optionalText(relay.gateway_base_url) || setupConfig.gatewayBaseUrl;
    const jobsPollPath = lifecyclePath(relay.jobs_poll_path, DEFAULT_SELF_HOSTED_JOBS_POLL_PATH);
    const jobsStartPathTemplate = lifecyclePath(
      relay.jobs_start_path_template,
      DEFAULT_SELF_HOSTED_JOBS_START_PATH_TEMPLATE
    );
    const jobsEventsPathTemplate = lifecyclePath(
      relay.jobs_events_path_template,
      DEFAULT_SELF_HOSTED_JOBS_EVENTS_PATH_TEMPLATE
    );
    const jobsResultPathTemplate = lifecyclePath(
      relay.jobs_result_path_template,
      DEFAULT_SELF_HOSTED_JOBS_RESULT_PATH_TEMPLATE
    );
    const state: SelfHostedNodeState = {
      node_id: nodeId,
      server_name: optionalText(bootstrap.node?.server_name) || setupConfig.serverName,
      relay_mode: bootstrap.node?.relay_mode || setupConfig.relayMode,
      machine_fingerprint: machineFingerprint,
      direct_base_url: setupConfig.directBaseUrl || null,
      runtime_token: undefined,
      artifact_store_path: setupConfig.artifactStorePath || defaultArtifactStorePath(),
      config_version: bootstrap.config_version,
      heartbeat_interval_seconds: heartbeatInterval,
      heartbeat_timeout_seconds: bootstrap.heartbeat_timeout_seconds,
      enrolled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      gateway_base_url: trimTrailingSlash(relayGatewayBaseUrl),
      jobs_poll_path: jobsPollPath,
      jobs_start_path_template: jobsStartPathTemplate,
      jobs_events_path_template: jobsEventsPathTemplate,
      jobs_result_path_template: jobsResultPathTemplate,
      lifecycle_health_status: "healthy",
      lifecycle_health_reason: undefined,
      lifecycle_health_message: undefined,
      lifecycle_health_updated_at: new Date().toISOString(),
      ollama_base_url: setupConfig.ollamaBaseUrl,
      discovery_mode: setupConfig.discoveryMode,
      mcoda_bin: setupConfig.mcodaBin,
      mcoda_list_args: setupConfig.mcodaListArgs,
      node_version: setupConfig.nodeVersion,
      request_timeout_ms: setupConfig.requestTimeoutMs,
      job_timeout_ms: setupConfig.jobTimeoutMs,
      max_concurrent_jobs: setupConfig.maxConcurrentJobs,
      max_concurrent_llm_jobs: setupConfig.maxConcurrentLlmJobs,
      generic_jobs_enabled: setupConfig.genericJobsEnabled,
      generic_job_timeout_ms: setupConfig.genericJobTimeoutMs,
      generic_job_max_concurrency: setupConfig.genericJobMaxConcurrency,
      capability_probe_timeout_ms: setupConfig.capabilityProbeTimeoutMs || DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
      drain_mode: setupConfig.drainMode,
      load_reporting_enabled: setupConfig.loadReportingEnabled,
      hardware_telemetry_enabled: setupConfig.hardwareTelemetryEnabled,
      expose_all_models: setupConfig.exposeAllModels,
      exposure_policy: setupConfig.exposeAllModels ? "all" : "none",
      model_allowlist: setupConfig.modelAllowlist,
      model_blocklist: setupConfig.modelBlocklist,
      client_allowlist: setupConfig.clientAllowlist
    };
    await writeSelfHostedNodeState(setupConfig.statePath, state);
    await writeSelfHostedRuntimeToken(setupConfig.runtimeTokenPath, runtimeToken);
    const runtimeGateway =
      deps?.gateway && trimTrailingSlash(relayGatewayBaseUrl) === setupConfig.gatewayBaseUrl
        ? deps.gateway
        : new MswarmSelfHostedNodeClient({
            gatewayBaseUrl: trimTrailingSlash(relayGatewayBaseUrl),
            jobsPollPath,
            jobsStartPathTemplate,
            jobsEventsPathTemplate,
            jobsResultPathTemplate,
            fetchImpl: deps?.fetchImpl,
            timeoutMs: setupConfig.requestTimeoutMs
          });
    const runtime = new SelfHostedNodeRuntime(
      {
        gatewayBaseUrl: trimTrailingSlash(relayGatewayBaseUrl),
        jobsPollPath,
        jobsStartPathTemplate,
        jobsEventsPathTemplate,
        jobsResultPathTemplate,
        nodeId,
        serverName: state.server_name,
        relayMode: state.relay_mode || setupConfig.relayMode,
        machineFingerprint,
        directBaseUrl: setupConfig.directBaseUrl || null,
        enrollmentToken: null,
        runtimeToken,
        discoveryMode: setupConfig.discoveryMode,
        mcodaBin: setupConfig.mcodaBin,
        mcodaListArgs: setupConfig.mcodaListArgs,
        ollamaBaseUrl: setupConfig.ollamaBaseUrl,
        statePath: setupConfig.statePath,
        runtimeTokenPath: setupConfig.runtimeTokenPath,
        artifactStorePath: setupConfig.artifactStorePath || defaultArtifactStorePath(),
        invocationSigningSecret: null,
        listenHost: DEFAULT_LISTEN_HOST,
        listenPort: DEFAULT_LISTEN_PORT,
        nodeVersion: setupConfig.nodeVersion,
        heartbeatIntervalSeconds: heartbeatInterval,
        requestTimeoutMs: setupConfig.requestTimeoutMs,
        jobTimeoutMs: setupConfig.jobTimeoutMs,
        maxConcurrentJobs: setupConfig.maxConcurrentJobs,
        maxConcurrentLlmJobs: setupConfig.maxConcurrentLlmJobs,
        genericJobsEnabled: setupConfig.genericJobsEnabled,
        genericJobTimeoutMs: setupConfig.genericJobTimeoutMs,
        genericJobMaxConcurrency: setupConfig.genericJobMaxConcurrency,
        capabilityProbeTimeoutMs: setupConfig.capabilityProbeTimeoutMs || DEFAULT_CAPABILITY_PROBE_TIMEOUT_MS,
        drainMode: setupConfig.drainMode,
        loadReportingEnabled: setupConfig.loadReportingEnabled,
        hardwareTelemetryEnabled: setupConfig.hardwareTelemetryEnabled,
        exposeAllModels: setupConfig.exposeAllModels,
        modelAllowlist: setupConfig.modelAllowlist,
        modelBlocklist: setupConfig.modelBlocklist,
        clientAllowlist: setupConfig.clientAllowlist
      },
      { ...deps, gateway: runtimeGateway }
    );
    const once = await runtime.runOnce();
    return {
      created: bootstrap.created === true,
      nodeId,
      serverName: state.server_name || setupConfig.serverName,
      modelCount: once.model_count,
      status: once.status,
      statePath: setupConfig.statePath,
      runtimeTokenPath: setupConfig.runtimeTokenPath,
      start: setupConfig.start
    };
  }

  private async discoverModels(): Promise<{
    source: "mcoda" | "ollama";
    status: "online" | "degraded";
    models: SelfHostedModelInput[];
    version: string | null;
    failureCount: number;
  }> {
    if (this.config.discoveryMode === "ollama") {
      const [version, models] = await Promise.all([
        this.ollama.getVersion(),
        this.ollama.listModels(this.config)
      ]);
      return { source: "ollama", status: "online", models, version, failureCount: 0 };
    }
    const models = await this.mcoda.listAgents(this.config);
    return { source: "mcoda", status: "online", models, version: null, failureCount: 0 };
  }

  async probeCapabilities(): Promise<MswarmNodeCapabilitySnapshot> {
    const timeoutMs = capabilityProbeTimeoutMs(this.config);
    const [gpu, docker, blender, ffmpeg] = await Promise.all([
      probeNvidiaGpuCapabilities(this.capabilityRunner, timeoutMs),
      probeDockerCapabilities(this.capabilityRunner, timeoutMs),
      probeVersionedSoftware(this.capabilityRunner, "blender", "blender", ["--version"], timeoutMs),
      probeVersionedSoftware(this.capabilityRunner, "ffmpeg", "ffmpeg", ["-version"], timeoutMs)
    ]);
    const software = {
      docker: docker.docker,
      "docker-nvidia": docker.dockerNvidia,
      blender,
      ffmpeg
    };
    const runnerCatalog = buildRunnerCapabilityCatalog(this.config, this.genericRunners).filter((entry) =>
      runnerCapabilityRequirementsAvailable(entry, {
        gpu,
        software,
        genericJobsEnabled: this.config.genericJobsEnabled
      })
    );
    const snapshotWithoutId: Omit<MswarmNodeCapabilitySnapshot, "snapshot_id"> = {
      schema_version: MSWARM_CAPABILITY_SCHEMA_VERSION,
      captured_at: new Date().toISOString(),
      node_id: this.config.nodeId,
      platform: platform(),
      arch: process.arch,
      generic_jobs_enabled: this.config.genericJobsEnabled,
      job_types: uniqueSortedStrings(runnerCatalog.map((entry) => entry.job_type)),
      trust_modes: uniqueSortedStrings(runnerCatalog.flatMap((entry) => entry.trust_modes)),
      gpu,
      software,
      runner_catalog: runnerCatalog
    };
    const snapshot: MswarmNodeCapabilitySnapshot = {
      ...snapshotWithoutId,
      snapshot_id: buildCapabilitySnapshotId(snapshotWithoutId)
    };
    const diagnostics = capabilityDiagnostics(snapshot);
    return diagnostics ? { ...snapshot, diagnostics } : snapshot;
  }

  async publicCapabilityProjection(): Promise<MswarmPublicCapabilityProjection> {
    return projectMswarmPublicCapabilities(await this.probeCapabilities());
  }

  async buildCapabilityHeartbeatPayload(runtimeToken: string): Promise<MswarmSignedCapabilityPayload> {
    const snapshot = await this.probeCapabilities();
    const privateCatalogEntry = buildMswarmPrivateCapabilityCatalogEntry(snapshot);
    return signCapabilityPayload({ privateCatalogEntry, runtimeToken });
  }

  async ensureEnrolled(): Promise<{ runtimeToken: string; state: SelfHostedNodeState; enrolled: boolean }> {
    const currentState = await readSelfHostedNodeState(this.config.statePath);
    const persistedRuntimeToken = await readSelfHostedRuntimeToken(this.config.runtimeTokenPath);
    const existingRuntimeToken = this.config.runtimeToken || persistedRuntimeToken || currentState.runtime_token;
    if (existingRuntimeToken) {
      return { runtimeToken: existingRuntimeToken, state: currentState, enrolled: false };
    }
    if (!this.config.enrollmentToken) {
      throw new Error("No runtime token is stored and MSWARM_SELF_HOSTED_ENROLLMENT_TOKEN is missing");
    }
    const response = await this.gateway.enroll(this.config.nodeId, this.config.enrollmentToken);
    const runtimeToken = optionalText(response.runtime_token);
    if (!runtimeToken) {
      throw new Error("Enrollment response did not include runtime_token");
    }
    const relay = response.relay || {};
    const gatewayBaseUrl = trimTrailingSlash(optionalText(relay.gateway_base_url) || this.config.gatewayBaseUrl);
    const jobsPollPath = lifecyclePath(relay.jobs_poll_path || this.config.jobsPollPath, DEFAULT_SELF_HOSTED_JOBS_POLL_PATH);
    const jobsStartPathTemplate = lifecyclePath(
      relay.jobs_start_path_template || this.config.jobsStartPathTemplate,
      DEFAULT_SELF_HOSTED_JOBS_START_PATH_TEMPLATE
    );
    const jobsEventsPathTemplate = lifecyclePath(
      relay.jobs_events_path_template || this.config.jobsEventsPathTemplate,
      DEFAULT_SELF_HOSTED_JOBS_EVENTS_PATH_TEMPLATE
    );
    const jobsResultPathTemplate = lifecyclePath(
      relay.jobs_result_path_template || this.config.jobsResultPathTemplate,
      DEFAULT_SELF_HOSTED_JOBS_RESULT_PATH_TEMPLATE
    );
    const nextState: SelfHostedNodeState = {
      ...currentState,
      node_id: this.config.nodeId,
      runtime_token: undefined,
      config_version: response.config_version,
      heartbeat_interval_seconds: response.heartbeat_interval_seconds || this.config.heartbeatIntervalSeconds,
      heartbeat_timeout_seconds: response.heartbeat_timeout_seconds,
      enrolled_at: currentState.enrolled_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      gateway_base_url: gatewayBaseUrl,
      jobs_poll_path: jobsPollPath,
      jobs_start_path_template: jobsStartPathTemplate,
      jobs_events_path_template: jobsEventsPathTemplate,
      jobs_result_path_template: jobsResultPathTemplate,
      lifecycle_health_status: "healthy",
      lifecycle_health_reason: undefined,
      lifecycle_health_message: undefined,
      lifecycle_health_updated_at: new Date().toISOString(),
      ollama_base_url: this.config.ollamaBaseUrl,
      discovery_mode: this.config.discoveryMode,
      mcoda_bin: this.config.mcodaBin,
      mcoda_list_args: this.config.mcodaListArgs,
      node_version: this.config.nodeVersion,
      request_timeout_ms: this.config.requestTimeoutMs,
      job_timeout_ms: this.config.jobTimeoutMs,
      max_concurrent_jobs: this.config.maxConcurrentJobs,
      max_concurrent_llm_jobs: this.config.maxConcurrentLlmJobs,
      generic_jobs_enabled: this.config.genericJobsEnabled,
      generic_job_timeout_ms: this.config.genericJobTimeoutMs,
      generic_job_max_concurrency: this.config.genericJobMaxConcurrency,
      drain_mode: this.config.drainMode === true,
      load_reporting_enabled: this.config.loadReportingEnabled !== false,
      hardware_telemetry_enabled: this.config.hardwareTelemetryEnabled === true,
      expose_all_models: this.config.exposeAllModels,
      exposure_policy: this.config.exposeAllModels ? "all" : "none",
      model_allowlist: this.config.modelAllowlist,
      model_blocklist: this.config.modelBlocklist,
      client_allowlist: this.config.clientAllowlist
    };
    await writeSelfHostedNodeState(this.config.statePath, nextState);
    await writeSelfHostedRuntimeToken(this.config.runtimeTokenPath, runtimeToken);
    return { runtimeToken, state: nextState, enrolled: true };
  }

  private async resolveMcodaAgentForJob(job: SelfHostedNodeInvocationJob): Promise<MswarmCodaliAgent> {
    const selectedSourceAgentSlug = optionalText(job.source_agent_slug);
    const selectedAgentSlug = optionalText(job.agent_slug);
    const selectedModel = optionalText(job.model) || optionalText(job.openai_request.model);
    const selected = selectedSourceAgentSlug || selectedAgentSlug || selectedModel;
    if (!selected) {
      throw new SelfHostedPreStartJobError("selected_agent_unavailable", "mcoda source agent slug is required");
    }
    const rawAgents = await this.mcoda.listRawAgents();
    const strictSelectedAgent = selectedSourceAgentSlug || selectedAgentSlug;
    const agent = rawAgents.find((entry) => {
      const slug = optionalText(entry.slug);
      if (strictSelectedAgent) {
        return slug === strictSelectedAgent;
      }
      const defaultModel = mcodaAgentDefaultModel(entry);
      return slug === selected || defaultModel === selected;
    });
    if (!agent) {
      throw new SelfHostedPreStartJobError(
        "selected_agent_unavailable",
        `selected local mcoda agent ${selected} is not available on this node`
      );
    }
    const mapped = mapMcodaAgentToSelfHostedModel(agent, this.config);
    if (!mapped?.exposed) {
      throw new SelfHostedPreStartJobError(
        "selected_agent_unavailable",
        `selected local mcoda agent ${selected} is not exposed by this node`
      );
    }
    if (mapped.health_status && mapped.health_status !== "healthy" && mapped.health_status !== "unknown") {
      throw new SelfHostedPreStartJobError(
        "selected_agent_unhealthy",
        `selected local mcoda agent ${selected} is ${mapped.health_status}`
      );
    }
    const codaliAgent = mapMcodaAgentToCodaliAgent(agent, selected);
    if (!codaliAgent.apiKey && mcodaAgentRequiresApiKey(agent, codaliAgent)) {
      let apiKey: string | undefined;
      try {
        apiKey = optionalText(await this.mcodaAgentAuthResolver(agent)) || undefined;
      } catch {
        throw new SelfHostedPreStartJobError(
          "selected_agent_auth_unavailable",
          `selected local mcoda agent ${selected} auth could not be loaded`
        );
      }
      if (!apiKey) {
        throw new SelfHostedPreStartJobError(
          "selected_agent_auth_unavailable",
          `selected local mcoda agent ${selected} requires an API key; run "mcoda agent auth set ${selected}" on this node`
        );
      }
      codaliAgent.apiKey = apiKey;
    }
    return codaliAgent;
  }

  async executeGenericJob(
    envelope: SelfHostedGenericNodeJob,
    options: MswarmGenericJobExecutionOptions = {}
  ): Promise<MswarmGenericJobExecutionResult> {
    const startedAt = Date.now();
    this.beginExecutionTelemetry("generic_job");
    const events: MswarmJobEvent[] = [];
    let sequence = 0;
    const emitEvent = async (event: Omit<MswarmJobEvent, "job_id" | "sequence" | "timestamp">) => {
      const next: MswarmJobEvent = {
        job_id: envelope.job_id,
        sequence,
        timestamp: new Date().toISOString(),
        ...event
      };
      sequence += 1;
      events.push(next);
      await options.onEvent?.(next);
    };
    const failed = async (
      code: string,
      message: string,
      validationIssues?: MswarmGenericJobValidationIssue[]
    ): Promise<MswarmGenericJobExecutionResult> => {
      await emitEvent({
        type: code === "cancelled" ? "cancelled" : "failed",
        message,
        data: { code }
      });
      const status: MswarmJobResult["status"] = code === "cancelled" ? "cancelled" : "failed";
      const result: MswarmJobResult = {
        job_id: envelope.job_id,
        status,
        error: {
          code,
          message,
          retryable: code === "timeout"
        },
        finished_at: new Date().toISOString()
      };
      this.finishExecutionTelemetry({
        executionClass: "generic_job",
        startedAt,
        ok: false,
        code
      });
      return {
        job_id: envelope.job_id,
        request_id: envelope.request_id,
        status,
        result,
        events,
        ...(validationIssues?.length ? { validation_issues: validationIssues } : {}),
        timing: { local_latency_ms: Date.now() - startedAt }
      };
    };

    if (!this.config.genericJobsEnabled) {
      return failed("feature_disabled", "Generic node jobs are disabled on this node.");
    }
    if (envelope.node_id !== this.config.nodeId) {
      return failed("validation_failed", "generic job node_id does not match this node");
    }
    const validation = validateMswarmGenericJobRequest(envelope.job, {
      registeredJobCatalog: registeredOwnerLocalGenericJobCatalog()
    });
    if (!validation.ok || !validation.value) {
      return failed("validation_failed", "generic job request failed validation", validation.issues);
    }
    const job = validation.value;
    const runner = runnerForGenericJob(job, this.genericRunners);
    if (!runner) {
      return failed("runner_unavailable", `No generic job runner is registered for ${job.job_type}.`);
    }
    if (job.job_type === RENDER_BLENDER_JOB_TYPE || job.job_type === CUDA_RUN_JOB_TYPE) {
      const capabilityMismatch = genericJobCapabilityMismatch(job, await this.probeCapabilities());
      if (capabilityMismatch) {
        return failed(capabilityMismatch.code, capabilityMismatch.message);
      }
    }
    let artifactContext: MswarmGenericJobArtifactContext;
    try {
      artifactContext = await this.artifactStore.prepareJobWorkspace(envelope.job_id, job);
    } catch (error) {
      return failed(
        "validation_failed",
        error instanceof Error ? error.message : String(error || "generic job artifact preparation failed")
      );
    }

    const controller = new AbortController();
    const timeoutMs = genericJobTimeoutMs(job, this.config.genericJobTimeoutMs || this.config.jobTimeoutMs);
    const onAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(options.signal?.reason || "cancelled");
      }
    };
    if (options.signal?.aborted) {
      controller.abort(options.signal.reason || "cancelled");
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort("timeout");
      }
    }, timeoutMs);

    try {
      await emitEvent({
        type: "started",
        message: `Running ${job.job_type}`,
        data: {
          runner: runner.id,
          sandbox_profile: artifactContext.sandbox.name,
          timeout_ms: timeoutMs
        }
      });
      const runnerResult = await runner.run({
        job,
        signal: controller.signal,
        emitEvent,
        artifacts: artifactContext,
        sandbox: artifactContext.sandbox
      });
      const status = runnerResult.status || "succeeded";
      const outputContext =
        status === "succeeded"
          ? artifactContext
          : {
              ...artifactContext,
              outputSpecs: artifactContext.outputSpecs.map((output) => ({ ...output, required: false }))
            };
      const outputArtifacts = await this.artifactStore.collectOutputs(outputContext, envelope.job_id);
      for (const artifact of outputArtifacts) {
        await emitEvent({
          type: "artifact",
          message: "output artifact collected",
          data: { artifact }
        });
      }
      const result: MswarmJobResult = {
        ...runnerResult,
        job_id: envelope.job_id,
        status,
        artifacts: [...(runnerResult.artifacts || []), ...outputArtifacts],
        started_at: runnerResult.started_at || new Date(startedAt).toISOString(),
        finished_at: runnerResult.finished_at || new Date().toISOString()
      };
      await emitEvent({
        type: status === "succeeded" ? "completed" : "failed",
        message: status === "succeeded" ? "generic job completed" : runnerResult.error?.message || "generic job failed",
        data: {
          status,
          exit_code: result.exit_code,
          runner: runner.id
        }
      });
      this.finishExecutionTelemetry({
        executionClass: "generic_job",
        startedAt,
        ok: status === "succeeded",
        code: runnerResult.error?.code || status
      });
      return {
        job_id: envelope.job_id,
        request_id: envelope.request_id,
        status,
        result,
        events,
        timing: { local_latency_ms: Date.now() - startedAt }
      };
    } catch (error) {
      const code = isGenericAbortError(error, controller.signal) ? abortErrorCode(controller.signal) : "runner_error";
      const message = code === "timeout" || code === "cancelled"
        ? abortErrorMessage(controller.signal)
        : error instanceof Error
          ? error.message
          : String(error);
      return failed(code, message);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async executeJob(
    job: SelfHostedNodeInvocationJob,
    options: SelfHostedJobExecutionOptions = {}
  ): Promise<SelfHostedNodeInvocationResult> {
    const startedAt = Date.now();
    this.beginExecutionTelemetry("llm");
    let selectedAgent: MswarmCodaliAgent | undefined;
    let jobStarted = false;
    const progressEvents: Record<string, unknown>[] = [];
    const streamEvents: Record<string, unknown>[] = [];
    const recordProgress = async (event: Record<string, unknown>) => {
      progressEvents.push(event);
      await options.onProgress?.(event);
    };
    const emitOpenAIChunk = async (chunk: Record<string, unknown>) => {
      streamEvents.push(chunk);
      await options.onOpenAIChunk?.(chunk);
    };
    const acknowledgeStarted = async (agent?: MswarmCodaliAgent) => {
      if (jobStarted) {
        return;
      }
      await options.onStarted?.({
        job_id: job.job_id,
        request_id: job.request_id,
        node_id: job.node_id,
        agent_slug: optionalText(job.agent_slug) || agent?.slug || "",
        source_agent_slug: optionalText(job.source_agent_slug) || agent?.slug || null,
        model: optionalText(job.model) || optionalText(job.openai_request.model)
      });
      jobStarted = true;
    };
    if (job.node_id !== this.config.nodeId) {
      const result: SelfHostedNodeInvocationResult = {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "failed",
        pre_start_failure: true,
        error: { code: "validation_failed", message: "job node_id does not match this node" }
      };
      this.finishExecutionTelemetry({
        executionClass: "llm",
        startedAt,
        ok: false,
        code: "validation_failed"
      });
      return result;
    }
    try {
      if (job.provider === "ollama") {
        const options: Record<string, unknown> = {};
        if (job.openai_request.temperature !== undefined) options.temperature = job.openai_request.temperature;
        if (job.openai_request.top_p !== undefined) options.top_p = job.openai_request.top_p;
        if (job.openai_request.max_tokens !== undefined) options.num_predict = job.openai_request.max_tokens;
        if (job.openai_request.stop !== undefined) options.stop = job.openai_request.stop;
        await acknowledgeStarted();
        const ollamaResult = await this.jobOllama.chat({
          model: job.model || job.openai_request.model,
          messages: job.openai_request.messages,
          options,
          format: resolveOllamaResponseFormat(job.openai_request.response_format)
        });
        if (job.openai_request.stream) {
          await emitOpenAIChunk({
            id: `chatcmpl-${job.request_id}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: job.openai_request.model,
            choices: [
              { index: 0, delta: { content: ollamaResult.content }, finish_reason: null }
            ]
          });
          await emitOpenAIChunk({
            id: `chatcmpl-${job.request_id}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: job.openai_request.model,
            choices: [
              { index: 0, delta: {}, finish_reason: "stop" }
            ]
          });
        }
        const promptTokens = positiveInteger(ollamaResult.promptTokens);
        const completionTokens = positiveInteger(ollamaResult.completionTokens);
        const invocationResult: SelfHostedNodeInvocationResult = {
          job_id: job.job_id,
          request_id: job.request_id,
          status: "success",
          openai_response: buildOpenAIChatCompletion({
            requestId: job.request_id,
            model: job.openai_request.model,
            content: ollamaResult.content,
            promptTokens,
            completionTokens,
            metadata: { provider: "ollama", raw: ollamaResult.raw }
          }),
          usage: usageFromTokenCounts(promptTokens, completionTokens),
          ...(streamEvents.length ? { stream_events: streamEvents } : {}),
          ...(progressEvents.length ? { progress_events: progressEvents } : {}),
          timing: { local_latency_ms: Date.now() - startedAt }
        };
        this.finishExecutionTelemetry({
          executionClass: "llm",
          startedAt,
          ok: true
        });
        return invocationResult;
      }
      const taskPreview = messagesToPrompt(job.openai_request.messages);
      if (!taskPreview) {
        throw new Error("mcoda invocation prompt is empty");
      }
      const agent = await this.resolveMcodaAgentForJob(job);
      selectedAgent = agent;
      validateRequiredDocdexContext(job, options.attachedMswarmApiKey);
      const attachedMswarmApiKey = attachedMswarmApiKeyForDocdex(job, options.attachedMswarmApiKey);
      await acknowledgeStarted(agent);
      await recordProgress({
        type: "agent_selected",
        job_id: job.job_id,
        request_id: job.request_id,
        agent_slug: agent.slug,
        adapter: agent.adapter,
        supports_tools: agent.supportsTools === true
      });
      const response = await this.codaliExecutor.invoke({
        jobId: job.job_id,
        requestId: job.request_id,
        model: job.openai_request.model,
        messages: job.openai_request.messages,
        agent,
        workspace: buildCodaliWorkspace(job),
        docdex: buildCodaliDocdex(job),
        attachedMswarmApiKey,
        policy: buildCodaliPolicy(job),
        temperature: job.openai_request.temperature,
        responseFormat: job.openai_request.response_format ?? null,
        stream: job.openai_request.stream === true,
        onOpenAIChunk: emitOpenAIChunk,
        onRuntimeEvent: async (event) => {
          if (event.type === "status" || event.type === "tool_call" || event.type === "tool_result" || event.type === "error") {
            await recordProgress({
              type: event.type,
              job_id: job.job_id,
              request_id: job.request_id,
              ...(event.type === "status" ? { phase: event.phase, message: event.message } : {}),
              ...(event.type === "tool_call" ? { name: event.name } : {}),
              ...(event.type === "tool_result" ? { name: event.name, ok: event.ok, error_code: event.errorCode } : {}),
              ...(event.type === "error" ? { message: event.message, code: event.code } : {}),
              at: event.at
            });
          }
        }
      });
      const tokens = usageTokens(response.usage);
      const result: SelfHostedNodeInvocationResult = {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "success",
        openai_response: buildOpenAIChatCompletion({
          requestId: job.request_id,
          model: job.openai_request.model,
          content: response.output,
          promptTokens: tokens.promptTokens,
          completionTokens: tokens.completionTokens,
          metadata: {
            provider: response.metadata.provider,
            adapter: response.metadata.adapter,
            local_model: response.metadata.local_model,
            agent_slug: response.metadata.agent_slug,
            codali_run_id: response.metadata.run_id,
            tool_calls_executed: response.metadata.tool_calls_executed,
            touched_files: response.metadata.touched_files,
            warnings: response.metadata.warnings,
            mode: response.metadata.mode
          }
        }),
        usage: usageFromTokenCounts(tokens.promptTokens, tokens.completionTokens),
        ...(streamEvents.length ? { stream_events: streamEvents } : {}),
        ...(progressEvents.length ? { progress_events: progressEvents } : {}),
        timing: { local_latency_ms: Date.now() - startedAt }
      };
      this.finishExecutionTelemetry({
        executionClass: "llm",
        startedAt,
        ok: true
      });
      return result;
    } catch (error) {
      const message = redactRuntimeSecretValues(
        error instanceof Error ? error.message : String(error),
        [selectedAgent?.apiKey, options.attachedMswarmApiKey],
      );
      const explicitCode = selfHostedErrorCode(error);
      const code =
        explicitCode ??
        (/timeout/i.test(message)
          ? "timeout"
          : /not exposed|validation|required|empty/i.test(message)
            ? "validation_failed"
            : /permission|policy|denied/i.test(message)
              ? "policy_denied"
              : "upstream_error");
      const result: SelfHostedNodeInvocationResult = {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "failed",
        ...(!jobStarted ? { pre_start_failure: true } : {}),
        error: {
          code,
          message
        },
        ...(streamEvents.length ? { stream_events: streamEvents } : {}),
        ...(progressEvents.length ? { progress_events: progressEvents } : {}),
        timing: { local_latency_ms: Date.now() - startedAt }
      };
      this.finishExecutionTelemetry({
        executionClass: "llm",
        startedAt,
        ok: false,
        code
      });
      return result;
    }
  }

  async runOnce(): Promise<SelfHostedNodeHeartbeatResult> {
    const enrollment = await this.ensureEnrolled();
    let status: "online" | "degraded" = "online";
    let version: string | null = null;
    let models: SelfHostedModelInput[] = [];
    let discoverySource: "mcoda" | "ollama" = this.config.discoveryMode;
    let recentFailureCount = 0;
    const startedAt = Date.now();
    try {
      const discovery = await this.discoverModels();
      status = discovery.status;
      version = discovery.version;
      models = discovery.models;
      discoverySource = discovery.source;
      recentFailureCount = discovery.failureCount;
    } catch (error) {
      status = "degraded";
      recentFailureCount = 1;
      models = [];
      version = null;
    }
    const lifecycleState = await this.readLifecycleState();
    const lifecycleProtocolDegraded = this.isLifecycleProtocolDegradedState(lifecycleState);
    if (lifecycleProtocolDegraded) {
      status = "degraded";
      recentFailureCount = Math.max(recentFailureCount, 1);
      this.lifecyclePollingDisabled = true;
    }
    const discoveryLatencyMs = Date.now() - startedAt;
    const capabilityPayload = await this.buildCapabilityHeartbeatPayload(enrollment.runtimeToken);
    const loadTelemetry = this.buildLoadTelemetry({
      models,
      discoveryLatencyMs,
      discoveryFailureCount: recentFailureCount,
      capabilityPayload
    });
    const exposedModelCount = models.filter((model) => model.exposed !== false).length;
    const loadReportingEnabled = this.config.loadReportingEnabled !== false;
    const capacityPayload = loadReportingEnabled
      ? {
          protocol_version: loadTelemetry.runtime_protocol_version,
          runtime_protocol_version: loadTelemetry.runtime_protocol_version,
          load_balancer_protocol_version: loadTelemetry.load_balancer_protocol_version,
          catalog_metadata_version: loadTelemetry.catalog_metadata_version,
          catalog_fingerprint: loadTelemetry.catalog_fingerprint,
          max_concurrency: loadTelemetry.max_concurrency,
          max_concurrent_llm_jobs: loadTelemetry.max_concurrent_llm_jobs,
          max_concurrent_generic_jobs: loadTelemetry.max_concurrent_generic_jobs,
          active_jobs: loadTelemetry.active_jobs,
          queued_jobs: loadTelemetry.queued_jobs,
          free_slots: loadTelemetry.free_slots,
          drain_mode: loadTelemetry.drain_mode,
          execution_class_capacity: loadTelemetry.execution_class_capacity
        }
      : {
          active_jobs: loadTelemetry.active_jobs,
          queued_jobs: loadTelemetry.queued_jobs
        };
    const heartbeatPayload: Record<string, unknown> = {
      node_id: this.config.nodeId,
      node_version: this.config.nodeVersion,
      runtime_protocol_version: SELF_HOSTED_RUNTIME_PROTOCOL_VERSION,
      config_version: enrollment.state.config_version ?? null,
      status,
      runtime: {
        protocol_version: SELF_HOSTED_RUNTIME_PROTOCOL_VERSION,
        relay_mode: this.config.relayMode || "outbound",
        load_reporting_enabled: loadReportingEnabled,
        hardware_telemetry_enabled: this.config.hardwareTelemetryEnabled === true,
        drain_mode: this.config.drainMode === true,
        ...(lifecycleProtocolDegraded
          ? {
              lifecycle: {
                status: "degraded",
                reason: lifecycleState.lifecycle_health_reason,
                message: lifecycleState.lifecycle_health_message,
                updated_at: lifecycleState.lifecycle_health_updated_at
              }
            }
          : {})
      },
      discovery: {
        source: discoverySource,
        mcoda_status: discoverySource === "mcoda" && status === "online" ? "ok" : status === "degraded" ? "error" : null
      },
      ollama:
        discoverySource === "ollama"
          ? {
              status: status === "online" ? "ok" : "error",
              version
            }
          : {
              status: null,
              version: null
            },
      capacity: capacityPayload,
      health: {
        avg_latency_ms: loadTelemetry.avg_latency_ms ?? discoveryLatencyMs,
        recent_failure_count: loadTelemetry.recent_failure_count,
        recent_failures: loadTelemetry.recent_failures,
        last_success_at: status === "online" ? new Date().toISOString() : null,
        ...(lifecycleProtocolDegraded
          ? {
              lifecycle_status: "degraded",
              lifecycle_reason: lifecycleState.lifecycle_health_reason,
              lifecycle_message: lifecycleState.lifecycle_health_message
            }
          : {})
      },
      local_agent_catalog: {
        revision: loadTelemetry.catalog_fingerprint,
        metadata_version: loadTelemetry.catalog_metadata_version,
        model_count: models.length,
        exposed_model_count: exposedModelCount
      },
      client_allowlist: this.config.clientAllowlist,
      models,
      capabilities: capabilityPayload,
      ...(loadTelemetry.hardware_pressure ? { hardware_pressure: loadTelemetry.hardware_pressure } : {})
    };
    const heartbeatResponse = await this.gateway.heartbeat(enrollment.runtimeToken, heartbeatPayload);
    return {
      enrolled: enrollment.enrolled,
      status,
      model_count: exposedModelCount,
      discovery_source: discoverySource,
      mcoda_agent_count: discoverySource === "mcoda" ? exposedModelCount : undefined,
      ollama_version: version,
      capacity: loadTelemetry,
      heartbeat_response: heartbeatResponse
    };
  }

  async notifyUninstall(input?: {
    reason?: string;
    source?: string;
    serviceManager?: string | null;
  }): Promise<SelfHostedNodeUninstallNotificationResult> {
    const runtimeToken = this.config.runtimeToken || (await readSelfHostedRuntimeToken(this.config.runtimeTokenPath));
    if (!runtimeToken) {
      return { notified: false, error: "missing runtime token" };
    }
    try {
      const response = await this.gateway.uninstall(runtimeToken, {
        node_id: this.config.nodeId,
        reason: input?.reason || "node_uninstall",
        source: input?.source || "mswarm_node_uninstall",
        node_version: this.config.nodeVersion,
        service_manager: input?.serviceManager || null
      });
      return { notified: true, response };
    } catch (error) {
      return { notified: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async pushModelsOnly(): Promise<{ count: number; response: unknown }> {
    const enrollment = await this.ensureEnrolled();
    const discovery = await this.discoverModels();
    const models = discovery.models;
    const response = await this.gateway.pushModels(enrollment.runtimeToken, {
      node_id: this.config.nodeId,
      models
    });
    return { count: models.filter((model) => model.exposed !== false).length, response };
  }

  async pollAndExecuteJob(waitMs = DEFAULT_JOB_POLL_WAIT_MS): Promise<{
    executed: boolean;
    job_id?: string;
    status?: "success" | "failed";
  }> {
    const lifecycleState = await this.readLifecycleState();
    if (this.lifecyclePollingDisabled || this.isLifecycleProtocolDegradedState(lifecycleState)) {
      this.lifecyclePollingDisabled = true;
      return { executed: false, status: "failed" };
    }
    const enrollment = await this.ensureEnrolled();
    const pollCapacity = this.buildLoadTelemetry({ models: [] });
    let response: { job?: SelfHostedNodeInvocationJob | null; attached_mswarm_api_key?: string | null };
    try {
      response = await this.gateway.pollJob(enrollment.runtimeToken, {
        node_id: this.config.nodeId,
        capacity: {
          active_jobs: pollCapacity.active_jobs,
          queued_jobs: pollCapacity.queued_jobs,
          max_jobs: pollCapacity.max_concurrency,
          max_concurrency: pollCapacity.max_concurrency,
          free_slots: pollCapacity.free_slots,
          drain_mode: pollCapacity.drain_mode
        },
        wait_ms: waitMs
      });
    } catch (error) {
      const mismatch = this.lifecycleProtocolMismatch("poll", error);
      if (mismatch) {
        await this.markLifecycleProtocolDegraded(mismatch);
        return { executed: false, status: "failed" };
      }
      throw error;
    }
    const job = response.job || null;
    if (!job) {
      return { executed: false };
    }
    const pendingStreamEvents: Record<string, unknown>[] = [];
    let streamEventForwardingFailed = false;
    let forwardedStreamEventCount = 0;
    const flushStreamEvents = async () => {
      if (pendingStreamEvents.length === 0 || streamEventForwardingFailed) {
        return;
      }
      const stream_events = pendingStreamEvents.splice(0, pendingStreamEvents.length);
      try {
        await this.gateway.postJobEvents(enrollment.runtimeToken, job.job_id, {
          node_id: this.config.nodeId,
          stream_events
        });
        forwardedStreamEventCount += stream_events.length;
      } catch (error) {
        const mismatch = this.lifecycleProtocolMismatch("events", error);
        if (mismatch) {
          streamEventForwardingFailed = true;
          await this.markLifecycleProtocolDegraded(mismatch);
          throw mismatch;
        }
        streamEventForwardingFailed = true;
      }
    };
    let result = await this.executeJob(job, {
      attachedMswarmApiKey: optionalText(response.attached_mswarm_api_key) || undefined,
      onStarted: async (event) => {
        try {
          await this.gateway.postJobStart(enrollment.runtimeToken, job.job_id, {
            node_id: this.config.nodeId,
            agent_slug: event.agent_slug || job.agent_slug,
            source_agent_slug: event.source_agent_slug || job.source_agent_slug || null,
            model: event.model || job.model || job.openai_request.model
          });
        } catch (error) {
          const mismatch = this.lifecycleProtocolMismatch("start", error);
          if (mismatch) {
            await this.markLifecycleProtocolDegraded(mismatch);
            throw mismatch;
          }
          throw error;
        }
      },
      onOpenAIChunk: async (chunk) => {
        if (job.openai_request.stream !== true || streamEventForwardingFailed) {
          return;
        }
        pendingStreamEvents.push(chunk);
        if (pendingStreamEvents.length >= DEFAULT_STREAM_EVENT_BATCH_SIZE) {
          await flushStreamEvents();
        }
      },
    });
    try {
      await flushStreamEvents();
    } catch (error) {
      if (!(error instanceof SelfHostedProtocolMismatchError)) {
        throw error;
      }
      result = {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "failed",
        error: { code: SELF_HOSTED_PROTOCOL_MISMATCH_CODE, message: error.message },
        ...(result.stream_events?.length ? { stream_events: result.stream_events } : {}),
        ...(result.progress_events?.length ? { progress_events: result.progress_events } : {}),
        timing: result.timing
      };
    }
    const postedResult = job.openai_request.stream === true
      ? streamEventForwardingFailed
        ? {
            ...result,
            stream_events: result.stream_events?.slice(forwardedStreamEventCount)
          }
        : (({ stream_events: _streamEvents, ...rest }) => rest)(result)
      : result;
    let resultPostError: unknown = null;
    for (let attempt = 0; attempt <= RELAY_RESULT_POST_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        await this.gateway.postJobResult(
          enrollment.runtimeToken,
          job.job_id,
          this.jobResultPayload(postedResult)
        );
        resultPostError = null;
        break;
      } catch (error) {
        resultPostError = error;
        const attemptNumber = attempt + 1;
        const maxAttempts = RELAY_RESULT_POST_RETRY_DELAYS_MS.length + 1;
        const retryDelayMs = RELAY_RESULT_POST_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs === undefined) {
          break;
        }
        console.warn(
          `[mswarm] self-hosted result post failed for ${job.job_id} ` +
            `(attempt ${attemptNumber}/${maxAttempts}): ${runtimeErrorMessage(error)}`
        );
        await sleep(retryDelayMs);
      }
    }
    if (resultPostError) {
      const error = resultPostError;
      const mismatch = this.lifecycleProtocolMismatch("result", error);
      if (mismatch) {
        await this.markLifecycleProtocolDegraded(mismatch);
        return { executed: true, job_id: job.job_id, status: "failed" };
      }
      throw error;
    }
    return { executed: true, job_id: job.job_id, status: result.status };
  }

  async doctor(): Promise<SelfHostedNodeDoctorResult> {
    const checks: SelfHostedNodeDoctorResult["checks"] = [];
    checks.push({ name: "config", ok: Boolean(this.config.nodeId), message: this.config.nodeId || "missing node id" });
    const runtimeToken = this.config.runtimeToken || (await readSelfHostedRuntimeToken(this.config.runtimeTokenPath));
    checks.push({ name: "runtime_token", ok: Boolean(runtimeToken), message: runtimeToken ? "present" : "missing" });
    try {
      await this.gateway.health();
      checks.push({ name: "gateway_health", ok: true });
    } catch (error) {
      checks.push({
        name: "gateway_health",
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      const once = await this.runOnce();
      checks.push({ name: "heartbeat", ok: once.status === "online", message: once.status });
      checks.push({
        name: "local_agents",
        ok: once.model_count > 0,
        message: `${once.model_count} exposed local agent(s)`
      });
    } catch (error) {
      checks.push({
        name: "heartbeat",
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return { ok: checks.every((check) => check.ok), checks };
  }

  startDaemon(): SelfHostedNodeDaemonHandle {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    const poll = () => {
      if (stopped || polling || this.lifecyclePollingDisabled || this.config.relayMode === "direct") return;
      polling = true;
      void this.pollAndExecuteJob()
        .catch((error) => {
          console.error(`[mswarm] self-hosted relay poll failed: ${runtimeErrorMessage(error)}`);
        })
        .finally(() => {
          polling = false;
          if (!stopped) {
            setTimeout(poll, 0);
          }
        });
    };
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => {
        void this.runOnce()
          .catch(() => undefined)
          .finally(schedule);
      }, this.config.heartbeatIntervalSeconds * 1000);
    };
    void this.runOnce()
      .catch(() => undefined)
      .finally(() => {
        schedule();
        poll();
      });
    return {
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }
}
