import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../shell/IsolatedExecutor.js";
import { ToolExecutionError, type ToolContext, type ToolDefinition, type ToolInputSchema, type ToolSchemaDefinition } from "../ToolTypes.js";

const string = (maxLength = 4000): ToolSchemaDefinition => ({ type: "string", minLength: 1, maxLength });
const choices = (...values: string[]): ToolSchemaDefinition => ({ type: "string", enum: values });
const array = (items: ToolSchemaDefinition, maxItems: number, minItems = 0): ToolSchemaDefinition => ({ type: "array", items, minItems, maxItems });
const object = (properties: Record<string, ToolSchemaDefinition>, required: string[]): ToolInputSchema => ({ type: "object", properties, required, additionalProperties: false });
const jsonValue: ToolSchemaDefinition = { additionalProperties: true };
const identifier = { ...string(64), pattern: "^[A-Za-z][A-Za-z0-9_]*$" };
const scalar: ToolSchemaDefinition = { type: ["string", "number", "boolean", "null"] };
const schemas: Record<string, ToolInputSchema> = {
  decimal_calculate: object({ operation: choices("add", "subtract", "multiply", "divide", "pow", "sqrt", "abs", "round"),
    values: array(string(512), 64, 1), precision: { type: "integer", minimum: 1, maximum: 200 }, places: { type: "integer", minimum: 0, maximum: 200 } }, ["operation", "values"]),
  numerical_calculate: object({ operation: choices("det", "inv", "multiply", "transpose", "lusolve", "mean", "median", "std", "sum", "dot", "cross"), args: array(jsonValue, 2, 1) }, ["operation", "args"]),
  validate_json: object({ schema: jsonValue, data: jsonValue }, ["schema", "data"]),
  symbolic_math: object({ operation: choices("simplify", "factor", "expand", "differentiate", "integrate", "solve"), expression: string(), symbols: array(identifier, 16), variable: identifier }, ["operation", "expression", "symbols"]),
  solve_constraints: object({ variables: { type: "object", additionalProperties: true }, constraints: array(string(), 64, 1) }, ["variables", "constraints"]),
  query_data: object({ sql: string(8000), tables: array(object({ name: identifier, columns: { type: "object", additionalProperties: true }, rows: array(array(scalar, 32, 1), 2000) }, ["name", "columns", "rows"]), 8) }, ["sql", "tables"]),
  transform_data: object({ rows: array({ type: "object", additionalProperties: true }, 2000), steps: array(object({
    operation: choices("select", "sort", "head", "filter", "aggregate"), columns: array(string(128), 32, 1), descending: { type: "boolean" },
    count: { type: "integer", minimum: 0, maximum: 1000 }, column: string(128), comparison: choices("eq", "ne", "gt", "ge", "lt", "le"), value: scalar,
    by: array(string(128), 32), aggregations: array(object({ column: string(128), function: choices("sum", "mean", "min", "max", "count", "n_unique", "median", "std"), alias: identifier }, ["column", "function", "alias"]), 16, 1),
  }, ["operation"]), 16) }, ["rows", "steps"]),
};
const descriptions: Record<string, string> = {
  decimal_calculate: "Decimal.js arithmetic on decimal STRING operands, default 50 significant digits, half-even rounding. Exact decimal representation with reported precision; use for money and decimal calculations.",
  numerical_calculate: "math.js numerical vectors/matrices: determinant, inverse, multiply, transpose, linear solve, statistics, dot/cross. args is the function argument list; IEEE-754 approximations, not exact symbolic math.",
  validate_json: "Ajv validates data against JSON Schema draft-07, without mutation/coercion, remote refs or format checks. Returns valid/errors. Offline and bounded.",
  symbolic_math: "SymPy exact symbolic algebra/calculus. Declare symbols; expression uses + - * / ** and sin/cos/tan/exp/log/sqrt/Abs, pi/E. solve treats expression as zero; variable required for solve/differentiate/integrate.",
  solve_constraints: "Z3 satisfiability. variables maps names to Int/Real/Bool. constraints use arithmetic, comparisons, and/or/not, And/Or/Not/If/Implies/Distinct. Returns sat/model with checks, unsat, or unknown; no claims of optimum.",
  query_data: "DuckDB SELECT over supplied in-memory tables. columns maps names to BIGINT/DOUBLE/VARCHAR/BOOLEAN/DECIMAL(p,s); rows are ordered arrays. Decimal/large integer values use strings. No files/network/extensions; max 1000 output rows.",
  transform_data: "Polars transforms supplied JSON rows through select/sort/head/filter/aggregate steps. aggregate uses by columns and {column,function,alias}; filter uses column/comparison/value. No files or code execution; max 1000 output rows.",
};
const pythonPackages: Record<string, [string, string]> = { symbolic_math: ["sympy", "1.14.0"], solve_constraints: ["z3-solver", "5.3.3.0"], query_data: ["duckdb", "2.0.0"], transform_data: ["polars", "2.1.0"] };
const nodePackages: Record<string, [string, string]> = { decimal_calculate: ["decimal.js", "10.6.0"], numerical_calculate: ["mathjs", "15.2.0"], validate_json: ["ajv", "8.20.0"] };

/** Deployment-owned configuration; runtime paths can never be supplied by a model. */
export interface DeterministicToolOptions { pythonRoot?: string; }
export const defaultPythonToolRoot = (): string => process.env.CODALI_TOOL_PYTHON_ROOT ?? path.join(os.homedir(), ".local", "state", "codali", "tool-runtimes", "python-v1");

async function execute(name: string, args: unknown, context: ToolContext, options: DeterministicToolOptions) {
  context.signal?.throwIfAborted();
  const payload = JSON.stringify({ tool: name, args });
  if (Buffer.byteLength(payload) > 256000) throw new ToolExecutionError("tool_invalid_args", "Deterministic input exceeds 256000 bytes");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-deterministic-"));
  const python = Object.prototype.hasOwnProperty.call(pythonPackages, name);
  const runtime = path.resolve(options.pythonRoot ?? defaultPythonToolRoot());
  const worker = new URL(python ? "./python-worker.py" : "./node-worker.cjs", import.meta.url);
  const started = Date.now();
  try {
    await fs.chmod(root, 0o700);
    if (python) {
      try { await fs.access(path.join(runtime, "pyvenv.cfg")); await fs.access(path.join(runtime, "bin", "python")); }
      catch { throw new ToolExecutionError("tool_execution_failed", "Python tool runtime is missing. Run the packaged config/deterministic/install-python.mjs setup script, or configure CODALI_TOOL_PYTHON_ROOT.", { retryable: false }); }
    }
    const source = await fs.readFile(worker);
    const script = path.join(root, python ? "worker.py" : "worker.cjs");
    await fs.writeFile(script, source, { mode: 0o600 });
    await fs.writeFile(path.join(root, "input.json"), payload, { mode: 0o600 });
    const result = await createIsolatedExecutor({ network: false, readOnlyRuntimeRoots: python ? [runtime] : [] })(
      python ? path.join(runtime, "bin", "python") : process.execPath,
      python ? ["-I", "-B", script] : ["--max-old-space-size=128", script],
      { workspaceRoot: root, signal: context.signal, allowedWritePaths: [], shellTimeoutMs: 7000, shellMaxOutputBytes: 128000 });
    const observation = result.data as { stdout: string; truncated: boolean };
    if (observation.truncated) throw new ToolExecutionError("tool_execution_failed", "Deterministic output exceeded the limit");
    const data = JSON.parse(observation.stdout) as Record<string, unknown>;
    if (data.error) throw new ToolExecutionError("tool_invalid_args", String(data.error));
    const [library, version] = (python ? pythonPackages : nodePackages)[name];
    if (data.library !== library || data.version !== version) throw new ToolExecutionError("tool_execution_failed", "Tool runtime version does not match the pinned contract");
    const receipt = { inputSha256: createHash("sha256").update(payload).digest("hex"), workerSha256: createHash("sha256").update(source).digest("hex"), elapsedMs: Date.now() - started,
      isolation: "offline, ephemeral input only", ...data };
    return { output: JSON.stringify(receipt), data: receipt };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export const createDeterministicTools = (options: DeterministicToolOptions = {}): ToolDefinition[] => Object.keys(schemas).map(name => ({
  name, description: descriptions[name], readOnly: true, capability: "deterministic", inputSchema: schemas[name],
  handler: (args, context) => execute(name, args, context, options),
}));
