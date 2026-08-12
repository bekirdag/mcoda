import { ToolExecutionError } from "../../tools/ToolTypes.js";
import { refreshAccessToken } from "../oauth/DeviceCodeAuth.js";
import { truncateToolResult } from "../../tools/TruncateResult.js";
import type { ToolDefinition, ToolInputSchema } from "../../tools/ToolTypes.js";

/**
 * Hand-declared HTTP tools.
 *
 * Deliberately *not* a generic OpenAPI compiler. Importing an arbitrary spec
 * drags in hundreds of irrelevant operations, several authentication styles,
 * inconsistent pagination, enormous nested schemas, and write operations that
 * have no business being reachable — and then the orchestrator has to choose
 * among them. A Jira, CRM, or Graph lookup is three lines of declaration; an
 * offline importer is worth building only once maintaining those declarations
 * across several real connectors proves burdensome.
 *
 * Everything here is read-only by construction: the method allowlist rejects
 * anything that mutates.
 */

export type HttpToolMethod = "GET" | "HEAD";

export interface HttpConnectorAuth {
  type: "bearer" | "basic" | "header" | "none" | "oauth2_refresh";
  /** Resolved value. Never a reference — resolution happens before this point. */
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  /** oauth2_refresh only: exchanges a stored refresh token for an access token. */
  tokenUrl?: string;
  clientId?: string;
  refreshToken?: string;
  scope?: string;
}

/**
 * Access tokens minted from refresh tokens, cached until shortly before expiry.
 *
 * Graph access tokens live about an hour. Without caching every tool call would
 * spend a network round trip on a token it already holds; without the safety
 * margin a call can start valid and arrive expired.
 */
const accessTokenCache = new Map<string, { token: string; expiresAtMs: number }>();
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

export const resetAccessTokenCache = (): void => accessTokenCache.clear();

const oauthAccessToken = async (
  auth: HttpConnectorAuth,
  fetchImpl: typeof fetch,
): Promise<string> => {
  if (!auth.tokenUrl || !auth.clientId || !auth.refreshToken) {
    throw new ToolExecutionError(
      "missing_credentials",
      "oauth2_refresh requires tokenUrl, clientId and refreshToken. Run `codali auth microsoft`.",
      { retryable: false },
    );
  }
  const key = `${auth.tokenUrl}|${auth.clientId}|${auth.refreshToken.slice(-16)}`;
  const cached = accessTokenCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.token;
  }
  try {
    const tokens = await refreshAccessToken(
      { tokenUrl: auth.tokenUrl, clientId: auth.clientId, scope: auth.scope ?? "" },
      auth.refreshToken,
      fetchImpl,
    );
    accessTokenCache.set(key, {
      token: tokens.accessToken,
      expiresAtMs: Date.now() + tokens.expiresInSeconds * 1000 - TOKEN_EXPIRY_MARGIN_MS,
    });
    return tokens.accessToken;
  } catch (error) {
    throw new ToolExecutionError(
      "missing_credentials",
      `Could not refresh the access token: ${
        error instanceof Error ? error.message : String(error)
      }. Re-run \`codali auth microsoft\`.`,
      { retryable: false },
    );
  }
};

export interface HttpToolDeclaration {
  id: string;
  description: string;
  method: HttpToolMethod;
  /** e.g. `/rest/api/3/issue/{issueKey}` — `{name}` is substituted from args. */
  urlTemplate: string;
  inputSchema?: ToolInputSchema;
  /**
   * Dotted path into the response, e.g. `issues[].fields.summary`. Applied
   * before the result reaches a model, because a raw API payload routinely
   * exceeds an entire evidence budget.
   */
  responseSelector?: string;
  /** Cap on serialized response characters. */
  maxResponseChars?: number;
}

export interface HttpConnectorDefinition {
  name: string;
  baseUrl: string;
  auth?: HttpConnectorAuth;
  headers?: Record<string, string>;
  timeoutMs?: number;
  tools: HttpToolDeclaration[];
  enabled?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_CHARS = 12_000;

/**
 * Only non-mutating verbs. A connector cannot opt into POST here — write access
 * is a separate decision with its own approval story, not a config flag.
 */
const ALLOWED_METHODS = new Set<HttpToolMethod>(["GET", "HEAD"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Substitutes `{name}` placeholders and appends anything left over as query
 * parameters. Placeholder values are URL-encoded, so a model cannot inject a
 * path segment or escape the connector's base URL.
 */
export const buildHttpUrl = (
  baseUrl: string,
  template: string,
  args: Record<string, unknown>,
): string => {
  const consumed = new Set<string>();
  const path = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = args[key];
    if (value === undefined || value === null) {
      throw new ToolExecutionError(
        "tool_invalid_args",
        `Missing required path parameter "${key}".`,
        { retryable: false, details: { parameter: key } },
      );
    }
    consumed.add(key);
    return encodeURIComponent(String(value));
  });

  const url = new URL(path.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  for (const [key, value] of Object.entries(args)) {
    if (consumed.has(key) || value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
};

/**
 * Projects a response down to what was asked for. `items[].name` maps over an
 * array; a plain dotted path drills in.
 */
export const applyResponseSelector = (payload: unknown, selector?: string): unknown => {
  if (!selector) return payload;
  let current: unknown = payload;
  for (const segment of selector.split(".")) {
    if (current === undefined || current === null) return undefined;
    const arrayMatch = segment.match(/^(\w+)\[\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1] as string;
      const value = isRecord(current) ? current[key] : undefined;
      if (!Array.isArray(value)) return undefined;
      current = value;
      continue;
    }
    if (Array.isArray(current)) {
      current = current.map((entry) => (isRecord(entry) ? entry[segment] : undefined));
      continue;
    }
    current = isRecord(current) ? current[segment] : undefined;
  }
  return current;
};

const buildAuthHeaders = (auth: HttpConnectorAuth | undefined): Record<string, string> => {
  if (!auth || auth.type === "none") return {};
  if (auth.type === "bearer" && auth.token) {
    return { Authorization: `Bearer ${auth.token}` };
  }
  if (auth.type === "basic" && auth.username) {
    const encoded = Buffer.from(`${auth.username}:${auth.password ?? ""}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  if (auth.type === "header" && auth.headerName && auth.token) {
    return { [auth.headerName]: auth.token };
  }
  return {};
};

const truncate = (value: string, limit: number): string =>
  value.length > limit
    ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]`
    : value;

export interface HttpToolFactoryOptions {
  connector: HttpConnectorDefinition;
  fetchImpl?: typeof fetch;
}

export const httpToolName = (connector: string, tool: string): string =>
  `http:${connector}:${tool}`;

export const httpToolToDefinition = (
  declaration: HttpToolDeclaration,
  options: HttpToolFactoryOptions,
): ToolDefinition => {
  const { connector } = options;
  if (!ALLOWED_METHODS.has(declaration.method)) {
    throw new Error(
      `HTTP tool ${declaration.id} declares method ${declaration.method}; only GET and HEAD are permitted.`,
    );
  }

  const qualified = httpToolName(connector.name, declaration.id);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = connector.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = declaration.maxResponseChars ?? DEFAULT_MAX_RESPONSE_CHARS;

  return {
    name: qualified,
    description: declaration.description,
    // A tool declared without a schema used to arrive as `properties: {}`,
    // which a model reads as "this takes no arguments" — and then declines to
    // call it rather than calling with none. Observed verbatim: "the tool does
    // not accept parameters for specifying a time range", against a connector
    // that would have accepted any query string. An under-declared tool does
    // not fail loudly; it produces a worker that talks itself out of the call.
    // Saying so in the description costs nothing and removes the false
    // conclusion.
    inputSchema: declaration.inputSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    ...(declaration.inputSchema
      ? {}
      : {
          description:
            `${declaration.description} ` +
            "Takes no declared parameters; any query parameters you pass are forwarded as-is, " +
            "and calling it with no arguments is valid.",
        }),
    // GET/HEAD only, enforced above.
    readOnly: true,
    capability: connector.name,
    handler: async (args) => {
      const record = isRecord(args) ? args : {};
      const url = buildHttpUrl(connector.baseUrl, declaration.urlTemplate, record);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // OAuth needs an await, so it is resolved before the request is built.
      const authHeaders =
        connector.auth?.type === "oauth2_refresh"
          ? { Authorization: `Bearer ${await oauthAccessToken(connector.auth, fetchImpl)}` }
          : buildAuthHeaders(connector.auth);

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: declaration.method,
          headers: {
            Accept: "application/json",
            ...(connector.headers ?? {}),
            ...authHeaders,
          },
          signal: controller.signal,
        });
      } catch (error) {
        throw new ToolExecutionError(
          "tool_execution_failed",
          `${qualified} request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { retryable: true, details: { tool: qualified } },
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The status is what a model needs to decide whether to try something
        // else; the body may carry a credential, so it is not forwarded.
        throw new ToolExecutionError(
          response.status === 401 || response.status === 403
            ? "tool_permission_denied"
            : "tool_execution_failed",
          `${qualified} returned HTTP ${response.status}.`,
          {
            retryable: response.status >= 500 || response.status === 429,
            details: { tool: qualified, status: response.status },
          },
        );
      }

      const text = await response.text();
      let payload: unknown = text;
      try {
        payload = JSON.parse(text);
      } catch {
        // Not JSON; the raw text is the payload.
      }

      const selected = applyResponseSelector(payload, declaration.responseSelector);
      const serialized =
        typeof selected === "string" ? selected : JSON.stringify(selected, null, 2);

      const trimmed = truncateToolResult(selected, serialized ?? "", maxChars);
      return {
        output: trimmed.text || "(empty response)",
        data: selected,
      };
    },
  };
};

export const httpConnectorToDefinitions = (
  options: HttpToolFactoryOptions,
): ToolDefinition[] =>
  options.connector.enabled === false
    ? []
    : options.connector.tools.map((declaration) =>
        httpToolToDefinition(declaration, options));
