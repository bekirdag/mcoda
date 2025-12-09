import { readFile } from "node:fs/promises";
import path from "node:path";
import { redactText } from "./redaction.js";
const DEFAULT_BLOCKLIST = [".mcoda", ".git", ".ssh", "node_modules", ".env", "secrets", "keys"];
const DEFAULT_CHUNK_SIZE = 4000;
const DEFAULT_MAX_SEGMENTS = 8;
const resolvePath = (workspaceRoot, target) => {
    const resolved = path.isAbsolute(target) ? target : path.join(workspaceRoot, target);
    return path.resolve(resolved);
};
const segmentMatchesBlocked = (segment, blocked) => {
    if (blocked === ".env") {
        return segment === blocked || segment.startsWith(".env.");
    }
    return segment === blocked;
};
const pathHasBlockedSegment = (filePath, blocklist) => {
    const segments = filePath.split(path.sep);
    return blocklist.some((blocked) => segments.some((segment) => segmentMatchesBlocked(segment, blocked)));
};
const pathIsUnder = (candidate, parent) => {
    const relative = path.relative(parent, candidate);
    if (!relative)
        return true;
    return !relative.startsWith("..") && !path.isAbsolute(relative);
};
export class DocdexClient {
    constructor(options = {}) {
        this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
        this.allowPaths = options.allowPaths?.map((p) => resolvePath(this.workspaceRoot, p));
        this.blocklist = [...DEFAULT_BLOCKLIST, ...(options.blocklist ?? [])];
        this.maxBytes = options.maxBytes ?? 32000;
        this.chunkSize = Math.max(512, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
        this.maxSegments = Math.max(1, options.maxSegments ?? DEFAULT_MAX_SEGMENTS);
    }
    ensureAllowed(resolved) {
        const explicitlyAllowed = this.allowPaths &&
            this.allowPaths.some((allowed) => pathIsUnder(resolved, allowed) || resolved === allowed);
        if (!explicitlyAllowed && pathHasBlockedSegment(resolved, this.blocklist)) {
            throw new Error(`docdex boundary enforcement: ${resolved} is blocked (SDS 4.3.3 disallows ${this.blocklist.join(", ")})`);
        }
        if (this.allowPaths && !explicitlyAllowed) {
            throw new Error(`docdex boundary enforcement: ${resolved} is not in the allow-list. Configure allowPaths to opt in (SDS 4.3.3).`);
        }
        const rel = path.relative(this.workspaceRoot, resolved);
        if (rel.startsWith("..")) {
            throw new Error(`docdex boundary enforcement: ${resolved} is outside workspace ${this.workspaceRoot}`);
        }
    }
    chunk(content) {
        const chunks = [];
        let offset = 0;
        const limit = Math.min(content.length, this.maxBytes);
        while (offset < limit && chunks.length < this.maxSegments) {
            const tentativeEnd = Math.min(offset + this.chunkSize, limit);
            // Prefer to end at a newline to avoid mid-sentence cuts.
            let end = content.lastIndexOf("\n", tentativeEnd);
            if (end <= offset + this.chunkSize * 0.5) {
                end = tentativeEnd;
            }
            const slice = content.slice(offset, end).trim();
            if (slice) {
                chunks.push(slice);
            }
            offset = end;
        }
        return chunks;
    }
    async fetchSegments(paths) {
        const unique = Array.from(new Set(paths));
        const segments = [];
        for (const target of unique) {
            const resolved = resolvePath(this.workspaceRoot, target);
            this.ensureAllowed(resolved);
            const content = await readFile(resolved, "utf8");
            const trimmed = content.slice(0, this.maxBytes);
            const pieces = this.chunk(trimmed);
            pieces.forEach((piece, idx) => {
                segments.push({
                    path: pieces.length > 1 ? `${resolved} (part ${idx + 1}/${pieces.length})` : resolved,
                    content: redactText(piece),
                });
            });
        }
        return segments;
    }
}
