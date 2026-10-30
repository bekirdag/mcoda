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

export const createJavaScriptVerificationTool = (): ToolDefinition => ({
  name: "verify_javascript", capability: "verification", readOnly: true,
  description: "Run a self-contained synchronous JavaScript ES module against explicit JSON cases. Named export entry receives each args array. Compares actual JSON with expected; optional preserveInput checks mutation. No imports, workspace, credentials or network. Passing supplied cases is limited evidence, not proof of general correctness.",
  inputSchema: { type: "object", properties: { source: { type: "string", minLength: 1, maxLength: 24000 }, ...javaScriptChecksSchema.properties },
    required: ["source", ...javaScriptChecksSchema.required], additionalProperties: false },
  handler: async (raw, context) => {
    context.signal?.throwIfAborted();
    const args = raw as JavaScriptChecks & { source: string };
    if (typeof args.source !== "string" || !args.source.trim() || args.source.length > 24000 || !/^[A-Za-z_$][\w$]{0,99}$/.test(args.entry)
      || !Array.isArray(args.cases) || args.cases.length < 1 || args.cases.length > 16
      || args.cases.some(test => !test || !Array.isArray(test.args) || test.args.length > 16 || !Object.prototype.hasOwnProperty.call(test, "expected"))) {
      throw new ToolExecutionError("tool_invalid_args", "Expected bounded source, a named export, and 1-16 JSON test cases");
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
      const checks = args.cases.map((test, index) => {
        const observation = observed.observations[index];
        const passed = !observation.error && Object.prototype.hasOwnProperty.call(observation, "actual") && isDeepStrictEqual(observation.actual, test.expected)
          && (!args.preserveInput || observation.inputPreserved === true);
        return { index, passed, ...(!passed ? { reason: observation.error ?? (args.preserveInput && !observation.inputPreserved ? "Input was mutated" : "Actual result differs"),
          actual: JSON.stringify(observation.actual)?.slice(0, 200), expected: JSON.stringify(test.expected).slice(0, 200) } : {}) };
      });
      const result = { passed: checks.every(check => check.passed), checks, sourceSha256: createHash("sha256").update(args.source).digest("hex"),
        scope: "Only the supplied cases; synchronous JSON values, fresh module per case, no imports" };
      return { output: JSON.stringify(result), data: result };
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
});
