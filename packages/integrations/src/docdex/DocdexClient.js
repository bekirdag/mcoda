import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
const nowIso = () => new Date().toISOString();
export class DocdexClient {
    constructor(options = {}) {
        this.options = options;
    }
    getStorePath() {
        const base = this.options.storePath
            ? path.resolve(this.options.storePath)
            : path.join(this.options.workspaceRoot ?? process.cwd(), ".mcoda", "docdex", "documents.json");
        return base;
    }
    normalizePath(inputPath) {
        if (!inputPath)
            return undefined;
        const absolute = path.resolve(inputPath);
        if (this.options.workspaceRoot) {
            const root = path.resolve(this.options.workspaceRoot);
            if (absolute.startsWith(root)) {
                return path.relative(root, absolute);
            }
        }
        return absolute;
    }
    async loadStore() {
        const storePath = this.getStorePath();
        try {
            const raw = await fs.readFile(storePath, "utf8");
            const parsed = JSON.parse(raw);
            parsed.documents = parsed.documents ?? [];
            return parsed;
        }
        catch {
            return { updatedAt: nowIso(), documents: [] };
        }
    }
    async saveStore(store) {
        const storePath = this.getStorePath();
        await fs.mkdir(path.dirname(storePath), { recursive: true });
        const payload = { ...store, updatedAt: nowIso() };
        await fs.writeFile(storePath, JSON.stringify(payload, null, 2), "utf8");
    }
    async fetchDocumentById(id) {
        const store = await this.loadStore();
        const doc = store.documents.find((d) => d.id === id);
        if (!doc) {
            throw new Error(`Docdex document not found: ${id}`);
        }
        return doc;
    }
    async findDocumentByPath(docPath, docType) {
        const normalized = this.normalizePath(docPath);
        const store = await this.loadStore();
        return store.documents.find((d) => d.path === normalized && (!docType || d.docType.toLowerCase() === docType.toLowerCase()));
    }
    async search(filter) {
        const store = await this.loadStore();
        return store.documents.filter((doc) => {
            if (filter.docType && doc.docType.toLowerCase() !== filter.docType.toLowerCase())
                return false;
            if (filter.projectKey && doc.metadata && doc.metadata.projectKey !== filter.projectKey)
                return false;
            return true;
        });
    }
    async registerDocument(input) {
        const store = await this.loadStore();
        const normalizedPath = this.normalizePath(input.path);
        const existingByPath = normalizedPath
            ? store.documents.find((d) => d.path === normalizedPath &&
                d.docType.toLowerCase() === input.docType.toLowerCase() &&
                (input.metadata?.projectKey ? d.metadata?.projectKey === input.metadata.projectKey : true))
            : undefined;
        const now = nowIso();
        if (existingByPath) {
            const updated = {
                ...existingByPath,
                content: input.content ?? existingByPath.content,
                metadata: { ...(existingByPath.metadata ?? {}), ...(input.metadata ?? {}) },
                title: input.title ?? existingByPath.title,
                updatedAt: now,
            };
            const idx = store.documents.findIndex((d) => d.id === existingByPath.id);
            store.documents[idx] = updated;
            await this.saveStore(store);
            return updated;
        }
        const doc = {
            id: randomUUID(),
            docType: input.docType,
            path: normalizedPath,
            content: input.content,
            metadata: input.metadata,
            title: input.title,
            createdAt: now,
            updatedAt: now,
        };
        store.documents.push(doc);
        await this.saveStore(store);
        return doc;
    }
    async ensureRegisteredFromFile(docPath, docType, metadata) {
        const normalizedPath = this.normalizePath(docPath) ?? docPath;
        const existing = await this.findDocumentByPath(normalizedPath, docType);
        if (existing)
            return existing;
        const content = await fs.readFile(docPath, "utf8");
        return this.registerDocument({ docType, path: docPath, content, metadata });
    }
}
