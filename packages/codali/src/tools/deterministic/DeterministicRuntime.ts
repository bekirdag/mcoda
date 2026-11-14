import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createDeterministicTools, defaultPythonToolRoot, type DeterministicToolOptions } from "./DeterministicTools.js";
import { executorStatus } from "../shell/IsolatedExecutor.js";
import { ToolRegistry } from "../ToolRegistry.js";
import { checkDocumentRuntime } from "../documents/DocumentRuntime.js";

/** Installation metadata only; functional qualification uses the checks below. */
export async function inspectDeterministicRuntime(options: DeterministicToolOptions = {}) {
  const pythonRoot = path.resolve(options.pythonRoot ?? defaultPythonToolRoot());
  const worker = async (url: URL) => {
    try { return { installed: true, sha256: createHash("sha256").update(await fs.readFile(url)).digest("hex") }; }
    catch { return { installed: false }; }
  };
  let installed = false;
  try { await fs.access(path.join(pythonRoot, "pyvenv.cfg")); await fs.access(path.join(pythonRoot, "bin", "python")); installed = true; } catch { /* Optional runtime. */ }
  return { pythonRoot, nodeWorker: await worker(new URL("./node-worker.cjs", import.meta.url)),
    pythonWorker: await worker(new URL("./python-worker.py", import.meta.url)), pythonEnvironment: { installed }, isolation: executorStatus(),
    checkCommand: "codali tools check", installCommand: "codali tools install", note: "Installed files do not prove functionality; run the checks." };
}

export interface DeterministicRuntimeCheck { name: string; passed: boolean; library?: string; version?: string; elapsedMs: number; error?: string; }
const probes: Array<{ name: string; args: unknown; accepts: (value: Record<string, unknown>) => boolean }> = [
  { name: "decimal_calculate", args: { operation: "add", values: ["0.1", "0.2"] }, accepts: value => value.result === "0.3" },
  { name: "numerical_calculate", args: { operation: "det", args: [[[1, 2], [3, 4]]] }, accepts: value => value.result === -2 },
  { name: "validate_json", args: { schema: { type: "integer" }, data: "not an integer" }, accepts: value => value.valid === false },
  { name: "symbolic_math", args: { operation: "differentiate", expression: "x**2+2*x+1", symbols: ["x"], variable: "x" }, accepts: value => value.result === "2*x + 2" },
  { name: "solve_constraints", args: { variables: { x: "Int" }, constraints: ["x>2", "x<1"] }, accepts: value => value.status === "unsat" },
  { name: "query_data", args: { sql: "SELECT 9007199254740993::BIGINT", tables: [] }, accepts: value => JSON.stringify(value.rows) === '[["9007199254740993"]]' },
  { name: "transform_data", args: { rows: [{ a: 1 }, { a: 2 }], steps: [{ operation: "head", count: 1 }] }, accepts: value => JSON.stringify(value.rows) === '[{"a":1}]' },
];

/** Exercise the real pinned offline workers against fixed independent values. */
export async function checkDeterministicRuntime(options: DeterministicToolOptions = {}, signal?: AbortSignal): Promise<DeterministicRuntimeCheck[]> {
  const registry = new ToolRegistry();
  for (const tool of createDeterministicTools(options)) registry.register(tool);
  const checks: DeterministicRuntimeCheck[] = [];
  for (const probe of probes) {
    signal?.throwIfAborted(); const started = Date.now();
    try {
      const result = await registry.execute(probe.name, probe.args, { workspaceRoot: os.tmpdir(), signal });
      if (!result.ok) throw new Error(result.error?.message ?? "Tool check failed");
      const value = JSON.parse(result.output) as Record<string, unknown>;
      const passed = probe.accepts(value);
      checks.push({ name: probe.name, passed, library: String(value.library), version: String(value.version), elapsedMs: Date.now() - started,
        ...(passed ? {} : { error: "Observed result differs from the independent check value" }) });
    } catch (error) {
      signal?.throwIfAborted();
      checks.push({ name: probe.name, passed: false, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return checks;
}

/** Host CLI only: models cannot select this script or inject installation args. */
export async function runDeterministicRuntimeCommand(argv: string[], write: (line: string) => void): Promise<number> {
  const [command, ...flags] = argv;
  if (!["install", "check"].includes(command) || flags.some(flag => !["--json", "--documents"].includes(flag)) || new Set(flags).size !== flags.length) throw new Error("Use codali tools install|check [--documents] [--json]; these are host runtime commands.");
  const json = flags.includes("--json");
  const documents = flags.includes("--documents");
  const abort = new AbortController(); const cancel = () => abort.abort(new Error("Tool runtime operation cancelled"));
  process.once("SIGINT", cancel);
  try {
    if (command === "install") {
      if (!json) write(`Installing the pinned ${documents ? "document" : "deterministic"} Python runtime…`);
      await promisify(execFile)(process.execPath, [fileURLToPath(new URL(`../../../config/${documents ? "documents" : "deterministic"}/install-python.mjs`, import.meta.url))],
        { timeout: 300000, maxBuffer: 2000000, signal: abort.signal });
    }
    const checks = documents ? await checkDocumentRuntime({}, abort.signal) : await checkDeterministicRuntime({}, abort.signal);
    const passed = checks.every(check => check.passed);
    if (json) write(JSON.stringify({ passed, checks }, null, 2));
    else {
      for (const check of checks) write(`${check.passed ? "PASS" : "FAIL"}  ${check.name.padEnd(22)} ${check.passed ? `${check.library} ${check.version}` : check.error}`);
      write(passed ? `All ${checks.length} ${documents ? "document" : "deterministic"} tool checks passed.` : "Some tools are unavailable. Run codali doctor for installation and isolation details.");
    }
    return passed ? 0 : 1;
  } finally { process.removeListener("SIGINT", cancel); }
}
