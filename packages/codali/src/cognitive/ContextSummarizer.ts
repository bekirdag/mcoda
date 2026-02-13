import type { Provider, ProviderMessage } from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import { CONTEXT_SUMMARY_PROMPT } from "./Prompts.js";

export interface ContextSummarizerOptions {
  temperature?: number;
  maxTokens?: number;
  logger?: RunLogger;
}

const formatHistory = (messages: ProviderMessage[]): string =>
  messages
    .map((message) => {
      const header = message.name ? `${message.role}(${message.name})` : message.role;
      return `${header}: ${message.content}`;
    })
    .join("\n\n");

export class ContextSummarizer {
  private temperature?: number;
  private maxTokens?: number;
  private logger?: RunLogger;

  constructor(private provider: Provider, options: ContextSummarizerOptions = {}) {
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.logger = options.logger;
  }

  async summarize(messages: ProviderMessage[]): Promise<ProviderMessage> {
    const requestMessages: ProviderMessage[] = [
      { role: "system", content: CONTEXT_SUMMARY_PROMPT },
      { role: "user", content: formatHistory(messages) },
    ];
    if (this.logger) {
      await this.logger.log("provider_request", {
        provider: this.provider.name,
        messages: requestMessages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
      });
    }
    const response = await this.provider.generate({
      messages: requestMessages,
      temperature: this.temperature,
      maxTokens: this.maxTokens,
    });

    if (response.usage && this.logger) {
      await this.logger.log("context_summarize_usage", { usage: response.usage });
    }

    const content = response.message.content?.trim() ?? "";
    if (!content) {
      throw new Error("Context summarizer response is empty");
    }
    return {
      role: "system",
      content: `Context summary: ${content}`,
    };
  }
}
