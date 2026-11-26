import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor, executorStatus, type ExecutorStatus } from "../shell/IsolatedExecutor.js";
import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

const MAX_SOURCE = 48_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
/** What the model reads back; the whole output stays in the receipt's data. */
const RETURNED_CHARS = 12_000;

/** Address-space cap for Python programs; JavaScript gets a 256 MB heap like the other sandboxed workers. */
export const PYTHON_MEMORY_BYTES = 1024 * 1024 * 1024;
// The sandbox probe is a blocking child process (up to 3 s, 20 s when the host is
// slow): run it once per process, not on every call. An unavailable result is not
// cached, so a host that was only overloaded can still recover.
let availableStatus: ExecutorStatus | undefined;
const sandboxStatus = (): ExecutorStatus => {
  if (availableStatus) return availableStatus;
  const status = executorStatus();
  if (status.available) availableStatus = status;
  return status;
};
/** Python launcher: cap memory, then run main.py as __main__ (tracebacks still name main.py). */
const PYTHON_LAUNCHER = `import resource,runpy,sys\ntry:\n resource.setrlimit(resource.RLIMIT_AS,(${PYTHON_MEMORY_BYTES},${PYTHON_MEMORY_BYTES}))\nexcept (ValueError,OSError): pass\nsys.argv=['main.py']\nrunpy.run_path('main.py',run_name='__main__')`;

const excerpt = (text: string, limit: number): { text: string; clipped: boolean } => text.length <= limit
  ? { text, clipped: false } : { text: `${text.slice(0, Math.floor(limit * 0.4))}\n[... ${text.length - limit} characters omitted ...]\n${text.slice(-Math.floor(limit * 0.6))}`, clipped: true };

/** Run a program and return what it printed. Models used verify_javascript with
 * made-up expectations ({"placeholder":1}) only to see a value, 69 of 74 times in
 * cycle 7, and Python had only a test runner, so a script that printed its table
 * and then raised was reported as "could not start". Here a run that exits
 * non-zero is still a successful receipt: its output and error are the evidence. */
export const createCodeRunTool = (): ToolDefinition => ({
  name: "run_code", capability: "verification", readOnly: true,
  description: "Run a self-contained Python 3 or JavaScript (Node ES module) program offline and return its printed stdout, stderr and exit code; use it to compute, simulate or enumerate and print the results. A crash still returns what was printed. Standard library only; no input, network, workspace or credentials.",
  inputSchema: { type: "object", properties: {
    language: { type: "string", enum: ["python", "javascript"] },
    source: { type: "string", minLength: 1, maxLength: MAX_SOURCE },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 },
  }, required: ["language", "source"], additionalProperties: false },
  handler: async (raw, context) => {
    context.signal?.throwIfAborted();
    const args = raw as { language: "python" | "javascript"; source: string; timeoutSeconds?: number };
    if (!["python", "javascript"].includes(args.language) || typeof args.source !== "string" || !args.source.trim() || args.source.length > MAX_SOURCE
      || args.timeoutSeconds !== undefined && (!Number.isInteger(args.timeoutSeconds) || args.timeoutSeconds < 1 || args.timeoutSeconds > 120)) {
      throw new ToolExecutionError("tool_invalid_args", `Supply language "python" or "javascript" and the program as source (up to ${MAX_SOURCE} characters); timeoutSeconds 1-120`);
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-run-"));
    const started = Date.now();
    try {
      await fs.chmod(root, 0o700);
      const file = args.language === "python" ? "main.py" : "main.mjs";
      await fs.writeFile(path.join(root, file), args.source, { mode: 0o600 });
      // The program has no input: stdin is closed, and the workspace is not mounted.
      const command = args.language === "python" ? "python3" : process.execPath;
      const commandArgs = args.language === "python" ? ["-I", "-B", "-c", PYTHON_LAUNCHER] : ["--max-old-space-size=256", "--no-warnings", file];
      let stdout = "", stderr = "", exitCode: number | null = 0, timedOut = false, truncated = false;
      try {
        const run = await createIsolatedExecutor({ network: false, status: sandboxStatus() })(command, commandArgs,
          { workspaceRoot: root, signal: context.signal, allowedWritePaths: [], shellTimeoutMs: (args.timeoutSeconds ?? 30) * 1000, shellMaxOutputBytes: MAX_OUTPUT_BYTES });
        const data = run.data as { stdout: string; stderr: string; truncated: boolean };
        stdout = data.stdout; stderr = data.stderr; truncated = data.truncated;
      } catch (error) {
        context.signal?.throwIfAborted();
        if (!(error instanceof ToolExecutionError) || !["tool_execution_failed", "tool_timeout"].includes(error.code) || !error.details) throw error;
        const details = error.details as { stdout?: string; stderr?: string; exitCode?: number | null; signal?: string | null; truncated?: boolean; timedOut?: boolean };
        stdout = String(details.stdout ?? ""); stderr = String(details.stderr ?? ""); truncated = details.truncated === true;
        timedOut = error.code === "tool_timeout" || details.timedOut === true;
        exitCode = typeof details.exitCode === "number" ? details.exitCode : null;
        if (!timedOut && exitCode === null && details.signal === "SIGKILL") throw error;
      }
      const shownOut = excerpt(stdout, RETURNED_CHARS), shownErr = excerpt(stderr, 4000);
      const result = { language: args.language, exitCode, timedOut, stdout: shownOut.text, stderr: shownErr.text,
        ...(shownOut.clipped || shownErr.clipped || truncated ? { truncated: true } : {}),
        sourceSha256: createHash("sha256").update(args.source).digest("hex"), elapsedMs: Date.now() - started,
        scope: "One offline run of the supplied program; its output shows what this program computed, not that the program models the request" };
      return { output: JSON.stringify(result), data: { ...result, stdout, stderr } };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
});
