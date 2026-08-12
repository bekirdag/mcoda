import type { RunContext } from "../../runcontext/RunContextResolver.js";
import type { ToolRegistry } from "../../tools/ToolRegistry.js";
import { httpConnectorToDefinitions } from "./HttpToolDefinition.js";

/**
 * Registers a run's declared HTTP connectors into its existing tool registry,
 * the same way MCP tools are attached. One registry remains the single source
 * of truth regardless of where a tool came from.
 */

export interface HttpAttachResult {
  registered: string[];
  warnings: string[];
}

export interface HttpAttachOptions {
  context: RunContext;
  toolRegistry: ToolRegistry;
  fetchImpl?: typeof fetch;
}

export const attachHttpTools = (options: HttpAttachOptions): HttpAttachResult => {
  const connectors = options.context.httpConnectors ?? [];
  const registered: string[] = [];
  const warnings: string[] = [];

  for (const connector of connectors) {
    let definitions;
    try {
      definitions = httpConnectorToDefinitions({ connector, fetchImpl: options.fetchImpl });
    } catch (error) {
      // A connector declaring a mutating method is a configuration error, not a
      // runtime one. Reject the connector and say why rather than silently
      // dropping it or, worse, allowing the write.
      warnings.push(
        `http_connector_rejected:${connector.name}:${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    for (const definition of definitions) {
      try {
        options.toolRegistry.register(definition);
        registered.push(definition.name);
        // The host can only fix this if it hears about it. A tool with no
        // declared arguments still works, but a worker asked for something the
        // schema does not mention will conclude the tool cannot do the job.
        const declaredProperties = Object.keys(definition.inputSchema?.properties ?? {}).length;
        if (declaredProperties === 0) {
          warnings.push(`http_tool_has_no_declared_arguments:${definition.name}`);
        }
      } catch (error) {
        warnings.push(
          `http_tool_registration_failed:${definition.name}:${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return { registered, warnings };
};
