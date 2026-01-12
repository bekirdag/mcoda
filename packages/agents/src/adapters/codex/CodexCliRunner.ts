import { spawn, spawnSync } from "node:child_process";

const CODEX_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const CODEX_REASONING_ENV = "MCODA_CODEX_REASONING_EFFORT";
const CODEX_REASONING_ENV_FALLBACK = "CODEX_REASONING_EFFORT";

const normalizeReasoningEffort = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!["low", "medium", "high", "xhigh"].includes(normalized)) return undefined;
  return normalized;
};

const resolveReasoningEffort = (model?: string): string | undefined => {
  const configured = normalizeReasoningEffort(process.env[CODEX_REASONING_ENV] ?? process.env[CODEX_REASONING_ENV_FALLBACK]);
  const normalizedModel = (model ?? "").toLowerCase();
  const isGpt51 = normalizedModel.includes("gpt-5.1");
  if (configured) {
    if (configured === "xhigh" && isGpt51) return "high";
    return configured;
  }
  if (isGpt51) return "high";
  return undefined;
};

export const cliHealthy = (throwOnError = false): { ok: boolean; details?: Record<string, unknown> } => {
  if (process.env.MCODA_CLI_STUB === "1") {
    return { ok: true, details: { stub: true } };
  }
  if (process.env.MCODA_SKIP_CLI_CHECKS === "1") {
    return { ok: true, details: { skipped: true } };
  }
  const result = spawnSync("codex", ["--version"], { encoding: "utf8", maxBuffer: CODEX_MAX_BUFFER_BYTES });
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
  if (process.env.MCODA_CLI_STUB === "1") {
    const output = `qa-stub:${prompt}`;
    const raw = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: output } });
    return { output, raw };
  }
  const health = cliHealthy(true);
  const resolvedModel = model ?? "gpt-5.1-codex-max";
  const args = ["exec", "--model", resolvedModel, "--full-auto", "--json"];
  const reasoningEffort = resolveReasoningEffort(resolvedModel);
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
  const result = spawnSync("codex", args, {
    input: prompt,
    encoding: "utf8",
    maxBuffer: CODEX_MAX_BUFFER_BYTES,
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
  if (process.env.MCODA_CLI_STUB === "1") {
    const output = `qa-stub:${prompt}\n`;
    const raw = JSON.stringify({ type: "item.delta", item: { type: "agent_message", text: output } });
    yield { output, raw };
    return;
  }
  cliHealthy(true);
  const resolvedModel = model ?? "gpt-5.1-codex-max";
  const args = ["exec", "--model", resolvedModel, "--full-auto", "--json"];
  const reasoningEffort = resolveReasoningEffort(resolvedModel);
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${reasoningEffort}`);
  }
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

  const parseLine = (line: string): string | null => {
    try {
      const parsed = JSON.parse(line);
      const item = parsed?.item;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        return item.text;
      }
      // The codex CLI emits many JSONL event types (thread/turn/task/tool events).
      // We only want the agent's textual output here.
      return null;
    } catch {
      // `codex exec --json` is expected to emit JSONL, but it can still print non-JSON
      // preamble lines (e.g., "Reading prompt from stdin..."). Treat those as noise.
      return null;
    }
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
      const parsed = parseLine(normalized);
      if (!parsed) continue;
      const output = normalizeOutput(parsed);
      yield { output, raw: normalized };
    }
  }
  const trailing = buffer.replace(/\r$/, "");
  if (trailing) {
    const parsed = parseLine(trailing);
    if (parsed) {
      const output = normalizeOutput(parsed);
      yield { output, raw: trailing };
    }
  }

  const exitCode = await closePromise;
  if (exitCode !== 0) {
    const error = new Error(`AUTH_ERROR: codex CLI failed (exit ${exitCode}): ${stderr || "no output"}`);
    (error as any).details = { reason: "cli_error", exitCode, stderr };
    throw error;
  }
}
