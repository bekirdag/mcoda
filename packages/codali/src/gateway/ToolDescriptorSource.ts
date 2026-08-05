import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolDefinition, ToolDescriptor } from "../tools/ToolTypes.js";
import { toolDescriptorFor } from "../tools/ToolRegistry.js";
import type { CodaliGatewayPlannerToolDescriptor } from "./GatewayPlanner.js";

/**
 * Bridges the executor's tool registry to the planner's model-facing view.
 *
 * This exists so there is exactly one place where a tool's schema is turned
 * into something a model reads. If the planner and the executor ever disagree
 * about a tool's arguments, it is because something bypassed this function.
 */

const toPlannerDescriptor = (
  descriptor: ToolDescriptor,
): CodaliGatewayPlannerToolDescriptor => ({
  name: descriptor.name,
  description: descriptor.description,
  inputSchema: descriptor.inputSchema as Record<string, unknown> | undefined,
  outputSchema: descriptor.outputSchema as Record<string, unknown> | undefined,
  capability: descriptor.capability,
  readOnly: descriptor.readOnly,
});

export const gatewayToolDescriptorsFromDefinitions = (
  tools: readonly ToolDefinition[],
): Record<string, CodaliGatewayPlannerToolDescriptor> => {
  const descriptors: Record<string, CodaliGatewayPlannerToolDescriptor> = {};
  for (const tool of tools) {
    descriptors[tool.name] = toPlannerDescriptor(toolDescriptorFor(tool));
  }
  return descriptors;
};

export const gatewayToolDescriptorsFromRegistry = (
  registry: ToolRegistry,
  names?: readonly string[],
): Record<string, CodaliGatewayPlannerToolDescriptor> => {
  const descriptors: Record<string, CodaliGatewayPlannerToolDescriptor> = {};
  for (const descriptor of registry.catalog(names)) {
    descriptors[descriptor.name] = toPlannerDescriptor(descriptor);
  }
  return descriptors;
};
