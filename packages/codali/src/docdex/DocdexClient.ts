import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  DocdexCapabilityMap,
  DocdexCapabilitySnapshot,
  DocdexCapabilityStatus,
} from "../cognitive/Types.js";

export interface DocdexClientOptions {
  baseUrl: string;
  repoRoot?: string;
  repoId?: string;
  authToken?: string;
  apiKey?: string;
  clientIdentity?: string;
  credentialSource?: "attached_mswarm_api_key" | string;
  required?: boolean;
  allowedOperations?: readonly string[];
  capabilities?: Record<string, boolean | undefined>;
  immutableRuntimeContext?: boolean;
  dagSessionId?: string;
}

export type DocdexRuntimeErrorCode =
  | "missing_credentials"
  | "repo_access_denied"
  | "scope_denied"
  | "encrypted_operation_disabled"
  | "docdex_context_missing"
  | "docdex_api_key_missing"
  | "docdex_operation_not_allowed"
  | "docdex_auth_failed"
  | "docdex_repo_access_denied"
  | "docdex_unavailable";

export type DocdexRuntimeOperation =
  | "health"
  | "initialize"
  | "search"
  | "snippet"
  | "open"
  | "symbols"
  | "ast"
  | "impact_graph"
  | "impact_diagnostics"
  | "dag_export"
  | "tree"
  | "memory_save"
  | "memory_recall"
  | "profile_read"
  | "profile_write"
  | "web_research"
  | "chat_context"
  | "rerank"
  | "batch_search"
  | "capabilities"
  | "stats"
  | "files"
  | "repo_inspect"
  | "index_rebuild"
  | "index_ingest"
  | "delegate"
  | "hooks_validate";

export interface DocdexRuntimeErrorOptions {
  status?: number;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export class DocdexRuntimeError extends Error {
  readonly code: DocdexRuntimeErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: DocdexRuntimeErrorCode,
    message: string,
    options: DocdexRuntimeErrorOptions = {},
  ) {
    super(message);
    this.name = code;
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? code === "docdex_unavailable";
    this.details = options.details;
  }
}

export interface DocdexSearchOptions {
  limit?: number;
  dagSessionId?: string;
}

export interface DocdexSnippetOptions {
  window?: number;
  textOnly?: boolean;
}

export interface DocdexImpactOptions {
  maxDepth?: number;
  maxEdges?: number;
  edgeTypes?: string[];
}

export interface DocdexDagOptions {
  format?: "json" | "text" | "dot";
  maxNodes?: number;
}

export interface DocdexImpactDiagnosticsOptions {
  limit?: number;
  offset?: number;
  file?: string;
}

export interface DocdexTreeOptions {
  path?: string;
  maxDepth?: number;
  dirsOnly?: boolean;
  includeHidden?: boolean;
  extraExcludes?: string[];
}

export interface DocdexOpenFileOptions {
  startLine?: number;
  endLine?: number;
  head?: number;
  clamp?: boolean;
}

export interface DocdexChatMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface DocdexChatContextOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  docdex?: Record<string, unknown>;
}

export interface DocdexWebResearchOptions {
  forceWeb?: boolean;
  skipLocalSearch?: boolean;
  webLimit?: number;
  noCache?: boolean;
}

export interface DocdexWriteMetadata {
  [key: string]: unknown;
}

const CAPABILITY_KEYS = [
  "score_breakdown",
  "rerank",
  "snippet_provenance",
  "retrieval_explanation",
  "batch_search",
] as const;

const DOCDEX_RUNTIME_ERROR_CODES = new Set<DocdexRuntimeErrorCode>([
  "missing_credentials",
  "repo_access_denied",
  "scope_denied",
  "encrypted_operation_disabled",
  "docdex_context_missing",
  "docdex_api_key_missing",
  "docdex_operation_not_allowed",
  "docdex_auth_failed",
  "docdex_repo_access_denied",
  "docdex_unavailable",
]);

const DOCDEX_RUNTIME_OPERATIONS = new Set<DocdexRuntimeOperation>([
  "health",
  "initialize",
  "search",
  "snippet",
  "open",
  "symbols",
  "ast",
  "impact_graph",
  "impact_diagnostics",
  "dag_export",
  "tree",
  "memory_save",
  "memory_recall",
  "profile_read",
  "profile_write",
  "web_research",
  "chat_context",
  "rerank",
  "batch_search",
  "capabilities",
  "stats",
  "files",
  "repo_inspect",
  "index_rebuild",
  "index_ingest",
  "delegate",
  "hooks_validate",
]);

const MCP_OPERATION_BY_METHOD: Record<string, DocdexRuntimeOperation> = {
  docdex_symbols: "symbols",
  docdex_ast: "ast",
  docdex_stats: "stats",
  docdex_files: "files",
  docdex_repo_inspect: "repo_inspect",
  docdex_memory_save: "memory_save",
  docdex_memory_recall: "memory_recall",
  docdex_tree: "tree",
  docdex_open: "open",
  docdex_get_profile: "profile_read",
  docdex_save_preference: "profile_write",
  docdex_web_research: "web_research",
  docdex_rerank: "rerank",
  docdex_batch_search: "batch_search",
  docdex_capabilities: "capabilities",
};

export const isDocdexRuntimeErrorCode = (value: unknown): value is DocdexRuntimeErrorCode => {
  return typeof value === "string" && DOCDEX_RUNTIME_ERROR_CODES.has(value as DocdexRuntimeErrorCode);
};

export const normalizeDocdexRuntimeOperation = (
  value: string,
): DocdexRuntimeOperation | undefined => {
  const normalized = value.trim().replace(/[.-]/g, "_").toLowerCase();
  const aliases: Record<string, DocdexRuntimeOperation> = {
    impact: "impact_graph",
    diagnostics: "impact_diagnostics",
    impact_diagnostics: "impact_diagnostics",
    web: "web_research",
    web_search: "web_research",
    chat: "chat_context",
    chat_completions: "chat_context",
    context_chat: "chat_context",
    open_file: "open",
    snippet_fetch: "snippet",
    profile: "profile_read",
    get_profile: "profile_read",
    save_preference: "profile_write",
    memory: "memory_recall",
    index: "index_rebuild",
    hooks: "hooks_validate",
  };
  const aliased = aliases[normalized];
  if (aliased) return aliased;
  return DOCDEX_RUNTIME_OPERATIONS.has(normalized as DocdexRuntimeOperation)
    ? (normalized as DocdexRuntimeOperation)
    : undefined;
};

const escapeRegExp = (value: string): string => {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

const invalidSearchQueryError = (status: number, body: string): boolean => {
  const normalized = body.toLowerCase();
  return status === 400 && /invalid_query|query parse failed|syntax error/.test(normalized);
};

const sanitizeSearchRetryQuery = (query: string): string | undefined => {
  const original = query.trim();
  if (!original) return undefined;
  const sanitized = original
    .replace(/\b[A-Za-z_][\w.-]{0,63}:\s*/g, " ")
    .replace(/\b(?:AND|OR|NOT)\b/gi, " ")
    .replace(/[()[\]{}^~*?]/g, " ")
    .replace(/["'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized && sanitized !== original ? sanitized : undefined;
};

export class DocdexClient {
  private repoId?: string;
  private dagSessionId?: string;
  private healthChecked = false;
  private repoInitializeAttempted = false;
  private capabilitySnapshot?: DocdexCapabilitySnapshot;

  constructor(private options: DocdexClientOptions) {
    this.repoId = options.repoId;
    this.dagSessionId = options.dagSessionId;
  }

  setRepoId(repoId: string): void {
    this.repoId = repoId;
  }

  getRepoId(): string | undefined {
    return this.repoId;
  }

  getRepoRoot(): string | undefined {
    return this.options.repoRoot;
  }

  setDagSessionId(sessionId: string): void {
    this.dagSessionId = sessionId;
  }

  getDagSessionId(): string | undefined {
    return this.dagSessionId;
  }

  clearCapabilityCache(): void {
    this.capabilitySnapshot = undefined;
  }

  private runtimeAllowedOperations(): Set<DocdexRuntimeOperation> | undefined {
    if (!this.options.allowedOperations?.length) return undefined;
    const operations = this.options.allowedOperations
      .map((entry) => normalizeDocdexRuntimeOperation(entry))
      .filter((entry): entry is DocdexRuntimeOperation => Boolean(entry));
    return operations.length ? new Set(operations) : new Set();
  }

  private runtimeCapability(operation: DocdexRuntimeOperation): boolean | undefined {
    if (!this.options.capabilities) return undefined;
    for (const [key, value] of Object.entries(this.options.capabilities)) {
      const normalized = normalizeDocdexRuntimeOperation(key);
      if (normalized === operation && typeof value === "boolean") {
        return value;
      }
    }
    return undefined;
  }

  private isImmutableRuntimeContext(): boolean {
    return (
      this.options.immutableRuntimeContext === true ||
      this.options.credentialSource === "attached_mswarm_api_key"
    );
  }

  private missingCredentialCode(): DocdexRuntimeErrorCode {
    return this.isImmutableRuntimeContext() ? "missing_credentials" : "docdex_api_key_missing";
  }

  private missingScopeCode(): DocdexRuntimeErrorCode {
    return this.isImmutableRuntimeContext() ? "scope_denied" : "docdex_context_missing";
  }

  private operationDisabledCode(): DocdexRuntimeErrorCode {
    return this.isImmutableRuntimeContext()
      ? "encrypted_operation_disabled"
      : "docdex_operation_not_allowed";
  }

  private redactSensitiveText(text: string): string {
    let output = text;
    for (const secret of [this.options.apiKey, this.options.authToken]) {
      if (typeof secret === "string" && secret.length >= 4) {
        output = output.replace(new RegExp(escapeRegExp(secret), "g"), "[redacted]");
      }
    }
    output = output.replace(
      /("(?:x-api-key|authorization|api[_-]?key|token|secret)"\s*:\s*")[^"]+(")/gi,
      "$1[redacted]$2",
    );
    output = output.replace(
      /((?:x-api-key|authorization|api[_-]?key|token|secret)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;}]+/gi,
      "$1[redacted]",
    );
    return output;
  }

  private runtimeError(
    code: DocdexRuntimeErrorCode,
    message: string,
    options: DocdexRuntimeErrorOptions = {},
  ): DocdexRuntimeError {
    return new DocdexRuntimeError(code, this.redactSensitiveText(message), options);
  }

  private assertRuntimeContext(operation: DocdexRuntimeOperation): void {
    const credentialSource = this.options.credentialSource;
    const requiresAttachedKey = credentialSource === "attached_mswarm_api_key";
    if (requiresAttachedKey && (!this.options.apiKey || this.options.apiKey.trim().length === 0)) {
      throw this.runtimeError(
        this.missingCredentialCode(),
        "Docdex attached mswarm API key is required but was not provided.",
        { retryable: false, details: { operation, credential_source: credentialSource } },
      );
    }
    if ((this.options.required || this.isImmutableRuntimeContext()) && this.resolveBaseUrl().length === 0) {
      throw this.runtimeError(this.missingScopeCode(), "Docdex base_url is required for this job.", {
        retryable: false,
        details: { operation },
      });
    }
    if ((this.options.required || this.isImmutableRuntimeContext()) && requiresAttachedKey && !this.repoId) {
      throw this.runtimeError(this.missingScopeCode(), "Docdex repo_id is required for this job.", {
        retryable: false,
        details: { operation },
      });
    }
    if (this.isImmutableRuntimeContext() && !this.options.allowedOperations?.length) {
      throw this.runtimeError(
        "scope_denied",
        "Docdex allowedOperations are required for immutable encrypted jobs.",
        { retryable: false, details: { operation, missing: "allowedOperations" } },
      );
    }
    if (this.isImmutableRuntimeContext() && !this.options.capabilities) {
      throw this.runtimeError(
        "scope_denied",
        "Docdex capability map is required for immutable encrypted jobs.",
        { retryable: false, details: { operation, missing: "capabilities" } },
      );
    }
  }

  private assertOperationAllowed(operation: DocdexRuntimeOperation): void {
    this.assertRuntimeContext(operation);
    const allowedOperations = this.runtimeAllowedOperations();
    if (allowedOperations && !allowedOperations.has(operation)) {
      throw this.runtimeError(
        this.operationDisabledCode(),
        `Docdex operation is not allowed by this job: ${operation}`,
        { retryable: false, details: { operation } },
      );
    }
    if (this.runtimeCapability(operation) === false) {
      throw this.runtimeError(
        this.operationDisabledCode(),
        `Docdex operation is disabled by this job capability map: ${operation}`,
        { retryable: false, details: { operation } },
      );
    }
  }

  private resolveBaseUrl(): string {
    const base = this.options.baseUrl.trim();
    return base.endsWith("/") ? base.slice(0, -1) : base;
  }

  private buildHeaders(dagSessionId?: string): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.apiKey) {
      headers["x-api-key"] = this.options.apiKey;
    } else if (this.options.authToken) {
      headers.authorization = `Bearer ${this.options.authToken}`;
    }
    if (this.repoId) headers["x-docdex-repo-id"] = this.repoId;
    const clientIdentity = this.options.clientIdentity?.trim();
    if (clientIdentity && /^[A-Za-z0-9._:-]{1,128}$/.test(clientIdentity)) {
      headers["x-mswarm-client-identity"] = clientIdentity;
      headers["x-mswarm-client"] = clientIdentity;
    }
    if (this.options.repoRoot && !this.isImmutableRuntimeContext()) {
      headers["x-docdex-repo-root"] = path.resolve(this.options.repoRoot);
    }
    const resolvedDagSessionId = dagSessionId ?? this.dagSessionId;
    if (resolvedDagSessionId) headers["x-docdex-dag-session"] = resolvedDagSessionId;
    return headers;
  }

  private async ensureHealth(): Promise<void> {
    if (this.healthChecked) return;
    let ok = false;
    try {
      ok = await this.healthCheck();
    } catch (error) {
      if (error instanceof DocdexRuntimeError) throw error;
      throw this.runtimeError(
        "docdex_unavailable",
        `Docdex health check failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
    if (!ok) {
      throw this.runtimeError("docdex_unavailable", "Docdex health check failed", {
        retryable: true,
      });
    }
  }

  async healthCheck(): Promise<boolean> {
    if (this.isImmutableRuntimeContext()) {
      this.assertRuntimeContext("health");
    }
    let response: Response;
    try {
      response = await fetch(`${this.resolveBaseUrl()}/healthz`);
    } catch (error) {
      throw this.runtimeError(
        "docdex_unavailable",
        `Docdex health check failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    }
    this.healthChecked = response.ok;
    return response.ok;
  }

  async initialize(rootUri: string): Promise<{ repoId?: string; repoRoot?: string }> {
    this.assertOperationAllowed("initialize");
    return this.initializeRepo(rootUri);
  }

  private async initializeRepo(rootUri: string): Promise<{ repoId?: string; repoRoot?: string }> {
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/initialize`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ rootUri }),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "initialize");
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const repoId = (payload.repo_id ?? payload.repoId ?? payload.repo) as string | undefined;
    const repoRoot = (payload.repo_root ?? payload.repoRoot) as string | undefined;
    if (repoId) this.repoId = repoId;
    return { repoId, repoRoot };
  }

  private async ensureRepoInitialized(): Promise<void> {
    if (this.isImmutableRuntimeContext()) return;
    if (this.repoId || this.repoInitializeAttempted || !this.options.repoRoot) return;
    this.repoInitializeAttempted = true;
    try {
      await this.initializeRepo(pathToFileURL(path.resolve(this.options.repoRoot)).toString());
    } catch {
      // Keep endpoint-specific calls responsible for reporting the final failure.
      // Single-repo daemons can still accept repo_root without a prior initialize.
    }
  }

  private withRepoId(params: URLSearchParams): void {
    if (this.repoId) params.set("repo_id", this.repoId);
    if (this.options.repoRoot && !this.isImmutableRuntimeContext()) {
      params.set("repo_root", path.resolve(this.options.repoRoot));
    }
  }

  private extractErrorCode(body: string): string | undefined {
    const parsed = this.tryParseJson(body);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as Record<string, unknown>;
    const error = record.error && typeof record.error === "object"
      ? (record.error as Record<string, unknown>)
      : undefined;
    const code = error?.code ?? record.code;
    return typeof code === "string" ? code : undefined;
  }

  private mapResponseErrorCode(status: number, body: string): DocdexRuntimeErrorCode {
    const extracted = this.extractErrorCode(body);
    if (isDocdexRuntimeErrorCode(extracted)) {
      if (this.isImmutableRuntimeContext()) {
        if (extracted === "docdex_api_key_missing" || extracted === "docdex_auth_failed") {
          return "missing_credentials";
        }
        if (extracted === "docdex_repo_access_denied") {
          return "repo_access_denied";
        }
        if (extracted === "docdex_context_missing") {
          return "scope_denied";
        }
        if (extracted === "docdex_operation_not_allowed") {
          return "encrypted_operation_disabled";
        }
      }
      return extracted;
    }
    const normalized = `${extracted ?? ""} ${body}`.toLowerCase();
    if (/introspection_unavailable|unavailable|timeout|timed out|econnrefused|enotfound/.test(normalized)) {
      return "docdex_unavailable";
    }
    if (/repo_access_denied|unknown_repo|repo.*denied|denied.*repo/.test(normalized)) {
      return this.isImmutableRuntimeContext() ? "repo_access_denied" : "docdex_repo_access_denied";
    }
    if (/scope_denied/.test(normalized)) {
      return this.isImmutableRuntimeContext() ? "scope_denied" : "docdex_operation_not_allowed";
    }
    if (/operation_not_allowed|encrypted_operation_disabled|not allowed|forbidden_operation/.test(normalized)) {
      return this.operationDisabledCode();
    }
    if (status === 401 || status === 403 || /invalid_credentials|missing_credentials|ambiguous_credentials/.test(normalized)) {
      return this.isImmutableRuntimeContext() ? "missing_credentials" : "docdex_auth_failed";
    }
    return "docdex_unavailable";
  }

  private responseRequestId(response: Response): string | undefined {
    for (const key of [
      "x-docdex-request-id",
      "x-request-id",
      "x-mswarm-request-id",
      "x-correlation-id",
      "traceparent",
    ]) {
      const value = response.headers.get(key);
      if (value?.trim()) return value.trim();
    }
    return undefined;
  }

  private attachResponseMetadata(
    payload: unknown,
    response: Response,
    operation: string,
  ): unknown {
    const headerRequestId = this.responseRequestId(response);
    if (!headerRequestId || !payload || typeof payload !== "object" || Array.isArray(payload)) {
      return payload;
    }
    const record = payload as Record<string, unknown>;
    const existingMeta =
      record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
        ? record.meta as Record<string, unknown>
        : {};
    const existingRequestId =
      typeof existingMeta.docdex_request_id === "string"
        ? existingMeta.docdex_request_id
        : typeof existingMeta.request_id === "string"
          ? existingMeta.request_id
          : undefined;
    return {
      ...record,
      meta: {
        ...existingMeta,
        docdex_request_id: existingRequestId ?? headerRequestId,
        docdex_operation: operation,
      },
    };
  }

  private async throwResponseError(response: Response, operation: string): Promise<never> {
    const body = await response.text();
    this.throwResponseBodyError(response.status, body, operation, this.responseRequestId(response));
  }

  private throwResponseBodyError(
    status: number,
    body: string,
    operation: string,
    requestId?: string,
  ): never {
    const code = this.mapResponseErrorCode(status, body);
    throw this.runtimeError(
      code,
      `Docdex ${operation} failed (${status}): ${body}`,
      {
        status,
        retryable: code === "docdex_unavailable" && status >= 500,
        details: requestId ? { operation, docdex_request_id: requestId } : { operation },
      },
    );
  }

  async search(query: string, options: DocdexSearchOptions = {}): Promise<unknown> {
    this.assertOperationAllowed("search");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const dagSessionId = options.dagSessionId ?? this.dagSessionId;
    const executeSearch = (searchQuery: string): Promise<Response> => {
      const params = new URLSearchParams({ q: searchQuery });
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (dagSessionId) params.set("dag_session_id", dagSessionId);
      this.withRepoId(params);
      return fetch(`${this.resolveBaseUrl()}/search?${params.toString()}`, {
        headers: this.buildHeaders(dagSessionId),
      });
    };
    const response = await executeSearch(query);
    if (!response.ok) {
      const body = await response.text();
      const retryQuery = invalidSearchQueryError(response.status, body)
        ? sanitizeSearchRetryQuery(query)
        : undefined;
      if (retryQuery) {
        const retryResponse = await executeSearch(retryQuery);
        if (retryResponse.ok) {
          const retryPayload = this.attachResponseMetadata(
            await retryResponse.json(),
            retryResponse,
            "search",
          );
          if (retryPayload && typeof retryPayload === "object" && !Array.isArray(retryPayload)) {
            const payloadRecord = retryPayload as Record<string, unknown>;
            const meta =
              payloadRecord.meta && typeof payloadRecord.meta === "object" && !Array.isArray(payloadRecord.meta)
                ? { ...(payloadRecord.meta as Record<string, unknown>) }
                : {};
            return {
              ...payloadRecord,
              meta: {
                ...meta,
                codali_query_retry: {
                  reason: "invalid_query",
                  original_query: query,
                  retried_query: retryQuery,
                },
              },
            };
          }
          return retryPayload;
        }
        const retryBody = await retryResponse.text();
        this.throwResponseBodyError(
          retryResponse.status,
          retryBody,
          "search",
          this.responseRequestId(retryResponse),
        );
      }
      this.throwResponseBodyError(response.status, body, "search", this.responseRequestId(response));
    }
    return this.attachResponseMetadata(await response.json(), response, "search");
  }

  async openSnippet(docId: string, options: DocdexSnippetOptions = {}): Promise<unknown> {
    this.assertOperationAllowed("snippet");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const params = new URLSearchParams();
    if (options.window !== undefined) params.set("window", String(options.window));
    if (options.textOnly) params.set("text_only", "true");
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/snippet/${encodeURIComponent(docId)}?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "snippet");
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return this.attachResponseMetadata(await response.json(), response, "snippet");
    }
    return response.text();
  }

  async impactGraph(file: string, options: DocdexImpactOptions = {}): Promise<unknown> {
    this.assertOperationAllowed("impact_graph");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const params = new URLSearchParams({ file });
    if (options.maxDepth !== undefined) params.set("max_depth", String(options.maxDepth));
    if (options.maxEdges !== undefined) params.set("max_edges", String(options.maxEdges));
    if (options.edgeTypes?.length) params.set("edge_types", options.edgeTypes.join(","));
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/v1/graph/impact?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "impact graph");
    }
    return this.attachResponseMetadata(await response.json(), response, "impact_graph");
  }

  async impactDiagnostics(options: DocdexImpactDiagnosticsOptions = {}): Promise<unknown> {
    this.assertOperationAllowed("impact_diagnostics");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const params = new URLSearchParams();
    if (options.file) params.set("file", options.file);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/v1/graph/impact/diagnostics?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "impact diagnostics");
    }
    return this.attachResponseMetadata(await response.json(), response, "impact_diagnostics");
  }

  async indexRebuild(libsSources?: string): Promise<unknown> {
    this.assertOperationAllowed("index_rebuild");
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/index/rebuild`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(libsSources ? { libs_sources: libsSources } : {}),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "index rebuild");
    }
    return this.attachResponseMetadata(await response.json(), response, "index_rebuild");
  }

  async indexIngest(file: string): Promise<unknown> {
    this.assertOperationAllowed("index_ingest");
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/index/ingest`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ file }),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "index ingest");
    }
    return this.attachResponseMetadata(await response.json(), response, "index_ingest");
  }

  async hooksValidate(files: string[]): Promise<unknown> {
    this.assertOperationAllowed("hooks_validate");
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/hooks/validate`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ files }),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "hooks validate");
    }
    return this.attachResponseMetadata(await response.json(), response, "hooks_validate");
  }

  async delegate(payload: Record<string, unknown>): Promise<unknown> {
    this.assertOperationAllowed("delegate");
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/delegate`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "delegate");
    }
    return this.attachResponseMetadata(await response.json(), response, "delegate");
  }

  async chatContext(
    messages: DocdexChatMessage[],
    options: DocdexChatContextOptions = {},
  ): Promise<unknown> {
    this.assertOperationAllowed("chat_context");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const body: Record<string, unknown> = {
      messages,
      stream: false,
    };
    if (options.model) body.model = options.model;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.docdex) body.docdex = options.docdex;
    const response = await fetch(`${this.resolveBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(this.dagSessionId),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "chat context");
    }
    return this.attachResponseMetadata(await response.json(), response, "chat_context");
  }

  async dagExport(sessionId: string, options: DocdexDagOptions = {}): Promise<unknown> {
    this.assertOperationAllowed("dag_export");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const params = new URLSearchParams({ session_id: sessionId });
    if (options.format) params.set("format", options.format);
    if (options.maxNodes !== undefined) params.set("max_nodes", String(options.maxNodes));
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/v1/dag/export?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    const body = await response.text();
    if (!response.ok) {
      const code = this.mapResponseErrorCode(response.status, body);
      throw this.runtimeError(
        code,
        `Docdex dag export failed (${response.status}): ${body}`,
        {
          status: response.status,
          retryable: code === "docdex_unavailable" && response.status >= 500,
          details: {
            operation: "dag_export",
            ...(this.responseRequestId(response) ? { docdex_request_id: this.responseRequestId(response) } : {}),
          },
        },
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        return this.attachResponseMetadata(JSON.parse(body) as unknown, response, "dag_export");
      } catch {
        return body;
      }
    }
    return body;
  }

  async callMcp<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const operation = MCP_OPERATION_BY_METHOD[method];
    if (operation) {
      this.assertOperationAllowed(operation);
    }
    await this.ensureHealth();
    const payload = {
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    };
    const response = await fetch(`${this.resolveBaseUrl()}/v1/mcp`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "MCP");
    }
    const raw = (await response.json()) as {
      result?: T;
      error?: { message?: string; code?: unknown; data?: unknown };
    };
    if (raw.error) {
      const body = JSON.stringify(raw.error);
      const code = this.mapResponseErrorCode(500, body);
      throw this.runtimeError(code, raw.error.message ?? "Docdex MCP error", {
        retryable: code === "docdex_unavailable",
        details: { method },
      });
    }
    return this.attachResponseMetadata(
      this.normalizeMcpResult(raw.result),
      response,
      operation ?? method,
    ) as T;
  }

  private normalizeMcpResult(payload: unknown): unknown {
    if (!payload || typeof payload !== "object") return payload;
    const record = payload as {
      structuredContent?: unknown;
      content?: unknown;
      isError?: unknown;
    };

    if (record.structuredContent !== undefined) {
      return record.structuredContent;
    }

    if (!Array.isArray(record.content) || record.content.length === 0) {
      return payload;
    }

    const textChunks = record.content
      .map((entry) => {
        if (!entry || typeof entry !== "object") return undefined;
        const text = (entry as { text?: unknown }).text;
        return typeof text === "string" ? text : undefined;
      })
      .filter((text): text is string => typeof text === "string");

    if (textChunks.length === 0) {
      return payload;
    }

    const joined = textChunks.join("\n").trim();
    if (joined.length === 0) {
      return payload;
    }

    const parsed = this.tryParseJson(joined);
    return parsed ?? joined;
  }

  private tryParseJson(text: string): unknown | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }

  private buildProjectParams(extra: Record<string, unknown>): Record<string, unknown> {
    if (this.isImmutableRuntimeContext()) {
      return { ...extra };
    }
    return {
      project_root: this.options.repoRoot,
      ...extra,
    };
  }

  private defaultCapabilityMap(status: DocdexCapabilityStatus): DocdexCapabilityMap {
    return {
      score_breakdown: status,
      rerank: status,
      snippet_provenance: status,
      retrieval_explanation: status,
      batch_search: status,
    };
  }

  private toCapabilityStatus(value: unknown): DocdexCapabilityStatus {
    if (value === true) return "available";
    if (value === false) return "unavailable";
    if (typeof value === "number") return value > 0 ? "available" : "unavailable";
    if (typeof value !== "string") return "unknown";
    const normalized = value.trim().toLowerCase();
    if (["available", "enabled", "supported", "ok", "true", "yes"].includes(normalized)) {
      return "available";
    }
    if (["unavailable", "disabled", "unsupported", "none", "false", "no"].includes(normalized)) {
      return "unavailable";
    }
    return "unknown";
  }

  private normalizeCapabilityPayload(payload: unknown): DocdexCapabilityMap | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    const source = (
      (record.capabilities && typeof record.capabilities === "object"
        ? record.capabilities
        : undefined) ??
      (record.retrieval && typeof record.retrieval === "object"
        ? record.retrieval
        : undefined) ??
      record
    ) as Record<string, unknown>;
    const scopedSource = (
      source.retrieval && typeof source.retrieval === "object"
        ? source.retrieval
        : source
    ) as Record<string, unknown>;
    const aliases: Record<(typeof CAPABILITY_KEYS)[number], string[]> = {
      score_breakdown: ["score_breakdown", "structured_scoring", "scoring"],
      rerank: ["rerank", "re_rank"],
      snippet_provenance: ["snippet_provenance", "stable_provenance", "provenance"],
      retrieval_explanation: ["retrieval_explanation", "hit_explanations", "explanations", "retrieval_explanations"],
      batch_search: ["batch_search", "batch_retrieval", "batch", "multi_fetch"],
    };
    const result = this.defaultCapabilityMap("unknown");
    let found = false;
    for (const key of CAPABILITY_KEYS) {
      const aliasKeys = aliases[key];
      const raw = aliasKeys.map((alias) => scopedSource[alias]).find((entry) => entry !== undefined);
      if (raw === undefined) continue;
      found = true;
      result[key] = this.toCapabilityStatus(raw);
    }
    return found ? result : undefined;
  }

  symbols(pathValue: string): Promise<unknown> {
    return this.callMcp("docdex_symbols", this.buildProjectParams({ path: pathValue }));
  }

  ast(pathValue: string, maxNodes?: number): Promise<unknown> {
    return this.callMcp("docdex_ast", this.buildProjectParams({ path: pathValue, max_nodes: maxNodes }));
  }

  stats(): Promise<unknown> {
    return this.callMcp("docdex_stats", this.buildProjectParams({}));
  }

  files(limit?: number, offset?: number): Promise<unknown> {
    return this.callMcp("docdex_files", this.buildProjectParams({ limit, offset }));
  }

  repoInspect(): Promise<unknown> {
    return this.callMcp("docdex_repo_inspect", this.buildProjectParams({}));
  }

  memorySave(text: string, metadata?: DocdexWriteMetadata): Promise<unknown> {
    return this.callMcp(
      "docdex_memory_save",
      this.buildProjectParams({ text, metadata }),
    );
  }

  memoryRecall(query: string, topK?: number): Promise<unknown> {
    return this.callMcp("docdex_memory_recall", this.buildProjectParams({ query, top_k: topK }));
  }

  tree(options: DocdexTreeOptions = {}): Promise<unknown> {
    return this.callMcp(
      "docdex_tree",
      this.buildProjectParams({
        path: options.path,
        max_depth: options.maxDepth,
        dirs_only: options.dirsOnly,
        include_hidden: options.includeHidden,
        extra_excludes: options.extraExcludes,
      }),
    );
  }

  openFile(pathValue: string, options: DocdexOpenFileOptions = {}): Promise<unknown> {
    return this.callMcp(
      "docdex_open",
      this.buildProjectParams({
        path: pathValue,
        start_line: options.startLine,
        end_line: options.endLine,
        head: options.head,
        clamp: options.clamp,
      }),
    );
  }

  getProfile(agentId?: string): Promise<unknown> {
    const params: Record<string, unknown> = {};
    if (agentId) params.agent_id = agentId;
    return this.callMcp("docdex_get_profile", params);
  }

  savePreference(
    agentId: string,
    category: string,
    content: string,
    metadata?: DocdexWriteMetadata,
  ): Promise<unknown> {
    return this.callMcp("docdex_save_preference", {
      agent_id: agentId,
      category,
      content,
      metadata,
    });
  }

  webResearch(query: string, options: DocdexWebResearchOptions = {}): Promise<unknown> {
    return this.callMcp(
      "docdex_web_research",
      this.buildProjectParams({
        query,
        force_web: options.forceWeb ?? true,
        skip_local_search: options.skipLocalSearch,
        web_limit: options.webLimit,
        no_cache: options.noCache,
      }),
    ).catch(() => this.webResearchHttp(query, options));
  }

  private async webResearchHttp(query: string, options: DocdexWebResearchOptions = {}): Promise<unknown> {
    this.assertOperationAllowed("web_research");
    await this.ensureHealth();
    await this.ensureRepoInitialized();
    const params = new URLSearchParams({ q: query });
    params.set("force_web", String(options.forceWeb ?? true));
    if (options.skipLocalSearch !== undefined) {
      params.set("skip_local_search", String(options.skipLocalSearch));
    }
    if (options.webLimit !== undefined) {
      params.set("max_web_results", String(options.webLimit));
    }
    if (options.noCache !== undefined) {
      params.set("no_cache", String(options.noCache));
    }
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/search?${params.toString()}`, {
      headers: this.buildHeaders(this.dagSessionId),
    });
    if (!response.ok) {
      await this.throwResponseError(response, "web research");
    }
    return this.attachResponseMetadata(await response.json(), response, "web_research");
  }

  rerank(query: string, candidates: unknown[], limit?: number): Promise<unknown> {
    return this.callMcp(
      "docdex_rerank",
      this.buildProjectParams({
        query,
        candidates,
        limit,
      }),
    );
  }

  batchSearch(
    queries: string[],
    options: { limit?: number; includeLibs?: boolean } = {},
  ): Promise<unknown> {
    return this.callMcp(
      "docdex_batch_search",
      this.buildProjectParams({
        queries,
        limit: options.limit,
        include_libs: options.includeLibs,
      }),
    );
  }

  async getCapabilities(forceRefresh = false): Promise<DocdexCapabilitySnapshot> {
    if (this.capabilitySnapshot && !forceRefresh) {
      return { ...this.capabilitySnapshot, cached: true };
    }
    try {
      const payload = await this.callMcp<unknown>(
        "docdex_capabilities",
        this.buildProjectParams({}),
      );
      const normalizedCapabilities = this.normalizeCapabilityPayload(payload);
      const capabilities = normalizedCapabilities ?? this.defaultCapabilityMap("unknown");
      const warnings = normalizedCapabilities ? undefined : ["probe_missing_capability_fields"];
      const snapshot: DocdexCapabilitySnapshot = {
        cached: false,
        source: "mcp_probe",
        probed_at_ms: Date.now(),
        capabilities,
        warnings,
      };
      this.capabilitySnapshot = snapshot;
      return snapshot;
    } catch (error) {
      const snapshot: DocdexCapabilitySnapshot = {
        cached: false,
        source: "fallback",
        probed_at_ms: Date.now(),
        capabilities: this.defaultCapabilityMap("unavailable"),
        warnings: [
          `probe_failed:${error instanceof Error ? error.message : String(error)}`,
        ],
      };
      this.capabilitySnapshot = snapshot;
      return snapshot;
    }
  }
}
