import { ToolExecutionError } from "../../tools/ToolTypes.js";
import type { ToolDefinition, ToolInputSchema } from "../../tools/ToolTypes.js";
import { truncateToolResult } from "../../tools/TruncateResult.js";
import type { McpClient, McpToolDefinition } from "./McpClient.js";

/**
 * Adapts MCP tools into Codali's own tool contract.
 *
 * The direction matters: MCP adapts *into* the neutral `ToolDefinition`, never
 * the reverse. Codali's internals stay decoupled from MCP's evolution, and a
 * built-in tool, a docdex tool and an MCP tool are indistinguishable to the
 * planner and the executor.
 */

/** `mcp:<server>:<tool>` — the namespace that keeps two servers from colliding. */
export const mcpToolName = (server: string, tool: string): string =>
  `mcp:${server}:${tool}`;

export const parseMcpToolName = (
  name: string,
): { server: string; tool: string } | undefined => {
  const parts = name.split(":");
  if (parts.length < 3 || parts[0] !== "mcp") return undefined;
  return { server: parts[1] ?? "", tool: parts.slice(2).join(":") };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * Normalizes an MCP input schema into Codali's `ToolInputSchema`.
 *
 * `additionalProperties` is forced open because the registry rejects unknown
 * arguments by default, and MCP servers frequently omit properties they still
 * accept. Rejecting a valid argument is worse here than passing an extra one
 * through: the server validates its own inputs.
 */
export const normalizeMcpInputSchema = (
  schema: Record<string, unknown> | undefined,
): ToolInputSchema => {
  if (!isRecord(schema)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return {
    ...schema,
    type: "object",
    properties: isRecord(schema.properties)
      ? (schema.properties as ToolInputSchema["properties"])
      : {},
    required: Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    additionalProperties: true,
  };
};

export interface McpToolAdapterOptions {
  client: McpClient;
  server: string;
  /**
   * Capability group the server's tools belong to, used for the orchestrator's
   * first-stage selection. Defaults to the server name, which is usually what
   * an operator means ("github", "jira").
   */
  capability?: string;
  /**
   * Whether these tools may mutate anything.
   *
   * Decided by Codali policy — an operator marking a connector read-only —
   * never by the server's own `readOnlyHint`. A server asserting it is harmless
   * is the party being constrained vouching for itself.
   */
  readOnly: boolean;
  /** Result text beyond this is truncated before it reaches a model. */
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 12_000;

const tryParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const truncate = (value: string, limit: number): string =>
  value.length > limit
    ? `${value.slice(0, limit)}\n…[truncated ${value.length - limit} characters]`
    : value;

/**
 * Builds a description the planner can act on. MCP descriptions are sometimes
 * absent, in which case the tool name is all we have — say so plainly rather
 * than inventing capability the tool may not have.
 */
const describeMcpTool = (tool: McpToolDefinition, server: string): string => {
  const base = tool.description?.trim();
  if (base) return base;
  return `${tool.name} (provided by the ${server} MCP server; no description supplied).`;
};

export const mcpToolToDefinition = (
  tool: McpToolDefinition,
  options: McpToolAdapterOptions,
): ToolDefinition => {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const qualified = mcpToolName(options.server, tool.name);

  return {
    name: qualified,
    description: describeMcpTool(tool, options.server),
    inputSchema: normalizeMcpInputSchema(tool.inputSchema),
    outputSchema: tool.outputSchema,
    readOnly: options.readOnly,
    capability: options.capability ?? options.server,
    handler: async (args) => {
      const result = await options.client.callTool(tool.name, args);
      if (!result.ok) {
        // Surface as a tool failure so the runner records it and the model is
        // told, rather than passing an error string off as a result.
        throw new ToolExecutionError(
          "tool_execution_failed",
          result.text || `MCP tool ${qualified} reported an error.`,
          { retryable: false, details: { server: options.server, tool: tool.name } },
        );
      }
      // Structural where possible: an oversized list keeps whole items so the
      // model receives valid JSON, not a document cut mid-token.
      const structured = result.structured ?? tryParseJson(result.text);
      const trimmed = structured !== undefined
        ? truncateToolResult(structured, result.text, maxOutputChars)
        : { text: truncate(result.text, maxOutputChars), truncated: false };
      return {
        output: trimmed.text || "(the tool returned no content)",
        // The *parsed* payload, not the MCP envelope. Evidence normalization
        // reads this to turn each returned record into its own evidence item;
        // handed `{content:[{type:"text",…}]}` it finds no records and emits a
        // single "returned structured data" placeholder instead.
        data: structured ?? result.raw,
      };
    },
  };
};

export const mcpToolsToDefinitions = (
  tools: readonly McpToolDefinition[],
  options: McpToolAdapterOptions,
): ToolDefinition[] => tools.map((tool) => mcpToolToDefinition(tool, options));
