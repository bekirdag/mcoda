import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

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

interface DocdexStore {
  updatedAt: string;
  documents: DocdexDocument[];
  segments: DocdexSegment[];
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

export class DocdexClient {
  constructor(
    private options: {
      workspaceRoot?: string;
      storePath?: string;
      baseUrl?: string;
      authToken?: string;
    } = {},
  ) {}

  private getStorePath(): string {
    const base = this.options.storePath
      ? path.resolve(this.options.storePath)
      : path.join(this.options.workspaceRoot ?? process.cwd(), ".mcoda", "docdex", "documents.json");
    return base;
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

  private async loadStore(): Promise<DocdexStore> {
    const storePath = this.getStorePath();
    try {
      const raw = await fs.readFile(storePath, "utf8");
      const parsed = JSON.parse(raw) as DocdexStore;
      parsed.documents = parsed.documents ?? [];
      parsed.segments = parsed.segments ?? [];
      return parsed;
    } catch {
      return { updatedAt: nowIso(), documents: [], segments: [] };
    }
  }

  private async fetchRemote<T>(pathname: string, init?: RequestInit): Promise<T> {
    if (!this.options.baseUrl) throw new Error("Docdex baseUrl not configured");
    const url = new URL(pathname, this.options.baseUrl);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.options.authToken) headers.authorization = `Bearer ${this.options.authToken}`;
    const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as any) } });
    if (!response.ok) {
      throw new Error(`Docdex request failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private async saveStore(store: DocdexStore): Promise<void> {
    const storePath = this.getStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const payload = { ...store, updatedAt: nowIso() };
    await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf8");
  }

  async fetchDocumentById(id: string): Promise<DocdexDocument> {
    if (this.options.baseUrl) {
      try {
        const doc = await this.fetchRemote<DocdexDocument>(`/documents/${id}`);
        return doc;
      } catch (error) {
        // fall through to local if remote fails
        // eslint-disable-next-line no-console
        console.warn(`Docdex remote fetch failed, falling back to local: ${(error as Error).message}`);
      }
    }
    const store = await this.loadStore();
    const doc = store.documents.find((d) => d.id === id);
    if (!doc) {
      throw new Error(`Docdex document not found: ${id}`);
    }
    const segments = store.segments.filter((s) => s.docId === id);
    return { ...doc, segments };
  }

  async findDocumentByPath(docPath: string, docType?: string): Promise<DocdexDocument | undefined> {
    const normalized = this.normalizePath(docPath);
    const store = await this.loadStore();
    const doc = store.documents.find(
      (d) => d.path === normalized && (!docType || d.docType.toLowerCase() === docType.toLowerCase()),
    );
    if (!doc) return undefined;
    return { ...doc, segments: store.segments.filter((s) => s.docId === doc.id) };
  }

  async search(filter: { docType?: string; projectKey?: string; query?: string; profile?: string }): Promise<DocdexDocument[]> {
    if (this.options.baseUrl) {
      try {
        const params = new URLSearchParams();
        if (filter.docType) params.set("doc_type", filter.docType);
        if (filter.projectKey) params.set("project_key", filter.projectKey);
        if (filter.query) params.set("q", filter.query);
        if (filter.profile) params.set("profile", filter.profile);
        const path = `/documents?${params.toString()}`;
        const docs = await this.fetchRemote<DocdexDocument[]>(path);
        return docs;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`Docdex remote search failed, falling back to local: ${(error as Error).message}`);
      }
    }
    const store = await this.loadStore();
    return store.documents
      .filter((doc) => {
        if (filter.docType && doc.docType.toLowerCase() !== filter.docType.toLowerCase()) return false;
        if (filter.projectKey && doc.metadata && (doc.metadata as any).projectKey !== filter.projectKey) return false;
        return true;
      })
      .map((doc) => ({ ...doc, segments: store.segments.filter((s) => s.docId === doc.id) }));
  }

  async registerDocument(input: RegisterDocumentInput): Promise<DocdexDocument> {
    if (this.options.baseUrl) {
      try {
        const registered = await this.fetchRemote<DocdexDocument>(`/documents`, {
          method: "POST",
          body: JSON.stringify({
            doc_type: input.docType,
            path: input.path,
            title: input.title,
            content: input.content,
            metadata: input.metadata,
          }),
        });
        return registered;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn(`Docdex remote register failed, falling back to local: ${(error as Error).message}`);
      }
    }
    const store = await this.loadStore();
    const normalizedPath = this.normalizePath(input.path);
    const existingByPath = normalizedPath
      ? store.documents.find(
          (d) =>
            d.path === normalizedPath &&
            d.docType.toLowerCase() === input.docType.toLowerCase() &&
            (input.metadata?.projectKey ? (d.metadata as any)?.projectKey === input.metadata.projectKey : true),
        )
      : undefined;
    const now = nowIso();
    if (existingByPath) {
      const updated: DocdexDocument = {
        ...existingByPath,
        content: input.content ?? existingByPath.content,
        metadata: { ...(existingByPath.metadata ?? {}), ...(input.metadata ?? {}) },
        title: input.title ?? existingByPath.title,
        updatedAt: now,
      };
      const segments = segmentize(updated.id, input.content);
      store.documents[store.documents.findIndex((d) => d.id === existingByPath.id)] = updated;
      store.segments = store.segments.filter((s) => s.docId !== updated.id).concat(segments);
      await this.saveStore(store);
      return { ...updated, segments };
    }
    const doc: DocdexDocument = {
      id: randomUUID(),
      docType: input.docType,
      path: normalizedPath,
      content: input.content,
      metadata: input.metadata,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };
    const segments = segmentize(doc.id, input.content);
    store.documents.push(doc);
    store.segments.push(...segments);
    await this.saveStore(store);
    return { ...doc, segments };
  }

  async ensureRegisteredFromFile(
    docPath: string,
    docType: string,
    metadata?: Record<string, unknown>,
  ): Promise<DocdexDocument> {
    const normalizedPath = this.normalizePath(docPath) ?? docPath;
    const existing = await this.findDocumentByPath(normalizedPath, docType);
    if (existing) return existing;
    const content = await fs.readFile(docPath, "utf8");
    return this.registerDocument({ docType, path: docPath, content, metadata });
  }
}
