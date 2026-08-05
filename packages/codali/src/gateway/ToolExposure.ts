import type { CodaliGatewayPlannerToolDescriptor } from "./GatewayPlanner.js";

/**
 * Two-level tool exposure.
 *
 * Sending every allowed tool's full JSON schema to the orchestrator does not
 * scale: a handful of connectors is already thousands of prompt tokens, and the
 * model's selection accuracy degrades long before the context window does. So
 * exposure happens in two stages:
 *
 *   1. capability selection - one line per capability group
 *   2. tool selection       - full schemas, but only for the chosen capabilities
 *
 * This is deliberately simpler than embedding or BM25 retrieval over tool
 * descriptions. Semantic retrieval is only worth adding if hierarchical
 * selection is measured to fail.
 */

const DEFAULT_CAPABILITY = "general";

/** Cap on how much of a tool's schema we are willing to spend prompt on. */
const MAX_SCHEMA_CHARS = 600;

/** Cap on tools expanded in one planner prompt, after capability narrowing. */
export const MAX_EXPANDED_TOOLS = 40;

export interface ToolExposureDescriptor extends CodaliGatewayPlannerToolDescriptor {
  capability?: string;
  readOnly?: boolean;
}

export type ToolExposureDescriptors = Record<
  string,
  string | ToolExposureDescriptor
>;

interface NormalizedDescriptor {
  name: string;
  description: string;
  capability: string;
  readOnly: boolean;
  inputSchema?: Record<string, unknown>;
}

/**
 * Human-readable summaries for capability groups Codali ships with. Connector
 * capabilities that are not listed fall back to a summary derived from their
 * tool names, so a new MCP server needs no code change here.
 */
const KNOWN_CAPABILITY_SUMMARIES: Record<string, string> = {
  docdex: "repository index, code structure, and organizational memory",
  web: "current external information from the public web",
  workspace: "local working-tree files and changes",
  shell: "shell command execution",
  media: "image and media generation",
  general: "assorted tools",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

/**
 * `docdex_impact_graph` -> `impact graph`. Used to build a capability summary
 * from its members when we have no curated description for the group.
 */
const shortToolLabel = (name: string, capability: string): string => {
  let label = name;
  const namespaced = label.split(":");
  if (namespaced.length >= 3) {
    label = namespaced.slice(2).join(":");
  }
  if (label.startsWith(`${capability}_`)) {
    label = label.slice(capability.length + 1);
  }
  return label.replace(/_/g, " ");
};

const normalize = (
  name: string,
  descriptor: string | ToolExposureDescriptor | undefined,
): NormalizedDescriptor => {
  if (typeof descriptor === "string") {
    return {
      name,
      description: descriptor,
      capability: DEFAULT_CAPABILITY,
      readOnly: true,
    };
  }
  return {
    name,
    description: descriptor?.description?.trim() || "read-only allowed tool",
    capability: descriptor?.capability?.trim() || DEFAULT_CAPABILITY,
    readOnly: descriptor?.readOnly ?? true,
    inputSchema: descriptor?.inputSchema,
  };
};

export const normalizeToolExposure = (
  toolNames: readonly string[],
  descriptors: ToolExposureDescriptors | undefined,
): NormalizedDescriptor[] =>
  toolNames.map((name) => normalize(name, descriptors?.[name]));

export const groupByCapability = (
  tools: NormalizedDescriptor[],
): Map<string, NormalizedDescriptor[]> => {
  const grouped = new Map<string, NormalizedDescriptor[]>();
  for (const tool of tools) {
    const bucket = grouped.get(tool.capability);
    if (bucket) bucket.push(tool);
    else grouped.set(tool.capability, [tool]);
  }
  return grouped;
};

const capabilitySummary = (
  capability: string,
  tools: NormalizedDescriptor[],
): string => {
  const known = KNOWN_CAPABILITY_SUMMARIES[capability];
  if (known) return known;
  const labels = tools
    .slice(0, 6)
    .map((tool) => shortToolLabel(tool.name, capability));
  const suffix = tools.length > labels.length ? ", …" : "";
  return `${labels.join(", ")}${suffix}`;
};

/**
 * Stage 1 rendering: one line per capability, no schemas. This is what the
 * classifier sees, and it stays a fixed small size no matter how many tools a
 * tenant has connected.
 */
export const renderCapabilityLines = (
  toolNames: readonly string[],
  descriptors: ToolExposureDescriptors | undefined,
): string => {
  const grouped = groupByCapability(normalizeToolExposure(toolNames, descriptors));
  if (grouped.size === 0) return "- none";
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capability, tools]) =>
      `- ${capability} — ${capabilitySummary(capability, tools)} (${tools.length} tool${
        tools.length === 1 ? "" : "s"
      })`)
    .join("\n");
};

const renderSchema = (schema: Record<string, unknown> | undefined): string | undefined => {
  if (!isRecord(schema)) return undefined;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  if (!properties || Object.keys(properties).length === 0) return undefined;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : [],
  );
  const parts = Object.entries(properties).map(([key, value]) => {
    const type = isRecord(value) && typeof value.type === "string" ? value.type : "any";
    return `${key}${required.has(key) ? "" : "?"}: ${type}`;
  });
  const rendered = `{ ${parts.join(", ")} }`;
  return rendered.length > MAX_SCHEMA_CHARS
    ? `${rendered.slice(0, MAX_SCHEMA_CHARS)}… }`
    : rendered;
};

export interface RenderToolLinesResult {
  text: string;
  expandedTools: string[];
  truncated: boolean;
}

/**
 * Stage 2 rendering: full descriptions and argument shapes, narrowed to the
 * capabilities the classifier selected. Passing no selection expands
 * everything, which is the correct behaviour for small local tool sets.
 */
export const renderToolLines = (
  toolNames: readonly string[],
  descriptors: ToolExposureDescriptors | undefined,
  selectedCapabilities?: readonly string[],
): RenderToolLinesResult => {
  const all = normalizeToolExposure(toolNames, descriptors);
  const selection = selectedCapabilities?.length
    ? new Set(selectedCapabilities.map((entry) => entry.trim().toLowerCase()))
    : undefined;
  const narrowed = selection
    ? all.filter((tool) => selection.has(tool.capability.toLowerCase()))
    : all;
  // A classifier that selects nothing recognizable must not blind the planner.
  const candidates = narrowed.length > 0 ? narrowed : all;
  const expanded = candidates.slice(0, MAX_EXPANDED_TOOLS);

  if (expanded.length === 0) {
    return { text: "- none", expandedTools: [], truncated: false };
  }

  const text = expanded
    .map((tool) => {
      const schema = renderSchema(tool.inputSchema);
      const write = tool.readOnly ? "" : " [write]";
      return schema
        ? `- ${tool.name}${write}: ${tool.description}\n  args: ${schema}`
        : `- ${tool.name}${write}: ${tool.description}`;
    })
    .join("\n");

  return {
    text,
    expandedTools: expanded.map((tool) => tool.name),
    truncated: candidates.length > expanded.length,
  };
};
