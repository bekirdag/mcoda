import { ToolExecutionError, type ToolDefinition } from "../ToolTypes.js";

export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a, ch => ch.codePointAt(0)!);
  const right = Array.from(b, ch => ch.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export const createTextTool = (): ToolDefinition => ({
  name: "transform_text", capability: "deterministic", readOnly: true,
  description: "Exact string-list operations: sort lexicographically by Unicode code points, deduplicate in source order, or normalize Unicode. No locale collation. Sorting does not normalize text.",
  inputSchema: { type: "object", required: ["operation", "values"], additionalProperties: false, properties: {
    operation: { type: "string", enum: ["sort_codepoints", "unique", "normalize"] },
    values: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 4096 } },
    form: { type: "string", enum: ["NFC", "NFD", "NFKC", "NFKD"] },
  } },
  handler: async (args, context) => {
    context.signal?.throwIfAborted();
    const { operation, values, form } = args as { operation: string; values: string[]; form?: string };
    if (!Array.isArray(values) || values.length > 1000 || values.some(v => typeof v !== "string" || v.length > 4096)
      || values.reduce((n, v) => n + v.length, 0) > 32000) throw new ToolExecutionError("tool_invalid_args", "Expected at most 1000 strings and 32000 total characters");
    if (form !== undefined && operation !== "normalize") throw new ToolExecutionError("tool_invalid_args", "Normalization form applies only to normalize; sorting preserves exact text");
    let result: string[];
    if (operation === "sort_codepoints") result = [...values].sort(compareCodePoints);
    else if (operation === "unique") result = [...new Set(values)];
    else if (operation === "normalize" && ["NFC", "NFD", "NFKC", "NFKD"].includes(form ?? "")) result = values.map(v => v.normalize(form));
    else throw new ToolExecutionError("tool_invalid_args", "Choose sort_codepoints, unique, or normalize with an explicit Unicode form");
    const data = { values: result };
    return { output: JSON.stringify(data), data };
  },
});
