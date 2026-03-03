import {
  ToolExecutionError,
  toolErrorCategoryForCode,
  type ToolContext,
  type ToolDefinition,
  type ToolError,
  type ToolErrorCode,
  type ToolExecutionResult,
  type ToolSchemaDefinition,
  type ToolSchemaPrimitiveType,
} from "./ToolTypes.js";

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const TOOL_SCHEMA_TYPES = new Set<ToolSchemaPrimitiveType>([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

const buildToolError = (
  code: ToolErrorCode,
  message: string,
  options: { retryable?: boolean; details?: Record<string, unknown> } = {},
): ToolError => ({
  code,
  category: toolErrorCategoryForCode(code),
  message,
  retryable: options.retryable ?? code === "tool_timeout",
  details: options.details,
});

const readSchemaTypes = (
  schema: ToolSchemaDefinition,
): ToolSchemaPrimitiveType[] | undefined => {
  if (schema.type === undefined) return undefined;
  if (Array.isArray(schema.type)) return schema.type;
  return [schema.type];
};

const schemaValidationError = (
  message: string,
  path: string,
  details: Record<string, unknown> = {},
): ToolError => {
  return buildToolError("tool_schema_invalid", message, {
    retryable: false,
    details: { path, ...details },
  });
};

const validateSchema = (
  schema: ToolSchemaDefinition | undefined,
  path = "$",
): ToolError | undefined => {
  if (!schema) return undefined;

  const types = readSchemaTypes(schema);
  if (types && types.length === 0) {
    return schemaValidationError("Invalid schema: empty type list", path);
  }
  if (types && types.some((type) => !TOOL_SCHEMA_TYPES.has(type))) {
    return schemaValidationError("Invalid schema: unsupported type", path, { types });
  }
  if (schema.required && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) {
    return schemaValidationError("Invalid schema: required must be a string array", path);
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) {
      return schemaValidationError("Invalid schema: properties must be an object", path);
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      const childError = validateSchema(child, `${path}.properties.${key}`);
      if (childError) return childError;
    }
  }
  if (schema.items !== undefined) {
    const childError = validateSchema(schema.items, `${path}.items`);
    if (childError) return childError;
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    return schemaValidationError("Invalid schema: additionalProperties must be boolean", path);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    return schemaValidationError("Invalid schema: enum must be an array", path);
  }
  return undefined;
};

const runtimeTypeOf = (value: unknown): ToolSchemaPrimitiveType | "unknown" => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (isObject(value)) return "object";
  return "unknown";
};

const matchesType = (value: unknown, type: ToolSchemaPrimitiveType): boolean => {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  return value === null;
};

const argumentValidationError = (
  message: string,
  path: string,
  details: Record<string, unknown> = {},
): ToolError => {
  return buildToolError("tool_invalid_args", message, {
    retryable: false,
    details: { path, ...details },
  });
};

const validateValue = (
  value: unknown,
  schema: ToolSchemaDefinition,
  path = "$",
): ToolError | undefined => {
  const schemaTypes = readSchemaTypes(schema);
  if (schemaTypes && schemaTypes.length > 0) {
    const matched = schemaTypes.some((type) => matchesType(value, type));
    if (!matched) {
      return argumentValidationError("Invalid argument type", path, {
        expected: schemaTypes,
        actual: runtimeTypeOf(value),
      });
    }
  }

  if (schema.enum && !schema.enum.some((entry) => Object.is(entry, value))) {
    return argumentValidationError("Invalid argument value", path, {
      expected: schema.enum,
      actual: value,
    });
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      return argumentValidationError("Argument is below minimum", path, {
        minimum: schema.minimum,
        actual: value,
      });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      return argumentValidationError("Argument is above maximum", path, {
        maximum: schema.maximum,
        actual: value,
      });
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return argumentValidationError("String argument is shorter than minimum length", path, {
        minLength: schema.minLength,
        actualLength: value.length,
      });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return argumentValidationError("String argument is longer than maximum length", path, {
        maxLength: schema.maxLength,
        actualLength: value.length,
      });
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let index = 0; index < value.length; index += 1) {
      const childError = validateValue(value[index], schema.items, `${path}[${index}]`);
      if (childError) return childError;
    }
  }

  if (isObject(value)) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        return argumentValidationError("Missing required argument", `${path}.${key}`, {
          required: key,
        });
      }
    }

    const allowUnknown = schema.additionalProperties === true;
    for (const [key, entry] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (propertySchema) {
        const childError = validateValue(entry, propertySchema, `${path}.${key}`);
        if (childError) return childError;
        continue;
      }
      if (!allowUnknown) {
        return argumentValidationError("Unknown argument", `${path}.${key}`, {
          unknown: key,
        });
      }
    }
  }

  return undefined;
};

const PERMISSION_DENIED_PATTERNS = [
  "outside the workspace",
  "not allowed",
  "disallowed",
  "permission",
  "read-only",
  "disabled",
  "eacces",
  "eperm",
];

const normalizeExecutionError = (error: unknown): ToolError => {
  if (error instanceof ToolExecutionError) {
    return error.toToolError();
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("timeout") || normalized.includes("timed out") || normalized.includes("etimedout")) {
    return buildToolError("tool_timeout", message, { retryable: true });
  }
  if (PERMISSION_DENIED_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return buildToolError("tool_permission_denied", message, { retryable: false });
  }
  return buildToolError("tool_execution_failed", message, { retryable: true });
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  describe(): Array<Pick<ToolDefinition, "name" | "description" | "inputSchema">> {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  async execute(name: string, args: unknown, context: ToolContext): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        output: "",
        error: buildToolError("tool_unknown", `Unknown tool: ${name}`, {
          retryable: false,
          details: { tool: name },
        }),
      };
    }

    const schemaError = validateSchema(tool.inputSchema);
    if (schemaError) {
      return { ok: false, output: "", error: schemaError };
    }

    const validationError = tool.inputSchema ? validateValue(args, tool.inputSchema) : undefined;
    if (validationError) {
      return { ok: false, output: "", error: validationError };
    }

    try {
      const result = await tool.handler(args, context);
      return { ok: true, output: result.output, data: result.data };
    } catch (error) {
      return {
        ok: false,
        output: "",
        error: normalizeExecutionError(error),
      };
    }
  }
}
