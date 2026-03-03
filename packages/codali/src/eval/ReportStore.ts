import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGlobalWorkspaceDir } from "../runtime/StoragePaths.js";
import { DEFAULT_LOG_DIR } from "../config/Config.js";
import { parseEvalReport, serializeEvalReport, type EvalReport } from "./ReportSerializer.js";

const sanitize = (value: string): string =>
  value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "suite";

type ReportSortKey = {
  timestamp: number;
  mtimeMs: number;
  fileName: string;
};

const fileTimestamp = (filePath: string): number | undefined => {
  const match = /-(\d{13})-[a-z0-9._-]+\.json$/i.exec(path.basename(filePath));
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const reportSortKey = async (filePath: string): Promise<ReportSortKey> => {
  let mtimeMs = 0;
  try {
    const info = await stat(filePath);
    mtimeMs = info.mtimeMs;
  } catch {
    mtimeMs = 0;
  }
  return {
    // Prefer timestamp encoded in the report filename to avoid OS-specific mtime granularity.
    timestamp: fileTimestamp(filePath) ?? Math.floor(mtimeMs),
    mtimeMs,
    fileName: path.basename(filePath).toLowerCase(),
  };
};

export class ReportStore {
  readonly report_dir: string;

  constructor(workspaceRoot: string, reportDir?: string) {
    const storageRoot = getGlobalWorkspaceDir(workspaceRoot);
    this.report_dir = path.resolve(storageRoot, reportDir ?? path.join(DEFAULT_LOG_DIR, "eval"));
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.report_dir, { recursive: true });
  }

  async save(report: EvalReport): Promise<string> {
    await this.ensureDir();
    const suiteId = sanitize(report.suite.suite_id);
    const timestamp = Date.now();
    const fileName = `${suiteId}-${timestamp}-${sanitize(report.report_id)}.json`;
    const filePath = path.join(this.report_dir, fileName);
    await writeFile(filePath, serializeEvalReport(report, true), "utf8");
    return filePath;
  }

  async read(reportPath: string): Promise<EvalReport> {
    const content = await readFile(reportPath, "utf8");
    return parseEvalReport(content);
  }

  async resolvePath(reportPath: string, cwd: string): Promise<string> {
    const candidate = path.isAbsolute(reportPath) ? reportPath : path.resolve(cwd, reportPath);
    return path.resolve(candidate);
  }

  async listReports(): Promise<string[]> {
    await this.ensureDir();
    const entries = await readdir(this.report_dir);
    const jsonEntries = entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join(this.report_dir, entry));
    const withKeys = await Promise.all(
      jsonEntries.map(async (entry) => ({ entry, key: await reportSortKey(entry) })),
    );
    withKeys.sort((left, right) => {
      const byTimestamp = right.key.timestamp - left.key.timestamp;
      if (byTimestamp !== 0) return byTimestamp;
      const byMtime = right.key.mtimeMs - left.key.mtimeMs;
      if (byMtime !== 0) return byMtime;
      return right.key.fileName.localeCompare(left.key.fileName);
    });
    return withKeys.map((entry) => entry.entry);
  }

  async findLatestForSuite(params: {
    suite_fingerprint: string;
    exclude_report_id?: string;
  }): Promise<{ path: string; report: EvalReport } | undefined> {
    const reportFiles = await this.listReports();
    for (const reportFile of reportFiles) {
      let parsed: EvalReport;
      try {
        parsed = await this.read(reportFile);
      } catch {
        continue;
      }
      if (parsed.suite.suite_fingerprint !== params.suite_fingerprint) continue;
      if (params.exclude_report_id && parsed.report_id === params.exclude_report_id) continue;
      return { path: reportFile, report: parsed };
    }
    return undefined;
  }
}
