import { createMcpServerRegistry, type McpServerRegistry } from "./McpServerRegistry.js";
import type { McpServerHealth } from "./McpServerRegistry.js";
import type { RunContext } from "../../runcontext/RunContextResolver.js";
import type { ToolRegistry } from "../../tools/ToolRegistry.js";

/**
 * Connects a run's configured MCP servers and registers what they expose into
 * the run's `ToolRegistry`.
 *
 * Registration goes into the *existing* registry rather than a parallel store:
 * one source of truth means the planner cannot see a schema the executor would
 * not honour, no matter where the tool came from.
 */

export interface McpAttachResult {
  registry?: McpServerRegistry;
  health: McpServerHealth[];
  registered: string[];
  warnings: string[];
}

export interface McpAttachOptions {
  context: RunContext;
  toolRegistry: ToolRegistry;
  maxConcurrentCalls?: number;
  /** Injected in tests. */
  createRegistry?: typeof createMcpServerRegistry;
}

export const attachMcpTools = async (
  options: McpAttachOptions,
): Promise<McpAttachResult> => {
  const servers = options.context.mcpServers ?? [];
  if (servers.length === 0) {
    return { health: [], registered: [], warnings: [] };
  }

  const warnings: string[] = [];
  const registry = (options.createRegistry ?? createMcpServerRegistry)({
    servers,
    maxConcurrentCalls: options.maxConcurrentCalls,
  });

  const definitions = await registry.discoverTools();
  const registered: string[] = [];

  for (const definition of definitions) {
    try {
      options.toolRegistry.register(definition);
      registered.push(definition.name);
    } catch (error) {
      // A duplicate name means two servers claimed the same namespaced tool,
      // which the `mcp:<server>:<tool>` scheme should prevent. Report rather
      // than crash, and keep the first registration.
      warnings.push(
        `mcp_tool_registration_failed:${definition.name}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const health = registry.healthReport();
  for (const entry of health) {
    if (entry.status === "failed") {
      warnings.push(`mcp_server_unavailable:${entry.name}:${entry.error ?? "unknown"}`);
    }
  }

  return { registry, health, registered, warnings };
};
