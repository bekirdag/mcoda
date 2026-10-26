import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { ToolExecutionError, type ToolContext, type ToolHandlerResult } from "../ToolTypes.js";

export const safeProcessEnvironment = (): NodeJS.ProcessEnv => Object.fromEntries(
  ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "TMPDIR", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]),
);

/** Host executor settings, never populated from model-supplied tool arguments. */
export interface ProcessEnvironment { HOME?: string; TMPDIR?: string; PATH?: string; }

export const runProcess = (command: string, args: string[], context: ToolContext, environment: ProcessEnvironment = {}): Promise<ToolHandlerResult> => {
  context.signal?.throwIfAborted();
  const timeoutMs = context.shellTimeoutMs ?? 120_000;
  const maxBytes = context.shellMaxOutputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid process limits");
  return new Promise((resolve, reject) => {
    const group = process.platform !== "win32";
    const env = safeProcessEnvironment();
    for (const key of ["HOME", "TMPDIR", "PATH"] as const) if (typeof environment[key] === "string") env[key] = environment[key];
    const child = spawn(command, args, { cwd: context.workspaceRoot, env, detached: group, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = ""; let captured = 0; let truncated = false; let timedOut = false;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (group) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
    };
    const stop = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 1000); escalation.unref(); };
    const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const append = (stream: "stdout" | "stderr", text: string) => {
      if (stream === "stdout") stdout += text; else stderr += text;
      if (text) { try { context.onOutput?.(stream, text); } catch { /* Rendering cannot abandon process cleanup. */ } }
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const remaining = Math.max(0, maxBytes - captured);
      if (chunk.length > remaining) truncated = true;
      const text = decoders[stream].write(chunk.subarray(0, remaining)); captured += Math.min(chunk.length, remaining);
      append(stream, text);
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    context.signal?.addEventListener("abort", stop, { once: true });
    if (context.signal?.aborted) stop();
    const cleanup = () => { clearTimeout(timeout); if (escalation) clearTimeout(escalation); context.signal?.removeEventListener("abort", stop); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (exitCode, signal) => {
      cleanup();
      append("stdout", decoders.stdout.end()); append("stderr", decoders.stderr.end());
      if (group) kill("SIGKILL");
      const details = { command, args, exitCode, signal, stdout, stderr, truncated, timedOut };
      if (context.signal?.aborted) { reject(context.signal.reason ?? new Error("Process cancelled")); return; }
      if (timedOut) { reject(new ToolExecutionError("tool_timeout", "Process deadline exceeded", { retryable: false, details })); return; }
      if (exitCode !== 0 || signal) { reject(new ToolExecutionError("tool_execution_failed", stderr || stdout || `Process terminated (${signal ?? exitCode})`, { retryable: false, details })); return; }
      resolve({ output: (stdout || stderr) + (truncated ? "\n[output truncated]" : ""), data: details });
    });
  });
};
