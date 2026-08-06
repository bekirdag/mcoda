import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ClaudeCliProvider } from "../providers/ClaudeCliProvider.js";
import { CodexCliProvider } from "../providers/CodexCliProvider.js";
import { OllamaRemoteProvider } from "../providers/OllamaRemoteProvider.js";
import { OpenAiCompatibleProvider } from "../providers/OpenAiCompatibleProvider.js";
import type { Provider, ProviderConfig } from "../providers/ProviderTypes.js";
import type { CodaliGatewayAgentAssignment } from "./AgentTierResolver.js";

/**
 * Builds a `Provider` from a resolved mcoda agent so the gateway can run
 * in-process from the CLI, without a round trip through mswarm.
 *
 * mswarm keeps its own cloud path; both should end up sharing this factory so
 * local and cloud behaviour cannot drift.
 */

export interface LocalProviderOptions {
  timeoutMs?: number;
  apiKey?: string;
  /** Scheduling priority; lower runs sooner. Defaults to CODALI_MSWARM_PRIORITY. */
  priority?: number;
  /**
   * Who this run is for, as mswarm knows them — a tenant slug such as `wodo`.
   *
   * mswarm lets a node be reached two ways: the caller owns it, or the caller's
   * identity appears in the node's `client_allowlist`. The second route is how
   * a tenant reaches a node someone else operates, and it is what the
   * self-hosted setup console configures. It requires the caller to say who it
   * is. `DocdexClient` already did; model calls did not, so a tenant could
   * reach an allowlisted repository and never an allowlisted model.
   */
  clientIdentity?: string;
}

/** mswarm accepts several spellings; send the canonical pair. */
const CLIENT_IDENTITY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const clientIdentityHeaders = (
  clientIdentity: string | undefined,
  baseUrl: string | undefined,
): Record<string, string> | undefined => {
  const value = clientIdentity?.trim();
  // Only for mswarm, and only when it is a plausible identity: a stray header
  // on someone's private endpoint is not ours to add.
  if (!value || !isMswarmEndpoint(baseUrl) || !CLIENT_IDENTITY_PATTERN.test(value)) {
    return undefined;
  }
  return { "x-mswarm-client-identity": value, "x-mswarm-client": value };
};

/**
 * Attaches the scheduling priority mswarm reads from `scheduling.priority`,
 * without disturbing any runner settings the agent already carries.
 */
const buildLocalRunner = (
  nested: Record<string, unknown>,
  baseUrl: string | undefined,
  priority: number | undefined,
  clientIdentity: string | undefined,
): ProviderConfig["localRunner"] => {
  const existing = isRecord(nested.localRunner)
    ? (nested.localRunner as Record<string, unknown>)
    : undefined;
  if (!isMswarmEndpoint(baseUrl)) {
    return existing as ProviderConfig["localRunner"];
  }
  const identityHeaders = clientIdentityHeaders(clientIdentity, baseUrl);
  const existingHeaders = isRecord(existing?.headers) ? existing.headers : {};
  const existingExtra = isRecord(existing?.extraBody) ? existing.extraBody : {};
  const existingScheduling = isRecord(existingExtra.scheduling) ? existingExtra.scheduling : {};
  return {
    ...(existing ?? {}),
    // An identity the agent already declares wins; this only fills the gap.
    headers: { ...(identityHeaders ?? {}), ...existingHeaders },
    extraBody: {
      ...existingExtra,
      scheduling: {
        ...existingScheduling,
        // An explicit value in the agent config wins over the default.
        priority: existingScheduling.priority ?? priority ?? CODALI_MSWARM_PRIORITY,
      },
    },
  } as ProviderConfig["localRunner"];
};

/**
 * Request timeout for a locally-hosted model.
 *
 * The providers default to 60s, which suits a hosted API and not a local one:
 * qwen3.6 on the self-hosted node takes ~47s for a one-line prompt, so a full
 * context pack aborted every time and surfaced as "the final model was
 * unavailable" — a timeout wearing the costume of an outage.
 */
const LOCAL_MODEL_TIMEOUT_MS = 600_000;

/**
 * Scheduling priority Codali asks mswarm for.
 *
 * mswarm sorts ascending, so a lower number runs sooner, and its nodes reserve
 * capacity for priority <= -1. Codali runs are interactive — someone is waiting
 * at a terminal or in a chat window — so they should not queue behind batch
 * work. -10 sits comfortably inside the reserved band without claiming the
 * extreme of the -100..100 range, leaving room for anything genuinely more
 * urgent.
 */
export const CODALI_MSWARM_PRIORITY = -10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const readString = (record: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const readBoolean = (
  record: Record<string, unknown>,
  keys: string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
};

/**
 * mcoda adapter -> Codali provider. Adapters not listed fall through to the
 * OpenAI-compatible provider, which is the correct default for local runners
 * (llama.cpp, vLLM, LocalAI) and most hosted endpoints.
 */
export const providerNameForAdapter = (adapter: string | undefined): string => {
  switch ((adapter ?? "").toLowerCase()) {
    case "claude-cli":
      return "claude-cli";
    case "codex-cli":
      return "codex-cli";
    case "ollama-cli":
    case "ollama-remote":
    case "ollama":
      return "ollama";
    default:
      return "openai-compatible";
  }
};

export const createProviderForName = (
  name: string,
  config: ProviderConfig,
): Provider => {
  switch (name) {
    case "claude-cli":
      return new ClaudeCliProvider(config);
    case "codex-cli":
      return new CodexCliProvider(config);
    case "ollama":
      return new OllamaRemoteProvider(config);
    default:
      return new OpenAiCompatibleProvider(config);
  }
};

/**
 * The mswarm API key, used to reach self-hosted agents served through the
 * mswarm gateway. `mcoda agent list --json` reports `auth.configured: true` but
 * never discloses the key itself, so it is read from local trusted config.
 *
 * Local CLI only. A multi-tenant deployment must receive credentials from its
 * host rather than reading the operator's files.
 */
let cachedMswarmKey: string | null | undefined;

export const resolveMswarmApiKey = (): string | undefined => {
  if (cachedMswarmKey !== undefined) return cachedMswarmKey ?? undefined;

  const fromEnv = process.env.MSWARM_API_KEY?.trim();
  if (fromEnv) {
    cachedMswarmKey = fromEnv;
    return fromEnv;
  }

  const configPath = path.join(homedir(), ".docdex", "config.toml");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      // Minimal TOML read: find api_key inside [integrations.mswarm].
      const section = raw.split(/^\[integrations\.mswarm\]\s*$/m)[1];
      const match = section?.match(/^\s*api_key\s*=\s*"([^"]+)"/m);
      if (match?.[1]) {
        cachedMswarmKey = match[1];
        return cachedMswarmKey;
      }
    } catch {
      // Unreadable config is not fatal; the provider will fail with a clearer
      // authentication error than anything we could raise here.
    }
  }

  cachedMswarmKey = null;
  return undefined;
};

/**
 * The key for a self-hosted agent that is not behind the mswarm relay.
 *
 * mcoda stores agent secrets encrypted (`agent_auth.encrypted_secret`) and
 * `agent list --json` reports only whether one is configured, so an agent
 * registered with `authMode: bearer` and a direct base URL arrives here with no
 * key at all. The provider then threw before making any request, which surfaced
 * as a worker failing in 0ms on every call while the run still reported
 * success — the finalizer answered without evidence rather than the run
 * stopping on a configuration error.
 *
 * Codali therefore takes the key from the operator's own environment, matching
 * how the mswarm key is read from local trusted config. The per-agent form wins
 * so several self-hosted models can be used at once.
 */
export const localAgentApiKeyEnvVar = (slug: string): string =>
  `CODALI_AGENT_API_KEY_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

const resolveLocalAgentApiKey = (slug: string | undefined): string | undefined => {
  const perAgent = slug ? process.env[localAgentApiKeyEnvVar(slug)]?.trim() : undefined;
  return perAgent || process.env.CODALI_API_KEY?.trim() || undefined;
};

const isMswarmEndpoint = (baseUrl: string | undefined): boolean =>
  Boolean(baseUrl && /(^|\/\/)([^/]*\.)?mswarm\.org/i.test(baseUrl));

/**
 * Creates a provider for an assigned agent. The raw inventory entry carries the
 * transport details (base URL, runner kind, auth mode) that the tier resolver
 * does not model, so it is read here.
 */
export const createProviderForAssignment = (
  assignment: CodaliGatewayAgentAssignment,
  options: LocalProviderOptions = {},
): Provider => {
  const raw = isRecord(assignment.candidate.raw) ? assignment.candidate.raw : {};
  // mcoda nests transport details under `config`; older entries put them at the
  // top level. Read both, preferring the nested form.
  const nested = isRecord(raw.config) ? raw.config : {};
  const adapter = assignment.candidate.adapter ?? readString(raw, ["adapter"]);
  const providerName = providerNameForAdapter(adapter);

  const baseUrl =
    readString(nested, ["baseUrl", "base_url", "apiBaseUrl", "api_base_url"]) ??
    readString(raw, ["baseUrl", "base_url"]);

  const apiKey =
    options.apiKey ??
    readString(nested, ["apiKey", "api_key"]) ??
    readString(raw, ["apiKey", "api_key"]) ??
    (isMswarmEndpoint(baseUrl)
      ? resolveMswarmApiKey()
      : resolveLocalAgentApiKey(assignment.candidate.slug));

  const config: ProviderConfig = {
    model: assignment.candidate.model ?? readString(raw, ["defaultModel", "model"]) ?? "",
    agentSlug: assignment.candidate.slug,
    baseUrl,
    apiKey,
    timeoutMs: options.timeoutMs ?? LOCAL_MODEL_TIMEOUT_MS,
    runnerKind: readString(nested, ["runnerKind", "runner_kind"]) as ProviderConfig["runnerKind"],
    authMode: readString(nested, ["authMode", "auth_mode"]) as ProviderConfig["authMode"],
    localRunner: buildLocalRunner(nested, baseUrl, options.priority, options.clientIdentity),
    supportsTools: assignment.candidate.supportsTools ?? readBoolean(raw, ["supportsTools"]),
    supportsJsonSchema:
      assignment.candidate.supportsJsonSchema ?? readBoolean(raw, ["supportsJsonSchema"]),
    supportsStreaming:
      assignment.candidate.supportsStreaming ?? readBoolean(raw, ["supportsStreaming"]),
  };

  return createProviderForName(providerName, config);
};

/**
 * Routes each gateway role to its own provider.
 *
 * Codali's whole premise is that a small model does the errands and a large one
 * writes the answer. A single shared provider would silently collapse that: the
 * planner and the synthesizer would run on the same model and the cost/quality
 * split would be lost. So role dispatch is explicit, with a declared fallback
 * rather than an accidental one.
 */
export class RoleRoutingProvider implements Provider {
  readonly name = "codali-role-router";

  constructor(
    private readonly providers: Record<string, Provider>,
    private readonly fallback: Provider,
    private readonly resolveRole: () => string | undefined = () => undefined,
  ) {}

  providerForRole(role: string | undefined): Provider {
    if (!role) return this.fallback;
    return this.providers[role] ?? this.fallback;
  }

  async generate(
    request: Parameters<Provider["generate"]>[0],
  ): ReturnType<Provider["generate"]> {
    return this.providerForRole(this.resolveRole()).generate(request);
  }
}
