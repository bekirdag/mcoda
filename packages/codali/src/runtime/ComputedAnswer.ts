import type { ToolExecutionResult } from "../tools/ToolTypes.js";

export interface ComputedAnswer {
  tool: string;
  args: Record<string, unknown>;
  fields: Record<string, { path: string; as?: "number" | "string" }>;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
const decimalIdentity = (value: string): string | undefined => {
  const match = value.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i); if (!match) return undefined;
  let digits = (match[2] + (match[3] ?? "")).replace(/^0+/, "");
  if (!digits) return "0";
  let exponent = Number(match[4] ?? 0) - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10000) return undefined;
  while (digits.endsWith("0")) { digits = digits.slice(0, -1); exponent++; }
  return `${match[1] === "-" ? "-" : ""}${digits}e${exponent}`;
};
export const parseComputedAnswer = (input: unknown): ComputedAnswer => {
  if (!record(input) || Object.keys(input).some(key => !["tool", "args", "fields"].includes(key)) || typeof input.tool !== "string"
    || !record(input.args) || !record(input.fields) || Object.keys(input.fields).length < 1 || Object.keys(input.fields).length > 16 || JSON.stringify(input).length > 256000) throw Error("Expected compute {tool,args,fields}, with 1..16 output fields");
  for (const [key, field] of Object.entries(input.fields)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || forbidden.has(key) || !record(field) || Object.keys(field).some(key => !["path", "as"].includes(key))
      || typeof field.path !== "string" || !field.path.length || field.path.length > 256 || field.path.split(".").length > 16
      || field.path.split(".").some(part => !/^[A-Za-z0-9_-]+$/.test(part) || forbidden.has(part)) || field.as !== undefined && !["number", "string"].includes(String(field.as))) throw Error("Invalid computed output field selector");
  }
  return input as unknown as ComputedAnswer;
};

/** Render actual tool values with no second model pass or unchecked arithmetic. */
export const renderComputedAnswer = (spec: ComputedAnswer, result: ToolExecutionResult, template: unknown, format: "json" | "text"): string => {
  if (!result.ok) throw Error(result.error?.message ?? "Computation failed");
  const source = result.data ?? JSON.parse(result.output);
  if (record(source) && source.truncated === true) throw Error("Computation output was truncated; narrow the operation before finalizing");
  const fields: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(spec.fields)) {
    let value: unknown = source;
    for (const part of field.path.split(".")) {
      if ((!record(value) && !Array.isArray(value)) || !Object.prototype.hasOwnProperty.call(value, part)) throw Error(`Computed result has no field ${field.path}`);
      value = (value as Record<string, unknown>)[part];
    }
    if (field.as === "number") {
      if (typeof value !== "string" && typeof value !== "number") throw Error("Numeric output requires a decimal string or number");
      const numeric = Number(value);
      if (!Number.isFinite(numeric) || Number.isInteger(numeric) && !Number.isSafeInteger(numeric)
        || decimalIdentity(String(value)) !== decimalIdentity(String(numeric))) throw Error("Numeric conversion would lose precision; retain the string");
      value = numeric;
    } else if (field.as === "string") value = typeof value === "string" ? value : JSON.stringify(value);
    if (value === undefined || typeof value === "number" && !Number.isFinite(value)) throw Error("Computed value is not finite JSON");
    fields[key] = value;
  }
  if (format === "json") return JSON.stringify(fields);
  if (typeof template !== "string" || !template.trim() || template.length > 12000) throw Error("Text computations require a template containing {{field}} placeholders");
  const used = new Set<string>();
  const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) throw Error(`Unknown computed placeholder: ${key}`);
    used.add(key); return typeof fields[key] === "string" ? fields[key] : JSON.stringify(fields[key]);
  });
  if (Object.keys(fields).some(key => !used.has(key))) throw Error("Every selected computation field must appear in the answer template");
  return rendered;
};
