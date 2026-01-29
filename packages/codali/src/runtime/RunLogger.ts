import { promises as fs } from "node:fs";
import path from "node:path";

export interface RunLogEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class RunLogger {
  readonly logPath: string;

  constructor(workspaceRoot: string, logDir: string, runId: string) {
    const resolvedDir = path.resolve(workspaceRoot, logDir);
    this.logPath = path.join(resolvedDir, `${runId}.jsonl`);
  }

  async log(type: string, data: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const event: RunLogEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    await fs.appendFile(this.logPath, `${JSON.stringify(event)}\n`, "utf8");
  }
}
