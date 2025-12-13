import { spawn, spawnSync } from "node:child_process";

export const cliHealthy = (throwOnError = false): { ok: boolean; details?: Record<string, unknown> } => {
  if (process.env.MCODA_SKIP_CLI_CHECKS === "1") {
    return { ok: true, details: { skipped: true } };
  }
  const result = spawnSync("codex", ["--version"], { encoding: "utf8" });
  if (result.error) {
    const details = { reason: "missing_cli", error: result.error.message };
    if (throwOnError) {
      const error = new Error(`AUTH_ERROR: codex CLI unavailable (${details.reason})`);
      (error as any).details = details;
      throw error;
    }
    return { ok: false, details };
  }
  if (result.status !== 0) {
    const details = { reason: "cli_error", exitCode: result.status, stderr: result.stderr?.toString() };
    if (throwOnError) {
      const error = new Error(`AUTH_ERROR: codex CLI unavailable (${details.reason})`);
      (error as any).details = details;
      throw error;
    }
    return { ok: false, details };
  }
  return { ok: true, details: { version: result.stdout?.toString().trim() } };
};

export const runCodexExec = (prompt: string, model?: string): { output: string; raw: string } => {
  const health = cliHealthy(true);
  const args = ["exec", "--model", model ?? "gpt-5.1-codex-max", "--full-auto", "--json"];
  const result = spawnSync("codex", args, {
    input: prompt,
    encoding: "utf8",
  });
  if (result.error) {
    const error = new Error(`AUTH_ERROR: codex CLI failed (${result.error.message})`);
    (error as any).details = { reason: "cli_error", cli: health.details };
    throw error;
  }
  if (result.status !== 0) {
    const error = new Error(`AUTH_ERROR: codex CLI failed (exit ${result.status}): ${result.stderr ?? result.stdout ?? ""}`);
    (error as any).details = { reason: "cli_error", exitCode: result.status, stderr: result.stderr };
    throw error;
  }

  const raw = result.stdout?.toString() ?? "";
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let message: string | undefined;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === "item.completed" && parsed?.item?.type === "agent_message" && typeof parsed?.item?.text === "string") {
        message = parsed.item.text;
      }
    } catch {
      /* ignore parse errors */
    }
  }
  if (!message) {
    message = lines[lines.length - 1] ?? "";
  }
  return { output: message.trim(), raw };
};

export async function* runCodexExecStream(
  prompt: string,
  model?: string,
): AsyncGenerator<{ output: string; raw: string }, void, unknown> {
  cliHealthy(true);
  const args = ["exec", "--model", model ?? "gpt-5.1-codex-max", "--full-auto", "--json"];
  const child = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"] });
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

  const parseLine = (line: string): string => {
    try {
      const parsed = JSON.parse(line);
      const item = parsed?.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        return item.text;
      }
    } catch {
      /* ignore parse errors */
    }
    return line;
  };

  const normalizeOutput = (value: string): string => (value.endsWith("\n") ? value : `${value}\n`);

  const stream = child.stdout;
  stream?.setEncoding("utf8");
  let buffer = "";
  for await (const chunk of stream ?? []) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const normalized = line.replace(/\r$/, "");
      const output = normalizeOutput(parseLine(normalized));
      yield { output, raw: normalized };
    }
  }
  const trailing = buffer.replace(/\r$/, "");
  if (trailing) {
    const output = parseLine(trailing);
    yield { output, raw: trailing };
  }

  const exitCode = await closePromise;
  if (exitCode !== 0) {
    const error = new Error(`AUTH_ERROR: codex CLI failed (exit ${exitCode}): ${stderr || "no output"}`);
    (error as any).details = { reason: "cli_error", exitCode, stderr };
    throw error;
  }
}
