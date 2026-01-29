import type {
  Provider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponseFormat,
  ProviderToolCall,
  ProviderUsage,
} from "../providers/ProviderTypes.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolContext } from "../tools/ToolTypes.js";
import type { RunLogger } from "./RunLogger.js";

export interface RunnerOptions {
  provider: Provider;
  tools: ToolRegistry;
  context: ToolContext;
  maxSteps: number;
  maxToolCalls: number;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: ProviderResponseFormat;
  toolChoice?: ProviderRequest["toolChoice"];
  stream?: boolean;
  onToken?: (token: string) => void;
  streamFlushMs?: number;
  timeoutMs?: number;
  logger?: RunLogger;
}

export interface RunnerResult {
  finalMessage: ProviderMessage;
  messages: ProviderMessage[];
  toolCallsExecuted: number;
  usage?: ProviderUsage;
}

const buildToolMessage = (call: ProviderToolCall, content: string): ProviderMessage => ({
  role: "tool",
  content,
  toolCallId: call.id,
  name: call.name,
});

export class Runner {
  private provider: Provider;
  private tools: ToolRegistry;
  private context: ToolContext;
  private maxSteps: number;
  private maxToolCalls: number;
  private maxTokens?: number;
  private temperature?: number;
  private responseFormat?: ProviderResponseFormat;
  private toolChoice?: ProviderRequest["toolChoice"];
  private stream?: boolean;
  private onToken?: (token: string) => void;
  private streamFlushMs?: number;
  private timeoutMs?: number;
  private logger?: RunLogger;

  constructor(options: RunnerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.context = options.context;
    this.maxSteps = options.maxSteps;
    this.maxToolCalls = options.maxToolCalls;
    this.maxTokens = options.maxTokens;
    this.temperature = options.temperature;
    this.responseFormat = options.responseFormat;
    this.toolChoice = options.toolChoice;
    this.stream = options.stream;
    this.onToken = options.onToken;
    this.streamFlushMs = options.streamFlushMs;
    this.timeoutMs = options.timeoutMs;
    this.logger = options.logger;
  }

  async run(initialMessages: ProviderMessage[]): Promise<RunnerResult> {
    const messages: ProviderMessage[] = [...initialMessages];
    let toolCallsExecuted = 0;
    let usageTotals: ProviderUsage | undefined;
    const deadline = this.timeoutMs ? Date.now() + this.timeoutMs : undefined;

    const recordUsage = (usage?: ProviderUsage): void => {
      if (!usage) return;
      if (!usageTotals) usageTotals = {};
      if (usage.inputTokens !== undefined) {
        usageTotals.inputTokens = (usageTotals.inputTokens ?? 0) + usage.inputTokens;
      }
      if (usage.outputTokens !== undefined) {
        usageTotals.outputTokens = (usageTotals.outputTokens ?? 0) + usage.outputTokens;
      }
      if (usage.totalTokens !== undefined) {
        usageTotals.totalTokens = (usageTotals.totalTokens ?? 0) + usage.totalTokens;
      }
    };

    const timeRemaining = (): number | undefined => {
      if (!deadline) return undefined;
      return deadline - Date.now();
    };

    const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      const remaining = timeRemaining();
      if (remaining === undefined) return promise;
      if (remaining <= 0) {
        throw new Error("Runner timeout exceeded");
      }
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Runner timeout exceeded")), remaining);
      });
      try {
        return await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    for (let step = 0; step < this.maxSteps; step += 1) {
      if (deadline && timeRemaining()! <= 0) {
        throw new Error("Runner timeout exceeded");
      }
      const response = await withTimeout(
        this.provider.generate({
          messages,
          tools: this.tools.describe().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          toolChoice: this.toolChoice ?? "auto",
          maxTokens: this.maxTokens,
          temperature: this.temperature,
          responseFormat: this.responseFormat,
          stream: this.stream,
          onToken: this.onToken,
          streamFlushMs: this.streamFlushMs,
        }),
        "provider",
      );

      recordUsage(response.usage);
      messages.push(response.message);
      if (this.logger) {
        await this.logger.log("provider_response", {
          message: response.message,
          toolCalls: response.toolCalls,
          usage: response.usage,
        });
      }

      if (!response.toolCalls || response.toolCalls.length === 0) {
        return {
          finalMessage: response.message,
          messages,
          toolCallsExecuted,
          usage: usageTotals,
        };
      }

      for (const call of response.toolCalls) {
        if (toolCallsExecuted >= this.maxToolCalls) {
          throw new Error("Tool call limit exceeded");
        }
        toolCallsExecuted += 1;
        const result = await withTimeout(
          this.tools.execute(call.name, call.args, this.context),
          "tool",
        );
        const content = result.ok ? result.output : `ERROR: ${result.error ?? "tool failed"}`;
        messages.push(buildToolMessage(call, content));
        if (this.logger) {
          await this.logger.log("tool_call", {
            name: call.name,
            ok: result.ok,
            error: result.error,
          });
        }
      }
    }

    throw new Error("Runner step limit exceeded");
  }
}
