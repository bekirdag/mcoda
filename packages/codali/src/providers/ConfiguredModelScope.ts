import { randomUUID } from "node:crypto";
import { effortBudget, pinOrchestrationConfig, resolveBinding, type EffortLevel, type ResolvedOrchestrationConfig } from "../config/OrchestrationConfig.js";
import { ConfiguredProvider, normalizeModelCaller, type ModelCallerContext, type ModelInvocation } from "./ConfiguredProvider.js";
import type { Provider, ProviderRequest, ProviderResponse, ProviderUsage } from "./ProviderTypes.js";

export interface ScopedModelUsage {
  modelCalls: number; inputTokens: number; outputTokens: number; totalTokens: number;
  estimated: boolean; pendingCalls: number;
}
export interface ScopedModelEvent {
  type: "intent" | "receipt";
  id: string;
  binding: string;
  configHash: string;
  route?: ModelInvocation;
  status: "pending" | "success" | "failed";
  usage: ScopedModelUsage;
}

/** Invalid upstream accounting cannot lower a shared budget or turn it into NaN. */
export const verifiedTokenUsage = (usage?: ProviderUsage): { input?: number; output?: number; total: number } | undefined => {
  const valid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
  if (!usage) return undefined;
  for (const value of [usage.inputTokens, usage.outputTokens, usage.totalTokens]) if (value !== undefined && !valid(value)) return undefined;
  const sum = usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : undefined;
  const total = usage.totalTokens ?? sum;
  if (!valid(total) || total < (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)) return undefined;
  return { input: usage.inputTokens, output: usage.outputTokens, total };
};

/** One model budget/deadline for one embedded gateway or pipeline invocation. */
export class ConfiguredModelScope {
  private readonly options: { effort?: EffortLevel; signal?: AbortSignal; caller?: ModelCallerContext; credentials?: Readonly<Record<string, string>>; onEvent?: (event: ScopedModelEvent) => Promise<void> | void };
  private readonly resolved: ResolvedOrchestrationConfig;
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly limits;
  private readonly stop: () => void;
  private readonly pending = new Map<string, number>();
  private toolCalls = 0;
  private readonly usage: ScopedModelUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false, pendingCalls: 0 };
  readonly id = randomUUID();

  constructor(resolved: ResolvedOrchestrationConfig, options: {
    effort?: EffortLevel; signal?: AbortSignal; caller?: ModelCallerContext; onEvent?: (event: ScopedModelEvent) => Promise<void> | void;
    credentials?: Readonly<Record<string, string>>;
  } = {}) {
    this.options = { ...options, caller: normalizeModelCaller(options.caller), credentials: Object.freeze(Object.assign(Object.create(null), options.credentials)) };
    this.resolved = pinOrchestrationConfig(resolved);
    this.limits = effortBudget(this.resolved.config, options.effort ?? "medium");
    this.stop = () => this.controller.abort(this.options.signal?.reason ?? new Error("Model scope cancelled"));
    options.signal?.addEventListener("abort", this.stop, { once: true });
    if (options.signal?.aborted) this.stop();
    this.timer = setTimeout(() => this.controller.abort(new Error("Shared model deadline exceeded")), this.limits.timeoutMs);
    this.timer.unref();
  }

  get signal(): AbortSignal { return this.controller.signal; }
  get configHash(): string { return this.resolved.hash; }
  get effort(): EffortLevel { return this.options.effort ?? "medium"; }
  matchesCaller(caller: ModelCallerContext): boolean { return JSON.stringify(normalizeModelCaller(caller)) === JSON.stringify(this.options.caller); }
  budget() { return { ...this.limits }; }
  get toolsUsed(): number { return this.toolCalls; }
  reserveTool(): void {
    this.signal.throwIfAborted();
    if (this.toolCalls >= this.limits.maxToolCalls) {
      const error = new Error("Shared orchestration tool budget exhausted");
      this.controller.abort(error);
      throw error;
    }
    this.toolCalls++;
  }
  models(binding: string) { return structuredClone(resolveBinding(this.resolved.config, binding, "chat.completions")); }
  snapshot(): ScopedModelUsage { return { ...this.usage, pendingCalls: this.pending.size, estimated: this.usage.estimated || this.pending.size > 0 }; }
  close(): void { clearTimeout(this.timer); this.options.signal?.removeEventListener("abort", this.stop); this.controller.abort(new Error("Model scope closed")); }

  provider(binding: string): Provider {
    resolveBinding(this.resolved.config, binding, "chat.completions");
    return { name: `configured:${binding}`, supportsToolCalls: true, generate: request => this.generate(binding, request) };
  }

  private async generate(binding: string, request: ProviderRequest): Promise<ProviderResponse> {
    this.signal.throwIfAborted(); request.signal?.throwIfAborted();
    const linked = new AbortController();
    const stopScope = () => linked.abort(this.signal.reason);
    const stopRequest = () => linked.abort(request.signal?.reason);
    this.signal.addEventListener("abort", stopScope, { once: true });
    request.signal?.addEventListener("abort", stopRequest, { once: true });
    let invocation: ModelInvocation | undefined;
    const provider = new ConfiguredProvider(this.resolved, binding, {
      caller: this.options.caller,
      credentials: this.options.credentials,
      effort: this.options.effort,
      beforeRequest: async (route, bounded) => {
        linked.signal.throwIfAborted();
        const reservation = Math.ceil(JSON.stringify([bounded.messages, bounded.tools]).length / 3) + (bounded.maxTokens ?? this.limits.maxOutputTokens);
        if (this.usage.modelCalls >= this.limits.maxModelCalls || this.usage.totalTokens + reservation > this.limits.maxTotalTokens) throw new Error("Shared model budget exhausted");
        invocation = route; this.usage.modelCalls++; this.usage.totalTokens += reservation; this.pending.set(route.id, reservation);
        await this.options.onEvent?.({ type: "intent", id: route.id, binding, configHash: this.resolved.hash, route, status: "pending", usage: this.snapshot() });
      },
    });
    try {
      const response = await provider.generate({ ...request, signal: linked.signal, maxTokens: Math.min(request.maxTokens ?? this.limits.maxOutputTokens, this.limits.maxOutputTokens) });
      linked.signal.throwIfAborted();
      if (!invocation) throw new Error("Configured provider did not reserve its invocation");
      const reported = verifiedTokenUsage(response.usage);
      if (reported) {
        this.usage.totalTokens += reported.total - this.pending.get(invocation.id)!;
        this.usage.inputTokens += reported.input ?? 0; this.usage.outputTokens += reported.output ?? 0;
      } else this.usage.estimated = true;
      this.pending.delete(invocation.id);
      await this.options.onEvent?.({ type: "receipt", id: invocation.id, binding, configHash: this.resolved.hash, route: invocation, status: "success", usage: this.snapshot() });
      return response;
    } catch (error) {
      // A submitted request is never replayed; an unknown bill keeps its reservation.
      if (invocation && this.pending.has(invocation.id)) {
        this.usage.estimated = true;
        await this.options.onEvent?.({ type: "receipt", id: invocation.id, binding, configHash: this.resolved.hash, route: invocation, status: "failed", usage: this.snapshot() });
      }
      throw error;
    } finally {
      this.signal.removeEventListener("abort", stopScope); request.signal?.removeEventListener("abort", stopRequest);
    }
  }
}
