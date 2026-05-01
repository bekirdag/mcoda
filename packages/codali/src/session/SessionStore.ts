import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type CodaliSessionStatus = "active" | "paused" | "completed" | "failed";

export interface CodaliSessionMetadata {
  schemaVersion: 1;
  sessionId: string;
  repoRoot: string;
  task: string;
  status: CodaliSessionStatus;
  branch?: string;
  parentSessionId?: string;
  runIds: string[];
  transcriptRefs: string[];
  summaryRefs: string[];
  contextLaneRefs: string[];
  instructionSources: string[];
  createdAt: string;
  updatedAt: string;
}

export type CodaliSessionTranscriptEventType =
  | "run_started"
  | "provider_request"
  | "provider_response"
  | "tool_result"
  | "codali_response"
  | "subagent_result"
  | "final"
  | "error"
  | "note";

export interface CodaliSessionTranscriptEvent {
  schemaVersion: 1;
  sessionId: string;
  type: CodaliSessionTranscriptEventType;
  timestamp: string;
  runId?: string;
  data: Record<string, unknown>;
}

export interface CodaliSessionSummary {
  schemaVersion: 1;
  sessionId: string;
  createdAt: string;
  eventCount: number;
  summary: string;
  highlights: string[];
}

export interface CodaliResumeBundle {
  metadata: CodaliSessionMetadata;
  latestSummary?: CodaliSessionSummary;
  recentEvents: CodaliSessionTranscriptEvent[];
}

export interface SessionStoreOptions {
  workspaceRoot: string;
  storageDir?: string;
}

export interface CreateSessionInput {
  sessionId?: string;
  repoRoot: string;
  task: string;
  status?: CodaliSessionStatus;
  branch?: string;
  parentSessionId?: string;
  contextLaneRefs?: string[];
  instructionSources?: string[];
}

const DEFAULT_SESSION_STORAGE_DIR = ".mcoda/codali/sessions";

const safeId = (value: string): string => {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
  if (!safe) throw new Error("Session id must contain at least one safe character");
  return safe;
};

const parseJsonLines = <T>(content: string): T[] => {
  if (!content.trim()) return [];
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
};

const nowIso = (): string => new Date().toISOString();

const shortJson = (value: unknown, maxLength = 400): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
};

const summarizeEvents = (
  metadata: CodaliSessionMetadata,
  events: CodaliSessionTranscriptEvent[],
): Pick<CodaliSessionSummary, "summary" | "highlights"> => {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.type, (counts.get(event.type) ?? 0) + 1);

  const highlights: string[] = [];
  for (const event of events.slice(-20)) {
    if (event.type === "final" && typeof event.data.content === "string") {
      highlights.push(`Final: ${shortJson(event.data.content, 240)}`);
    } else if (event.type === "tool_result") {
      highlights.push(
        `Tool ${String(event.data.name ?? "unknown")}: ${String(event.data.ok ?? "unknown")}`,
      );
    } else if (event.type === "subagent_result") {
      highlights.push(
        `Subagent ${String(event.data.role ?? "unknown")}: ${String(event.data.status ?? "unknown")}`,
      );
    } else if (event.type === "error") {
      highlights.push(`Error: ${shortJson(event.data.message, 240)}`);
    }
  }

  const countText = Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
  return {
    summary: [
      `Task: ${metadata.task}`,
      `Status: ${metadata.status}`,
      `Runs: ${metadata.runIds.join(", ") || "none"}`,
      `Events: ${countText || "none"}`,
      highlights.length ? `Recent highlights: ${highlights.join(" | ")}` : "Recent highlights: none",
    ].join("\n"),
    highlights,
  };
};

export class SessionStore {
  readonly workspaceRoot: string;
  readonly storageDir: string;
  private lastTimestampMs = 0;

  constructor(options: SessionStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.storageDir = options.storageDir ?? DEFAULT_SESSION_STORAGE_DIR;
  }

  private rootDir(): string {
    const resolved = path.resolve(this.workspaceRoot, this.storageDir);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Session storage path is outside workspace root");
    }
    return resolved;
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.rootDir(), safeId(sessionId));
  }

  private metadataPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "metadata.json");
  }

  private transcriptPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "transcript.jsonl");
  }

  private summariesDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "summaries");
  }

  private nextTimestampIso(after?: string): string {
    const afterMs = after ? Date.parse(after) : Number.NaN;
    const timestampMs = Math.max(
      Date.now(),
      this.lastTimestampMs + 1,
      Number.isFinite(afterMs) ? afterMs + 1 : 0,
    );
    this.lastTimestampMs = timestampMs;
    return new Date(timestampMs).toISOString();
  }

  async createSession(input: CreateSessionInput): Promise<CodaliSessionMetadata> {
    const sessionId = input.sessionId ? safeId(input.sessionId) : randomUUID();
    const createdAt = this.nextTimestampIso();
    const metadata: CodaliSessionMetadata = {
      schemaVersion: 1,
      sessionId,
      repoRoot: input.repoRoot,
      task: input.task,
      status: input.status ?? "active",
      branch: input.branch,
      parentSessionId: input.parentSessionId,
      runIds: [],
      transcriptRefs: ["transcript.jsonl"],
      summaryRefs: [],
      contextLaneRefs: input.contextLaneRefs ?? [],
      instructionSources: input.instructionSources ?? [],
      createdAt,
      updatedAt: createdAt,
    };
    await fs.mkdir(this.sessionDir(sessionId), { recursive: true });
    await fs.writeFile(this.metadataPath(sessionId), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    return metadata;
  }

  async readSession(sessionId: string): Promise<CodaliSessionMetadata> {
    const content = await fs.readFile(this.metadataPath(sessionId), "utf8");
    return JSON.parse(content) as CodaliSessionMetadata;
  }

  async getOrCreateSession(input: CreateSessionInput): Promise<CodaliSessionMetadata> {
    if (input.sessionId) {
      try {
        return await this.readSession(input.sessionId);
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return this.createSession(input);
  }

  async updateSession(
    sessionId: string,
    patch: Partial<Omit<CodaliSessionMetadata, "schemaVersion" | "sessionId" | "createdAt">>,
  ): Promise<CodaliSessionMetadata> {
    const current = await this.readSession(sessionId);
    const next: CodaliSessionMetadata = {
      ...current,
      ...patch,
      runIds: patch.runIds ?? current.runIds,
      transcriptRefs: patch.transcriptRefs ?? current.transcriptRefs,
      summaryRefs: patch.summaryRefs ?? current.summaryRefs,
      contextLaneRefs: patch.contextLaneRefs ?? current.contextLaneRefs,
      instructionSources: patch.instructionSources ?? current.instructionSources,
      updatedAt: this.nextTimestampIso(current.updatedAt),
    };
    await fs.writeFile(this.metadataPath(sessionId), `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  async addRun(sessionId: string, runId: string): Promise<CodaliSessionMetadata> {
    const current = await this.readSession(sessionId);
    if (current.runIds.includes(runId)) return current;
    return this.updateSession(sessionId, { runIds: [...current.runIds, runId] });
  }

  async appendTranscript(
    sessionId: string,
    event: Omit<CodaliSessionTranscriptEvent, "schemaVersion" | "sessionId" | "timestamp"> & {
      timestamp?: string;
    },
  ): Promise<CodaliSessionTranscriptEvent> {
    const record: CodaliSessionTranscriptEvent = {
      schemaVersion: 1,
      sessionId,
      type: event.type,
      timestamp: event.timestamp ?? nowIso(),
      runId: event.runId,
      data: event.data,
    };
    const transcriptPath = this.transcriptPath(sessionId);
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.appendFile(transcriptPath, `${JSON.stringify(record)}\n`, "utf8");
    await this.updateSession(sessionId, {});
    return record;
  }

  async readTranscript(sessionId: string): Promise<CodaliSessionTranscriptEvent[]> {
    try {
      const content = await fs.readFile(this.transcriptPath(sessionId), "utf8");
      return parseJsonLines<CodaliSessionTranscriptEvent>(content);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async listSessions(): Promise<CodaliSessionMetadata[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.rootDir());
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const sessions: CodaliSessionMetadata[] = [];
    for (const entry of entries) {
      try {
        sessions.push(await this.readSession(entry));
      } catch {
        // Ignore incomplete session directories.
      }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async compactSession(sessionId: string): Promise<CodaliSessionSummary> {
    const metadata = await this.readSession(sessionId);
    const events = await this.readTranscript(sessionId);
    const createdAt = nowIso();
    const compacted = summarizeEvents(metadata, events);
    const summary: CodaliSessionSummary = {
      schemaVersion: 1,
      sessionId,
      createdAt,
      eventCount: events.length,
      ...compacted,
    };
    const summariesDir = this.summariesDir(sessionId);
    await fs.mkdir(summariesDir, { recursive: true });
    const fileName = `${createdAt.replace(/[^0-9T]/g, "").slice(0, 15)}-${events.length}.json`;
    const filePath = path.join(summariesDir, fileName);
    await fs.writeFile(filePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    const relativeRef = path.relative(this.sessionDir(sessionId), filePath);
    await this.updateSession(sessionId, {
      summaryRefs: [...metadata.summaryRefs, relativeRef],
    });
    return summary;
  }

  async readLatestSummary(sessionId: string): Promise<CodaliSessionSummary | undefined> {
    const metadata = await this.readSession(sessionId);
    const latest = metadata.summaryRefs.at(-1);
    if (!latest) return undefined;
    const content = await fs.readFile(path.join(this.sessionDir(sessionId), latest), "utf8");
    return JSON.parse(content) as CodaliSessionSummary;
  }

  async buildResumeBundle(
    sessionId: string,
    options: { recentEvents?: number } = {},
  ): Promise<CodaliResumeBundle> {
    const metadata = await this.readSession(sessionId);
    const transcript = await this.readTranscript(sessionId);
    const recentCount = Math.max(0, options.recentEvents ?? 20);
    return {
      metadata,
      latestSummary: await this.readLatestSummary(sessionId),
      recentEvents: recentCount ? transcript.slice(-recentCount) : [],
    };
  }
}
