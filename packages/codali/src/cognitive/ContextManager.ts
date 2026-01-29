import type { ProviderMessage } from "../providers/ProviderTypes.js";
import type { RunLogger } from "../runtime/RunLogger.js";
import type { ContextLane, ContextLaneRole, LaneScope, LocalContextConfig } from "./Types.js";
import { ContextStore, type ContextLaneSnapshot, type ContextMessageRecord } from "./ContextStore.js";
import { ContextRedactor } from "./ContextRedactor.js";
import { ContextSummarizer } from "./ContextSummarizer.js";
import {
  DEFAULT_CHAR_PER_TOKEN,
  DEFAULT_MODEL_TOKEN_LIMIT,
  estimateBudget,
  estimateMessagesTokens,
  resolveModelTokenLimit,
} from "./ContextBudget.js";

export interface ContextManagerOptions {
  config: LocalContextConfig;
  store: ContextStore;
  redactor?: ContextRedactor;
  summarizer?: ContextSummarizer;
  logger?: RunLogger;
  charPerToken?: number;
}

interface LaneState {
  id: string;
  role: ContextLaneRole;
  persisted: boolean;
  messages: ContextMessageRecord[];
  tokenEstimate: number;
  updatedAt: number;
  redactions: number;
}

export const buildLaneId = (scope: LaneScope): string => {
  const jobPart = scope.jobId ?? scope.runId ?? "run";
  const taskPart = scope.taskId ?? scope.taskKey ?? "ad-hoc";
  return `${jobPart}:${taskPart}:${scope.role}`;
};

const trimMessagesByBytes = (messages: ContextMessageRecord[], maxBytes: number): ContextMessageRecord[] => {
  if (maxBytes <= 0) return [];
  let total = 0;
  const kept: ContextMessageRecord[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = `${JSON.stringify(messages[index])}\n`;
    const size = Buffer.byteLength(line, "utf8");
    if (total + size > maxBytes) {
      break;
    }
    total += size;
    kept.push(messages[index]);
  }
  return kept.reverse();
};

export class ContextManager {
  private lanes = new Map<string, LaneState>();
  private enabled: boolean;
  private charPerToken: number;

  constructor(private options: ContextManagerOptions) {
    this.enabled = options.config.enabled;
    this.charPerToken = options.charPerToken ?? DEFAULT_CHAR_PER_TOKEN;
  }

  async getLane(scope: LaneScope): Promise<ContextLane> {
    const laneId = buildLaneId(scope);
    const persisted = this.enabled && !scope.ephemeral;
    const state = await this.ensureLane(laneId, scope.role, persisted);
    return {
      id: state.id,
      role: state.role,
      model: undefined,
      messages: state.messages,
      tokenEstimate: state.tokenEstimate,
      updatedAt: state.updatedAt,
      persisted: state.persisted,
    };
  }

  async append(
    laneId: string,
    message: ProviderMessage,
    meta: { model?: string; tokens?: number; role?: ContextLaneRole; persisted?: boolean } = {},
  ): Promise<void> {
    const persisted = meta.persisted ?? this.enabled;
    const role = meta.role ?? "custom";
    const state = await this.ensureLane(laneId, role, persisted);
    if (!this.options.config.persistToolMessages && message.role === "tool") {
      return;
    }

    let content = message.content ?? "";
    let redactions = 0;
    if (this.options.redactor) {
      const redacted = this.options.redactor.redact(content);
      content = redacted.content;
      redactions = redacted.redactions;
    }

    const record: ContextMessageRecord = {
      ...message,
      content,
      ts: Date.now(),
      model: meta.model,
      tokens: meta.tokens,
    };
    const messages = [...state.messages, record];
    const tokenEstimate = estimateMessagesTokens(messages, this.charPerToken);
    const updatedAt = Date.now();
    const nextState: LaneState = {
      ...state,
      messages,
      tokenEstimate,
      updatedAt,
      redactions: state.redactions + redactions,
    };
    this.lanes.set(laneId, nextState);

    if (!state.persisted) {
      await this.logLaneUpdate(nextState);
      return;
    }

    const snapshot = await this.options.store.append(laneId, record);
    const limited = await this.enforceStorageLimits(laneId, snapshot, nextState.redactions);
    this.updateStateFromSnapshot(laneId, limited, nextState.role, nextState.redactions);
    const updated = this.lanes.get(laneId);
    if (updated) {
      await this.logLaneUpdate(updated);
    }
  }

  async prepare(
    laneId: string,
    options: { systemPrompt?: string; bundle?: string; model?: string } = {},
  ): Promise<ProviderMessage[]> {
    const state = this.lanes.get(laneId) ?? (await this.ensureLane(laneId, "custom", this.enabled));
    if (!state.persisted) {
      return state.messages;
    }
    await this.summarizeIfNeeded(laneId, options);
    const refreshed = this.lanes.get(laneId) ?? state;
    return refreshed.messages;
  }

  async summarizeIfNeeded(
    laneId: string,
    options: { systemPrompt?: string; bundle?: string; model?: string } = {},
  ): Promise<void> {
    const state = this.lanes.get(laneId);
    if (!state || !state.persisted || !this.enabled) return;
    if (!this.options.summarizer || !this.options.config.summarize.enabled) return;

    const modelLimit = resolveModelTokenLimit(
      options.model ?? "",
      this.options.config.modelTokenLimits,
      DEFAULT_MODEL_TOKEN_LIMIT,
    );
    const beforeMessages = state.messages.length;
    const beforeTokens = estimateMessagesTokens(state.messages, this.charPerToken);
    let messages = state.messages;
    let estimate = estimateBudget({
      systemPrompt: options.systemPrompt,
      bundle: options.bundle,
      history: messages,
      charPerToken: this.charPerToken,
    });
    let iterations = 0;
    let updated = false;

    while (estimate.totalTokens > modelLimit && messages.length > 1 && iterations < 5) {
      const splitIndex = Math.max(1, Math.floor(messages.length / 2));
      const summary = await this.options.summarizer.summarize(messages.slice(0, splitIndex));
      const summaryRecord: ContextMessageRecord = { ...summary, ts: Date.now() };
      messages = [summaryRecord, ...messages.slice(splitIndex)];
      estimate = estimateBudget({
        systemPrompt: options.systemPrompt,
        bundle: options.bundle,
        history: messages,
        charPerToken: this.charPerToken,
      });
      iterations += 1;
      updated = true;
    }

    if (!updated) {
      return;
    }

    const snapshot = await this.options.store.replace(laneId, messages);
    const limited = await this.enforceStorageLimits(laneId, snapshot, state.redactions);
    this.updateStateFromSnapshot(laneId, limited, state.role, state.redactions);
    const updatedLane = this.lanes.get(laneId);
    if (updatedLane) {
      await this.logLaneSummarized({
        laneId,
        role: updatedLane.role,
        beforeMessages,
        afterMessages: updatedLane.messages.length,
        beforeTokens,
        afterTokens: updatedLane.tokenEstimate,
        iterations,
        modelLimit,
        redactions: updatedLane.redactions,
      });
    }
  }

  async flush(laneId: string): Promise<void> {
    const state = this.lanes.get(laneId);
    if (!state || !state.persisted) return;
    await this.options.store.replace(laneId, state.messages);
  }

  private async ensureLane(laneId: string, role: ContextLaneRole, persisted: boolean): Promise<LaneState> {
    const existing = this.lanes.get(laneId);
    if (existing) return existing;
    let messages: ContextMessageRecord[] = [];
    let updatedAt = Date.now();
    if (persisted) {
      const snapshot = await this.options.store.loadLane(laneId);
      messages = snapshot.messages;
      updatedAt = snapshot.updatedAt || updatedAt;
    }
    const tokenEstimate = estimateMessagesTokens(messages, this.charPerToken);
    const state: LaneState = {
      id: laneId,
      role,
      persisted,
      messages,
      tokenEstimate,
      updatedAt,
      redactions: 0,
    };
    this.lanes.set(laneId, state);
    return state;
  }

  private async enforceStorageLimits(
    laneId: string,
    snapshot: ContextLaneSnapshot,
    redactions: number,
  ): Promise<ContextLaneSnapshot> {
    const { maxMessages, maxBytesPerLane } = this.options.config;
    const beforeMessages = snapshot.messages.length;
    const beforeBytes = snapshot.byteSize;
    let messages = snapshot.messages;
    let trimmedByMessages = false;
    let trimmedByBytes = false;
    if (maxMessages >= 0 && messages.length > maxMessages) {
      messages = messages.slice(-maxMessages);
      trimmedByMessages = true;
    }
    if (maxBytesPerLane >= 0) {
      const trimmed = trimMessagesByBytes(messages, maxBytesPerLane);
      if (trimmed.length !== messages.length) {
        trimmedByBytes = true;
      }
      messages = trimmed;
    }
    if (messages.length !== snapshot.messages.length) {
      const replaced = await this.options.store.replace(laneId, messages);
      this.updateStateFromSnapshot(laneId, replaced, this.lanes.get(laneId)?.role ?? "custom", redactions);
      await this.logLaneTrimmed({
        laneId,
        role: this.lanes.get(laneId)?.role ?? "custom",
        beforeMessages,
        afterMessages: replaced.messages.length,
        beforeBytes,
        afterBytes: replaced.byteSize,
        reasons: [
          ...(trimmedByMessages ? ["max_messages"] : []),
          ...(trimmedByBytes ? ["max_bytes"] : []),
        ],
        redactions,
      });
      return replaced;
    }
    return snapshot;
  }

  private updateStateFromSnapshot(
    laneId: string,
    snapshot: ContextLaneSnapshot,
    role: ContextLaneRole,
    redactions: number,
  ): void {
    this.lanes.set(laneId, {
      id: laneId,
      role,
      persisted: true,
      messages: snapshot.messages,
      tokenEstimate: estimateMessagesTokens(snapshot.messages, this.charPerToken),
      updatedAt: snapshot.updatedAt,
      redactions,
    });
  }

  private async logLaneUpdate(state: LaneState): Promise<void> {
    if (!this.options.logger || !this.enabled || !state.persisted) return;
    await this.options.logger.log("context_lane_update", {
      laneId: state.id,
      role: state.role,
      messageCount: state.messages.length,
      tokenEstimate: state.tokenEstimate,
      redactionCount: state.redactions,
    });
  }

  private async logLaneSummarized(params: {
    laneId: string;
    role: ContextLaneRole;
    beforeMessages: number;
    afterMessages: number;
    beforeTokens: number;
    afterTokens: number;
    iterations: number;
    modelLimit: number;
    redactions: number;
  }): Promise<void> {
    if (!this.options.logger || !this.enabled) return;
    await this.options.logger.log("context_lane_summarized", {
      laneId: params.laneId,
      role: params.role,
      beforeMessages: params.beforeMessages,
      afterMessages: params.afterMessages,
      beforeTokens: params.beforeTokens,
      afterTokens: params.afterTokens,
      iterations: params.iterations,
      modelLimit: params.modelLimit,
      redactionCount: params.redactions,
    });
  }

  private async logLaneTrimmed(params: {
    laneId: string;
    role: ContextLaneRole;
    beforeMessages: number;
    afterMessages: number;
    beforeBytes: number;
    afterBytes: number;
    reasons: string[];
    redactions: number;
  }): Promise<void> {
    if (!this.options.logger || !this.enabled) return;
    await this.options.logger.log("context_lane_trimmed", {
      laneId: params.laneId,
      role: params.role,
      beforeMessages: params.beforeMessages,
      afterMessages: params.afterMessages,
      beforeBytes: params.beforeBytes,
      afterBytes: params.afterBytes,
      reasons: params.reasons,
      redactionCount: params.redactions,
    });
  }
}
