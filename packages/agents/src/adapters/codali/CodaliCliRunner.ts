import { spawn, spawnSync } from "node:child_process";
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

export const buildEnv = (options: CodaliCliOptions): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };
  // Codali must never run under a sandboxed codex shell.
  env.MCODA_CODEX_NO_SANDBOX = "1";
  const apiKey = options.apiKey ?? env.CODALI_API_KEY;
  if (apiKey) {
    env.CODALI_API_KEY = apiKey;
  }
  if (options.baseUrl && !env.CODALI_BASE_URL) {
    env.CODALI_BASE_URL = options.baseUrl;
  }
  return env;
};

const parseRunMetaLine = (line: string): Record<string, unknown> | undefined => {
  if (!line.startsWith("CODALI_RUN_META ")) return undefined;
  const payload = line.slice("CODALI_RUN_META ".length).trim();
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

const parseRunMeta = (stderr: string | undefined): Record<string, unknown> | undefined => {
  if (!stderr) return undefined;
  const lines = stderr.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    const parsed = parseRunMetaLine(line);
    if (parsed) return parsed;
  }
  return undefined;
};

export async function* runCodaliStream(
  input: string,
  options: CodaliCliOptions,
): AsyncGenerator<{ output: string; meta?: Record<string, unknown> }> {
  if (process.env[CODALI_STUB_ENV] === "1") {
    yield { output: `codali-stub:${input}` };
    return;
  }

  const bin = process.env[CODALI_BIN_ENV] ?? "codali";
  const args = buildArgs(options);
  const env = buildEnv(options);
  const child = spawn(bin, args, {
    cwd: path.resolve(options.workspaceRoot),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuffer = "";
  let stderr = "";
  let meta: Record<string, unknown> | undefined;
  let exitCode: number | null = null;
  let spawnError: Error | null = null;
  let done = false;
  const queue: string[] = [];
  let notify: (() => void) | null = null;

  const push = (line: string) => {
    if (!line) return;
    queue.push(line);
    if (notify) {
      notify();
      notify = null;
    }
  };

  const handleStderrLine = (line: string) => {
    const parsed = parseRunMetaLine(line);
    if (parsed) {
      meta = parsed;
      return;
    }
    stderr += `${line}\n`;
    push(`${line}\n`);
  };

  child.stdout.on("data", (chunk) => {
    push(chunk.toString());
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      handleStderrLine(line);
    }
  });

  child.on("error", (error) => {
    spawnError = error;
    done = true;
    if (notify) {
      notify();
      notify = null;
    }
  });

  child.on("close", (code) => {
    exitCode = code ?? 0;
    if (stderrBuffer.trim()) {
      handleStderrLine(stderrBuffer.trim());
    }
    done = true;
    if (notify) {
      notify();
      notify = null;
    }
  });

  child.stdin.write(input);
  child.stdin.end();

  while (!done || queue.length > 0) {
    if (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) {
        yield { output: next };
      }
      continue;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  }

  if (spawnError) {
    throw spawnError;
  }
  if (exitCode !== 0) {
    throw new Error(`codali CLI failed: ${stderr}`.trim());
  }

  if (meta) {
    yield { output: "", meta };
  }
}

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
  const env = buildEnv(options);

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
