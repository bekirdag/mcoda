import { spawn } from "node:child_process";
import os from "node:os";
import { safeProcessEnvironment } from "../tools/shell/AsyncProcess.js";
import type { OrchestrationConfig } from "../config/OrchestrationConfig.js";

/** A trusted evaluator child runs the CLI itself, so it needs only the declared
 * provider credentials. This is never used for model-requested shell tools. */
export function evaluationEnvironment(config: OrchestrationConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...safeProcessEnvironment(), HOME: os.homedir() };
  for (const provider of Object.values(config.providers)) {
    if (!provider.credentialRef?.startsWith("env:")) continue;
    const key = provider.credentialRef.slice(4);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function runEvaluationProcess(options: { file: string; args: string[]; cwd: string; config: OrchestrationConfig; timeoutMs: number; signal?: AbortSignal }): Promise<void> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("Invalid evaluator deadline");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [options.file, ...options.args], { cwd: options.cwd, env: evaluationEnvironment(options.config),
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let bytes = 0; let failure: Error | undefined; let escalation: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { if (process.platform !== "win32") process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal); }
    };
    const stop = () => { kill("SIGTERM"); escalation ??= setTimeout(() => kill("SIGKILL"), 3000); escalation.unref(); };
    const timeout = setTimeout(() => { failure = new Error("Evaluation stage deadline exceeded"); stop(); }, options.timeoutMs);
    const capture = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 131072) output += chunk.toString("utf8");
      else { failure ??= new Error("Evaluation stage output exceeded its bound"); stop(); }
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    options.signal?.addEventListener("abort", stop, { once: true }); if (options.signal?.aborted) stop();
    child.once("error", error => { failure = error; });
    child.once("close", (code, signal) => {
      clearTimeout(timeout); if (escalation) clearTimeout(escalation); options.signal?.removeEventListener("abort", stop);
      if (process.platform !== "win32") kill("SIGKILL");
      if (options.signal?.aborted) reject(options.signal.reason ?? new Error("Evaluation cancelled"));
      else if (failure) reject(failure);
      else if (code !== 0 || signal) reject(new Error(output.slice(-8000) || `Evaluation exited ${code ?? signal}`));
      else resolve();
    });
  });
}
