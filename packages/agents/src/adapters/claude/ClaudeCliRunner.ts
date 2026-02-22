import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const CLAUDE_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const CLAUDE_BIN_ENV = "MCODA_CLAUDE_CLI_BIN";
const CLAUDE_STUB_ENV = "MCODA_CLAUDE_STUB";
const GLOBAL_STUB_ENV = "MCODA_CLI_STUB";
const SKIP_CLI_CHECKS_ENV = "MCODA_SKIP_CLI_CHECKS";

const resolveString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const candidateBinaries = (): string[] => {
  const override = resolveString(process.env[CLAUDE_BIN_ENV]);
  if (override) return [override];
  return ["claude", path.join(os.homedir(), ".local", "bin", "claude")];
};

const isStubEnabled = (): boolean => {
  return process.env[CLAUDE_STUB_ENV] === "1" || process.env[GLOBAL_STUB_ENV] === "1";
};

const buildArgs = (model?: string): string[] => {
  const args = ["--print", "--output-format", "text"];
  if (model) args.push("--model", model);
  return args;
};

const resolveBinaryForRun = (details?: Record<string, unknown>): string => {
  const explicit = resolveString(details?.binary);
  if (explicit) return explicit;
  return candidateBinaries()[0];
};

export const claudeHealthy = (throwOnError = false): { ok: boolean; details?: Record<string, unknown> } => {
  if (isStubEnabled()) {
    return { ok: true, details: { stub: true } };
  }
  if (process.env[SKIP_CLI_CHECKS_ENV] === "1") {
    return { ok: true, details: { skipped: true, binary: candidateBinaries()[0] } };
  }

  let lastFailure: Record<string, unknown> | undefined;
  for (const binary of candidateBinaries()) {
    const result = spawnSync(binary, ["--version"], {
      encoding: "utf8",
      maxBuffer: CLAUDE_MAX_BUFFER_BYTES,
    });
    if (!result.error && result.status === 0) {
      return {
        ok: true,
        details: {
          binary,
          version: result.stdout?.toString().trim(),
        },
      };
    }
    lastFailure = {
      binary,
      reason: result.error ? "missing_cli" : "cli_error",
      exitCode: result.status,
      stderr: result.stderr?.toString(),
      error: result.error?.message,
    };
  }

  if (throwOnError) {
    const reason = String(lastFailure?.reason ?? "missing_cli");
    const error = new Error(`AUTH_ERROR: claude CLI unavailable (${reason})`);
    (error as any).details = lastFailure;
    throw error;
  }
  return { ok: false, details: lastFailure };
};

export const runClaudeExec = (prompt: string, model?: string): { output: string; raw: string } => {
  if (isStubEnabled()) {
    const output = `claude-stub:${prompt}`;
    return { output, raw: output };
  }

  const health = claudeHealthy(true);
  const binary = resolveBinaryForRun(health.details);
  const result = spawnSync(binary, buildArgs(model), {
    input: prompt,
    encoding: "utf8",
    maxBuffer: CLAUDE_MAX_BUFFER_BYTES,
  });
  const stderr = result.stderr?.toString().trim();
  const stdout = result.stdout?.toString() ?? "";
  const diagnostic = stderr || stdout.trim();
  if (result.error || result.status !== 0) {
    const details = {
      reason: "cli_error",
      binary,
      exitCode: result.status,
      stderr,
      stdout,
      error: result.error?.message,
    };
    const reason = result.error?.message ?? `exit ${result.status}`;
    const error = new Error(`AUTH_ERROR: claude CLI failed (${reason})${diagnostic ? `: ${diagnostic}` : ""}`);
    (error as any).details = details;
    throw error;
  }

  return { output: stdout.trim(), raw: stdout };
};

export async function* runClaudeExecStream(
  prompt: string,
  model?: string,
): AsyncGenerator<{ output: string; raw: string }, void, unknown> {
  if (isStubEnabled()) {
    const output = `claude-stub:${prompt}\n`;
    yield { output, raw: output };
    return;
  }

  const health = claudeHealthy(true);
  const binary = resolveBinaryForRun(health.details);
  const child = spawn(binary, buildArgs(model), { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.write(prompt);
  child.stdin.end();

  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const closePromise = new Promise<number>((resolve, reject) => {
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve(code ?? 0));
  });

  const stream = child.stdout;
  stream?.setEncoding("utf8");
  for await (const chunk of stream ?? []) {
    if (!chunk) continue;
    yield { output: chunk, raw: chunk };
  }

  const exitCode = await closePromise;
  if (exitCode !== 0) {
    const error = new Error(`AUTH_ERROR: claude CLI failed (exit ${exitCode}): ${stderr || "no output"}`);
    (error as any).details = { reason: "cli_error", binary, exitCode, stderr };
    throw error;
  }
}
