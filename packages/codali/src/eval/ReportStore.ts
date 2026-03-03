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

const reportSortKey = async (filePath: string): Promise<number> => {
  try {
    const info = await stat(filePath);
    return info.mtimeMs;
  } catch {
    return 0;
  }
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
    withKeys.sort((left, right) => right.key - left.key);
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
