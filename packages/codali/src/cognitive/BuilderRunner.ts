import type { Provider, ProviderMessage, ProviderResponseFormat } from "../providers/ProviderTypes.js";
import type { ToolContext } from "../tools/ToolTypes.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import { Runner, type RunnerResult } from "../runtime/Runner.js";
import type { ContextBundle, ContextRequest, Plan } from "./Types.js";
import { buildBuilderPrompt } from "./Prompts.js";
import { parsePatchOutput, type PatchFormat } from "./BuilderOutputParser.js";
import { PatchApplier } from "./PatchApplier.js";
import type { ContextManager } from "./ContextManager.js";

export interface BuilderRunResult extends RunnerResult {
  contextRequest?: ContextRequest;
}

export interface BuilderRunnerOptions {
  provider: Provider;
  tools: ToolRegistry;
  context: ToolContext;
  maxSteps: number;
  maxToolCalls: number;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  responseFormat?: ProviderResponseFormat;
  logger?: RunLogger;
  mode?: "tool_calls" | "patch_json";
  patchFormat?: PatchFormat;
  patchApplier?: PatchApplier;
  contextManager?: ContextManager;
  laneId?: string;
  model?: string;
  stream?: boolean;
  onToken?: (token: string) => void;
  streamFlushMs?: number;
}

const parseContextRequest = (content: string): ContextRequest | undefined => {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const needsContext =
      parsed.needs_context === true ||
      parsed.request_context === true ||
      parsed.context_request === true ||
      parsed.type === "needs_context";
    if (needsContext) {
      const queries = Array.isArray(parsed.queries)
        ? parsed.queries.map((entry) => String(entry)).filter(Boolean)
        : undefined;
      const files = Array.isArray(parsed.files)
        ? parsed.files.map((entry) => String(entry)).filter(Boolean)
        : undefined;
      const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
      return { reason, queries, files };
    }
  } catch {
    // ignore invalid JSON
  }
  if (/needs_context/i.test(trimmed)) {
    return { reason: "needs_context" };
  }
  return undefined;
};

export class BuilderRunner {
  private options: BuilderRunnerOptions;

  constructor(options: BuilderRunnerOptions) {
    this.options = options;
  }

  async run(
    plan: Plan,
    contextBundle: ContextBundle,
    options: { contextManager?: ContextManager; laneId?: string; model?: string } = {},
  ): Promise<BuilderRunResult> {
    const mode = this.options.mode ?? "tool_calls";
    const patchFormat = this.options.patchFormat ?? "search_replace";
    const contextContent = contextBundle.serialized?.content ?? JSON.stringify(contextBundle, null, 2);
    const systemMessage: ProviderMessage = {
      role: "system",
      content: buildBuilderPrompt(mode, patchFormat),
    };
    const userMessage: ProviderMessage = {
      role: "user",
      content: ["PLAN:", JSON.stringify(plan, null, 2), "", contextContent].join("\n"),
    };
    const contextManager = options.contextManager ?? this.options.contextManager;
    const laneId = options.laneId ?? this.options.laneId;
    const model = options.model ?? this.options.model;
    const history =
      contextManager && laneId
        ? await contextManager.prepare(laneId, {
            systemPrompt: systemMessage.content,
            bundle: userMessage.content,
            model,
          })
        : [];
    const messages: ProviderMessage[] = [systemMessage, ...history, userMessage];

    const runner = new Runner({
      provider: this.options.provider,
      tools: this.options.tools,
      context: this.options.context,
      maxSteps: this.options.maxSteps,
      maxToolCalls: this.options.maxToolCalls,
      maxTokens: this.options.maxTokens,
      timeoutMs: this.options.timeoutMs,
      temperature: this.options.temperature,
      responseFormat: this.options.responseFormat,
      toolChoice: mode === "patch_json" ? "none" : "auto",
      stream: this.options.stream,
      onToken: this.options.onToken,
      streamFlushMs: this.options.streamFlushMs,
      logger: this.options.logger,
    });

    const result = await runner.run(messages);

    if (contextManager && laneId) {
      await contextManager.append(laneId, userMessage, {
        role: "builder",
        model,
      });
      await contextManager.append(laneId, result.finalMessage, {
        role: "builder",
        model,
        tokens: result.usage?.totalTokens,
      });
    }

    const contextRequest = parseContextRequest(result.finalMessage.content);
    if (contextRequest) {
      if (this.options.logger) {
        await this.options.logger.log("context_request", {
          reason: contextRequest.reason,
          queries: contextRequest.queries,
          files: contextRequest.files,
        });
      }
      return { ...result, contextRequest };
    }
    if (mode === "patch_json") {
      const patchApplier = this.options.patchApplier;
      if (!patchApplier) {
        throw new Error("PatchApplier is required for patch_json mode");
      }
      const payload = parsePatchOutput(result.finalMessage.content, patchFormat);
      const applyResult = await patchApplier.apply(payload.patches);
      if (this.options.logger) {
        await this.options.logger.log("patch_applied", {
          patches: payload.patches.length,
          touchedFiles: applyResult.touched,
        });
      }
    }
    return result;
  }
}
