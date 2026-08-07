import { compileCodaliGatewayPolicy } from "./GatewayPolicyCompiler.js";
import type { RunContext } from "../runcontext/RunContextResolver.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";

/**
 * What a host's declared tools actually become inside a run.
 *
 * A tool can be present in the registry and still never reach the planner. The
 * capability compiler drops anything the request did not declare as an actual
 * tool, and it does so quietly: the run succeeds, the model is simply never
 * offered the tool, and the answer comes back thinner with no error to explain
 * why. That has now cost this project twice — first the MCP connector tools,
 * then `docdex_web_research`, which meant the web capability was never offered
 * to the classifier at all.
 *
 * A host embedding Codali configures tools per tenant and cannot see any of
 * this. This reports it: what was supplied, what survived, and the compiler's
 * own reason for every tool that did not.
 */

export interface ToolSurfaceEntry {
  tool: string;
  reason: string;
}

export interface ToolSurfaceOptions {
  /**
   * Whether the model that will run the tasks can emit tool calls.
   *
   * A run whose worker cannot call tools is given an empty allowed list, so
   * every tool is lost no matter how correctly it was declared. Reporting the
   * compiled surface without this said "visible, nothing dropped" about a run
   * that would call nothing — the exact false confidence this check exists to
   * prevent. Defaults to true so a caller only asking about declaration still
   * gets a useful answer.
   */
  workerCanCallTools?: boolean;
}

export interface ToolSurfaceReport {
  /** Tools registered from the context — MCP servers, HTTP connectors, docdex. */
  registered: string[];
  /** Tools the planner will actually be offered. */
  visible: string[];
  /** Registered but unreachable, with the compiler's reason. */
  dropped: ToolSurfaceEntry[];
  /** Warnings raised while compiling the tool surface. */
  warnings: string[];
}

/**
 * Compiles the tool surface exactly as a run would, and reports the difference.
 *
 * Deliberately uses the real compiler rather than reimplementing its rules: a
 * conformance check that can disagree with the thing it checks is worse than
 * none, because it grants confidence it has not earned.
 */
export const inspectToolSurface = (
  context: RunContext,
  registry: ToolRegistry,
  options: ToolSurfaceOptions = {},
): ToolSurfaceReport => {
  const registered = registry.catalog().map((tool) => tool.name).sort();

  if (options.workerCanCallTools === false) {
    return {
      registered,
      visible: [],
      dropped: registered.map((tool) => ({
        tool,
        reason: "worker_cannot_call_tools",
      })),
      warnings: [
        "The worker model cannot emit tool calls, so this run is given no tools " +
          "at all. Nothing below is a declaration problem.",
      ],
    };
  }

  const compilation = compileCodaliGatewayPolicy({
    request: {
      query: "",
      policy: { allowedTools: registered },
      // `actualTools` belongs on the tool manifest, not the policy. Declaring
      // it in the wrong place is silent — the compiler simply reports every
      // connector tool as `not_declared` — and it is the mistake this project
      // has now made three times, twice in production code and once while
      // writing this very check.
      tools: { actualTools: registered },
      tenant: context.tenant,
      docdex: context.docdex
        ? {
            baseUrl: context.docdex.baseUrl,
            repoId: context.docdex.repoId,
            allowedOperations: context.docdex.allowedOperations,
          }
        : undefined,
    } as never,
  });

  const visible = [...compilation.effectiveAllowedTools].sort();
  const visibleSet = new Set(visible);
  const reasons = new Map<string, string>();
  for (const skipped of compilation.skippedTools ?? []) {
    if (typeof skipped === "string") {
      reasons.set(skipped, "skipped");
      continue;
    }
    const entry = skipped as { tool?: string; reason?: string };
    if (entry.tool) reasons.set(entry.tool, entry.reason ?? "skipped");
  }

  const dropped = registered
    .filter((tool) => !visibleSet.has(tool))
    .map((tool) => ({ tool, reason: reasons.get(tool) ?? "not_visible_to_planner" }));

  return {
    registered,
    visible,
    dropped,
    warnings: (compilation.warnings ?? []).map((warning) =>
      typeof warning === "string" ? warning : JSON.stringify(warning),
    ),
  };
};
