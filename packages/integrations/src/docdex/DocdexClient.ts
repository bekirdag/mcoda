import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { resolveDocdexBaseUrl, runDocdex } from "./DocdexRuntime.js";

export interface DocdexSegment {
  id: string;
  docId: string;
  index: number;
  content: string;
  heading?: string;
}

export interface DocdexDocument {
  id: string;
  docType: string;
  path?: string;
  title?: string;
  content?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  segments?: DocdexSegment[];
}

export interface RegisterDocumentInput {
  docType: string;
  path?: string;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const nowIso = (): string => new Date().toISOString();

const segmentize = (docId: string, content: string): DocdexSegment[] => {
  const lines = content.split(/\r?\n/);
  const segments: DocdexSegment[] = [];
  let buffer: string[] = [];
  let heading = "";
  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({
      id: `${docId}-seg-${segments.length + 1}`,
      docId,
      index: segments.length,
      content: buffer.join("\n").trim(),
      heading: heading || undefined,
    });
    buffer = [];
    heading = "";
  };
  for (const line of lines) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
    }
    buffer.push(line);
    if (buffer.join("").length > 1500) {
      flush();
    }
  }
  flush();
  return segments;
};

const inferDocType = (docPath?: string, fallback = "DOC"): string => {
  if (!docPath) return fallback;
  const name = path.basename(docPath).toLowerCase();
  if (name.includes("openapi") || name.includes("swagger")) return "OPENAPI";
  if (name.includes("sds")) return "SDS";
  if (name.includes("pdr")) return "PDR";
  if (name.includes("rfp")) return "RFP";
  return fallback;
};

const normalizeBaseUrl = (value: string): string => {
  if (!value) return value;
  return value.endsWith("/") ? value.slice(0, -1) : value;
};

export class DocdexClient {
  private resolvedBaseUrl?: string;
  private repoId?: string;
  private initializing = false;
  private disabledReason?: string;

  constructor(
    private options: {
      workspaceRoot?: string;
      baseUrl?: string;
      authToken?: string;
      repoId?: string;
    } = {},
  ) {
    this.repoId = options.repoId;
  }

  disable(reason?: string): void {
    this.disabledReason = reason?.trim() || "docdex unavailable";
  }

  isAvailable(): boolean {
    return !this.disabledReason;
  }

  private normalizePath(inputPath?: string): string | undefined {
    if (!inputPath) return undefined;
    const absolute = path.resolve(inputPath);
    if (this.options.workspaceRoot) {
      const root = path.resolve(this.options.workspaceRoot);
      if (absolute.startsWith(root)) {
        return path.relative(root, absolute);
      }
    }
    return absolute;
  }

  private resolveLocalDocPath(docPath: string): { absolute: string; relative?: string } | undefined {
    if (!this.options.workspaceRoot) return undefined;
    const root = path.resolve(this.options.workspaceRoot);
    const absolute = path.resolve(path.isAbsolute(docPath) ? docPath : path.join(root, docPath));
    if (!absolute.startsWith(root)) return undefined;
    const relative = path.relative(root, absolute);
    return { absolute, relative: relative || undefined };
  }

  private async loadLocalDoc(docPath: string, docType?: string): Promise<DocdexDocument | undefined> {
    const resolved = this.resolveLocalDocPath(docPath);
    if (!resolved) return undefined;
    try {
      const content = await fs.readFile(resolved.absolute, "utf8");
      const inferred = docType || inferDocType(resolved.relative ?? docPath);
      return this.buildLocalDoc(inferred, resolved.relative ?? docPath, content);
    } catch {
      return undefined;
    }
  }

  private async resolveBaseUrl(): Promise<string | undefined> {
    if (this.disabledReason) return undefined;
    if (this.options.baseUrl !== undefined) {
      const trimmed = this.options.baseUrl.trim();
      return trimmed ? normalizeBaseUrl(trimmed) : undefined;
    }
    if (this.resolvedBaseUrl !== undefined) return this.resolvedBaseUrl;
    const resolved = await resolveDocdexBaseUrl({ cwd: this.options.workspaceRoot });
    this.resolvedBaseUrl = resolved ? normalizeBaseUrl(resolved) : undefined;
    return this.resolvedBaseUrl;
  }

  private buildMissingRepoMessage(): string {
    const root = this.options.workspaceRoot ? path.resolve(this.options.workspaceRoot) : "unknown workspace";
    return `Docdex repo scope missing for ${root}. Ensure docdexd is running and initialized for this repo, or set MCODA_DOCDEX_URL and MCODA_DOCDEX_REPO_ID.`;
  }

  async ensureRepoScope(): Promise<void> {
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) return;
    if (!this.repoId) {
      await this.ensureRepoInitialized(baseUrl, true);
    }
    if (!this.repoId) {
      throw new Error(this.buildMissingRepoMessage());
    }
  }

  private async ensureRepoInitialized(baseUrl: string, force = false): Promise<void> {
    if ((this.repoId && !force) || this.initializing) return;
    if (!this.options.workspaceRoot) return;
    this.initializing = true;
    try {
      const rootUri = `file://${path.resolve(this.options.workspaceRoot)}`;
      const response = await fetch(`${baseUrl}/v1/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootUri }),
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
      const repoId =
        (payload?.repoId as string | undefined) ??
        (payload?.repo_id as string | undefined) ??
        (payload?.repo as string | undefined) ??
        (payload?.id as string | undefined);
      if (repoId) this.repoId = String(repoId);
    } catch {
      // ignore initialize errors; assume single-repo daemon
    } finally {
      this.initializing = false;
    }
  }

  private async fetchRemote(pathname: string, init?: RequestInit): Promise<Response> {
    if (this.disabledReason) {
      throw new Error(`Docdex unavailable: ${this.disabledReason}`);
    }
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      throw new Error("Docdex baseUrl not configured. Run docdex setup or set MCODA_DOCDEX_URL.");
    }
    await this.ensureRepoScope();
    const url = new URL(pathname, baseUrl);
    if (this.repoId && !url.searchParams.has("repo_id")) {
      url.searchParams.set("repo_id", this.repoId);
    }
    if (this.options.workspaceRoot && !url.searchParams.has("repo_root")) {
      url.searchParams.set("repo_root", path.resolve(this.options.workspaceRoot));
    }
    const buildHeaders = () => {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
      if (this.repoId) headers["x-docdex-repo-id"] = this.repoId;
      if (this.options.workspaceRoot) headers["x-docdex-repo-root"] = path.resolve(this.options.workspaceRoot);
      return { ...headers, ...(init?.headers as any) };
    };
    const response = await fetch(url, { ...init, headers: buildHeaders() });
    if (!response.ok) {
      const message = await response.text();
      if (message.includes("missing_repo")) {
        await this.ensureRepoInitialized(baseUrl, true);
        if (this.repoId) {
          const retry = await fetch(url, { ...init, headers: buildHeaders() });
          if (retry.ok) return retry;
          const retryMessage = await retry.text();
          throw new Error(`Docdex request failed (${retry.status}): ${retryMessage}`);
        }
      }
      throw new Error(`Docdex request failed (${response.status}): ${message}`);
    }
    return response;
  }

  private buildLocalDoc(docType: string, docPath: string | undefined, content: string, metadata?: Record<string, unknown>): DocdexDocument {
    const now = nowIso();
    const id = `local-${randomUUID()}`;
    return {
      id,
      docType,
      path: docPath,
      title: docPath ? path.basename(docPath) : undefined,
      content,
      metadata,
      createdAt: now,
      updatedAt: now,
      segments: segmentize(id, content),
    };
  }

  private coerceSearchResults(raw: any, fallbackDocType?: string): DocdexDocument[] {
    const items: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.results)
        ? raw.results
        : Array.isArray(raw?.hits)
          ? raw.hits
          : [];
    const now = nowIso();
    return items
      .map((item, idx) => {
        if (!item || typeof item !== "object") return undefined;
        const id = (item.doc_id ?? item.docId ?? item.id ?? `doc-${idx + 1}`) as string;
        const pathValue = (item.path ?? item.file ?? item.rel_path ?? item.file_path) as string | undefined;
        const title = (item.title ?? item.name ?? item.file_name) as string | undefined;
        const docType = (item.doc_type ?? item.docType ?? item.type ?? inferDocType(pathValue, fallbackDocType ?? "DOC")) as string;
        const snippet = (item.snippet ?? item.summary ?? item.excerpt) as string | undefined;
        const content = (item.content ?? snippet) as string | undefined;
        const segments = Array.isArray(item.segments)
          ? item.segments.map((seg: any, segIdx: number) => ({
              id: seg.id ?? `${id}-seg-${segIdx + 1}`,
              docId: id,
              index: segIdx,
              content: seg.content ?? seg.text ?? "",
              heading: seg.heading ?? seg.title ?? undefined,
            }))
          : snippet
            ? [
                {
                  id: `${id}-seg-1`,
                  docId: id,
                  index: 0,
                  content: snippet,
                  heading: undefined,
                },
              ]
            : undefined;
        return {
          id,
          docType,
          path: pathValue,
          title,
          content,
          createdAt: item.created_at ?? item.createdAt ?? now,
          updatedAt: item.updated_at ?? item.updatedAt ?? now,
          segments,
        } as DocdexDocument;
      })
      .filter(Boolean) as DocdexDocument[];
  }

  async fetchDocumentById(id: string): Promise<DocdexDocument> {
    const response = await this.fetchRemote(`/snippet/${encodeURIComponent(id)}?text_only=true`);
    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    let content = body;
    if (contentType.includes("application/json")) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        content =
          (parsed.text as string | undefined) ??
          (parsed.content as string | undefined) ??
          (parsed.snippet as string | undefined) ??
          body;
      } catch {
        content = body;
      }
    }
    const now = nowIso();
    return {
      id,
      docType: "DOC",
      content,
      createdAt: now,
      updatedAt: now,
      segments: content ? segmentize(id, content) : undefined,
    };
  }

  async findDocumentByPath(docPath: string, docType?: string): Promise<DocdexDocument | undefined> {
    const normalized = this.normalizePath(docPath);
    const query = normalized ?? docPath;
    let docs: DocdexDocument[] = [];
    try {
      docs = await this.search({ query, docType });
    } catch (error) {
      const local = await this.loadLocalDoc(docPath, docType);
      if (local) return local;
      throw error;
    }
    if (!docs.length) {
      return await this.loadLocalDoc(docPath, docType);
    }
    if (!normalized) return docs[0];
    return docs.find((doc) => doc.path === normalized) ?? docs[0];
  }

  async search(filter: { docType?: string; projectKey?: string; query?: string; profile?: string }): Promise<DocdexDocument[]> {
    const params = new URLSearchParams();
    const queryParts = [filter.query, filter.docType, filter.projectKey].filter(Boolean) as string[];
    const query = queryParts.join(" ").trim();
    if (query) params.set("q", query);
    if (filter.profile) params.set("profile", filter.profile);
    if (filter.docType) params.set("doc_type", filter.docType);
    if (filter.projectKey) params.set("project_key", filter.projectKey);
    params.set("limit", "8");
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      return [];
    }
    const response = await this.fetchRemote(`/search?${params.toString()}`);
    const payload = (await response.json()) as any;
    return this.coerceSearchResults(payload, filter.docType);
  }

  async reindex(): Promise<void> {
    const repoRoot = this.options.workspaceRoot ?? process.cwd();
    const baseUrl = await this.resolveBaseUrl();
    await runDocdex(["index", "--repo", repoRoot], {
      cwd: repoRoot,
      env: baseUrl
        ? {
            DOCDEX_URL: baseUrl,
            MCODA_DOCDEX_URL: baseUrl,
          }
        : undefined,
    });
  }

  async registerDocument(input: RegisterDocumentInput): Promise<DocdexDocument> {
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      const normalized = input.path ? this.normalizePath(input.path) ?? input.path : undefined;
      return this.buildLocalDoc(input.docType, normalized, input.content, input.metadata);
    }
    if (!input.path) {
      throw new Error("Docdex register requires a file path to ingest.");
    }
    await this.ensureRepoInitialized(baseUrl);
    const resolvedPath = path.isAbsolute(input.path)
      ? input.path
      : path.join(this.options.workspaceRoot ?? process.cwd(), input.path);
    const repoRoot = this.options.workspaceRoot ?? process.cwd();
    await runDocdex(["ingest", "--repo", repoRoot, "--file", resolvedPath], {
      cwd: repoRoot,
      env: {
        DOCDEX_URL: baseUrl,
        MCODA_DOCDEX_URL: baseUrl,
      },
    });
    const registered = await this.findDocumentByPath(resolvedPath, input.docType).catch(() => undefined);
    if (registered) return registered;
    return this.buildLocalDoc(input.docType, resolvedPath, input.content, input.metadata);
  }

  async ensureRegisteredFromFile(
    docPath: string,
    docType: string,
    metadata?: Record<string, unknown>,
  ): Promise<DocdexDocument> {
    const normalizedPath = this.normalizePath(docPath) ?? docPath;
    try {
      const existing = await this.findDocumentByPath(normalizedPath, docType);
      if (existing) return existing;
    } catch {
      // ignore docdex lookup failures; fall back to local
    }
    const content = await fs.readFile(docPath, "utf8");
    const inferredType = docType || inferDocType(docPath);
    const baseUrl = await this.resolveBaseUrl();
    if (!baseUrl) {
      return this.buildLocalDoc(inferredType, normalizedPath, content, metadata);
    }
    try {
      return await this.registerDocument({ docType: inferredType, path: docPath, content, metadata });
    } catch {
      return this.buildLocalDoc(inferredType, normalizedPath, content, metadata);
    }
  }
}
