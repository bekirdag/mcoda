import { spawn, spawnSync } from "node:child_process";

export const ollamaHealthy = (throwOnError = false): { ok: boolean; details?: Record<string, unknown> } => {
  const result = spawnSync("ollama", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const details = {
      reason: result.error ? "missing_cli" : "cli_error",
      exitCode: result.status,
      stderr: result.stderr?.toString(),
      error: result.error?.message,
    };
    if (throwOnError) {
      const error = new Error(`AUTH_ERROR: ollama CLI unavailable (${details.reason})`);
      (error as any).details = details;
      throw error;
    }
    return { ok: false, details };
  }
  return { ok: true, details: { version: result.stdout?.toString().trim() } };
};

export const runOllamaExec = (prompt: string, model?: string): { output: string; raw: string } => {
  ollamaHealthy(true);
  const args = ["run", model ?? "llama3"];
  const result = spawnSync("ollama", args, { input: prompt, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const error = new Error(`AUTH_ERROR: ollama CLI failed (${result.error?.message ?? `exit ${result.status}`})`);
    (error as any).details = { reason: "cli_error", exitCode: result.status, stderr: result.stderr };
    throw error;
  }
  const stdout = result.stdout?.toString() ?? "";
  const output = stdout.trim();
  return { output, raw: stdout };
};

export async function* runOllamaExecStream(
  prompt: string,
  model?: string,
): AsyncGenerator<{ output: string; raw: string }, void, unknown> {
  ollamaHealthy(true);
  const args = ["run", model ?? "llama3"];
  const child = spawn("ollama", args, { stdio: ["pipe", "pipe", "pipe"] });
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
    const error = new Error(`AUTH_ERROR: ollama CLI failed (exit ${exitCode}): ${stderr || "no output"}`);
    (error as any).details = { reason: "cli_error", exitCode, stderr };
    throw error;
  }
}
