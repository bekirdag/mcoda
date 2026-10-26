import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { atomicWriteJson, withStateLock } from "./AtomicState.js";
import { createWorkState, validateWorkState } from "./WorkState.js";
import type { WorkState } from "./WorkTypes.js";

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
  /** Trusted host-only option. Repository configuration must never set this. */
  allowExternalStorage?: boolean;
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)) throw new Error("Invalid session id");
  return value;
};

const parseJsonLines = <T>(content: string): T[] => {
  if (!content.trim()) return [];
  const lines = content.split("\n");
  const result: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try { result.push(JSON.parse(line) as T); }
    catch (error) {
      // Only an unterminated final record may be a crash tail. Never hide middle corruption.
      if (index === lines.length - 1 && !content.endsWith("\n")) break;
      throw error;
    }
  }
  return result;
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
  private readonly allowExternalStorage: boolean;

  constructor(options: SessionStoreOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.storageDir = options.storageDir ?? DEFAULT_SESSION_STORAGE_DIR;
    this.allowExternalStorage = options.allowExternalStorage === true;
  }

  private rootDir(): string {
    const resolved = path.resolve(this.workspaceRoot, this.storageDir);
    const relative = path.relative(this.workspaceRoot, resolved);
    if (!this.allowExternalStorage && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) {
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
    await withStateLock(this.metadataPath(sessionId), async () => {
      try { await fs.stat(this.metadataPath(sessionId)); throw new Error("Session already exists"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await atomicWriteJson(this.metadataPath(sessionId), metadata);
    });
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
    return this.mutateSession(sessionId, current => ({ ...current, ...patch }));
  }

  private async mutateSession(
    sessionId: string,
    mutate: (current: CodaliSessionMetadata) => CodaliSessionMetadata,
  ): Promise<CodaliSessionMetadata> {
    return withStateLock(this.metadataPath(sessionId), async () => {
    const current = await this.readSession(sessionId);
    const patch = mutate(structuredClone(current));
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
    await atomicWriteJson(this.metadataPath(sessionId), next);
    return next;
    });
  }

  async addRun(sessionId: string, runId: string): Promise<CodaliSessionMetadata> {
    return this.mutateSession(sessionId, current => ({ ...current, runIds: [...new Set([...current.runIds, runId])] }));
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
    await withStateLock(transcriptPath, async () => {
      try {
        const contents = await fs.readFile(transcriptPath, "utf8");
        if (contents && !contents.endsWith("\n")) {
          const lastNewline = contents.lastIndexOf("\n");
          try { JSON.parse(contents.slice(lastNewline + 1)); await fs.appendFile(transcriptPath, "\n"); }
          catch { await fs.truncate(transcriptPath, Buffer.byteLength(contents.slice(0, lastNewline + 1))); }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const handle = await fs.open(transcriptPath, "a", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
    });
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
    await atomicWriteJson(filePath, summary);
    const relativeRef = path.relative(this.sessionDir(sessionId), filePath);
    await this.mutateSession(sessionId, current => ({ ...current, summaryRefs: [...new Set([...current.summaryRefs, relativeRef])] }));
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

  async initializeWork(sessionId: string, objective: string): Promise<WorkState> {
    await this.readSession(sessionId);
    const file = path.join(this.sessionDir(sessionId), "work.json");
    return withStateLock(file, async () => {
      try { return await this.readWork(sessionId); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const state = createWorkState(objective);
      await atomicWriteJson(file, state);
      return state;
    });
  }

  async readWork(sessionId: string): Promise<WorkState> {
    const state = JSON.parse(await fs.readFile(path.join(this.sessionDir(sessionId), "work.json"), "utf8")) as WorkState;
    validateWorkState(state);
    return state;
  }

  async updateWork(sessionId: string, expectedRevision: number, mutate: (state: WorkState) => void): Promise<WorkState> {
    const file = path.join(this.sessionDir(sessionId), "work.json");
    return withStateLock(file, async () => {
      const state = await this.readWork(sessionId);
      if (state.revision !== expectedRevision) throw new Error("Work revision conflict; reload before retrying");
      const identity = [state.goalId, state.originalObjective, state.createdAt];
      mutate(state);
      if (JSON.stringify(identity) !== JSON.stringify([state.goalId, state.originalObjective, state.createdAt])) throw new Error("Original goal identity is immutable");
      state.revision += 1; state.updatedAt = nowIso();
      validateWorkState(state);
      await atomicWriteJson(file, state);
      return state;
    });
  }
}
