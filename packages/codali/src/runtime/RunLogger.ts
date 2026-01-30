import { promises as fs } from "node:fs";
import path from "node:path";

export interface RunLogEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class RunLogger {
  readonly logPath: string;
  readonly logDir: string;
  readonly runId: string;

  constructor(workspaceRoot: string, logDir: string, runId: string) {
    const resolvedDir = path.resolve(workspaceRoot, logDir);
    this.logDir = resolvedDir;
    this.runId = runId;
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

  async writePhaseArtifact(
    phase: string,
    kind: string,
    payload: unknown,
  ): Promise<string> {
    const phaseDir = path.join(this.logDir, "phase");
    await fs.mkdir(phaseDir, { recursive: true });
    const safePhase = phase.replace(/[^a-z0-9_-]/gi, "_");
    const safeKind = kind.replace(/[^a-z0-9_-]/gi, "_");
    const ext = typeof payload === "string" ? "txt" : "json";
    const timestamp = Date.now();
    const filename = `${this.runId}-${safePhase}-${safeKind}-${timestamp}.${ext}`;
    const filePath = path.join(phaseDir, filename);
    const content =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    await fs.writeFile(filePath, content, "utf8");
    return filePath;
  }
}
