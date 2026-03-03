import { randomUUID } from "node:crypto";
import path from "node:path";
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
  dagSessionId?: string;
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

export class DocdexClient {
  private repoId?: string;
  private dagSessionId?: string;
  private healthChecked = false;
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

  private resolveBaseUrl(): string {
    const base = this.options.baseUrl.trim();
    return base.endsWith("/") ? base.slice(0, -1) : base;
  }

  private buildHeaders(dagSessionId?: string): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    if (this.repoId) headers["x-docdex-repo-id"] = this.repoId;
    if (this.options.repoRoot) headers["x-docdex-repo-root"] = path.resolve(this.options.repoRoot);
    const resolvedDagSessionId = dagSessionId ?? this.dagSessionId;
    if (resolvedDagSessionId) headers["x-docdex-dag-session"] = resolvedDagSessionId;
    return headers;
  }

  private async ensureHealth(): Promise<void> {
    if (this.healthChecked) return;
    const ok = await this.healthCheck();
    if (!ok) {
      throw new Error("Docdex health check failed");
    }
  }

  async healthCheck(): Promise<boolean> {
    const response = await fetch(`${this.resolveBaseUrl()}/healthz`);
    this.healthChecked = response.ok;
    return response.ok;
  }

  async initialize(rootUri: string): Promise<{ repoId?: string; repoRoot?: string }> {
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/initialize`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ rootUri }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex initialize failed (${response.status}): ${body}`);
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const repoId = (payload.repo_id ?? payload.repoId ?? payload.repo) as string | undefined;
    const repoRoot = (payload.repo_root ?? payload.repoRoot) as string | undefined;
    if (repoId) this.repoId = repoId;
    return { repoId, repoRoot };
  }

  private withRepoId(params: URLSearchParams): void {
    if (this.repoId) params.set("repo_id", this.repoId);
    if (this.options.repoRoot) params.set("repo_root", path.resolve(this.options.repoRoot));
  }

  async search(query: string, options: DocdexSearchOptions = {}): Promise<unknown> {
    await this.ensureHealth();
    const params = new URLSearchParams({ q: query });
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const dagSessionId = options.dagSessionId ?? this.dagSessionId;
    if (dagSessionId) params.set("dag_session_id", dagSessionId);
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/search?${params.toString()}`, {
      headers: this.buildHeaders(dagSessionId),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex search failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async openSnippet(docId: string, options: DocdexSnippetOptions = {}): Promise<unknown> {
    await this.ensureHealth();
    const params = new URLSearchParams();
    if (options.window !== undefined) params.set("window", String(options.window));
    if (options.textOnly) params.set("text_only", "true");
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/snippet/${encodeURIComponent(docId)}?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex snippet failed (${response.status}): ${body}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  async impactGraph(file: string, options: DocdexImpactOptions = {}): Promise<unknown> {
    await this.ensureHealth();
    const params = new URLSearchParams({ file });
    if (options.maxDepth !== undefined) params.set("max_depth", String(options.maxDepth));
    if (options.maxEdges !== undefined) params.set("max_edges", String(options.maxEdges));
    if (options.edgeTypes?.length) params.set("edge_types", options.edgeTypes.join(","));
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/v1/graph/impact?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex impact graph failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async impactDiagnostics(options: DocdexImpactDiagnosticsOptions = {}): Promise<unknown> {
    await this.ensureHealth();
    const params = new URLSearchParams();
    if (options.file) params.set("file", options.file);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/v1/graph/impact/diagnostics?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex impact diagnostics failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async indexRebuild(libsSources?: string): Promise<unknown> {
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/index/rebuild`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(libsSources ? { libs_sources: libsSources } : {}),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex index rebuild failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async indexIngest(file: string): Promise<unknown> {
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/index/ingest`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ file }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex index ingest failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async hooksValidate(files: string[]): Promise<unknown> {
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/hooks/validate`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({ files }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex hooks validate failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async delegate(payload: Record<string, unknown>): Promise<unknown> {
    await this.ensureHealth();
    const response = await fetch(`${this.resolveBaseUrl()}/v1/delegate`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Docdex delegate failed (${response.status}): ${body}`);
    }
    return response.json();
  }

  async dagExport(sessionId: string, options: DocdexDagOptions = {}): Promise<unknown> {
    await this.ensureHealth();
    const params = new URLSearchParams({ session_id: sessionId });
    if (options.format) params.set("format", options.format);
    if (options.maxNodes !== undefined) params.set("max_nodes", String(options.maxNodes));
    this.withRepoId(params);
    const response = await fetch(`${this.resolveBaseUrl()}/v1/dag/export?${params.toString()}`, {
      headers: this.buildHeaders(),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Docdex dag export failed (${response.status}): ${body}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return body;
      }
    }
    return body;
  }

  async callMcp<T>(method: string, params: Record<string, unknown>): Promise<T> {
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
      const body = await response.text();
      throw new Error(`Docdex MCP failed (${response.status}): ${body}`);
    }
    const raw = (await response.json()) as { result?: T; error?: { message?: string } };
    if (raw.error) {
      throw new Error(raw.error.message ?? "Docdex MCP error");
    }
    return this.normalizeMcpResult(raw.result) as T;
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
    );
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
