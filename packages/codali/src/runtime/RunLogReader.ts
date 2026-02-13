import { promises as fs } from "node:fs";
import path from "node:path";
import { getGlobalWorkspaceDir } from "./StoragePaths.js";

interface RunMeta {
  runId: string;
  touchedFiles: string[];
  timestamp: number;
}

export class RunLogReader {
  private logDir: string;

  constructor(workspaceRoot: string, logDirName = "logs") {
    const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
    this.logDir = path.resolve(storageRoot, logDirName);
  }

  async findLastRunForFile(filePath: string): Promise<string | undefined> {
    try {
      const files = await fs.readdir(this.logDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      
      // Sort by modification time, newest first
      const sortedFiles = await Promise.all(
        jsonlFiles.map(async (f) => {
          const stat = await fs.stat(path.join(this.logDir, f));
          return { file: f, mtime: stat.mtimeMs };
        })
      );
      sortedFiles.sort((a, b) => b.mtime - a.mtime);

      for (const { file } of sortedFiles) {
        const content = await fs.readFile(path.join(this.logDir, file), "utf8");
        const lines = content.split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === "run_summary") {
              const touched = (event.data?.touchedFiles as string[]) || [];
              // Normalize paths for comparison
              const normalizedTarget = path.normalize(filePath);
              const hit = touched.find(t => path.normalize(t).endsWith(normalizedTarget) || normalizedTarget.endsWith(path.normalize(t)));
              if (hit) {
                return event.data.runId as string;
              }
            }
          } catch {
            continue;
          }
        }
      }
    } catch (error) {
      // ignore
    }
    return undefined;
  }

  async getRunArtifact(runId: string, kind: string): Promise<string | undefined> {
    const phaseDir = path.join(this.logDir, "phase");
    try {
      const files = await fs.readdir(phaseDir);
      // Look for files starting with runId and containing kind
      // e.g. <runId>-builder-patch-*.json
      const candidates = files.filter(f => f.startsWith(runId) && f.includes(kind));
      if (candidates.length === 0) return undefined;
      
      // Return the content of the last one (assuming newest is most relevant if multiple)
      const last = candidates.sort().pop(); 
      if (last) {
        return fs.readFile(path.join(phaseDir, last), "utf8");
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async getRunIntent(runId: string): Promise<string | undefined> {
    const logFile = path.join(this.logDir, `${runId}.jsonl`);
    try {
      const content = await fs.readFile(logFile, "utf8");
      const lines = content.split("\n").filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line);
        if (event.type === "phase_input" && event.data?.phase === "librarian") {
           // Try to read the input artifact to get the request
           const artifactPath = event.data?.path;
           if (artifactPath && typeof artifactPath === 'string') {
               try {
                   const artifact = JSON.parse(await fs.readFile(artifactPath, 'utf8'));
                   if (artifact.request) return artifact.request;
               } catch {
                   // ignore
               }
           }
        }
      }
    } catch {
        // ignore
    }
    return undefined;
  }
}
