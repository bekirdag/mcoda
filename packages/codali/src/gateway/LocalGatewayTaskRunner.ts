import type {
  Provider,
  ProviderMessage,
  ProviderToolDefinition,
} from "../providers/ProviderTypes.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/ToolTypes.js";
import { CODALI_GATEWAY_SECURITY_PROMPT_HARDENING } from "./GatewaySecurityPolicy.js";
import type {
  CodaliGatewayWorkerModelCallRecord,
  CodaliGatewayWorkerTaskRunInput,
  CodaliGatewayWorkerTaskRunResult,
  CodaliGatewayWorkerTaskRunner,
  CodaliGatewayWorkerToolCallRecord,
} from "./GatewayStateMachine.js";

/**
 * Bounded worker-task runner.
 *
 * ## Why this exists
 *
 * Codali previously executed every gateway worker task by handing it to the
 * full `CodaliRuntime` agent loop (see `createGatewayTaskRunner` in
 * `packages/mswarm/src/codali-executor.ts`). That nested one open-ended loop
 * inside another: the gateway decided how many *rounds* to run, while the
 * runtime independently decided how many *steps* to take inside each task.
 * Neither could bound the other, so a single request could fan out
 * unpredictably and a runaway task was near-impossible to attribute.
 *
 * This runner removes the inner loop. Exactly one component - the gateway state
 * machine - owns iteration. A task here is a single bounded pass:
 *
 *   1. ask the model what it needs (one model call)
 *   2. execute the tool calls it asked for, in parallel where independent
 *   3. ask the model to turn the results into the task output (one model call)
 *
 * There is no step 4 and no "decide whether to keep going". If the evidence is
 * insufficient, that is the verifier's judgement to make, and the gateway will
 * schedule another round against `maxIterations`. A worker never extends its
 * own budget.
 *
 * The upper bound on work per task is therefore fixed and knowable:
 * 2 model calls and `min(remainingToolCalls, MAX_TOOL_CALLS_PER_TASK)` tool
 * calls.
 */

/** Hard ceiling on tool calls in a single task, independent of run budget. */
export const MAX_TOOL_CALLS_PER_TASK = 8;

/** Model calls per task: one to select tools, one to summarize results. */
export const MAX_MODEL_CALLS_PER_TASK = 2;

const DEFAULT_TASK_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_TOKENS = 1_200;
const DEFAULT_TEMPERATURE = 0;

/**
 * Tool output beyond this is truncated before it reaches the model.
 *
 * Connector list endpoints are the pressure here: a GitHub `list_commits` for a
 * fortnight of activity runs well past the old 8k cap, and the model then
 * summarized only the commits that survived — accurately, but incompletely.
 */
const MAX_TOOL_OUTPUT_CHARS = 24_000;

export interface LocalGatewayTaskRunnerOptions {
  provider: Provider;
  registry: ToolRegistry;
  toolContext: ToolContext;
  maxTokens?: number;
  temperature?: number;
  /** Observability hook; see `GatewayTracer`. */
  onEvent?: (event: LocalGatewayTaskRunnerEvent) => void;
}

export type LocalGatewayTaskRunnerEvent =
  | { type: "task_start"; taskId: string; workerRole: string; allowedTools: string[] }
  | { type: "tool_call"; taskId: string; tool: string; args: unknown }
  | {
      type: "tool_result";
      taskId: string;
      tool: string;
      ok: boolean;
      latencyMs: number;
      errorCode?: string;
    }
  | {
      type: "task_end";
      taskId: string;
      status: "succeeded" | "failed";
      toolCallCount: number;
      modelCallCount: number;
      durationMs: number;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const truncate = (value: string, limit = MAX_TOOL_OUTPUT_CHARS): string =>
  value.length > limit
    ? `${value.slice(0, limit)}\n\n[TRUNCATED: ${value.length - limit} more characters were cut. This result is INCOMPLETE — say so explicitly in your summary and do not present it as the full set.]`
    : value;

const positiveInteger = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const nonNegativeInteger = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;

const errorMessageFor = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Tool definitions offered to the worker model, narrowed to what the planner
 * allowed for this task. A tool absent from `allowedTools` is not merely
 * discouraged - the model never sees it.
 */
const toolDefinitionsFor = (
  registry: ToolRegistry,
  allowedTools: readonly string[],
): ProviderToolDefinition[] =>
  registry.catalog(allowedTools).map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as Record<string, unknown> | undefined,
  }));

const buildTaskMessages = (
  input: CodaliGatewayWorkerTaskRunInput,
  hasTools: boolean,
): ProviderMessage[] => {
  const system = [
    "You are a Codali gateway worker.",
    "Gather evidence for one bounded sub-task. Do not answer the user's overall question.",
    hasTools
      ? "Call the tools you need in a single batch. You get exactly one opportunity to call tools, so request everything you need at once."
      : "No tools are available. Answer from the task description alone or state what is missing.",
    "Report only what the tool results actually support. Never invent file paths, identifiers, figures, or quotations.",
    "If the results are insufficient, say so plainly instead of guessing; another round may be scheduled.",
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.toolOutputBoundary,
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.policyImmutability,
    CODALI_GATEWAY_SECURITY_PROMPT_HARDENING.tenantScope,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: input.prompt },
  ];
};

export class LocalGatewayTaskRunner implements CodaliGatewayWorkerTaskRunner {
  constructor(private readonly options: LocalGatewayTaskRunnerOptions) {}

  async run(
    input: CodaliGatewayWorkerTaskRunInput,
  ): Promise<CodaliGatewayWorkerTaskRunResult> {
    const startedMs = Date.now();
    const taskId = input.task.id;
    const deadlineMs = startedMs + positiveInteger(input.timeoutMs, DEFAULT_TASK_TIMEOUT_MS);

    const allowedTools = input.allowedTools ?? [];
    const toolBudget = Math.min(
      nonNegativeInteger(input.remainingToolCalls, 0),
      MAX_TOOL_CALLS_PER_TASK,
    );
    const modelBudget = Math.min(
      nonNegativeInteger(input.remainingModelCalls, MAX_MODEL_CALLS_PER_TASK),
      MAX_MODEL_CALLS_PER_TASK,
    );

    const toolCalls: CodaliGatewayWorkerToolCallRecord[] = [];
    const modelCalls: CodaliGatewayWorkerModelCallRecord[] = [];

    this.options.onEvent?.({
      type: "task_start",
      taskId,
      workerRole: input.task.workerRole,
      allowedTools: [...allowedTools],
    });

    const finish = (
      result: CodaliGatewayWorkerTaskRunResult,
    ): CodaliGatewayWorkerTaskRunResult => {
      this.options.onEvent?.({
        type: "task_end",
        taskId,
        status: result.status,
        toolCallCount: toolCalls.length,
        modelCallCount: modelCalls.length,
        durationMs: Date.now() - startedMs,
      });
      return { ...result, toolCalls, modelCalls };
    };

    if (modelBudget <= 0) {
      return finish({
        status: "failed",
        errorCode: "GATEWAY_MODEL_BUDGET_EXCEEDED",
        errorMessage: "No model calls remain for this worker task.",
      });
    }

    const offerTools = toolBudget > 0 && allowedTools.length > 0;
    const toolDefinitions = offerTools
      ? toolDefinitionsFor(this.options.registry, allowedTools)
      : [];
    const messages = buildTaskMessages(input, toolDefinitions.length > 0);

    // ---- Pass 1: ask the model what it needs -----------------------------
    let selection;
    const selectionStartedMs = Date.now();
    try {
      selection = await this.options.provider.generate({
        messages,
        tools: toolDefinitions.length > 0 ? toolDefinitions : undefined,
        toolChoice: toolDefinitions.length > 0 ? "auto" : "none",
        maxTokens: positiveInteger(this.options.maxTokens, DEFAULT_MAX_TOKENS),
        temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
      });
    } catch (error) {
      modelCalls.push({
        role: "worker",
        status: "failed",
        latencyMs: Date.now() - selectionStartedMs,
        provider: this.options.provider.name,
        errorCode: "GATEWAY_WORKER_MODEL_FAILED",
        errorMessage: errorMessageFor(error),
      });
      return finish({
        status: "failed",
        errorCode: "GATEWAY_WORKER_MODEL_FAILED",
        errorMessage: errorMessageFor(error),
      });
    }

    modelCalls.push({
      role: "worker",
      status: "success",
      latencyMs: Date.now() - selectionStartedMs,
      provider: this.options.provider.name,
      output: selection.message.content,
      metadata: {
        pass: "tool_selection",
        requestedToolCalls: selection.toolCalls?.length ?? 0,
        usage: selection.usage,
      },
    });

    const requested = (selection.toolCalls ?? []).slice(0, toolBudget);
    const droppedForBudget = (selection.toolCalls ?? []).length - requested.length;

    // No tools requested: the first answer is the task output. One model call,
    // and we return rather than looping to look for more work.
    if (requested.length === 0) {
      const output = selection.message.content.trim();
      return finish({
        status: "succeeded",
        output,
        metadata: {
          pass: "direct",
          modelCallCount: modelCalls.length,
          toolCallCount: 0,
          ...(droppedForBudget > 0 ? { droppedToolCalls: droppedForBudget } : {}),
        },
      });
    }

    // ---- Execute the batch ------------------------------------------------
    // Independent read-only calls run in parallel. Ordering between them is not
    // meaningful; each is validated against the registry schema before running.
    const executions = await Promise.all(
      requested.map(async (call) => {
        if (Date.now() > deadlineMs) {
          return {
            call,
            record: {
              tool: call.name,
              status: "failed" as const,
              latencyMs: 0,
              args: call.args,
              errorCode: "tool_timeout",
              errorMessage: "Task deadline elapsed before the tool was invoked.",
            },
            output: "Tool skipped: task deadline elapsed.",
          };
        }

        this.options.onEvent?.({ type: "tool_call", taskId, tool: call.name, args: call.args });
        const toolStartedMs = Date.now();

        if (!allowedTools.includes(call.name)) {
          // The model named a tool outside the planner's allowance. Refuse it
          // and tell the model, rather than silently widening the policy.
          const latencyMs = Date.now() - toolStartedMs;
          this.options.onEvent?.({
            type: "tool_result",
            taskId,
            tool: call.name,
            ok: false,
            latencyMs,
            errorCode: "tool_permission_denied",
          });
          return {
            call,
            record: {
              tool: call.name,
              status: "failed" as const,
              latencyMs,
              args: call.args,
              errorCode: "tool_permission_denied",
              errorMessage: `Tool ${call.name} is not allowed for this task.`,
            },
            output: `Tool ${call.name} is not allowed for this task.`,
          };
        }

        const result = await this.options.registry.execute(
          call.name,
          call.args,
          this.options.toolContext,
        );
        const latencyMs = Date.now() - toolStartedMs;

        this.options.onEvent?.({
          type: "tool_result",
          taskId,
          tool: call.name,
          ok: result.ok,
          latencyMs,
          errorCode: result.error?.code,
        });

        return {
          call,
          record: {
            tool: call.name,
            status: result.ok ? ("success" as const) : ("failed" as const),
            latencyMs,
            args: call.args,
            result: result.ok ? (result.data ?? result.output) : undefined,
            errorCode: result.error?.code,
            errorMessage: result.error?.message,
          },
          output: result.ok
            ? truncate(result.output)
            : `Tool failed (${result.error?.code ?? "unknown"}): ${result.error?.message ?? ""}`,
        };
      }),
    );

    for (const execution of executions) {
      toolCalls.push(execution.record);
    }

    const succeededCount = executions.filter(
      (execution) => execution.record.status === "success",
    ).length;

    // Every tool failed: report the failure rather than asking the model to
    // narrate an empty result set, which is where fabrication starts.
    if (succeededCount === 0) {
      const first = executions[0]?.record;
      return finish({
        status: "failed",
        errorCode: first?.errorCode ?? "GATEWAY_WORKER_TOOLS_FAILED",
        errorMessage:
          first?.errorMessage ?? "All tool calls for this worker task failed.",
        metadata: { pass: "tools_failed", toolCallCount: toolCalls.length },
      });
    }

    if (modelCalls.length >= modelBudget) {
      // No budget left to summarize. Return the raw tool outputs as the task
      // output; the finalizer, not the user, is what sees this.
      return finish({
        status: "succeeded",
        output: executions.map((execution) =>
          `${execution.call.name}: ${execution.output}`).join("\n\n"),
        metadata: {
          pass: "unsummarized",
          reason: "model_budget_exhausted",
          toolCallCount: toolCalls.length,
        },
      });
    }

    // ---- Pass 2: turn the results into the task output --------------------
    const resultMessages: ProviderMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: selection.message.content ||
          `Requested tools: ${requested.map((call) => call.name).join(", ")}`,
      },
      {
        role: "user",
        content: [
          "Tool results:",
          ...executions.map((execution) =>
            `--- ${execution.call.name} ---\n${execution.output}`),
          "",
          "Summarize what these results establish for this sub-task.",
          "If any result is marked TRUNCATED, state that the data is incomplete and roughly what is missing. Never present a truncated list as complete.",
          "Attribute each statement to the tool that produced it.",
          "State explicitly what remains unknown. Do not speculate beyond the results.",
        ].join("\n"),
      },
    ];

    const summaryStartedMs = Date.now();
    try {
      const summary = await this.options.provider.generate({
        messages: resultMessages,
        toolChoice: "none",
        maxTokens: positiveInteger(this.options.maxTokens, DEFAULT_MAX_TOKENS),
        temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
      });
      modelCalls.push({
        role: "worker",
        status: "success",
        latencyMs: Date.now() - summaryStartedMs,
        provider: this.options.provider.name,
        output: summary.message.content,
        metadata: { pass: "summary", usage: summary.usage },
      });
      return finish({
        status: "succeeded",
        output: summary.message.content.trim(),
        metadata: {
          pass: "tools_summarized",
          toolCallCount: toolCalls.length,
          succeededToolCalls: succeededCount,
          ...(droppedForBudget > 0 ? { droppedToolCalls: droppedForBudget } : {}),
        },
      });
    } catch (error) {
      modelCalls.push({
        role: "worker",
        status: "failed",
        latencyMs: Date.now() - summaryStartedMs,
        provider: this.options.provider.name,
        errorCode: "GATEWAY_WORKER_SUMMARY_FAILED",
        errorMessage: errorMessageFor(error),
      });
      // Summarization failed but the evidence is real. Return it unsummarized
      // rather than discarding a successful tool batch.
      return finish({
        status: "succeeded",
        output: executions.map((execution) =>
          `${execution.call.name}: ${execution.output}`).join("\n\n"),
        metadata: {
          pass: "unsummarized",
          reason: "summary_failed",
          toolCallCount: toolCalls.length,
        },
      });
    }
  }
}

export const createLocalGatewayTaskRunner = (
  options: LocalGatewayTaskRunnerOptions,
): LocalGatewayTaskRunner => new LocalGatewayTaskRunner(options);

export const isRecordValue = isRecord;
