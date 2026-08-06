import { readFile } from "node:fs/promises";
import path from "node:path";
import { attachHttpTools } from "../connectors/http/HttpToolSource.js";
import { attachMcpTools } from "../connectors/mcp/McpToolSource.js";
import { DocdexClient } from "../docdex/DocdexClient.js";
import { LocalConfigRunContextResolver } from "../runcontext/RunContextResolver.js";
import type { RunContext } from "../runcontext/RunContextResolver.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { createDocdexTools } from "../tools/docdex/DocdexTools.js";
import { sanitizeArgs } from "../gateway/GatewayTracer.js";
import { inspectToolSurface } from "../gateway/ToolSurface.js";

/**
 * `codali tools` — inspect what an orchestration run can actually reach.
 *
 * Without this the only way to find out which tools a configured MCP server
 * exposes is to ask a question and read the trace, which conflates connector
 * problems with planning problems.
 */

const HELP = `Usage: codali tools <list|describe|call|health> [options]

Commands:
  list                 List every tool available to a run, grouped by capability
  describe <name>      Show one tool's description and argument schema
  call <name>          Invoke a tool directly (read-only connectors)
  health               Show MCP server connection status

Options:
  --workspace-root <path>   Repository to resolve config against (default: cwd)
  --args-json <json>        Arguments for "call"
  --context-json <path>     Run against a host-supplied RunContext instead of
                            local config, to see what one tenant's run gets
  --json                    Machine-readable output
  --help, -h                Show this help
`;

export interface ToolsOptions {
  command: "list" | "describe" | "call" | "health";
  target?: string;
  workspaceRoot: string;
  argsJson?: string;
  contextJson?: string;
  json: boolean;
}

export const parseToolsArgs = (argv: string[]): ToolsOptions => {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand as ToolsOptions["command"];
  if (!["list", "describe", "call", "health"].includes(command)) {
    throw new Error(`Unknown tools command: ${rawCommand ?? "(none)"}\n\n${HELP}`);
  }

  let workspaceRoot = process.cwd();
  let argsJson: string | undefined;
  let json = false;
  let contextJson: string | undefined;
  let target: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const next = rest[index + 1];
    if (arg === "--workspace-root" && next) {
      workspaceRoot = path.resolve(next);
      index += 1;
    } else if (arg === "--context-json" && next) {
      contextJson = next;
      index += 1;
    } else if (arg === "--args-json" && next) {
      argsJson = next;
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg && !arg.startsWith("--") && !target) {
      target = arg;
    }
  }

  if ((command === "describe" || command === "call") && !target) {
    throw new Error(`codali tools ${command} requires a tool name.\n\n${HELP}`);
  }

  return { command, target, workspaceRoot, argsJson, contextJson, json };
};

export interface ToolsDependencies {
  resolveRunContext?: (workspaceRoot: string) => Promise<RunContext>;
  buildBaseRegistry?: (context: RunContext, workspaceRoot: string) => ToolRegistry;
  attachMcp?: typeof attachMcpTools;
  write?: (line: string) => void;
}

const buildBaseRegistryDefault = (
  context: RunContext,
  workspaceRoot: string,
): ToolRegistry => {
  const registry = new ToolRegistry();
  const client = new DocdexClient({
    baseUrl: context.docdex?.baseUrl ?? "http://127.0.0.1:28491",
    repoRoot: context.repo?.root ?? workspaceRoot,
    repoId: context.docdex?.repoId,
    apiKey: context.docdex?.apiKey,
    allowedOperations: context.docdex?.allowedOperations,
  });
  for (const tool of createDocdexTools(client)) registry.register(tool);
  return registry;
};

export const runTools = async (
  argv: string[],
  deps: ToolsDependencies = {},
): Promise<number> => {
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    write(HELP);
    return 0;
  }

  const options = parseToolsArgs(argv);
  // A host-supplied context answers the question a product actually has: not
  // "what can this machine do" but "what would this tenant's run get".
  const context = options.contextJson
    ? (JSON.parse(await readFile(options.contextJson, "utf8")) as RunContext)
    : deps.resolveRunContext
      ? await deps.resolveRunContext(options.workspaceRoot)
      : await new LocalConfigRunContextResolver().resolve({
          workspaceRoot: options.workspaceRoot,
        });

  const registry = (deps.buildBaseRegistry ?? buildBaseRegistryDefault)(
    context,
    options.workspaceRoot,
  );

  const mcp = await (deps.attachMcp ?? attachMcpTools)({
    context,
    toolRegistry: registry,
  });
  // Hand-declared HTTP connectors are part of the same catalog; omitting them
  // here would make `tools list` disagree with what a run can actually reach.
  const http = attachHttpTools({ context, toolRegistry: registry });
  mcp.warnings.push(...http.warnings);

  try {
    if (options.command === "health") {
      if (options.json) {
        write(JSON.stringify({ servers: mcp.health, warnings: mcp.warnings }, null, 2));
      } else if (mcp.health.length === 0) {
        write("No MCP servers configured.");
        write("Add them under \"mcpServers\" in ~/.codali/config.json.");
      } else {
        for (const server of mcp.health) {
          const detail =
            server.status === "connected"
              ? `${server.toolCount} tool(s), ${server.discoveryMs ?? 0}ms`
              : (server.error ?? server.status);
          write(`${server.status === "connected" ? "ok  " : "FAIL"} ${server.name}  ${detail}`);
        }
      }
      return mcp.health.some((server) => server.status === "failed") ? 1 : 0;
    }

    if (options.command === "list") {
      const capabilities = registry.capabilities();
      if (options.json) {
        write(JSON.stringify(inspectToolSurface(context, registry), null, 2));
        return 0;
      }
      const surface = inspectToolSurface(context, registry);
      if (surface.dropped.length > 0) {
        // Silent loss is the failure this exists to catch: a tool the host
        // supplied, present in the registry, that the compiler will not let
        // the planner see. The run does not fail — it answers without it.
        write(`${surface.dropped.length} tool(s) will NOT reach the planner:`);
        for (const entry of surface.dropped) write(`  ${entry.tool}  (${entry.reason})`);
        write("");
      }
      if (capabilities.size === 0) {
        write("No tools available.");
        return 0;
      }
      for (const [capability, tools] of [...capabilities.entries()].sort(([a], [b]) =>
        a.localeCompare(b))) {
        write(`${capability} (${tools.length})`);
        for (const tool of tools.sort((a, b) => a.name.localeCompare(b.name))) {
          const flag = tool.readOnly ? "" : " [write]";
          write(`  ${tool.name}${flag}`);
          write(`    ${tool.description}`);
        }
        write("");
      }
      for (const warning of mcp.warnings) write(`warning: ${warning}`);
      return 0;
    }

    if (options.command === "describe") {
      const descriptor = registry.catalog([options.target as string])[0];
      if (!descriptor) {
        write(`Unknown tool: ${options.target}`);
        return 1;
      }
      if (options.json) {
        write(JSON.stringify(descriptor, null, 2));
        return 0;
      }
      write(descriptor.name);
      write(`  capability: ${descriptor.capability}`);
      write(`  read-only:  ${descriptor.readOnly}`);
      write(`  ${descriptor.description}`);
      if (descriptor.inputSchema) {
        write("  input schema:");
        write(
          JSON.stringify(descriptor.inputSchema, null, 2)
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n"),
        );
      }
      return 0;
    }

    // call
    const descriptor = registry.catalog([options.target as string])[0];
    if (!descriptor) {
      write(`Unknown tool: ${options.target}`);
      return 1;
    }
    if (!descriptor.readOnly) {
      // Phase 2 connectors are read-only by policy; a direct invocation must
      // not be the way around that.
      write(`Refusing to call ${descriptor.name}: it is not marked read-only.`);
      return 1;
    }

    const args = options.argsJson ? JSON.parse(options.argsJson) : {};
    const result = await registry.execute(descriptor.name, args, {
      workspaceRoot: options.workspaceRoot,
      allowShell: false,
      allowDestructiveOperations: false,
      allowOutsideWorkspace: false,
    });

    if (options.json) {
      write(
        JSON.stringify(
          {
            ok: result.ok,
            output: result.output,
            error: result.error,
            args: sanitizeArgs(args),
          },
          null,
          2,
        ),
      );
    } else if (result.ok) {
      write(result.output);
    } else {
      write(`Tool failed (${result.error?.code}): ${result.error?.message}`);
    }
    return result.ok ? 0 : 1;
  } finally {
    // stdio servers are child processes; leaving them running would orphan them.
    await mcp.registry?.close();
  }
};

export const ToolsCommand = {
  async run(argv: string[]): Promise<void> {
    const exitCode = await runTools(argv);
    if (exitCode !== 0) process.exitCode = exitCode;
  },
};
