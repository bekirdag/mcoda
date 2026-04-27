import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname, homedir, platform, userInfo } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export type FetchLike = typeof fetch;
export type SelfHostedDiscoveryMode = "mcoda" | "ollama";
export type SelfHostedRelayMode = "outbound" | "direct";
export type CommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number; input?: string }
) => Promise<{ stdout: string; stderr: string }>;
export type SelfHostedModelHealthStatus = "healthy" | "degraded" | "unreachable" | "unknown" | "blocked";

export interface SelfHostedModelInput {
  name: string;
  provider?: "mcoda" | "ollama";
  adapter?: string | null;
  source_agent_id?: string | null;
  source_agent_slug?: string | null;
  model_id?: string | null;
  display_name?: string | null;
  digest?: string | null;
  exposed?: boolean;
  family?: string | null;
  parameter_size?: string | null;
  quantization_level?: string | null;
  context_window?: number | null;
  max_output_tokens?: number | null;
  supports_tools?: boolean;
  supports_vision?: boolean;
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
  invocationSigningSecret?: string | null;
  listenHost: string;
  listenPort: number;
  nodeVersion: string;
  heartbeatIntervalSeconds: number;
  requestTimeoutMs: number;
  exposeAllModels: boolean;
  modelAllowlist: string[];
  modelBlocklist: string[];
}

export interface SelfHostedNodeState {
  node_id?: string;
  server_name?: string;
  relay_mode?: SelfHostedRelayMode;
  machine_fingerprint?: string;
  direct_base_url?: string | null;
  runtime_token?: string;
  config_version?: number;
  heartbeat_interval_seconds?: number;
  heartbeat_timeout_seconds?: number;
  enrolled_at?: string;
  updated_at?: string;
  gateway_base_url?: string;
  ollama_base_url?: string;
  discovery_mode?: SelfHostedDiscoveryMode;
  mcoda_bin?: string;
  mcoda_list_args?: string[];
  node_version?: string;
  request_timeout_ms?: number;
  expose_all_models?: boolean;
  model_allowlist?: string[];
  model_blocklist?: string[];
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
  machineIdPath: string;
  mcodaBin: string;
  mcodaListArgs: string[];
  ollamaBaseUrl: string;
  nodeVersion: string;
  heartbeatIntervalSeconds: number;
  requestTimeoutMs: number;
  exposeAllModels: boolean;
  modelAllowlist: string[];
  modelBlocklist: string[];
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
  adapter?: string | null;
  source_agent_slug?: string | null;
  model?: string | null;
  openai_request: {
    model: string;
    messages: SelfHostedOpenAIChatMessage[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stop?: string | string[];
  };
  policy?: {
    max_runtime_ms?: number;
    max_output_tokens?: number;
    allow_tools?: boolean;
    allow_images?: boolean;
  };
}

export interface SelfHostedNodeInvocationResult {
  job_id: string;
  request_id: string;
  status: "success" | "failed";
  openai_response?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  timing?: {
    local_latency_ms: number;
  };
}

export interface SelfHostedNodeHeartbeatResult {
  enrolled: boolean;
  status: "online" | "degraded";
  model_count: number;
  discovery_source: "mcoda" | "ollama";
  mcoda_agent_count?: number;
  ollama_version?: string | null;
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

interface GatewayEnrollmentResponse {
  runtime_token?: string;
  heartbeat_interval_seconds?: number;
  heartbeat_timeout_seconds?: number;
  config_version?: number;
}

const DEFAULT_GATEWAY_BASE_URL = "http://127.0.0.1:8080";
const DEFAULT_SETUP_GATEWAY_BASE_URL = "https://api.mswarm.org";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 18083;
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 30;
const DEFAULT_SELF_HOSTED_NODE_VERSION = "0.1.49";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SERVICE_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_MCODA_BIN = "mcoda";
const DEFAULT_MCODA_LIST_ARGS = ["agent", "list", "--json", "--refresh-health"];
const DEFAULT_COMMAND_MAX_BUFFER = 16 * 1024 * 1024;
const DEFAULT_JOB_POLL_WAIT_MS = 25_000;
const SERVICE_LABEL = "com.mcoda.mswarm.self-hosted-node";
const SYSTEMD_SERVICE_NAME = "mswarm-self-hosted-node.service";
const WINDOWS_TASK_NAME = "MswarmSelfHostedNode";
const WINDOWS_WRAPPER_SCRIPT_NAME = "mswarm-self-hosted-node.ps1";

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function defaultStatePath(): string {
  return join(homedir(), ".mswarm", "self-hosted-node", "config.json");
}

function defaultRuntimeTokenPath(): string {
  return join(homedir(), ".mswarm", "self-hosted-node", "node.key");
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

function isMswarmManagedCloudAgent(agent: McodaAgentListEntry): boolean {
  const config = agent.config && typeof agent.config === "object" ? agent.config : {};
  const mswarmCloud = config.mswarmCloud;
  return Boolean(
    mswarmCloud &&
      typeof mswarmCloud === "object" &&
      (mswarmCloud as Record<string, unknown>).managed === true
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
      throw new Error(`request_failed:${response.status}:${text.slice(0, 200)}`);
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

function quoteEnvAssignment(key: string, value: string): string {
  return `${key}=${value}`;
}

function serviceLogDir(homeDir: string): string {
  return join(homeDir, ".mswarm", "self-hosted-node");
}

function serviceEnvironment(config: SelfHostedNodeConfig, env: NodeJS.ProcessEnv, homeDir: string): Record<string, string> {
  const values: Record<string, string | null | undefined> = {
    HOME: env.HOME || homeDir,
    PATH: env.PATH || env.Path || env.path || "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    MSWARM_GATEWAY_BASE_URL: config.gatewayBaseUrl,
    MSWARM_SELF_HOSTED_NODE_STATE_PATH: config.statePath,
    MSWARM_SELF_HOSTED_NODE_KEY_PATH: config.runtimeTokenPath,
    MSWARM_SELF_HOSTED_RELAY_MODE: config.relayMode || "outbound",
    MSWARM_SELF_HOSTED_DIRECT_BASE_URL: config.directBaseUrl || null,
    MSWARM_SELF_HOSTED_DISCOVERY_MODE: config.discoveryMode,
    MSWARM_SELF_HOSTED_MCODA_BIN: config.mcodaBin,
    MSWARM_SELF_HOSTED_MCODA_LIST_ARGS: config.mcodaListArgs.join(","),
    MSWARM_SELF_HOSTED_OLLAMA_BASE_URL: config.ollamaBaseUrl,
    MSWARM_SELF_HOSTED_NODE_VERSION: config.nodeVersion,
    MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS: config.exposeAllModels ? "true" : "false",
    MSWARM_SELF_HOSTED_MODEL_ALLOWLIST: config.modelAllowlist.join(","),
    MSWARM_SELF_HOSTED_MODEL_BLOCKLIST: config.modelBlocklist.join(","),
    MSWARM_SELF_HOSTED_HEARTBEAT_INTERVAL_SECONDS: String(config.heartbeatIntervalSeconds),
    MSWARM_SELF_HOSTED_REQUEST_TIMEOUT_MS: String(config.requestTimeoutMs)
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
  );
}

function buildLaunchdPlist(input: {
  label: string;
  nodePath: string;
  commandPath: string;
  logPath: string;
  errorLogPath: string;
  env: Record<string, string>;
}): string {
  const args = [
    "/usr/bin/env",
    "-i",
    ...Object.entries(input.env).map(([key, value]) => quoteEnvAssignment(key, value)),
    input.nodePath,
    input.commandPath,
    "start"
  ]
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
  nodePath: string;
  commandPath: string;
  logPath: string;
  errorLogPath: string;
  env: Record<string, string>;
}): string {
  const envArgs = Object.entries(input.env)
    .map(([key, value]) => quoteSystemdValue(quoteEnvAssignment(key, value)))
    .join(" ");
  return `[Unit]
Description=mswarm self-hosted node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/env -i ${envArgs} ${quoteSystemdValue(input.nodePath)} ${quoteSystemdValue(input.commandPath)} start
Restart=always
RestartSec=5
StandardOutput=append:${input.logPath}
StandardError=append:${input.errorLogPath}

[Install]
WantedBy=default.target
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
  if (targetPlatform === "darwin") {
    return {
      platform: targetPlatform,
      manager: "launchd",
      serviceName: SERVICE_LABEL,
      servicePath: join(homeDir, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
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
      logPath,
      errorLogPath
    };
  }
  if (targetPlatform === "win32") {
    return {
      platform: targetPlatform,
      manager: "windows-task-scheduler",
      serviceName: WINDOWS_TASK_NAME,
      servicePath: join(logDir, WINDOWS_WRAPPER_SCRIPT_NAME),
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

async function ensureLaunchdServiceBootstrapped(
  runner: CommandRunner,
  domain: string,
  serviceTarget: string,
  servicePath: string,
  timeoutMs: number
): Promise<void> {
  try {
    await runServiceCommand(runner, "launchctl", ["bootstrap", domain, servicePath], timeoutMs);
    return;
  } catch (error) {
    try {
      await runServiceCommand(runner, "launchctl", ["print", serviceTarget], timeoutMs);
      return;
    } catch {
      throw error;
    }
  }
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
      layout.servicePath,
      buildLaunchdPlist({
        label: SERVICE_LABEL,
        nodePath,
        commandPath: options.commandPath,
        logPath: layout.logPath,
        errorLogPath: layout.errorLogPath,
        env
      }),
      "utf8"
    );
    const domain = launchdDomain();
    await runner("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    }).catch(() => undefined);
    await runner("launchctl", ["bootstrap", domain, layout.servicePath], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    });
    await runner("launchctl", ["enable", `${domain}/${SERVICE_LABEL}`], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    }).catch(() => undefined);
    await runner("launchctl", ["kickstart", "-k", `${domain}/${SERVICE_LABEL}`], {
      timeoutMs: serviceTimeoutMs,
      maxBuffer: DEFAULT_COMMAND_MAX_BUFFER
    });
    return { ...layout, started: true };
  }

  if (layout.platform === "linux") {
    await mkdir(dirname(layout.servicePath), { recursive: true });
    await writeFile(
      layout.servicePath,
      buildSystemdUserService({
        nodePath,
        commandPath: options.commandPath,
        logPath: layout.logPath,
        errorLogPath: layout.errorLogPath,
        env
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
  return {
    gatewayBaseUrl: trimTrailingSlash(gatewayBaseUrl),
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
    invocationSigningSecret:
      optionalText(env.MSWARM_SELF_HOSTED_INVOCATION_SIGNING_SECRET) ||
      optionalText(env.MSWARM_SELF_HOSTED_RELAY_SIGNING_SECRET),
    listenHost: optionalText(env.MSWARM_SELF_HOSTED_LISTEN_HOST) || DEFAULT_LISTEN_HOST,
    listenPort: parsePositiveInteger(env.MSWARM_SELF_HOSTED_LISTEN_PORT, DEFAULT_LISTEN_PORT),
    nodeVersion:
      optionalText(env.MSWARM_SELF_HOSTED_NODE_VERSION) ||
      packageNodeVersion ||
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
    exposeAllModels: parseBoolean(
      env.MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS,
      typeof state.expose_all_models === "boolean" ? state.expose_all_models : false
    ),
    modelAllowlist: parseList(env.MSWARM_SELF_HOSTED_MODEL_ALLOWLIST || state.model_allowlist),
    modelBlocklist: parseList(env.MSWARM_SELF_HOSTED_MODEL_BLOCKLIST || state.model_blocklist)
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
  const packageNodeVersion = await readPackageNodeVersion();
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
    exposeAllModels:
      options["expose-all"] === true || parseBoolean(env.MSWARM_SELF_HOSTED_EXPOSE_ALL_MODELS, false),
    modelAllowlist: allowlist,
    modelBlocklist: blocklist,
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
  if (isMswarmManagedCloudAgent(agent)) {
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
  return {
    name: slug,
    provider: "mcoda",
    adapter,
    source_agent_id: optionalText(agent.id),
    source_agent_slug: slug,
    model_id: defaultModel || slug,
    display_name: slug,
    context_window: optionalNumber(agent.contextWindow, agent.context_window),
    max_output_tokens: optionalNumber(agent.maxOutputTokens, agent.max_output_tokens),
    supports_tools: optionalBoolean(agent.supportsTools, agent.supports_tools) === true,
    supports_vision:
      capabilities.some((capability) => capability.toLowerCase().includes("vision")) ||
      capabilities.some((capability) => capability.toLowerCase().includes("visual")),
    openai_compatible: optionalBoolean(agent.openaiCompatible, agent.openai_compatible) === true,
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
  options: { timeoutMs: number; maxBuffer: number; input?: string }
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${options.timeoutMs}ms: ${command}`));
    }, options.timeoutMs);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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

  async listAgents(
    config: Pick<SelfHostedNodeConfig, "exposeAllModels" | "modelAllowlist" | "modelBlocklist">
  ): Promise<SelfHostedModelInput[]> {
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
    return parseMcodaAgentListOutput(stdout)
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

export class McodaLocalAgentExecutor {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;

  constructor(input: { command?: string; timeoutMs?: number; runner?: CommandRunner }) {
    this.command = input.command || DEFAULT_MCODA_BIN;
    this.timeoutMs = input.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
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
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(input: { gatewayBaseUrl: string; fetchImpl?: FetchLike; timeoutMs?: number }) {
    this.gatewayBaseUrl = trimTrailingSlash(input.gatewayBaseUrl);
    this.fetchImpl = input.fetchImpl || fetch;
    this.timeoutMs = input.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
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
  ): Promise<{ job?: SelfHostedNodeInvocationJob | null }> {
    return fetchJson<{ job?: SelfHostedNodeInvocationJob | null }>(
      this.fetchImpl,
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/jobs/poll`,
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
      `${this.gatewayBaseUrl}/v1/swarm/self-hosted/node/jobs/${encodeURIComponent(jobId)}/result`,
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
  private readonly mcodaExecutor: McodaLocalAgentExecutor;
  private readonly ollama: OllamaClient;

  constructor(
    config: SelfHostedNodeConfig,
    deps?: {
      gateway?: MswarmSelfHostedNodeClient;
      mcoda?: McodaAgentInventoryClient;
      mcodaExecutor?: McodaLocalAgentExecutor;
      ollama?: OllamaClient;
      fetchImpl?: FetchLike;
    }
  ) {
    this.config = config;
    this.gateway =
      deps?.gateway ||
      new MswarmSelfHostedNodeClient({
        gatewayBaseUrl: config.gatewayBaseUrl,
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
    this.mcodaExecutor =
      deps?.mcodaExecutor ||
      new McodaLocalAgentExecutor({
        command: config.mcodaBin,
        timeoutMs: config.requestTimeoutMs
      });
    this.ollama =
      deps?.ollama ||
      new OllamaClient({
        baseUrl: config.ollamaBaseUrl,
        fetchImpl: deps?.fetchImpl,
        timeoutMs: config.requestTimeoutMs
      });
  }

  static async setup(
    setupConfig: SelfHostedOwnerSetupConfig,
    deps?: {
      gateway?: MswarmSelfHostedNodeClient;
      mcoda?: McodaAgentInventoryClient;
      mcodaExecutor?: McodaLocalAgentExecutor;
      ollama?: OllamaClient;
      fetchImpl?: FetchLike;
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
      heartbeat_interval_seconds: setupConfig.heartbeatIntervalSeconds
    });
    const nodeId = optionalText(bootstrap.node?.node_id);
    const runtimeToken = optionalText(bootstrap.runtime_token);
    if (!nodeId || !runtimeToken) {
      throw new Error("Bootstrap response did not include node_id and runtime_token");
    }
    const heartbeatInterval =
      bootstrap.heartbeat_interval_seconds || setupConfig.heartbeatIntervalSeconds;
    const state: SelfHostedNodeState = {
      node_id: nodeId,
      server_name: optionalText(bootstrap.node?.server_name) || setupConfig.serverName,
      relay_mode: bootstrap.node?.relay_mode || setupConfig.relayMode,
      machine_fingerprint: machineFingerprint,
      direct_base_url: setupConfig.directBaseUrl || null,
      runtime_token: undefined,
      config_version: bootstrap.config_version,
      heartbeat_interval_seconds: heartbeatInterval,
      heartbeat_timeout_seconds: bootstrap.heartbeat_timeout_seconds,
      enrolled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      gateway_base_url: setupConfig.gatewayBaseUrl,
      ollama_base_url: setupConfig.ollamaBaseUrl,
      discovery_mode: setupConfig.discoveryMode,
      mcoda_bin: setupConfig.mcodaBin,
      mcoda_list_args: setupConfig.mcodaListArgs,
      node_version: setupConfig.nodeVersion,
      request_timeout_ms: setupConfig.requestTimeoutMs,
      expose_all_models: setupConfig.exposeAllModels,
      model_allowlist: setupConfig.modelAllowlist,
      model_blocklist: setupConfig.modelBlocklist
    };
    await writeSelfHostedNodeState(setupConfig.statePath, state);
    await writeSelfHostedRuntimeToken(setupConfig.runtimeTokenPath, runtimeToken);
    const runtime = new SelfHostedNodeRuntime(
      {
        gatewayBaseUrl: setupConfig.gatewayBaseUrl,
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
        invocationSigningSecret: null,
        listenHost: DEFAULT_LISTEN_HOST,
        listenPort: DEFAULT_LISTEN_PORT,
        nodeVersion: setupConfig.nodeVersion,
        heartbeatIntervalSeconds: heartbeatInterval,
        requestTimeoutMs: setupConfig.requestTimeoutMs,
        exposeAllModels: setupConfig.exposeAllModels,
        modelAllowlist: setupConfig.modelAllowlist,
        modelBlocklist: setupConfig.modelBlocklist
      },
      { ...deps, gateway }
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
    const nextState: SelfHostedNodeState = {
      ...currentState,
      node_id: this.config.nodeId,
      runtime_token: undefined,
      config_version: response.config_version,
      heartbeat_interval_seconds: response.heartbeat_interval_seconds || this.config.heartbeatIntervalSeconds,
      heartbeat_timeout_seconds: response.heartbeat_timeout_seconds,
      enrolled_at: currentState.enrolled_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      gateway_base_url: this.config.gatewayBaseUrl,
      ollama_base_url: this.config.ollamaBaseUrl,
      discovery_mode: this.config.discoveryMode,
      mcoda_bin: this.config.mcodaBin,
      mcoda_list_args: this.config.mcodaListArgs,
      node_version: this.config.nodeVersion,
      request_timeout_ms: this.config.requestTimeoutMs,
      expose_all_models: this.config.exposeAllModels,
      model_allowlist: this.config.modelAllowlist,
      model_blocklist: this.config.modelBlocklist
    };
    await writeSelfHostedNodeState(this.config.statePath, nextState);
    await writeSelfHostedRuntimeToken(this.config.runtimeTokenPath, runtimeToken);
    return { runtimeToken, state: nextState, enrolled: true };
  }

  async executeJob(job: SelfHostedNodeInvocationJob): Promise<SelfHostedNodeInvocationResult> {
    const startedAt = Date.now();
    if (job.node_id !== this.config.nodeId) {
      return {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "failed",
        error: { code: "validation_failed", message: "job node_id does not match this node" }
      };
    }
    if (job.openai_request.stream) {
      return {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "failed",
        error: { code: "validation_failed", message: "streaming relay jobs are not supported by this node yet" }
      };
    }
    try {
      if (job.provider === "ollama") {
        const options: Record<string, unknown> = {};
        if (job.openai_request.temperature !== undefined) options.temperature = job.openai_request.temperature;
        if (job.openai_request.top_p !== undefined) options.top_p = job.openai_request.top_p;
        if (job.openai_request.max_tokens !== undefined) options.num_predict = job.openai_request.max_tokens;
        if (job.openai_request.stop !== undefined) options.stop = job.openai_request.stop;
        const result = await this.ollama.chat({
          model: job.model || job.openai_request.model,
          messages: job.openai_request.messages,
          options
        });
        return {
          job_id: job.job_id,
          request_id: job.request_id,
          status: "success",
          openai_response: buildOpenAIChatCompletion({
            requestId: job.request_id,
            model: job.openai_request.model,
            content: result.content,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            metadata: { provider: "ollama", raw: result.raw }
          }),
          timing: { local_latency_ms: Date.now() - startedAt }
        };
      }
      const agentSlug = optionalText(job.source_agent_slug) || optionalText(job.model) || optionalText(job.agent_slug);
      if (!agentSlug) {
        throw new Error("mcoda source agent slug is required");
      }
      const prompt = messagesToPrompt(job.openai_request.messages);
      if (!prompt) {
        throw new Error("mcoda invocation prompt is empty");
      }
      const response = await this.mcodaExecutor.invoke(agentSlug, prompt);
      const metadata = response.metadata || {};
      const promptTokens = positiveInteger(metadata.tokensPrompt ?? metadata.tokens_prompt);
      const completionTokens = positiveInteger(metadata.tokensCompletion ?? metadata.tokens_completion);
      return {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "success",
        openai_response: buildOpenAIChatCompletion({
          requestId: job.request_id,
          model: job.openai_request.model,
          content: response.output,
          promptTokens,
          completionTokens,
          metadata: {
            provider: "mcoda",
            adapter: response.adapter,
            local_model: response.model,
            mcoda_metadata: metadata
          }
        }),
        timing: { local_latency_ms: Date.now() - startedAt }
      };
    } catch (error) {
      return {
        job_id: job.job_id,
        request_id: job.request_id,
        status: "failed",
        error: {
          code: "upstream_error",
          message: error instanceof Error ? error.message : String(error)
        },
        timing: { local_latency_ms: Date.now() - startedAt }
      };
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
    const heartbeatPayload: Record<string, unknown> = {
      node_id: this.config.nodeId,
      node_version: this.config.nodeVersion,
      config_version: enrollment.state.config_version ?? null,
      status,
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
      capacity: {
        active_jobs: 0,
        queued_jobs: 0
      },
      health: {
        avg_latency_ms: Date.now() - startedAt,
        recent_failure_count: recentFailureCount,
        last_success_at: status === "online" ? new Date().toISOString() : null
      },
      models
    };
    const heartbeatResponse = await this.gateway.heartbeat(enrollment.runtimeToken, heartbeatPayload);
    return {
      enrolled: enrollment.enrolled,
      status,
      model_count: models.length,
      discovery_source: discoverySource,
      mcoda_agent_count: discoverySource === "mcoda" ? models.length : undefined,
      ollama_version: version,
      heartbeat_response: heartbeatResponse
    };
  }

  async pushModelsOnly(): Promise<{ count: number; response: unknown }> {
    const enrollment = await this.ensureEnrolled();
    const discovery = await this.discoverModels();
    const models = discovery.models;
    const response = await this.gateway.pushModels(enrollment.runtimeToken, {
      node_id: this.config.nodeId,
      models
    });
    return { count: models.length, response };
  }

  async pollAndExecuteJob(waitMs = DEFAULT_JOB_POLL_WAIT_MS): Promise<{
    executed: boolean;
    job_id?: string;
    status?: "success" | "failed";
  }> {
    const enrollment = await this.ensureEnrolled();
    const response = await this.gateway.pollJob(enrollment.runtimeToken, {
      node_id: this.config.nodeId,
      capacity: { active_jobs: 0, max_jobs: 1 },
      wait_ms: waitMs
    });
    const job = response.job || null;
    if (!job) {
      return { executed: false };
    }
    const result = await this.executeJob(job);
    await this.gateway.postJobResult(enrollment.runtimeToken, job.job_id, {
      ...result,
      node_id: this.config.nodeId
    });
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
      if (stopped || polling || this.config.relayMode === "direct") return;
      polling = true;
      void this.pollAndExecuteJob()
        .catch(() => undefined)
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
