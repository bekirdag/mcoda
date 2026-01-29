import { spawnSync } from "node:child_process";
import path from "node:path";

const CODALI_BIN_ENV = "CODALI_BIN";
const CODALI_STUB_ENV = "MCODA_CLI_STUB";
const CODALI_SKIP_CHECKS_ENV = "MCODA_SKIP_CLI_CHECKS";

export interface CodaliCliOptions {
  workspaceRoot: string;
  project?: string;
  command?: string;
  commandRunId?: string;
  jobId?: string;
  runId?: string;
  taskId?: string;
  taskKey?: string;
  agentId?: string;
  agentSlug?: string;
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  docdexBaseUrl?: string;
  docdexRepoId?: string;
  docdexRepoRoot?: string;
  env?: Record<string, string>;
}

export const cliHealthy = (throwOnError = false): { ok: boolean; details?: Record<string, unknown> } => {
  if (process.env[CODALI_STUB_ENV] === "1") {
    return { ok: true, details: { stub: true } };
  }
  if (process.env[CODALI_SKIP_CHECKS_ENV] === "1") {
    return { ok: true, details: { skipped: true } };
  }
  const bin = process.env[CODALI_BIN_ENV] ?? "codali";
  const result = spawnSync(bin, ["--help"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const error = result.error?.message ?? result.stderr ?? "codali CLI unavailable";
    if (throwOnError) {
      throw new Error(`AUTH_ERROR: codali CLI unavailable (${error})`);
    }
    return { ok: false, details: { error } };
  }
  return { ok: true };
};

export const buildArgs = (options: CodaliCliOptions): string[] => {
  const args = ["run", "--workspace-root", options.workspaceRoot, "--provider", options.provider, "--model", options.model];
  if (options.project) {
    args.push("--project", options.project);
  }
  if (options.command) {
    args.push("--command", options.command);
  }
  if (options.commandRunId) {
    args.push("--command-run-id", options.commandRunId);
  }
  if (options.jobId) {
    args.push("--job-id", options.jobId);
  }
  if (options.runId) {
    args.push("--run-id", options.runId);
  }
  if (options.taskId) {
    args.push("--task-id", options.taskId);
  }
  if (options.taskKey) {
    args.push("--task-key", options.taskKey);
  }
  if (options.agentId) {
    args.push("--agent-id", options.agentId);
  }
  if (options.agentSlug) {
    args.push("--agent-slug", options.agentSlug);
  }
  if (options.baseUrl) {
    args.push("--base-url", options.baseUrl);
  }
  if (options.docdexBaseUrl) {
    args.push("--docdex-base-url", options.docdexBaseUrl);
  }
  if (options.docdexRepoId) {
    args.push("--docdex-repo-id", options.docdexRepoId);
  }
  if (options.docdexRepoRoot) {
    args.push("--docdex-repo-root", options.docdexRepoRoot);
  }
  return args;
};

const parseRunMeta = (stderr: string | undefined): Record<string, unknown> | undefined => {
  if (!stderr) return undefined;
  const lines = stderr.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("CODALI_RUN_META ")) continue;
    const payload = line.slice("CODALI_RUN_META ".length).trim();
    if (!payload) return undefined;
    try {
      return JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
};

export const runCodaliExec = (
  input: string,
  options: CodaliCliOptions,
): { output: string; raw: string; meta?: Record<string, unknown> } => {
  if (process.env[CODALI_STUB_ENV] === "1") {
    return {
      output: `codali-stub:${input}`,
      raw: `codali-stub:${input}`,
    };
  }
  const bin = process.env[CODALI_BIN_ENV] ?? "codali";
  const args = buildArgs(options);
  const env = {
    ...process.env,
    ...(options.env ?? {}),
  };
  const apiKey = options.apiKey ?? env.CODALI_API_KEY;
  if (apiKey) {
    env.CODALI_API_KEY = apiKey;
  }

  const result = spawnSync(bin, args, {
    cwd: path.resolve(options.workspaceRoot),
    input,
    encoding: "utf8",
    env,
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ?? "";
    throw new Error(`codali CLI failed: ${stderr}`);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const raw = [stdout, stderr].filter(Boolean).join("\n");
  const meta = parseRunMeta(stderr);
  return { output: stdout.trim(), raw, meta };
};
