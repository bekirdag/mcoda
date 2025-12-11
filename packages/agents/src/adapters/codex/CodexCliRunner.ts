import { spawnSync } from "node:child_process";

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
