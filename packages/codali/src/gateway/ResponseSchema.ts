import type { ToolSchemaDefinition } from "../tools/ToolTypes.js";

/**
 * Enforcement for `CodaliGatewayRequest.response.schema`.
 *
 * The field has been part of the request contract for a while but was never
 * validated — only `response.format === "json"` was read, so a caller could ask
 * for a schema and receive anything at all. That pushes parsing and correction
 * logic into every consuming product, which is precisely the duplication Codali
 * exists to remove.
 *
 * Validation reuses the same structural rules as tool-argument validation so a
 * schema behaves identically whether it describes a tool input or a response.
 */

export interface ResponseSchemaViolation {
  path: string;
  message: string;
}

export interface ResponseSchemaValidation {
  ok: boolean;
  value?: unknown;
  violations: ResponseSchemaViolation[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const typeMatches = (value: unknown, expected: string): boolean => {
  const actual = typeOf(value);
  if (expected === actual) return true;
  // An integer satisfies "number"; a whole float satisfies "integer".
  if (expected === "number" && actual === "integer") return true;
  if (expected === "integer" && actual === "number") return Number.isInteger(value);
  return false;
};

const validateAgainst = (
  value: unknown,
  schema: ToolSchemaDefinition,
  path: string,
  violations: ResponseSchemaViolation[],
): void => {
  const expectedTypes = schema.type
    ? (Array.isArray(schema.type) ? schema.type : [schema.type])
    : undefined;

  if (expectedTypes && !expectedTypes.some((type) => typeMatches(value, type))) {
    violations.push({
      path,
      message: `expected ${expectedTypes.join(" or ")}, received ${typeOf(value)}`,
    });
    return;
  }

  if (schema.enum && !schema.enum.some((entry) => entry === value)) {
    violations.push({
      path,
      message: `value is not one of ${JSON.stringify(schema.enum)}`,
    });
    return;
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => {
      validateAgainst(entry, schema.items as ToolSchemaDefinition, `${path}[${index}]`, violations);
    });
    return;
  }

  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        violations.push({ path: `${path}.${key}`, message: "required property is missing" });
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, entry] of Object.entries(value)) {
      const child = properties[key];
      if (child) {
        validateAgainst(entry, child, `${path}.${key}`, violations);
      } else if (schema.additionalProperties === false) {
        violations.push({ path: `${path}.${key}`, message: "unexpected property" });
      }
    }
  }
};

/**
 * Extracts a JSON value from a model response. Models routinely wrap JSON in
 * prose or a fenced block even when told not to, and rejecting those outright
 * would burn a repair attempt on a formatting quirk rather than a real
 * structural failure.
 */
export const extractJsonPayload = (content: string): unknown => {
  const trimmed = content.trim();
  if (!trimmed) return undefined;

  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const firstBrace = trimmed.search(/[[{]/);
  if (firstBrace >= 0) {
    const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (lastBrace > firstBrace) {
      const parsed = tryParse(trimmed.slice(firstBrace, lastBrace + 1));
      if (parsed !== undefined) return parsed;
    }
  }

  return undefined;
};

const tryParse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

export const validateResponseAgainstSchema = (
  content: string,
  schema: Record<string, unknown> | undefined,
): ResponseSchemaValidation => {
  if (!schema) {
    return { ok: true, value: content, violations: [] };
  }

  const payload = extractJsonPayload(content);
  if (payload === undefined) {
    return {
      ok: false,
      violations: [{ path: "$", message: "response was not parseable as JSON" }],
    };
  }

  const violations: ResponseSchemaViolation[] = [];
  validateAgainst(payload, schema as ToolSchemaDefinition, "$", violations);

  return violations.length === 0
    ? { ok: true, value: payload, violations: [] }
    : { ok: false, value: payload, violations };
};

/** Human-readable violation list, used to prompt one repair attempt. */
export const describeViolations = (violations: ResponseSchemaViolation[]): string =>
  violations.map((violation) => `- ${violation.path}: ${violation.message}`).join("\n");
