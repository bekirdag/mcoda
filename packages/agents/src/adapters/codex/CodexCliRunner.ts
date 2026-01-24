import { spawn, spawnSync } from "node:child_process";

const CODEX_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const CODEX_REASONING_ENV = "MCODA_CODEX_REASONING_EFFORT";
const CODEX_REASONING_ENV_FALLBACK = "CODEX_REASONING_EFFORT";
const CODEX_NO_SANDBOX_ENV = "MCODA_CODEX_NO_SANDBOX";
const CODEX_STREAM_IO_ENV = "MCODA_STREAM_IO";
const CODEX_STREAM_IO_FORMAT_ENV = "MCODA_STREAM_IO_FORMAT";
const CODEX_STREAM_IO_COLOR_ENV = "MCODA_STREAM_IO_COLOR";
const CODEX_STREAM_IO_PREFIX = "codex-cli";

type AssistantTextEvent = { text: string; kind: "delta" | "final" };
type StreamLine = { text: string; indent?: number; color?: keyof typeof ANSI; bold?: boolean };

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
  gray: "\u001b[90m",
} as const;

const isStreamIoEnabled = (): boolean => {
  const raw = process.env[CODEX_STREAM_IO_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};

const isStreamIoRaw = (): boolean => {
  const raw = process.env[CODEX_STREAM_IO_FORMAT_ENV];
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return ["raw", "json", "jsonl"].includes(normalized);
};

const isStreamIoColorEnabled = (): boolean => {
  const raw = process.env[CODEX_STREAM_IO_COLOR_ENV];
  if (!raw) return true;
  const normalized = raw.trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(normalized);
};

const resolveSandboxArgs = (): { args: string[]; bypass: boolean } => {
  const raw = process.env[CODEX_NO_SANDBOX_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { args: ["--dangerously-bypass-approvals-and-sandbox"], bypass: true };
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "0") {
    return { args: [], bypass: false };
  }
  return { args: ["--dangerously-bypass-approvals-and-sandbox"], bypass: true };
};

let streamIoQueue = Promise.resolve();

const emitStreamIoLine = (line: string): void => {
  if (!isStreamIoEnabled()) return;
  const normalized = line.endsWith("\n") ? line : `${line}\n`;
  streamIoQueue = streamIoQueue
    .then(
      () =>
        new Promise<void>((resolve) => {
          try {
            process.stderr.write(normalized, () => resolve());
          } catch {
            resolve();
          }
        }),
    )
    .catch(() => {});
};

const safeJsonParse = (line: string): any | null => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const colorize = (text: string, color?: keyof typeof ANSI, bold = false): string => {
  if (!isStreamIoColorEnabled()) return text;
  const colorCode = color ? ANSI[color] : "";
  const boldCode = bold ? ANSI.bold : "";
  if (!colorCode && !boldCode) return text;
  return `${boldCode}${colorCode}${text}${ANSI.reset}`;
};

const formatTextLines = (prefix: string, text: string | undefined | null, color?: keyof typeof ANSI): StreamLine[] => {
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  const output: StreamLine[] = [];
  for (const line of lines) {
    if (!line.trim()) {
      output.push({ text: "", color });
      continue;
    }
    output.push({ text: `${prefix}${line}`, color });
  }
  while (output.length && !output[0].text.trim()) output.shift();
  while (output.length && !output[output.length - 1].text.trim()) output.pop();
  return output;
};

const extractItemText = (item: any): string => {
  if (!item) return "";
  if (typeof item.text === "string") return item.text;
  if (Array.isArray(item.content)) {
    return item.content
      .map((entry: any) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
};

const normalizeValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  if (trimmed.length > 200000) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
};

const formatValueLines = (
  value: unknown,
  indent: number,
  depth = 0,
  maxDepth = Number.POSITIVE_INFINITY,
  maxLines = Number.POSITIVE_INFINITY,
): StreamLine[] => {
  const lines: StreamLine[] = [];
  if (lines.length >= maxLines) return lines;
  const normalized = normalizeValue(value);
  if (depth >= maxDepth) {
    lines.push({ text: "…", indent, color: "gray" });
    return lines;
  }
  if (normalized === null || normalized === undefined) {
    lines.push({ text: String(normalized), indent, color: "gray" });
    return lines;
  }
  if (typeof normalized === "string") {
    const entries = normalized.split(/\r?\n/);
    for (const entry of entries) {
      if (!entry.trim()) {
        lines.push({ text: "", indent });
        continue;
      }
      lines.push({ text: entry, indent });
      if (lines.length >= maxLines) break;
    }
    return lines;
  }
  if (typeof normalized !== "object") {
    lines.push({ text: String(normalized), indent });
    return lines;
  }
  if (Array.isArray(normalized)) {
    if (normalized.length === 0) {
      lines.push({ text: "[]", indent, color: "gray" });
      return lines;
    }
    for (const entry of normalized) {
      if (lines.length >= maxLines) break;
      const normalizedEntry = normalizeValue(entry);
      if (normalizedEntry !== null && typeof normalizedEntry === "object") {
        lines.push({ text: "-", indent });
        lines.push(...formatValueLines(normalizedEntry, indent + 1, depth + 1, maxDepth, maxLines));
        continue;
      }
      if (typeof normalizedEntry === "string" && normalizedEntry.includes("\n")) {
        lines.push({ text: "-", indent });
        lines.push(...formatValueLines(normalizedEntry, indent + 1, depth + 1, maxDepth, maxLines));
        continue;
      }
      lines.push({ text: `- ${String(normalizedEntry)}`, indent });
    }
    if (normalized.length + 1 > maxLines) {
      lines.push({ text: "…", indent, color: "gray" });
    }
    return lines;
  }
  const keys = Object.keys(normalized as Record<string, unknown>);
  if (!keys.length) {
    lines.push({ text: "{}", indent, color: "gray" });
    return lines;
  }
  for (const key of keys) {
    if (lines.length >= maxLines) break;
    const entry = (normalized as Record<string, unknown>)[key];
    const normalizedEntry = normalizeValue(entry);
    if (normalizedEntry !== null && typeof normalizedEntry === "object") {
      lines.push({ text: `${key}:`, indent });
      lines.push(...formatValueLines(normalizedEntry, indent + 1, depth + 1, maxDepth, maxLines));
      continue;
    }
    if (typeof normalizedEntry === "string" && normalizedEntry.includes("\n")) {
      lines.push({ text: `${key}:`, indent });
      lines.push(...formatValueLines(normalizedEntry, indent + 1, depth + 1, maxDepth, maxLines));
      continue;
    }
    const valueText = normalizedEntry === null || normalizedEntry === undefined ? String(normalizedEntry) : String(normalizedEntry);
    lines.push({ text: `${key}: ${valueText}`, indent });
  }
  if (keys.length + 1 > maxLines) {
    lines.push({ text: "…", indent, color: "gray" });
  }
  return lines;
};

const formatValueBlock = (title: string, value: unknown, indent: number, color?: keyof typeof ANSI): StreamLine[] => {
  const lines: StreamLine[] = [{ text: title, indent, color, bold: true }];
  lines.push(...formatValueLines(value, indent + 1));
  return lines;
};

const statusColor = (status: string | undefined): keyof typeof ANSI | undefined => {
  if (!status) return undefined;
  const normalized = status.toLowerCase();
  if (["failed", "error", "cancelled"].includes(normalized)) return "red";
  if (["completed", "succeeded", "success"].includes(normalized)) return "green";
  if (["in_progress", "started", "running"].includes(normalized)) return "yellow";
  return undefined;
};

const formatItemEvent = (eventType: string, item: any): StreamLine[] => {
  const verb = eventType.replace("item.", "");
  const itemTypeRaw = item?.item_type ?? item?.itemType ?? item?.type ?? "unknown";
  const itemType = String(itemTypeRaw);
  const id = item?.id ? ` id=${item.id}` : "";
  let status = item?.status ? String(item.status) : verb;
  let headerColor = statusColor(status);
  if (item?.error || itemType.toLowerCase().includes("error")) {
    headerColor = "red";
  }
  const lines: StreamLine[] = [
    { text: `${itemType} (${status})${id}`, color: headerColor, bold: true },
  ];

  switch (itemType.toLowerCase()) {
    case "reasoning": {
      lines.push(...formatTextLines("reasoning: ", item?.text, "magenta").map((line) => ({ ...line, indent: 1 })));
      break;
    }
    case "assistant_message":
    case "agent_message": {
      const text = extractItemText(item);
      lines.push(...formatTextLines("assistant: ", text, "green").map((line) => ({ ...line, indent: 1 })));
      break;
    }
    case "command_execution": {
      const command = item?.command ? ` command="${item.command}"` : "";
      const exitCode = item?.exit_code ?? item?.exitCode;
      const rawCommand = typeof item?.command === "string" ? item.command : "";
      const rgNoMatch =
        exitCode === 1 &&
        rawCommand.includes("rg ") &&
        (!item?.aggregated_output || String(item.aggregated_output).trim().length === 0);
      if (rgNoMatch) {
        status = "no_matches";
        headerColor = "yellow";
      } else if (exitCode !== undefined && exitCode !== 0) {
        headerColor = "red";
      }
      const exitText = exitCode !== undefined ? ` exit=${exitCode}` : "";
      const statusLine = `${itemType} (${status})${id}${exitText}${command}`;
      lines[0] = { text: statusLine, color: headerColor, bold: true };
      if (item?.aggregated_output) {
        lines.push({ text: "output:", indent: 1, color: "gray", bold: true });
        const outputColor = exitCode !== undefined && exitCode !== 0 && !rgNoMatch ? "red" : undefined;
        lines.push(...formatTextLines("", item.aggregated_output, outputColor).map((line) => ({ ...line, indent: 2 })));
      }
      break;
    }
    case "file_change": {
      const changes = Array.isArray(item?.changes) ? item.changes : [];
      for (const change of changes) {
        const kind = change?.kind ? String(change.kind) : "update";
        const path = change?.path ? String(change.path) : "unknown";
        const changeColor = kind === "add" ? "green" : kind === "delete" ? "red" : "yellow";
        lines.push({ text: `file_change: ${kind} ${path}`, indent: 1, color: changeColor });
      }
      break;
    }
    case "mcp_tool_call": {
      const server = item?.server ? String(item.server) : "mcp";
      const tool = item?.tool ? String(item.tool) : "tool";
      if (item?.error) {
        headerColor = "red";
      }
      lines[0] = { text: `tool: ${server}.${tool} (${status})${id}`, color: headerColor, bold: true };
      if (item?.arguments !== undefined) {
        lines.push(...formatValueBlock("args:", item.arguments, 1, "blue"));
      }
      if (item?.error) {
        lines.push(...formatValueBlock("error:", item.error, 1, "red"));
      }
      if (item?.result) {
        lines.push(...formatValueBlock("result:", item.result, 1, "green"));
      }
      break;
    }
    case "web_search": {
      if (item?.query) {
        lines.push({ text: `web_search: ${String(item.query)}`, indent: 1, color: "blue" });
      }
      break;
    }
    case "error": {
      if (item?.message) {
        lines.push({ text: `error: ${String(item.message)}`, indent: 1, color: "red" });
      }
      break;
    }
    default: {
      const text = extractItemText(item);
      if (text) {
        lines.push(...formatTextLines("text: ", text).map((line) => ({ ...line, indent: 1 })));
      }
      break;
    }
  }

  return lines;
};

const formatCodexEvent = (parsed: any): StreamLine[] => {
  const type = typeof parsed?.type === "string" ? parsed.type : "unknown";
  if (type === "thread.started") {
    const id = parsed.thread_id ?? parsed.threadId ?? "";
    return [{ text: `Thread started${id ? ` (id=${id})` : ""}`, color: "cyan", bold: true }];
  }
  if (type === "turn.started") return [{ text: "Turn started", color: "cyan", bold: true }];
  if (type === "turn.completed") {
    const usage = parsed?.usage ?? {};
    const parts: string[] = [];
    if (typeof usage.input_tokens === "number") parts.push(`input=${usage.input_tokens}`);
    if (typeof usage.cached_input_tokens === "number") parts.push(`cached=${usage.cached_input_tokens}`);
    if (typeof usage.output_tokens === "number") parts.push(`output=${usage.output_tokens}`);
    const suffix = parts.length ? ` usage(${parts.join(",")})` : "";
    return [{ text: `Turn completed${suffix}`, color: "green", bold: true }];
  }
  if (type === "turn.failed") {
    const message = parsed?.error?.message ?? parsed?.error ?? "";
    return [{ text: `Turn failed${message ? `: ${String(message)}` : ""}`, color: "red", bold: true }];
  }
  if (type.startsWith("output_text.")) {
    const event = extractAssistantText(parsed);
    if (event) return formatTextLines("assistant: ", event.text, "green");
    return [{ text: type, color: "gray" }];
  }
  if (type.startsWith("item.")) {
    return formatItemEvent(type, parsed?.item ?? {});
  }
  if (type === "error" && parsed?.message) {
    return [{ text: `error: ${String(parsed.message)}`, color: "red", bold: true }];
  }
  return [{ text: type, color: "gray" }];
};

const createStreamFormatter = (model?: string) => {
  let started = false;
  let lastWasBlank = true;
  let assistantBuffer = "";
  let assistantActive = false;
  const baseIndent = 1;

  const emitLine = (line: StreamLine) => {
    if (!line.text) {
      emitBlank();
      return;
    }
    const indent = "  ".repeat(baseIndent + (line.indent ?? 0));
    const text = colorize(line.text, line.color, line.bold);
    emitStreamIoLine(`${indent}${text}`);
    lastWasBlank = false;
  };

  const emitBlank = () => {
    emitStreamIoLine("");
    lastWasBlank = true;
  };

  const start = () => {
    if (started) return;
    started = true;
    const headerDetails = model ? ` (model=${model})` : "";
    emitStreamIoLine(colorize(`${CODEX_STREAM_IO_PREFIX} ------- output start --------${headerDetails}`, "cyan", true));
    emitBlank();
  };

  const end = () => {
    if (!started) return;
    flushAssistant(true);
    if (!lastWasBlank) emitBlank();
    emitStreamIoLine(colorize(`${CODEX_STREAM_IO_PREFIX} ------- output end --------`, "cyan", true));
    emitBlank();
  };

  const emitLines = (lines: StreamLine[], blankBefore = true) => {
    if (!lines.length) return;
    start();
    if (blankBefore && !lastWasBlank) emitBlank();
    for (const line of lines) emitLine(line);
  };

  const flushAssistant = (force = false) => {
    if (!assistantBuffer) return;
    if (!force && !assistantBuffer.includes("\n")) return;
    const chunks = assistantBuffer.split(/\r?\n/);
    const trailing = assistantBuffer.endsWith("\n") ? "" : chunks.pop() ?? "";
    const lines: StreamLine[] = [];
    for (const rawLine of chunks) {
      const line = rawLine.trimEnd();
      if (!line.trim()) {
        lines.push({ text: "" });
        continue;
      }
      lines.push({ text: `assistant: ${line}`, color: "green" });
    }
    if (lines.length) {
      emitLines(lines, !assistantActive);
      assistantActive = true;
    }
    assistantBuffer = trailing ?? "";
    if (force && assistantBuffer.trim()) {
      emitLines([{ text: `assistant: ${assistantBuffer.trimEnd()}`, color: "green" }], !assistantActive);
      assistantBuffer = "";
      assistantActive = false;
    }
    if (force && !assistantBuffer) {
      assistantActive = false;
    }
  };

  const handleLine = (line: string) => {
    if (!isStreamIoEnabled()) return;
    start();
    if (isStreamIoRaw()) {
      emitLine({ text: line });
      return;
    }
    const parsed = safeJsonParse(line);
    if (!parsed) {
      emitLine({ text: line });
      return;
    }
    const type = typeof parsed?.type === "string" ? parsed.type : "";
    if (type.startsWith("output_text.")) {
      const event = extractAssistantText(parsed);
      if (event?.text) {
        assistantBuffer += event.text;
        flushAssistant(event.kind === "final");
        return;
      }
    }
    if (assistantActive) {
      flushAssistant(true);
    }
    const formatted = formatCodexEvent(parsed);
    emitLines(formatted, true);
  };

  return { handleLine, end };
};

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

const extractAssistantText = (parsed: any): AssistantTextEvent | null => {
  if (!parsed || typeof parsed !== "object") return null;
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type.includes("output_text.delta") && typeof parsed.delta === "string") {
    return { text: parsed.delta, kind: "delta" };
  }
  if (type.includes("output_text.done") && typeof parsed.text === "string") {
    return { text: parsed.text, kind: "final" };
  }
  const item = parsed.item;
  const itemType = item?.item_type ?? item?.itemType ?? item?.type;
  if (!itemType) return null;
  const normalizedType = String(itemType).toLowerCase();
  if (normalizedType !== "assistant_message" && normalizedType !== "agent_message") return null;
  if (typeof item.delta === "string") {
    return { text: item.delta, kind: "delta" };
  }
  if (Array.isArray(item.delta)) {
    const parts = item.delta
      .map((entry: any) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("");
    if (parts) {
      return { text: parts, kind: "delta" };
    }
  }
  const isFinal = type.includes("completed") || type.includes("done");
  if (typeof item.text === "string" && isFinal) {
    return { text: item.text, kind: "final" };
  }
  if (Array.isArray(item.content) && isFinal) {
    const parts = item.content
      .map((entry: any) => (typeof entry?.text === "string" ? entry.text : ""))
      .filter(Boolean)
      .join("");
    if (parts) {
      return { text: parts, kind: "final" };
    }
  }
  return null;
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
  const sandboxArgs = resolveSandboxArgs();
  const args = [...sandboxArgs.args, "exec", "--model", resolvedModel, "--json"];
  if (!sandboxArgs.bypass) {
    args.push("--full-auto");
  }
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
  let message = "";
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const event = extractAssistantText(parsed);
      if (!event) continue;
      if (event.kind === "delta") {
        message += event.text;
        continue;
      }
      message = event.text;
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
  const sandboxArgs = resolveSandboxArgs();
  const args = [...sandboxArgs.args, "exec", "--model", resolvedModel, "--json"];
  if (!sandboxArgs.bypass) {
    args.push("--full-auto");
  }
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

  const parseLine = (line: string): AssistantTextEvent | null => {
    try {
      const parsed = JSON.parse(line);
      return extractAssistantText(parsed);
    } catch {
      return null;
    }
  };

  const stream = child.stdout;
  stream?.setEncoding("utf8");
  const formatter = createStreamFormatter(resolvedModel);
  let buffer = "";
  let sawDelta = false;
  let streamError: Error | null = null;
  try {
    for await (const chunk of stream ?? []) {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const normalized = line.replace(/\r$/, "");
        formatter.handleLine(normalized);
        const parsed = parseLine(normalized);
        if (!parsed) continue;
        if (parsed.kind === "delta") {
          sawDelta = true;
          yield { output: parsed.text, raw: normalized };
          continue;
        }
        if (!sawDelta) {
          const output = parsed.text.endsWith("\n") ? parsed.text : `${parsed.text}\n`;
          yield { output, raw: normalized };
        }
        sawDelta = false;
      }
    }
    const trailing = buffer.replace(/\r$/, "");
    if (trailing) {
      formatter.handleLine(trailing);
      const parsed = parseLine(trailing);
      if (parsed) {
        if (parsed.kind === "delta") {
          sawDelta = true;
          yield { output: parsed.text, raw: trailing };
        } else if (!sawDelta) {
          const output = parsed.text.endsWith("\n") ? parsed.text : `${parsed.text}\n`;
          yield { output, raw: trailing };
          sawDelta = false;
        }
      }
    }
  } catch (error) {
    streamError = error as Error;
  }

  const exitCode = await closePromise;
  if (exitCode !== 0) {
    formatter.handleLine(
      JSON.stringify({
        type: "error",
        message: `codex exec failed with exit ${exitCode}: ${stderr || "no output"}`,
      }),
    );
    const error = new Error(`AUTH_ERROR: codex CLI failed (exit ${exitCode}): ${stderr || "no output"}`);
    (error as any).details = { reason: "cli_error", exitCode, stderr };
    formatter.end();
    if (streamError) {
      throw streamError;
    }
    throw error;
  }
  formatter.end();
  if (streamError) {
    throw streamError;
  }
}
