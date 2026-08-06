import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { McpServerDefinition } from "../connectors/mcp/McpClient.js";
import type { HttpConnectorDefinition } from "../connectors/http/HttpToolDefinition.js";
import { resolveCredential } from "./CredentialFile.js";

/**
 * The one seam through which Codali learns what a request is allowed to touch.
 *
 * Codali is meant to serve many products, and a multi-tenant product like
 * okacam has a different tool set, different credentials, and different limits
 * for every tenant. So the tool configuration is never read from a file at run
 * time — it is *resolved* per request.
 *
 * A config file is simply one implementation of this interface, used by the
 * local CLI and single-tenant deployments. An embedded product implements its
 * own, or passes a `RunContext` directly on the request; either way the host
 * supplies the context, and Codali never calls back into the product to fetch
 * it. That callback would create a circular dependency
 * (product -> codali -> product) plus the caching, invalidation, and
 * failure-mode machinery that comes with it, and the authenticated host already
 * holds this data.
 */

export interface RunContextRepo {
  root?: string;
  repoId?: string;
}

export interface RunContextDocdex {
  baseUrl?: string;
  apiKey?: string;
  repoRoot?: string;
  repoId?: string;
  allowedOperations?: string[];
}

export interface RunContextTenant {
  id?: string;
  slug?: string;
  realm?: string;
  /**
   * The product this tenant belongs to, sent to mswarm alongside the per-tenant
   * identity so a self-hosted node can grant every tenant of a product at once.
   * Hosts that set `MSWARM_CLIENT_PRODUCT` in their deployment can leave this unset.
   */
  product?: string;
}

export interface RunContextLimits {
  maxRounds?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
  deadlineMs?: number;
}

export interface RunContextAgentRoles {
  /** Routes, plans, assesses completeness, repairs. Runs on every question. */
  orchestrator?: string;
  /** Makes the tool calls. Defaults to the orchestrator when unset. */
  worker?: string;
  /** Produces multi-source answers. */
  synthesizer?: string;
  /** Generates images and other media. */
  media?: string;
}

export interface RunContext {
  tenant?: RunContextTenant;
  repo?: RunContextRepo;
  docdex?: RunContextDocdex;
  agentRoles?: RunContextAgentRoles;
  limits?: RunContextLimits;
  /**
   * MCP servers this run may connect to.
   *
   * Only ever populated from user/host config or a host-supplied context —
   * never from repository config. See {@link scrubRepoConfig}.
   */
  mcpServers?: McpServerDefinition[];
  /**
   * Hand-declared HTTP connectors. Same trust rules as MCP servers: trusted
   * layers only, never repository config.
   */
  httpConnectors?: HttpConnectorDefinition[];
  /** Tool names permitted for this run. Absent means "registry default". */
  allowedTools?: string[];
  deniedTools?: string[];
  /** Non-fatal problems encountered while resolving, surfaced in the trace. */
  warnings?: string[];
}

export interface RunContextResolveInput {
  workspaceRoot: string;
  tenant?: RunContextTenant;
  /** Context supplied directly by an embedding host, taking precedence. */
  provided?: RunContext;
}

export interface RunContextResolver {
  readonly id: string;
  resolve(input: RunContextResolveInput): Promise<RunContext>;
}

/**
 * Keys a repository-level config file is forbidden to set.
 *
 * A checked-out repository is untrusted input. If `.codali/config.toml` could
 * define an MCP server command, a base URL, or a credential reference, then
 * cloning a repository and running `codali ask` inside it would be enough to
 * execute an arbitrary binary or redirect traffic to an attacker's endpoint.
 *
 * The boundary is therefore: user/host config may define what runs and where
 * it connects; repository config may only *narrow* what is already permitted,
 * identify the repository, and set harmless presentation defaults.
 */
const REPO_FORBIDDEN_KEYS = new Set([
  "command",
  "args",
  "env",
  "url",
  "base_url",
  "baseurl",
  "api_key",
  "apikey",
  "token",
  "secret",
  "credential",
  "credentials",
  "password",
  "headers",
  // Every reader below accepts both snake_case and camelCase, so both spellings
  // must be forbidden. Listing only one is a hole, not a style preference.
  "mcp_servers",
  "mcpservers",
  "api_connectors",
  "apiconnectors",
  "http_connectors",
  "httpconnectors",
  "agents",
  "agent_roles",
  "agentroles",
  "docdex",
]);

export interface RepoConfigScrubResult {
  value: Record<string, unknown>;
  rejectedKeys: string[];
}

/**
 * Strips forbidden keys from a repository config, recording what was dropped.
 * Rejection is loud rather than silent: the keys land in run warnings so a
 * repository that tries to widen its own permissions is visible.
 */
export const scrubRepoConfig = (
  config: Record<string, unknown>,
  pathPrefix = "",
): RepoConfigScrubResult => {
  const value: Record<string, unknown> = {};
  const rejectedKeys: string[] = [];

  for (const [key, entry] of Object.entries(config)) {
    const qualified = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (REPO_FORBIDDEN_KEYS.has(key.toLowerCase())) {
      rejectedKeys.push(qualified);
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = scrubRepoConfig(entry as Record<string, unknown>, qualified);
      value[key] = nested.value;
      rejectedKeys.push(...nested.rejectedKeys);
      continue;
    }
    value[key] = entry;
  }

  return { value, rejectedKeys };
};

const readJsonFile = async (
  filePath: string,
): Promise<Record<string, unknown> | undefined> => {
  if (!existsSync(filePath)) return undefined;
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const asStringArray = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readAgentRoles = (value: unknown): RunContextAgentRoles | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const roles: RunContextAgentRoles = {
    orchestrator: asString(record.orchestrator),
    worker: asString(record.worker),
    synthesizer: asString(record.synthesizer),
    media: asString(record.media),
  };
  return Object.values(roles).some(Boolean) ? roles : undefined;
};

const readLimits = (value: unknown): RunContextLimits | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const limits: RunContextLimits = {
    maxRounds: asNumber(record.maxRounds ?? record.max_rounds),
    maxToolCalls: asNumber(record.maxToolCalls ?? record.max_tool_calls),
    maxModelCalls: asNumber(record.maxModelCalls ?? record.max_model_calls),
    deadlineMs: asNumber(record.deadlineMs ?? record.deadline_ms),
  };
  return Object.values(limits).some((entry) => entry !== undefined) ? limits : undefined;
};

/**
 * Reads MCP server definitions from a *trusted* config layer. Never called on
 * repository config: `scrubRepoConfig` removes the keys first.
 */
const readMcpServers = (value: unknown): McpServerDefinition[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const servers: McpServerDefinition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = asString(record.name);
    if (!name) continue;

    const transport = asString(record.transport) ?? (record.command ? "stdio" : "http");
    const common = {
      name,
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
      readOnly: record.readOnly === true || record.read_only === true,
      timeoutMs: asNumber(record.timeoutMs ?? record.timeout_ms),
      allowTools: asStringArray(record.allowTools ?? record.allow_tools),
      denyTools: asStringArray(record.denyTools ?? record.deny_tools),
    };

    if (transport === "stdio") {
      const command = asString(record.command);
      if (!command) continue;
      servers.push({
        ...common,
        transport: "stdio",
        command,
        args: asStringArray(record.args),
        cwd: asString(record.cwd),
        env: resolveEnvRefs(record.env),
      });
      continue;
    }

    const url = asString(record.url);
    if (!url) continue;
    servers.push({
      ...common,
      transport: "http",
      url,
      headers: resolveEnvRefs(record.headers),
    });
  }
  return servers.length > 0 ? servers : undefined;
};

/**
 * Reads HTTP connector declarations from a *trusted* config layer. Credentials
 * are resolved through the same `env:` indirection as MCP servers, so a config
 * file never has to hold a literal secret.
 */
const readHttpConnectors = (value: unknown): HttpConnectorDefinition[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const connectors: HttpConnectorDefinition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = asString(record.name);
    // Base URLs resolve `env:` references too. A site hostname is not secret,
    // but keeping every connector detail in one credentials file beats
    // splitting it across two places for no reason.
    const baseUrl = resolveEnvRef(record.baseUrl ?? record.base_url);
    if (!name || !baseUrl || !Array.isArray(record.tools)) continue;

    const tools = record.tools
      .filter((tool): tool is Record<string, unknown> =>
        Boolean(tool && typeof tool === "object"))
      .map((tool) => ({
        id: asString(tool.id) ?? "",
        description: asString(tool.description) ?? "",
        method: (asString(tool.method) ?? "GET").toUpperCase() as "GET" | "HEAD",
        urlTemplate: asString(tool.urlTemplate ?? tool.url_template) ?? "",
        inputSchema: tool.inputSchema as HttpConnectorDefinition["tools"][number]["inputSchema"],
        responseSelector: asString(tool.responseSelector ?? tool.response_selector),
        maxResponseChars: asNumber(tool.maxResponseChars ?? tool.max_response_chars),
      }))
      .filter((tool) => tool.id && tool.urlTemplate);

    if (tools.length === 0) continue;

    const authRecord = record.auth && typeof record.auth === "object"
      ? (record.auth as Record<string, unknown>)
      : undefined;

    connectors.push({
      name,
      baseUrl,
      enabled: typeof record.enabled === "boolean" ? record.enabled : undefined,
      timeoutMs: asNumber(record.timeoutMs ?? record.timeout_ms),
      headers: resolveEnvRefs(record.headers),
      tools,
      auth: authRecord
        ? {
            type: (asString(authRecord.type) ?? "none") as HttpConnectorDefinition["auth"] extends
              infer A ? A extends { type: infer T } ? T : never : never,
            token: resolveEnvRef(authRecord.token),
            username: resolveEnvRef(authRecord.username),
            password: resolveEnvRef(authRecord.password),
            headerName: asString(authRecord.headerName ?? authRecord.header_name),
            tokenUrl: resolveEnvRef(authRecord.tokenUrl ?? authRecord.token_url),
            clientId: resolveEnvRef(authRecord.clientId ?? authRecord.client_id),
            refreshToken: resolveEnvRef(authRecord.refreshToken ?? authRecord.refresh_token),
            scope: asString(authRecord.scope),
          }
        : undefined,
    });
  }
  return connectors.length > 0 ? connectors : undefined;
};

/**
 * Substitutes `env:NAME` references, including when embedded in a larger
 * string. Header values are the common case — `"Bearer env:GITHUB_TOKEN"` is
 * what anyone would write, and requiring the reference to sit at the start of
 * the value would silently transmit the literal text as a credential.
 *
 * An unresolvable reference yields `undefined` for the whole value rather than
 * a half-substituted string: sending `Bearer env:GITHUB_TOKEN` to an API is
 * worse than sending nothing, because the failure looks like a bad token
 * instead of a missing one.
 */
const ENV_REF_PATTERN = /env:([A-Za-z_][A-Za-z0-9_]*)/g;

const substituteEnvRefs = (value: string): string | undefined => {
  if (!value.includes("env:")) return value;
  let missing = false;
  const output = value.replace(ENV_REF_PATTERN, (_match, name: string) => {
    const resolved = resolveCredential(name);
    if (resolved === undefined) {
      missing = true;
      return "";
    }
    return resolved;
  });
  return missing ? undefined : output;
};

const resolveEnvRef = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  return substituteEnvRefs(value);
};

/**
 * Resolves `env:NAME` references so a config file never has to contain a
 * literal secret. Local-CLI convenience only: an embedded multi-tenant host
 * supplies credentials directly and must not be able to name host env vars.
 */
const resolveEnvRefs = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") continue;
    // Resolved from the process environment first, then ~/.codali/.creds.
    const resolved = substituteEnvRefs(entry);
    if (resolved !== undefined) output[key] = resolved;
  }
  return Object.keys(output).length > 0 ? output : undefined;
};

const contextFromConfig = (config: Record<string, unknown>): RunContext => ({
  agentRoles: readAgentRoles(config.agents ?? config.agent_roles),
  mcpServers: readMcpServers(config.mcpServers ?? config.mcp_servers),
  httpConnectors: readHttpConnectors(config.httpConnectors ?? config.http_connectors),
  limits: readLimits(config.limits),
  allowedTools: asStringArray(config.allowedTools ?? config.allowed_tools),
  deniedTools: asStringArray(config.deniedTools ?? config.denied_tools),
  docdex: (() => {
    const raw = config.docdex;
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    return {
      baseUrl: asString(record.baseUrl ?? record.base_url),
      apiKey: asString(record.apiKey ?? record.api_key),
      repoRoot: asString(record.repoRoot ?? record.repo_root),
      repoId: asString(record.repoId ?? record.repo_id),
      allowedOperations: asStringArray(
        record.allowedOperations ?? record.allowed_operations,
      ),
    };
  })(),
});

/**
 * Merges a narrower context over a broader one. Allow-lists intersect and
 * deny-lists union, so a later layer can only ever restrict what an earlier one
 * permitted — never widen it.
 */
export const mergeRunContexts = (base: RunContext, override: RunContext): RunContext => {
  const allowedTools = base.allowedTools && override.allowedTools
    ? base.allowedTools.filter((tool) => override.allowedTools?.includes(tool))
    : (override.allowedTools ?? base.allowedTools);

  const deniedTools = [
    ...new Set([...(base.deniedTools ?? []), ...(override.deniedTools ?? [])]),
  ];

  const minDefined = (a?: number, b?: number): number | undefined => {
    if (a === undefined) return b;
    if (b === undefined) return a;
    return Math.min(a, b);
  };

  return {
    tenant: override.tenant ?? base.tenant,
    repo: { ...base.repo, ...override.repo },
    // Servers come from a trusted layer only; a narrower layer cannot add one.
    mcpServers: override.mcpServers ?? base.mcpServers,
    httpConnectors: override.httpConnectors ?? base.httpConnectors,
    docdex: { ...base.docdex, ...override.docdex },
    agentRoles: { ...base.agentRoles, ...override.agentRoles },
    limits: {
      maxRounds: minDefined(base.limits?.maxRounds, override.limits?.maxRounds),
      maxToolCalls: minDefined(base.limits?.maxToolCalls, override.limits?.maxToolCalls),
      maxModelCalls: minDefined(base.limits?.maxModelCalls, override.limits?.maxModelCalls),
      deadlineMs: minDefined(base.limits?.deadlineMs, override.limits?.deadlineMs),
    },
    allowedTools,
    deniedTools: deniedTools.length > 0 ? deniedTools : undefined,
    warnings: [...(base.warnings ?? []), ...(override.warnings ?? [])],
  };
};

export interface LocalConfigResolverOptions {
  /** Overridden in tests; defaults to `~/.codali`. */
  userConfigDir?: string;
}

/**
 * Resolves run context from trusted user config, then applies the repository's
 * narrowing config on top. Used by the CLI and any single-tenant deployment.
 */
export class LocalConfigRunContextResolver implements RunContextResolver {
  readonly id = "local_config";

  constructor(private readonly options: LocalConfigResolverOptions = {}) {}

  async resolve(input: RunContextResolveInput): Promise<RunContext> {
    const warnings: string[] = [];

    const userDir = this.options.userConfigDir ?? path.join(homedir(), ".codali");
    const userConfig = await readJsonFile(path.join(userDir, "config.json"));
    const base: RunContext = userConfig ? contextFromConfig(userConfig) : {};

    const repoConfigRaw = await readJsonFile(
      path.join(input.workspaceRoot, ".codali", "config.json"),
    );
    let repoContext: RunContext = {};
    if (repoConfigRaw) {
      const scrubbed = scrubRepoConfig(repoConfigRaw);
      if (scrubbed.rejectedKeys.length > 0) {
        warnings.push(
          `repo_config_keys_rejected:${scrubbed.rejectedKeys.join(",")}`,
        );
      }
      repoContext = contextFromConfig(scrubbed.value);
    }

    const merged = mergeRunContexts(base, repoContext);

    return {
      ...merged,
      tenant: input.tenant ?? merged.tenant,
      repo: { root: input.workspaceRoot, ...merged.repo },
      warnings: [...(merged.warnings ?? []), ...warnings],
    };
  }
}

/**
 * Uses context handed over by an embedding host. This is the okacam path: the
 * product resolves the tenant's tools and credentials from its own database and
 * passes them on the request.
 */
export class ProvidedRunContextResolver implements RunContextResolver {
  readonly id = "provided";

  async resolve(input: RunContextResolveInput): Promise<RunContext> {
    if (!input.provided) {
      throw new Error(
        "ProvidedRunContextResolver requires a RunContext on the request.",
      );
    }
    return {
      ...input.provided,
      repo: { root: input.workspaceRoot, ...input.provided.repo },
      tenant: input.tenant ?? input.provided.tenant,
    };
  }
}

export const resolveRunContext = async (
  input: RunContextResolveInput,
  resolver?: RunContextResolver,
): Promise<RunContext> => {
  const active =
    resolver ??
    (input.provided ? new ProvidedRunContextResolver() : new LocalConfigRunContextResolver());
  return active.resolve(input);
};
