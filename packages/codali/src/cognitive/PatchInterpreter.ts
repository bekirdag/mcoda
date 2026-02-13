import type {
  Provider,
  ProviderMessage,
  ProviderResponseFormat,
} from "../providers/ProviderTypes.js";
import { parsePatchOutput, type PatchFormat, type PatchPayload } from "./BuilderOutputParser.js";
import { normalizePatchOutput } from "./PatchOutputNormalizer.js";
import { buildInterpreterPrompt, buildInterpreterRetryPrompt } from "./Prompts.js";

export interface PatchInterpreterLogger {
  log(type: string, data: Record<string, unknown>): Promise<void>;
}

export interface PatchInterpreterOptions {
  provider: Provider;
  patchFormat: PatchFormat;
  responseFormat?: ProviderResponseFormat;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  logger?: PatchInterpreterLogger;
  model?: string;
}

export interface PatchInterpreterClient {
  interpret(raw: string, patchFormatOverride?: PatchFormat): Promise<PatchPayload>;
}

export class PatchInterpreter implements PatchInterpreterClient {
  private provider: Provider;
  private patchFormat: PatchFormat;
  private responseFormat?: ProviderResponseFormat;
  private temperature?: number;
  private maxTokens?: number;
  private timeoutMs?: number;
  private maxRetries: number;
  private logger?: PatchInterpreterLogger;
  private model?: string;

  constructor(options: PatchInterpreterOptions) {
    this.provider = options.provider;
    this.patchFormat = options.patchFormat;
    this.responseFormat = options.responseFormat;
    this.temperature = options.temperature;
    this.maxTokens = options.maxTokens;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries ?? 1;
    this.logger = options.logger;
    this.model = options.model;
  }

  private async requestPatch(
    prompt: string,
    raw: string,
    meta: { retry: boolean; patchFormat: PatchFormat },
  ): Promise<string> {
    const messages: ProviderMessage[] = [
      { role: "system", content: prompt },
      { role: "user", content: raw },
    ];
    if (this.logger) {
      await this.logger.log("provider_request", {
        provider: this.provider.name,
        model: this.model,
        messages,
        temperature: this.temperature,
        maxTokens: this.maxTokens,
        responseFormat: this.responseFormat ?? { type: "json" },
        stream: false,
      });
      await this.logger.log("interpreter_request", {
        retry: meta.retry,
        patchFormat: meta.patchFormat,
        model: this.model,
      });
    }
    const response = await this.provider.generate({
      messages,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      responseFormat: this.responseFormat ?? { type: "json" },
      stream: false,
    });
    if (this.logger) {
      await this.logger.log("interpreter_response", {
        retry: meta.retry,
        length: response.message?.content?.length ?? 0,
        patchFormat: meta.patchFormat,
      });
    }
    return response.message?.content ?? "";
  }

  private parse(content: string, patchFormat: PatchFormat): PatchPayload {
    const normalized = normalizePatchOutput(content);
    if (!normalized) {
      throw new Error("Patch output is not valid JSON");
    }
    return parsePatchOutput(normalized, patchFormat);
  }

  async interpret(raw: string, patchFormatOverride?: PatchFormat): Promise<PatchPayload> {
    const patchFormat = patchFormatOverride ?? this.patchFormat;
    // Fast-path: in patch_json mode the builder may already emit a usable payload.
    try {
      const parsed = this.parse(raw, patchFormat);
      if (this.logger) {
        await this.logger.log("interpreter_direct_parse", {
          patchFormat,
          length: raw.length,
        });
      }
      return parsed;
    } catch {
      // Fall back to provider-assisted interpretation below.
    }
    const prompt = buildInterpreterPrompt(patchFormat);
    const content = await this.requestPatch(prompt, raw, {
      retry: false,
      patchFormat,
    });
    try {
      return this.parse(content, patchFormat);
    } catch (error) {
      if (this.maxRetries <= 0) {
        throw error;
      }
      if (this.logger) {
        const message = error instanceof Error ? error.message : String(error);
        await this.logger.log("interpreter_retry", { error: message });
      }
      const retryPrompt = buildInterpreterRetryPrompt(patchFormat);
      const retryContent = await this.requestPatch(retryPrompt, raw, {
        retry: true,
        patchFormat,
      });
      return this.parse(retryContent, patchFormat);
    }
  }
}
