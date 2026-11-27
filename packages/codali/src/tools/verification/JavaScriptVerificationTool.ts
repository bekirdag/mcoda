import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../shell/IsolatedExecutor.js";
import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

export interface JavaScriptChecks {
  entry: string;
  cases: Array<{ args: unknown[]; expected: unknown }>;
  preserveInput?: boolean;
}

export const javaScriptChecksSchema = {
  type: "object" as const,
  properties: {
    entry: { type: "string" as const, minLength: 1, maxLength: 100 },
    cases: { type: "array" as const, minItems: 1, maxItems: 16, items: { type: "object" as const,
      properties: { args: { type: "array" as const, maxItems: 16 }, expected: { additionalProperties: true } },
      required: ["args", "expected"], additionalProperties: false } },
    preserveInput: { type: "boolean" as const },
  },
  required: ["entry", "cases"], additionalProperties: false,
};

/** Extract only a complete module, never a different source from the one shown. */
export const javaScriptAnswerSource = (answer: string): string => {
  const fences = [...answer.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)];
  if (!fences.length && !answer.includes("```")) return answer.trim();
  if (fences.length !== 1 || !/^(?:js|javascript|mjs)?\s*$/i.test(fences[0][1])) throw new ToolExecutionError("tool_invalid_args", "Verification requires one complete JavaScript module in a code fence, or raw module text");
  return fences[0][2].trim();
};

/** The tool's own cases may omit expected: such a case only runs and reports its
 * actual value. Answer checks (final_answer checks) still need expectations. */
const toolCasesSchema = { ...javaScriptChecksSchema.properties.cases, items: { ...javaScriptChecksSchema.properties.cases.items, required: ["args"] } };
const ACTUAL_CHARS = 4000;

export const createJavaScriptVerificationTool = (): ToolDefinition => ({
  name: "verify_javascript", capability: "verification", readOnly: true,
  description: "Run a self-contained synchronous JavaScript ES module against JSON cases. Named export entry receives each args array. A case with expected compares the actual JSON with it; a case without expected only runs and returns its actual value (use that to compute values, never a placeholder expectation). Optional preserveInput checks mutation. No imports, workspace, credentials or network. Passing supplied cases is limited evidence, not proof of general correctness.",
  inputSchema: { type: "object", properties: { source: { type: "string", minLength: 1, maxLength: 24000 }, ...javaScriptChecksSchema.properties, cases: toolCasesSchema },
    required: ["source", ...javaScriptChecksSchema.required], additionalProperties: false },
  handler: async (raw, context) => {
    context.signal?.throwIfAborted();
    const args = raw as JavaScriptChecks & { source: string };
    if (typeof args.source !== "string" || !args.source.trim() || args.source.length > 24000 || !/^[A-Za-z_$][\w$]{0,99}$/.test(args.entry)
      || !Array.isArray(args.cases) || args.cases.length < 1 || args.cases.length > 16
      || args.cases.some(test => !test || !Array.isArray(test.args) || test.args.length > 16)) {
      throw new ToolExecutionError("tool_invalid_args", "Expected bounded source, a named export, and 1-16 JSON cases of the form {args:[...]} or {args:[...], expected:...}");
    }
    const payload = JSON.stringify({ source: args.source, entry: args.entry, inputs: args.cases.map(test => test.args) });
    if (payload.length > 64000 || JSON.stringify(args.cases).length > 64000) throw new ToolExecutionError("tool_invalid_args", "Verification input exceeds 64000 characters");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-verify-"));
    try {
      await fs.chmod(root, 0o700);
      await fs.writeFile(path.join(root, "input.json"), payload, { mode: 0o600 });
      await fs.copyFile(new URL("./JavaScriptVerificationWorker.js", import.meta.url), path.join(root, "observe.mjs"));
      const run = await createIsolatedExecutor({ network: false })(process.execPath,
        ["--experimental-vm-modules", "--no-warnings", "--max-old-space-size=64", path.join(root, "observe.mjs")],
        { workspaceRoot: root, signal: context.signal, allowedWritePaths: [], shellTimeoutMs: 5000, shellMaxOutputBytes: 128 * 1024 });
      const data = run.data as { stdout: string; truncated: boolean };
      if (data.truncated) throw new ToolExecutionError("tool_execution_failed", "Verification observations exceeded the output limit");
      const observed = JSON.parse(data.stdout) as { observations: Array<{ actual?: unknown; inputPreserved?: boolean; error?: string }> };
      if (!Array.isArray(observed.observations) || observed.observations.length !== args.cases.length) throw new ToolExecutionError("tool_execution_failed", "Incomplete verification observations");
      const expects = (test: { expected?: unknown }) => Object.prototype.hasOwnProperty.call(test, "expected");
      const checks = args.cases.map((test, index) => {
        const observation = observed.observations[index];
        const ran = !observation.error && Object.prototype.hasOwnProperty.call(observation, "actual");
        // A run-only case reports what the code returned; there is nothing to pass or fail.
        if (!expects(test)) return { index, runOnly: true, ran, ...(ran ? { actual: JSON.stringify(observation.actual).slice(0, ACTUAL_CHARS) } : { reason: observation.error }) };
        const passed = ran && isDeepStrictEqual(observation.actual, test.expected) && (!args.preserveInput || observation.inputPreserved === true);
        return { index, passed, ...(!passed ? { reason: observation.error ?? (args.preserveInput && !observation.inputPreserved ? "Input was mutated" : "Actual result differs"),
          actual: JSON.stringify(observation.actual)?.slice(0, ACTUAL_CHARS), expected: JSON.stringify(test.expected).slice(0, 200) } : {}) };
      });
      const checked = checks.filter(check => !("runOnly" in check));
      const result = { ...(checked.length ? { passed: checked.every(check => "passed" in check && check.passed) } : {}), ...(checked.length < checks.length ? { runOnlyCases: checks.length - checked.length } : {}), checks,
        sourceSha256: createHash("sha256").update(args.source).digest("hex"),
        scope: checked.length ? "Only the supplied cases; synchronous JSON values, fresh module per case, no imports" : "Run only: values the code returned for the supplied inputs; nothing was compared" };
      // The full returned values stay in the receipt data (the output shows them clipped).
      return { output: JSON.stringify(result), data: { ...result, actuals: observed.observations.map(observation => observation.actual) } };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
});
