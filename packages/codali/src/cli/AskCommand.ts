import path from "node:path";
import { filterLocallyDrivable, getAgentInventory } from "../agents/AgentInventory.js";
import { resolveConfigurableRoles } from "../agents/RoleResolution.js";
import { attachHttpTools } from "../connectors/http/HttpToolSource.js";
import { attachMcpTools } from "../connectors/mcp/McpToolSource.js";
import { DocdexClient } from "../docdex/DocdexClient.js";
import { createCodaliGateway } from "../gateway/CodaliGateway.js";
import { createLocalGatewayTaskRunner } from "../gateway/LocalGatewayTaskRunner.js";
import {
  createProviderForAssignment,
  RoleRoutingProvider,
} from "../gateway/LocalGatewayProvider.js";
import { gatewayToolDescriptorsFromRegistry } from "../gateway/ToolDescriptorSource.js";
import { GatewayTracer } from "../gateway/GatewayTracer.js";
import { createRelevanceJudge } from "../gateway/RelevanceJudge.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { createDocdexTools } from "../tools/docdex/DocdexTools.js";
import { LocalConfigRunContextResolver } from "../runcontext/RunContextResolver.js";
import type { RunContext } from "../runcontext/RunContextResolver.js";
import type {
  CodaliGatewayMode,
  CodaliGatewayRequest,
  CodaliGatewayResult,
} from "../gateway/CodaliGatewayTypes.js";
import { providerSupportsToolCalls } from "../providers/ProviderTypes.js";
import type { Provider } from "../providers/ProviderTypes.js";

/**
 * `codali ask` — the terminal entry point to the orchestration gateway.
 *
 * Until this existed the gateway had exactly one caller (mswarm's cloud job
 * path) and could not be exercised locally at all, which made every other
 * improvement unverifiable.
 */

/**
 * Default budgets. Deliberately small: an orchestrator that can quietly spend
 * fifty tool calls on one question is not one you can put in front of users.
 */
export const DEFAULT_MAX_ROUNDS = 3;
export const DEFAULT_MAX_TOOL_CALLS = 20;
export const DEFAULT_MAX_MODEL_CALLS = 12;
/**
 * Wall-clock budget. Generous because CLI-backed agents (codex, claude,
 * gemini) commonly take 30-90s per call, and several tasks run per question.
 */
export const DEFAULT_DEADLINE_MS = 600_000;

/**
 * Independent worker tasks executed concurrently. Bounded rather than
 * unlimited: each task holds a model call, and a tenant's connectors have their
 * own rate limits.
 */
export const DEFAULT_MAX_PARALLEL_WORKERS = 3;

/** Read-only docdex tools offered by default. */
const DEFAULT_ALLOWED_TOOLS = [
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

export interface AskOptions {
  query: string;
  workspaceRoot: string;
  mode: CodaliGatewayMode;
  trace: boolean;
  json: boolean;
  maxRounds: number;
  maxToolCalls: number;
  deadlineMs: number;
  docdexBaseUrl?: string;
  responseSchemaPath?: string;
  responseFormat?: "text" | "json";
  noTools: boolean;
}

const HELP = `Usage: codali ask "<question>" [options]

Ask Codali a question. The orchestrator routes the request, gathers evidence
with the tools available to it, and returns a cited answer.

Options:
  --workspace-root <path>   Repository to run against (default: cwd)
  --mode <mode>             fast | balanced | deep | cheap  (default: balanced)
  --trace                   Stream progress and print the run trace
  --json                    Emit the full result as JSON
  --max-rounds <n>          Orchestration rounds (default: ${DEFAULT_MAX_ROUNDS})
  --max-tool-calls <n>      Tool calls for the whole run (default: ${DEFAULT_MAX_TOOL_CALLS})
  --deadline-ms <n>         Wall-clock budget (default: ${DEFAULT_DEADLINE_MS})
  --docdex-base-url <url>   Docdex endpoint (default: http://127.0.0.1:28491)
  --response-schema <path>  JSON Schema the answer must satisfy
  --format <text|json>      Response format (default: text)
  --no-tools                Answer without tools, for a pure generation task
  --help, -h                Show this help
`;

const parseIntArg = (value: string | undefined, flag: string, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${flag} expects a positive integer`);
  }
  return parsed;
};

export const parseAskArgs = (argv: string[]): AskOptions => {
  const queryParts: string[] = [];
  let workspaceRoot = process.cwd();
  let mode: CodaliGatewayMode = "balanced";
  let trace = false;
  let json = false;
  let maxRounds = DEFAULT_MAX_ROUNDS;
  let maxToolCalls = DEFAULT_MAX_TOOL_CALLS;
  let deadlineMs = DEFAULT_DEADLINE_MS;
  let docdexBaseUrl: string | undefined;
  let responseSchemaPath: string | undefined;
  let responseFormat: "text" | "json" | undefined;
  let noTools = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--workspace-root" && next) {
      workspaceRoot = path.resolve(next);
      index += 1;
    } else if (arg === "--mode" && next) {
      mode = next as CodaliGatewayMode;
      index += 1;
    } else if (arg === "--trace") {
      trace = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--no-tools") {
      noTools = true;
    } else if (arg === "--max-rounds" && next) {
      maxRounds = parseIntArg(next, "--max-rounds", DEFAULT_MAX_ROUNDS);
      index += 1;
    } else if (arg === "--max-tool-calls" && next) {
      maxToolCalls = parseIntArg(next, "--max-tool-calls", DEFAULT_MAX_TOOL_CALLS);
      index += 1;
    } else if (arg === "--deadline-ms" && next) {
      deadlineMs = parseIntArg(next, "--deadline-ms", DEFAULT_DEADLINE_MS);
      index += 1;
    } else if (arg === "--docdex-base-url" && next) {
      docdexBaseUrl = next;
      index += 1;
    } else if (arg === "--response-schema" && next) {
      responseSchemaPath = next;
      index += 1;
    } else if (arg === "--format" && next) {
      responseFormat = next === "json" ? "json" : "text";
      index += 1;
    } else if (arg && !arg.startsWith("--")) {
      queryParts.push(arg);
    }
  }

  const query = queryParts.join(" ").trim();
  if (!query) {
    throw new Error("codali ask requires a question.\n\n" + HELP);
  }

  return {
    query,
    workspaceRoot,
    mode,
    trace,
    json,
    maxRounds,
    maxToolCalls,
    deadlineMs,
    docdexBaseUrl,
    responseSchemaPath,
    responseFormat,
    noTools,
  };
};

export interface AskDependencies {
  loadInventory?: typeof getAgentInventory;
  resolveRunContext?: (workspaceRoot: string) => Promise<RunContext>;
  buildRegistry?: (options: AskOptions, context: RunContext) => ToolRegistry;
  createProvider?: (
    assignment: Parameters<typeof createProviderForAssignment>[0],
  ) => Provider;
  attachMcp?: typeof attachMcpTools;
  write?: (line: string) => void;
}

const buildDefaultRegistry = (
  options: AskOptions,
  context: RunContext,
  judgeProvider?: Provider,
): ToolRegistry => {
  const registry = new ToolRegistry();
  if (options.noTools) return registry;

  const client = new DocdexClient({
    baseUrl: options.docdexBaseUrl ?? context.docdex?.baseUrl ?? "http://127.0.0.1:28491",
    repoRoot: context.repo?.root ?? options.workspaceRoot,
    repoId: context.docdex?.repoId,
    apiKey: context.docdex?.apiKey,
    allowedOperations: context.docdex?.allowedOperations,
  });

  for (const tool of createDocdexTools(client, {
    // Judged by the orchestrator model: small, fast, and already loaded.
    judgeRelevance: judgeProvider
      ? createRelevanceJudge({ provider: judgeProvider })
      : undefined,
  })) {
    registry.register(tool);
  }
  return registry;
};

export interface AskOutcome {
  result?: CodaliGatewayResult;
  tracer: GatewayTracer;
  exitCode: number;
}

export const runAsk = async (
  argv: string[],
  deps: AskDependencies = {},
): Promise<AskOutcome> => {
  if (argv.includes("--help") || argv.includes("-h")) {
    (deps.write ?? console.log)(HELP);
    return { tracer: new GatewayTracer(""), exitCode: 0 };
  }

  const options = parseAskArgs(argv);
  const write = deps.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const tracer = new GatewayTracer(options.query, { verbose: options.trace });

  // ---- Resolve what this run may touch --------------------------------
  const context = deps.resolveRunContext
    ? await deps.resolveRunContext(options.workspaceRoot)
    : await new LocalConfigRunContextResolver().resolve({
        workspaceRoot: options.workspaceRoot,
      });
  for (const warning of context.warnings ?? []) tracer.addWarning(warning);

  // ---- Resolve models (inventory is loaded once per process) -----------
  const inventory = await (deps.loadInventory ?? getAgentInventory)();
  for (const warning of inventory.warnings) tracer.addWarning(warning);

  // Only consider agents this process can actually call. Selecting one it
  // cannot drive produces a plausible plan and then a wall of provider errors.
  const drivable = filterLocallyDrivable(inventory.agents);
  if (drivable.length < inventory.agents.length) {
    tracer.addWarning(
      `agents_not_locally_drivable:${inventory.agents.length - drivable.length}`,
    );
  }

  const roles = resolveConfigurableRoles({
    inventory: drivable,
    bindings: context.agentRoles,
  });
  for (const warning of roles.warnings) tracer.addWarning(warning);
  tracer.setRoleBindings(roles.bindings);

  const orchestrator = roles.assignments.orchestrator;
  const synthesizer = roles.assignments.synthesizer;
  if (!orchestrator && !synthesizer) {
    write(
      "No usable mcoda agent was found for the orchestrator or synthesizer role.\n" +
        "Check `mcoda agent list --json` and bind roles in ~/.codali/config.json.",
    );
    tracer.finish({ status: "failed", completionReason: "no_agents_resolved" });
    if (options.trace) write(tracer.render());
    return { tracer, exitCode: 1 };
  }

  const clientIdentity = context.tenant?.slug ?? context.tenant?.id;
  const baseProvider = deps.createProvider ?? createProviderForAssignment;
  const makeProvider: typeof createProviderForAssignment = (assignment, options) =>
    baseProvider(assignment, { clientIdentity, ...options });
  const orchestratorProvider = orchestrator ? makeProvider(orchestrator) : undefined;
  const synthesizerProvider = synthesizer ? makeProvider(synthesizer) : undefined;
  // Either role can stand in for the other if only one resolved; the trace
  // records which, so a degraded run is visible rather than silent.
  const primary = (synthesizerProvider ?? orchestratorProvider) as Provider;
  if (!orchestrator || !synthesizer) {
    tracer.addWarning("agent_role_substituted");
  }

  // Worker tasks need a provider that can emit structured tool calls. The
  // agent's advertised `supportsTools` is not sufficient — a CLI-backed agent
  // reports true because the CLI has tools, while this adapter drives it
  // through text and can never surface a call. So probe the built provider.
  const workerCandidates = [roles.toolCapable, roles.assignments.worker, orchestrator, synthesizer].filter(
    (assignment): assignment is NonNullable<typeof assignment> => Boolean(assignment),
  );
  let workerAssignment = workerCandidates[0];
  let worker = workerAssignment ? makeProvider(workerAssignment) : primary;
  for (const candidate of workerCandidates) {
    const provider = makeProvider(candidate);
    if (providerSupportsToolCalls(provider)) {
      workerAssignment = candidate;
      worker = provider;
      break;
    }
  }
  if (workerAssignment) {
    tracer.setRoleBindings({ worker: workerAssignment.candidate.slug });
  }

  // If nothing can call a tool, do not offer tools at all. Planning four
  // retrieval tasks that physically cannot execute is worse than planning
  // none: the run burns its budget and answers "I could not determine",
  // with the real cause buried.
  const toolsExecutable = providerSupportsToolCalls(worker);
  if (!toolsExecutable && !options.noTools) {
    tracer.addWarning(
      `tools_unavailable:no_tool_calling_provider:${
        workerAssignment?.candidate.slug ?? "none"
      }`,
    );
  }

  // ---- Tools -----------------------------------------------------------
  const registry = deps.buildRegistry
    ? deps.buildRegistry(options, context)
    : buildDefaultRegistry(options, context, orchestratorProvider ?? worker);

  // Connect the run's MCP servers and register what they expose into the same
  // registry the built-in and docdex tools live in. A failing server degrades
  // its own tools to unavailable and is reported; it never fails the run.
  const mcp = options.noTools
    ? { registry: undefined, health: [], registered: [], warnings: [] }
    : await (deps.attachMcp ?? attachMcpTools)({ context, toolRegistry: registry });
  for (const warning of mcp.warnings) tracer.addWarning(warning);
  if (mcp.registered.length > 0) {
    tracer.addWarning(`mcp_tools_registered:${mcp.registered.length}`);
  }

  // Hand-declared HTTP connectors register the same way MCP tools do.
  const http = options.noTools
    ? { registered: [], warnings: [] }
    : attachHttpTools({ context, toolRegistry: registry });
  for (const warning of http.warnings) tracer.addWarning(warning);

  const registeredTools = registry.list().map((tool) => tool.name);
  // Only read-only MCP tools enter the default set. Phase 2 keeps every
  // external connector read-only, and since a server's self-description is not
  // trusted, "read-only" means an operator declared it so — either with
  // `readOnly: true` on the server or by naming tools in `allowTools`. Write
  // tools stay registered and visible to `codali tools list`, but are not
  // offered to a model unless the operator allow-lists them explicitly.
  const readOnlyMcpTools = registry
    .catalog(mcp.registered)
    .filter((descriptor) => descriptor.readOnly)
    .map((descriptor) => descriptor.name);
  const withheldWriteTools = mcp.registered.length - readOnlyMcpTools.length;
  if (withheldWriteTools > 0) {
    tracer.addWarning(`mcp_write_tools_withheld:${withheldWriteTools}`);
  }
  // HTTP connector tools are GET/HEAD by construction, so they are read-only
  // without needing an operator declaration.
  const defaultAllowed = [...DEFAULT_ALLOWED_TOOLS, ...readOnlyMcpTools, ...http.registered];
  const allowedTools = toolsExecutable
    ? (context.allowedTools ?? defaultAllowed).filter((tool) =>
        registeredTools.includes(tool))
    : [];
  const toolDescriptors = gatewayToolDescriptorsFromRegistry(registry, allowedTools);

  // ---- Build the request ------------------------------------------------
  const limits = context.limits ?? {};
  const maxToolCalls = Math.min(options.maxToolCalls, limits.maxToolCalls ?? Infinity);
  const maxRounds = Math.min(options.maxRounds, limits.maxRounds ?? Infinity);
  const deadlineMs = Math.min(options.deadlineMs, limits.deadlineMs ?? Infinity);

  // Every tool must be declared to the capability compiler, which otherwise
  // discards it as `not_declared`. That includes docdex tools outside the
  // compiler's hardcoded backing-tool set — `docdex_web_research` among them,
  // which meant the "web" capability was never offered to the classifier and
  // no question could ever reach the public web.
  const connectorTools = allowedTools.filter((tool) => registeredTools.includes(tool));

  let responseSchema: Record<string, unknown> | undefined;
  if (options.responseSchemaPath) {
    const { readFile } = await import("node:fs/promises");
    responseSchema = JSON.parse(
      await readFile(path.resolve(options.responseSchemaPath), "utf8"),
    );
  }

  const request: CodaliGatewayRequest = {
    query: options.query,
    mode: options.mode,
    product: { name: "codali-cli" },
    tenant: context.tenant,
    // Declare discovered MCP tools to the capability compiler. Without this it
    // treats them as `not_declared` and silently drops every one: the compiler
    // predates connectors and otherwise only recognizes built-ins, app
    // contracts, and manifest entries. Discovery is the declaration — these
    // names came from a live `tools/list` against a configured server.
    tools: connectorTools.length > 0
      ? { actualTools: connectorTools, readOnlyTools: connectorTools }
      : undefined,
    docdex: {
      enabled: !options.noTools,
      baseUrl: options.docdexBaseUrl ?? context.docdex?.baseUrl,
      repoRoot: context.repo?.root ?? options.workspaceRoot,
      repoId: context.docdex?.repoId,
    },
    policy: {
      allowedTools,
      deniedTools: context.deniedTools,
      maxIterations: maxRounds,
      maxRuntimeMs: deadlineMs,
      maxToolCalls,
      maxModelCalls: DEFAULT_MAX_MODEL_CALLS,
      maxEvidenceItems: 40,
      maxContextPackTokens: 16_000,
      allowWrites: false,
      allowShell: false,
      allowDestructiveOperations: false,
      allowOutsideWorkspace: false,
      // Phase 1 resolves two roles; requiring a strictly "large" final model
      // would fail on setups that only expose medium agents.
      requireFinalLargeModel: false,
      allowDegradedFinalAnswer: true,
    },
    response: {
      format: responseSchema ? "json" : (options.responseFormat ?? "text"),
      schema: responseSchema,
    },
  };

  // ---- Run --------------------------------------------------------------
  const gateway = createCodaliGateway({
    provider: primary,
    // Classify and plan on the orchestrator model; only the final answer pays
    // for the large one.
    plannerProvider: orchestratorProvider ?? primary,
    // So the trace names the model that actually ran.
    finalAgent: synthesizer ?? orchestrator,
    agentInventory: inventory.agents,
    toolDescriptors,
    taskRunner: createLocalGatewayTaskRunner({
      provider: worker,
      registry,
      toolContext: {
        workspaceRoot: options.workspaceRoot,
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
      // The state machine defaults to 30s per task, which is fine for a hosted
      // API and far too short for a CLI-backed agent — those routinely take a
      // minute per call, and every task times out before it can call a tool.
      // Derive it from the run deadline instead of guessing a constant.
      perTaskTimeoutMs: Math.max(60_000, Math.floor(deadlineMs / 2)),
      // Independent read-only tasks run concurrently. The state machine
      // defaults to serial, which turns a four-source question into four
      // sequential model round trips.
      maxParallelWorkers: DEFAULT_MAX_PARALLEL_WORKERS,
    },
  });

  try {
    const planning = await gateway.plan(request);
    tracer.setRunId(planning.runId);
    tracer.recordPlan({
      capabilities: planning.classifier.capabilities,
      tasks: planning.planner.workerTasks,
    });

    // An ambiguous request stops before any research budget is spent. Guessing
    // which "Bekir" was meant yields a confident answer about the wrong person.
    const clarification = planning.classifier.needsClarification?.trim();
    if (clarification) {
      const clarified = await gateway.buildClarificationResult(
        request,
        planning,
        clarification,
      );
      tracer.finish({
        status: clarified.status,
        completionReason: "needs_clarification",
      });
      if (options.json) {
        write(JSON.stringify(clarified, null, 2));
      } else {
        write(`[needs clarification] ${clarified.answer}`);
      }
      if (options.trace) {
        if (options.json) process.stderr.write(`\n${tracer.render()}\n`);
        else { write(""); write(tracer.render()); }
      }
      return { result: clarified, tracer, exitCode: 0 };
    }

    const workers = await gateway.executePlannedWorkerTasks(request, planning);
    tracer.recordRound(1);

    // Surface worker failures. Without this a run whose every task failed still
    // reaches the synthesizer, which correctly reports it cannot answer — and
    // the actual cause (a 400 from a provider, say) never appears anywhere.
    for (const task of workers.workers.taskResults) {
      if (task.status === "failed") {
        tracer.addWarning(
          `worker_task_failed:${task.taskId}:${task.errorCode ?? "unknown"}:${
            (task.errorMessage ?? "").slice(0, 300)
          }`,
        );
      }
    }
    for (const error of workers.workers.errors) tracer.addWarning(`worker_error:${error}`);

    const result = await gateway.synthesizeFinalAnswer({
      runId: planning.runId,
      request,
      planning,
      workers: workers.workers,
    });

    tracer.finish({
      status: result.status,
      finalizerMode: String(result.telemetry.finalizerMode ?? "synthesizer"),
      completionReason: result.status === "succeeded" ? "complete" : result.status,
      warnings: result.warnings,
    });

    if (options.json) {
      write(JSON.stringify(result, null, 2));
    } else {
      // A partial answer must never read like a complete one.
      if (result.status !== "succeeded") {
        write(`[${result.status}] This answer is incomplete. See warnings below.`);
        write("");
      }
      write(result.answer);
      if (result.sources.length > 0) {
        write("");
        write("Sources:");
        for (const source of result.sources) {
          write(`  [${source.evidenceId}] ${source.title ?? source.sourceType}${
            source.uri ? ` — ${source.uri}` : ""
          }`);
        }
      }
      if (result.artifacts.length > 0) {
        write("");
        write("Artifacts:");
        for (const artifact of result.artifacts) {
          write(`  ${artifact.type}: ${artifact.path ?? artifact.uri ?? artifact.id}`);
        }
      }
      if (result.status !== "succeeded" && result.warnings.length > 0 && !options.trace) {
        write("");
        write("Warnings:");
        for (const warning of result.warnings) write(`  ${warning}`);
      }
    }

    // With --json, stdout is a machine-readable document. Appending the
    // rendered trace after it makes the output unparseable, so the trace goes
    // to stderr instead of being interleaved.
    if (options.trace) {
      if (options.json) {
        process.stderr.write(`\n${tracer.render()}\n`);
      } else {
        write("");
        write(tracer.render());
      }
    }

    return {
      result,
      tracer,
      exitCode: result.status === "failed" ? 1 : 0,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    tracer.finish({ status: "failed", completionReason: message });
    // A caller that asked for JSON gets JSON on every path. Printing prose here
    // hands a program `Codali run failed: fetch failed`, which parses as
    // nothing at all — the failure arrives looking like a crash in the caller
    // rather than a reported error from the run.
    if (options.json) {
      write(
        JSON.stringify(
          {
            runId: tracer.snapshot().runId,
            status: "failed",
            answer: "",
            output: "",
            sources: [],
            evidence: [],
            artifacts: [],
            warnings: [],
            errors: [{ code: "GATEWAY_RUN_FAILED", message }],
          },
          null,
          2,
        ),
      );
    } else {
      write(`Codali run failed: ${message}`);
    }
    if (options.trace) write(tracer.render());
    return { tracer, exitCode: 1 };
  } finally {
    // stdio MCP servers are child processes. They must be shut down on the
    // failure path too, or a failed run leaves orphans behind.
    await mcp.registry?.close();
  }
};

export const AskCommand = {
  async run(argv: string[]): Promise<void> {
    const outcome = await runAsk(argv);
    if (outcome.exitCode !== 0) {
      process.exitCode = outcome.exitCode;
    }
  },
};
