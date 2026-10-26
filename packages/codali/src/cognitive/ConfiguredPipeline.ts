import { ConfiguredModelScope, type ScopedModelEvent, type ScopedModelUsage } from "../providers/ConfiguredModelScope.js";
import type { EffortLevel, ResolvedOrchestrationConfig } from "../config/OrchestrationConfig.js";
import type { ModelCallerContext } from "../providers/ConfiguredProvider.js";
import type { DocdexClient } from "../docdex/DocdexClient.js";
import { ArchitectPlanner, type ArchitectPlannerOptions } from "./ArchitectPlanner.js";
import { BuilderRunner, type BuilderRunnerOptions } from "./BuilderRunner.js";
import { ContextAssembler, type ContextAssemblerOptions } from "./ContextAssembler.js";
import { PatchInterpreter, type PatchInterpreterOptions } from "./PatchInterpreter.js";
import { SmartPipeline, type SmartPipelineOptions, type SmartPipelineResult } from "./SmartPipeline.js";

export interface ConfiguredPipelineHost {
  /** Host supplies a managed/configured retrieval client and owns its tool permissions. */
  docdex: DocdexClient;
  context?: Omit<ContextAssemblerOptions, "queryProvider">;
  architect?: ArchitectPlannerOptions;
  builder: Omit<BuilderRunnerOptions, "provider" | "interpreter">;
  interpreter?: Omit<PatchInterpreterOptions, "provider">;
  /** ValidationRunner and other host operations must use scope.signal. */
  pipeline: Omit<SmartPipelineOptions, "contextAssembler" | "architectPlanner" | "builderRunner" | "onPhaseProviderFailure">;
}
export interface ConfiguredPipelineOptions {
  orchestration: ResolvedOrchestrationConfig;
  effort?: EffortLevel;
  signal?: AbortSignal;
  caller?: ModelCallerContext;
  onModelEvent?: (event: ScopedModelEvent) => Promise<void> | void;
  configure: (scope: ConfiguredModelScope) => ConfiguredPipelineHost | Promise<ConfiguredPipelineHost>;
}

/** Adapter for the existing cognitive pipeline; no second execution loop or undeclared fallback. */
export const runConfiguredPipeline = async (task: string, options: ConfiguredPipelineOptions): Promise<{ result: SmartPipelineResult; usage: ScopedModelUsage; toolCalls: number }> => {
  const scope = new ConfiguredModelScope(options.orchestration, { effort: options.effort, signal: options.signal, caller: options.caller, onEvent: options.onModelEvent });
  let toolCalls = 0;
  try {
    const host = await options.configure(scope); const budget = scope.budget();
    for (const [record, forbidden] of [[host.context, ["queryProvider"]], [host.builder, ["provider", "interpreter"]], [host.interpreter, ["provider"]],
      [host.pipeline, ["contextAssembler", "architectPlanner", "builderRunner", "onPhaseProviderFailure"]]] as const) {
      for (const key of forbidden) if (record && key in record) throw new Error(`Configured pipeline cannot accept a legacy ${key} override`);
    }
    scope.signal.throwIfAborted();
    const beforeTool = host.builder.context.beforeTool;
    const afterTool = host.builder.context.afterTool;
    const context = { ...host.builder.context, signal: scope.signal,
      beforeTool: async (...args: Parameters<NonNullable<typeof beforeTool>>) => {
        scope.signal.throwIfAborted();
        if (toolCalls >= budget.maxToolCalls) throw new Error("Shared pipeline tool budget exhausted");
        toolCalls++; await beforeTool?.(...args); scope.signal.throwIfAborted();
      },
      afterTool: async (...args: Parameters<NonNullable<typeof afterTool>>) => { await afterTool?.(...args); scope.signal.throwIfAborted(); },
    };
    const pipeline = new SmartPipeline({ ...host.pipeline,
      contextAssembler: new ContextAssembler(host.docdex, { ...host.context, queryProvider: scope.provider("router") }),
      architectPlanner: new ArchitectPlanner(scope.provider("architect"), host.architect),
      builderRunner: new BuilderRunner({ ...host.builder, context, provider: scope.provider("worker"),
        maxTokens: Math.min(host.builder.maxTokens ?? budget.maxOutputTokens, budget.maxOutputTokens),
        maxSteps: Math.min(host.builder.maxSteps, budget.maxSteps), maxToolCalls: Math.min(host.builder.maxToolCalls, budget.maxToolCalls),
        timeoutMs: Math.min(host.builder.timeoutMs ?? budget.timeoutMs, budget.timeoutMs),
        interpreter: host.interpreter ? new PatchInterpreter({ ...host.interpreter, provider: scope.provider("repair") }) : undefined }),
    });
    const result = await pipeline.run(task); scope.signal.throwIfAborted();
    return { result, usage: scope.snapshot(), toolCalls };
  } finally { scope.close(); }
};
