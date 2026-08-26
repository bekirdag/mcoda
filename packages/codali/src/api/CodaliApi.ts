import { randomUUID } from "node:crypto";
import { attachHttpTools } from "../connectors/http/HttpToolSource.js";
import { attachMcpTools } from "../connectors/mcp/McpToolSource.js";
import {
  createImageGenerationTool,
  type ImageGenerationConfig,
} from "../connectors/media/ImageGenerationTool.js";
import { DocdexClient, docdexRepoRootFor } from "../docdex/DocdexClient.js";
import { createCodaliGateway } from "../gateway/CodaliGateway.js";
import { createLocalGatewayTaskRunner } from "../gateway/LocalGatewayTaskRunner.js";
import { createProviderForAssignment } from "../gateway/LocalGatewayProvider.js";
import { gatewayToolDescriptorsFromRegistry } from "../gateway/ToolDescriptorSource.js";
import { defaultPerTaskTimeoutMs } from "../gateway/GatewayStateMachine.js";
import { GatewayTracer } from "../gateway/GatewayTracer.js";
import { getAgentInventory, filterLocallyDrivable } from "../agents/AgentInventory.js";
import { resolveConfigurableRoles } from "../agents/RoleResolution.js";
import { providerSupportsToolCalls } from "../providers/ProviderTypes.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { createDocdexTools } from "../tools/docdex/DocdexTools.js";
import { LocalConfigRunContextResolver } from "../runcontext/RunContextResolver.js";
import type { RunContext } from "../runcontext/RunContextResolver.js";
import type {
  CodaliArtifactRef,
  CodaliGatewayMode,
  CodaliGatewayRequest,
  CodaliGatewayResult,
  CodaliGatewaySource,
  CodaliGatewayStatus,
} from "../gateway/CodaliGatewayTypes.js";
import { resolveMswarmClientProduct } from "@mcoda/shared";

/**
 * The canonical Codali API.
 *
 * This is the contract products integrate against — okacam AI chat, line items,
 * badges, employee daily-log review. One entry point, one result shape, the
 * same behaviour the CLI gets, so a product never has to reimplement routing,
 * tool selection, evidence handling, or budget enforcement.
 *
 * Everything a run is allowed to touch arrives on the request as `runContext`.
 * Codali does not call back into the host to fetch tenant configuration: the
 * authenticated host already holds it, and a callback would make every request
 * a circular distributed dependency.
 */

export interface CodaliMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CodaliRequest {
  messages: CodaliMessage[];
  /** Tenant scope, tools, credentials, agent bindings, limits. */
  runContext?: RunContext;
  /**
   * Permits falling back to the operator's own configuration when no context
   * is supplied — `~/.codali/config.json` and `~/.codali/.creds`.
   *
   * Off by default, and it must stay that way. Those files hold the operator's
   * GitHub, Jira and Microsoft tokens, so a tenant request that forgot its
   * context would be answered from the wrong account. It would not error: it
   * would return a plausible answer against someone else's data, and in
   * development, where the operator is the tenant, it would look correct.
   *
   * Set it only where the caller genuinely is the operator: the CLI, and a
   * server the operator runs for themselves.
   */
  allowOperatorConfigFallback?: boolean;
  /** JSON Schema the answer must satisfy. Enforced, with one repair attempt. */
  responseSchema?: Record<string, unknown>;
  responseMode?: "text" | "json" | "artifact";
  mode?: CodaliGatewayMode;
  /** Workspace the run resolves paths against. Defaults to `process.cwd()`. */
  workspaceRoot?: string;
  requestId?: string;
  product?: { name?: string; version?: string; surface?: string };
  /** Image generation config; absent means the media tool is not offered. */
  media?: ImageGenerationConfig;
  budgets?: {
    maxRounds?: number;
    maxToolCalls?: number;
    maxModelCalls?: number;
    deadlineMs?: number;
  };
}

export interface CodaliSourceRef extends CodaliGatewaySource {}

/**
 * One tool call the run made, as the tracer recorded it.
 *
 * Arguments are deliberately not carried: they are model-generated and often
 * contain the user's own text, and a host that logs the result should not have
 * to sanitise it again. The name, the outcome and the latency are what answer
 * "did this question actually retrieve anything?", which is the question a host
 * run log has to be able to answer.
 */
export interface CodaliToolCallRecord {
  taskId: string;
  tool: string;
  ok?: boolean;
  latencyMs?: number;
  errorCode?: string;
}

export interface CodaliResult {
  status: CodaliGatewayStatus;
  /** Text answer, or the clarifying question when status is needs_clarification. */
  answer: string;
  /** Schema-conformant structured output when a responseSchema was supplied. */
  output: unknown;
  sources: CodaliSourceRef[];
  artifacts: CodaliArtifactRef[];
  warnings: string[];
  traceId: string;
  /**
   * Whether the answer was required to rest on retrieved evidence.
   *
   * `open` means there was nothing to retrieve - a request to write a function,
   * an arithmetic question - so an empty `sources` list is the correct outcome
   * and not a failed search. A host that suppresses uncited answers must read
   * this before deciding; absent means assume `grounded`.
   */
  groundingMode?: CodaliGatewayResult["groundingMode"];
  /** Every tool call the run made, in order. Empty when it called none. */
  toolCalls: CodaliToolCallRecord[];
}

const DEFAULTS = {
  maxRounds: 3,
  maxToolCalls: 20,
  maxModelCalls: 12,
  deadlineMs: 600_000,
  maxParallelWorkers: 3,
};

const DEFAULT_DOCDEX_TOOLS = [
  "docdex_search",
  "docdex_open",
  "docdex_symbols",
  "docdex_tree",
  "docdex_files",
  "docdex_impact_graph",
  "docdex_batch_search",
  "docdex_web_research",
  "docdex_stats",
];

/** Flattens a message list into the single query the gateway plans against. */
export const messagesToQuery = (messages: readonly CodaliMessage[]): string => {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  if (!lastUser) return "";
  const priorContext = messages
    .slice(0, messages.indexOf(lastUser))
    .filter((message) => message.role !== "system")
    .slice(-4)
    .map((message) => `${message.role}: ${message.content}`);
  return priorContext.length > 0
    ? `${priorContext.join("\n")}\n\nCurrent question: ${lastUser.content}`
    : lastUser.content;
};

/** The tracer's tool-call log, minus the model-generated arguments. */
const toolCallRecords = (tracer: GatewayTracer): CodaliToolCallRecord[] =>
  tracer.snapshot().toolCalls.map((call) => ({
    taskId: call.taskId,
    tool: call.tool,
    ok: call.ok,
    latencyMs: call.latencyMs,
    errorCode: call.errorCode,
  }));

export interface CodaliRunDependencies {
  loadInventory?: typeof getAgentInventory;
  resolveRunContext?: (workspaceRoot: string) => Promise<RunContext>;
  buildRegistry?: (workspaceRoot: string, context: RunContext) => ToolRegistry;
  createProvider?: typeof createProviderForAssignment;
  attachMcp?: typeof attachMcpTools;
}

/**
 * Runs one Codali request end to end.
 *
 * The same code path the CLI uses, so a product and the terminal cannot drift.
 */
export const runCodali = async (
  request: CodaliRequest,
  deps: CodaliRunDependencies = {},
): Promise<CodaliResult> => {
  const workspaceRoot = request.workspaceRoot ?? process.cwd();
  const query = messagesToQuery(request.messages);
  const tracer = new GatewayTracer(query);

  if (!query.trim()) {
    return {
      status: "failed",
      answer: "The request contained no user message.",
      output: undefined,
      sources: [],
      artifacts: [],
      warnings: ["empty_request"],
      traceId: request.requestId ?? randomUUID(),
      toolCalls: [],
    };
  }

  // Host-supplied context wins. A host that supplies neither a context nor a
  // resolver is not configured for tenants, and answering anyway would use the
  // operator's credentials — so refuse instead of guessing whose data to read.
  const resolvedContext = request.runContext
    ? request.runContext
    : deps.resolveRunContext
      ? await deps.resolveRunContext(workspaceRoot)
      : request.allowOperatorConfigFallback
        ? await new LocalConfigRunContextResolver().resolve({ workspaceRoot })
        : undefined;
  if (!resolvedContext) {
    return {
      status: "failed",
      answer:
        "No run context was supplied. Codali does not call back into the host, " +
        "so a run must arrive with the tenant's tools, credentials and scope on " +
        "`request.runContext` (or a `resolveRunContext` dependency). Set " +
        "`allowOperatorConfigFallback: true` only when the caller is the machine " +
        "operator — it reads ~/.codali/config.json and ~/.codali/.creds.",
      output: undefined,
      sources: [],
      artifacts: [],
      warnings: ["run_context_required"],
      traceId: request.requestId ?? randomUUID(),
      toolCalls: [],
    };
  }
  const context = resolvedContext;
  for (const warning of context.warnings ?? []) tracer.addWarning(warning);

  const inventory = await (deps.loadInventory ?? getAgentInventory)();
  const drivable = filterLocallyDrivable(inventory.agents);
  const roles = resolveConfigurableRoles({
    inventory: drivable,
    bindings: context.agentRoles,
    roles: request.media ? ["orchestrator", "synthesizer", "media"] : undefined,
  });
  for (const warning of roles.warnings) tracer.addWarning(warning);

  const orchestrator = roles.assignments.orchestrator;
  const synthesizer = roles.assignments.synthesizer;
  if (!orchestrator && !synthesizer) {
    return {
      status: "failed",
      answer: "No usable model agent could be resolved for this run.",
      output: undefined,
      sources: [],
      artifacts: [],
      warnings: [...tracer.snapshot().warnings, "no_agents_resolved"],
      traceId: request.requestId ?? randomUUID(),
      toolCalls: [],
    };
  }

  // mswarm reaches a node the caller does not own by matching this against the
  // node's client allowlist, so every model call has to carry it. The slug is
  // what the self-hosted setup console registers ("wodo", "heka"); the id is a
  // usable fallback when a host only tracks ids.
  const clientIdentity = context.tenant?.slug ?? context.tenant?.id;
  // Sent alongside the identity, never instead of it: a node may admit this caller
  // by its product without the tenant itself being allowlisted.
  const clientProduct = resolveMswarmClientProduct(context.tenant?.product);
  const baseProvider = deps.createProvider ?? createProviderForAssignment;
  const makeProvider: typeof createProviderForAssignment = (assignment, options) =>
    baseProvider(assignment, { clientIdentity, clientProduct, ...options });
  const primary = makeProvider((synthesizer ?? orchestrator)!);
  const orchestratorProvider = orchestrator ? makeProvider(orchestrator) : undefined;

  const workerCandidates = [roles.toolCapable, orchestrator, synthesizer].filter(Boolean);
  let worker = primary;
  for (const candidate of workerCandidates) {
    const provider = makeProvider(candidate!);
    if (providerSupportsToolCalls(provider)) {
      worker = provider;
      break;
    }
  }
  const toolsExecutable = providerSupportsToolCalls(worker);

  const min = (a: number, b?: number) => (b === undefined ? a : Math.min(a, b));

  // ---- Tools ------------------------------------------------------------
  const registry =
    deps.buildRegistry?.(workspaceRoot, context) ?? buildDefaultRegistry(workspaceRoot, context);

  const mcp = await (deps.attachMcp ?? attachMcpTools)({ context, toolRegistry: registry });
  for (const warning of mcp.warnings) tracer.addWarning(warning);
  const http = attachHttpTools({ context, toolRegistry: registry });
  for (const warning of http.warnings) tracer.addWarning(warning);

  const artifacts: CodaliArtifactRef[] = [];
  const runId = request.requestId ?? `codali-${randomUUID()}`;
  if (request.media) {
    registry.register(
      createImageGenerationTool({
        config: request.media,
        workspaceRoot,
        runId,
        onArtifact: (artifact) => artifacts.push(artifact),
      }),
    );
  }

  const registered = registry.list().map((tool) => tool.name);
  const readOnlyMcpTools = registry
    .catalog(mcp.registered)
    .filter((descriptor) => descriptor.readOnly)
    .map((descriptor) => descriptor.name);
  const defaultAllowed = [
    ...DEFAULT_DOCDEX_TOOLS,
    ...readOnlyMcpTools,
    ...http.registered,
    ...(request.media ? ["media_generate_image"] : []),
  ];
  // A run with no tool budget is a run without tools. Offering them anyway
  // produced tasks that could not execute, and a failed job where the honest
  // outcome was an answer given without them.
  const toolBudget = min(
    request.budgets?.maxToolCalls ?? DEFAULTS.maxToolCalls,
    context.limits?.maxToolCalls,
  );
  const allowedTools = toolsExecutable && toolBudget > 0
    ? (context.allowedTools ?? defaultAllowed).filter((tool) => registered.includes(tool))
    : [];
  // Losing every tool because the worker model cannot emit tool calls is the
  // most consequential thing that can happen to a run, and it used to happen in
  // silence: connectors registered, compiled, reported visible, and never
  // called, with a successful run and an empty source list as the only symptom.
  // Say it, and name what was lost.
  if (!toolsExecutable && registered.length > 0) {
    tracer.addWarning(
      `tools_disabled_worker_cannot_call_tools:${worker.name}:${registered.length}_tools_dropped`,
    );
  }

  // Every allowed tool must be declared to the capability compiler, which
  // otherwise discards it as `not_declared` — including docdex tools outside
  // its hardcoded backing-tool set, such as `docdex_web_research`. That
  // omission kept the "web" capability off the classifier's list entirely, so
  // no question could ever reach the public web.
  const connectorTools = allowedTools;

  // ---- Budgets ----------------------------------------------------------
  const maxRounds = min(request.budgets?.maxRounds ?? DEFAULTS.maxRounds, context.limits?.maxRounds);
  const maxToolCalls = toolBudget;
  const deadlineMs = min(
    request.budgets?.deadlineMs ?? DEFAULTS.deadlineMs,
    context.limits?.deadlineMs,
  );

  const gatewayRequest: CodaliGatewayRequest = {
    id: runId,
    query,
    mode: request.mode ?? "balanced",
    product: request.product ?? { name: "codali-api" },
    tenant: context.tenant,
    tools: connectorTools.length > 0
      ? { actualTools: connectorTools, readOnlyTools: connectorTools }
      : undefined,
    docdex: {
      enabled: true,
      baseUrl: context.docdex?.baseUrl,
      repoRoot: context.repo?.root ?? workspaceRoot,
      repoId: context.docdex?.repoId,
    },
    policy: {
      allowedTools,
      deniedTools: context.deniedTools,
      maxIterations: maxRounds,
      maxRuntimeMs: deadlineMs,
      maxToolCalls,
      maxModelCalls: request.budgets?.maxModelCalls ?? DEFAULTS.maxModelCalls,
      maxEvidenceItems: 40,
      maxImageArtifacts: request.media ? 4 : 0,
      maxContextPackTokens: 16_000,
      allowWrites: false,
      allowShell: false,
      allowDestructiveOperations: false,
      allowOutsideWorkspace: false,
      requireFinalLargeModel: false,
      allowDegradedFinalAnswer: true,
      allowImageWorker: Boolean(request.media),
    },
    response: {
      format: request.responseSchema ? "json" : (request.responseMode === "json" ? "json" : "text"),
      schema: request.responseSchema,
    },
  };

  const gateway = createCodaliGateway({
    provider: primary,
    // Classify and plan on the orchestrator model; only the final answer pays
    // for the large one.
    plannerProvider: orchestratorProvider ?? primary,
    // So the trace names the model that actually ran.
    finalAgent: synthesizer ?? orchestrator,
    agentInventory: drivable,
    toolDescriptors: gatewayToolDescriptorsFromRegistry(registry, allowedTools),
    taskRunner: createLocalGatewayTaskRunner({
      provider: worker,
      registry,
      toolContext: {
        workspaceRoot,
        allowShell: false,
        allowDestructiveOperations: false,
        allowOutsideWorkspace: false,
      },
      onEvent: (event) => {
        if (event.type === "tool_call") {
          tracer.recordToolCall({ taskId: event.taskId, tool: event.tool, args: event.args });
        } else if (event.type === "tool_result") {
          tracer.recordToolResult({
            taskId: event.taskId,
            tool: event.tool,
            ok: event.ok,
            latencyMs: event.latencyMs,
            errorCode: event.errorCode,
          });
        }
      },
    }),
    workerOptions: {
      maxRuntimeMs: deadlineMs,
      maxToolCalls,
      perTaskTimeoutMs: defaultPerTaskTimeoutMs(deadlineMs),
      maxParallelWorkers: DEFAULTS.maxParallelWorkers,
    },
  });

  try {
    const result = await gateway.run(gatewayRequest);
    return {
      status: result.status,
      answer: result.answer,
      output: result.output ?? result.answer,
      sources: result.sources,
      // Artifacts collected by the media tool are authoritative; the gateway's
      // own list covers anything a worker persisted directly.
      artifacts: artifacts.length > 0 ? artifacts : result.artifacts,
      warnings: [...tracer.snapshot().warnings, ...result.warnings],
      traceId: result.runId,
      groundingMode: result.groundingMode,
      /**
       * What the run actually called, so a host run log can answer "did this
       * question retrieve anything?" without reading a proxy access log. Every
       * okacam run recorded `toolCallCount: 0` for months because this was not
       * on the result to report.
       */
      toolCalls: toolCallRecords(tracer),
    };
  } catch (error) {
    return {
      status: "failed",
      answer: `Codali run failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      output: undefined,
      sources: [],
      artifacts,
      warnings: tracer.snapshot().warnings,
      traceId: runId,
      toolCalls: toolCallRecords(tracer),
    };
  } finally {
    await mcp.registry?.close();
  }
};

const buildDefaultRegistry = (
  workspaceRoot: string,
  context: RunContext,
): ToolRegistry => {
  const registry = new ToolRegistry();
  const client = new DocdexClient({
    baseUrl: context.docdex?.baseUrl ?? "http://127.0.0.1:28491",
    repoRoot: docdexRepoRootFor(context.repo?.root, context.docdex?.repoId, workspaceRoot),
    repoId: context.docdex?.repoId,
    apiKey: context.docdex?.apiKey,
    allowedOperations: context.docdex?.allowedOperations,
    // Same allowlist story as the model calls: a tenant reaching a repository
    // it does not own is authorised by identity, not by key alone.
    clientIdentity: context.tenant?.slug ?? context.tenant?.id,
  });
  for (const tool of createDocdexTools(client)) registry.register(tool);
  return registry;
};
