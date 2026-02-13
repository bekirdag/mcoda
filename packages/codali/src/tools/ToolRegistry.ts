import type { ToolContext, ToolDefinition, ToolExecutionResult } from "./ToolTypes.js";

const isObject = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const validateArgs = (args: unknown, schema?: Record<string, unknown>): string | undefined => {
  if (!schema) return undefined;
  const required = (schema.required as string[] | undefined) ?? [];
  if (!required.length) return undefined;
  if (!isObject(args)) {
    return `Invalid arguments: expected object with required keys ${required.join(", ")}`;
  }
  const missing = required.filter((key) => !(key in args));
  if (missing.length) {
    return `Missing required arguments: ${missing.join(", ")}`;
  }
  return undefined;
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
      return { ok: false, output: "", error: `Unknown tool: ${name}` };
    }

    const validationError = validateArgs(args, tool.inputSchema);
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
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
