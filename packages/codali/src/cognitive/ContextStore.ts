import { promises as fs } from "node:fs";
import path from "node:path";
import type { ProviderMessage } from "../providers/ProviderTypes.js";

export interface ContextMessageRecord extends ProviderMessage {
  ts: number;
  model?: string;
  tokens?: number;
}

export interface ContextLaneSnapshot {
  laneId: string;
  messages: ContextMessageRecord[];
  messageCount: number;
  byteSize: number;
  updatedAt: number;
}

export interface ContextStoreOptions {
  workspaceRoot: string;
  storageDir: string;
}

const safeLaneId = (laneId: string): string => laneId.replace(/[^a-zA-Z0-9._-]+/g, "_");

const resolveLanePath = (workspaceRoot: string, storageDir: string, laneId: string): string => {
  const resolvedDir = path.resolve(workspaceRoot, storageDir);
  const fileName = `${safeLaneId(laneId)}.jsonl`;
  const resolvedPath = path.join(resolvedDir, fileName);
  const relative = path.relative(workspaceRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace root");
  }
  return resolvedPath;
};

const parseJsonLines = (content: string): ContextMessageRecord[] => {
  if (!content.trim()) return [];
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ContextMessageRecord);
};

const buildSnapshot = (
  laneId: string,
  messages: ContextMessageRecord[],
  byteSize: number,
  updatedAt: number,
): ContextLaneSnapshot => ({
  laneId,
  messages,
  messageCount: messages.length,
  byteSize,
  updatedAt,
});

export class ContextStore {
  constructor(private options: ContextStoreOptions) {}

  private lanePath(laneId: string): string {
    return resolveLanePath(this.options.workspaceRoot, this.options.storageDir, laneId);
  }

  async loadLane(laneId: string): Promise<ContextLaneSnapshot> {
    const filePath = this.lanePath(laneId);
    try {
      const [content, stats] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
      const messages = parseJsonLines(content);
      return buildSnapshot(laneId, messages, Buffer.byteLength(content, "utf8"), stats.mtimeMs);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return buildSnapshot(laneId, [], 0, 0);
      }
      throw error;
    }
  }

  async append(laneId: string, messages: ContextMessageRecord[] | ContextMessageRecord): Promise<ContextLaneSnapshot> {
    const filePath = this.lanePath(laneId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const items = Array.isArray(messages) ? messages : [messages];
    if (items.length) {
      const payload = `${items.map((item) => JSON.stringify(item)).join("\n")}\n`;
      await fs.appendFile(filePath, payload, "utf8");
    }
    return this.loadLane(laneId);
  }

  async replace(laneId: string, messages: ContextMessageRecord[]): Promise<ContextLaneSnapshot> {
    const filePath = this.lanePath(laneId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const payload = messages.length ? `${messages.map((item) => JSON.stringify(item)).join("\n")}\n` : "";
    await fs.writeFile(filePath, payload, "utf8");
    return this.loadLane(laneId);
  }

  async truncate(laneId: string, maxMessages: number): Promise<ContextLaneSnapshot> {
    const snapshot = await this.loadLane(laneId);
    if (maxMessages < 0) {
      throw new Error("maxMessages must be non-negative");
    }
    if (snapshot.messages.length <= maxMessages) {
      return snapshot;
    }
    const trimmed = maxMessages === 0 ? [] : snapshot.messages.slice(-maxMessages);
    return this.replace(laneId, trimmed);
  }
}
