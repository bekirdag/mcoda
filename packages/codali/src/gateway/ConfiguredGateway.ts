import { CodaliGateway, type CodaliGatewayOptions } from "./CodaliGateway.js";
import type { CodaliGatewayRequest, CodaliGatewayResult } from "./CodaliGatewayTypes.js";
import { ConfiguredModelScope, type ScopedModelEvent, type ScopedModelUsage } from "../providers/ConfiguredModelScope.js";
import { pinOrchestrationConfig, type EffortLevel, type ResolvedOrchestrationConfig } from "../config/OrchestrationConfig.js";
import type { ModelCallerContext } from "../providers/ConfiguredProvider.js";
import { normalizeCodaliGatewayAgentCandidate, resolveCodaliGatewayAgentTiers, type CodaliGatewayAgentAssignment } from "./AgentTierResolver.js";

export type ConfiguredGatewayHostOptions = Omit<CodaliGatewayOptions, "provider" | "plannerProvider" | "planner" | "stateMachine" | "finalRouteAssignments">;
export interface ConfiguredGatewayOptions {
  orchestration: ResolvedOrchestrationConfig;
  effort?: EffortLevel;
  signal?: AbortSignal;
  caller?: ModelCallerContext;
  /** Optional trusted parent scope; never closed by a child gateway. */
  scope?: ConfiguredModelScope;
  onModelEvent?: (event: ScopedModelEvent) => Promise<void> | void;
  /** Host owns tool authorization/state. Its workers use scope.provider("worker"), etc. */
  configure?: (scope: ConfiguredModelScope) => ConfiguredGatewayHostOptions | Promise<ConfiguredGatewayHostOptions>;
}

/** Reuse the gateway lifecycle; bind its models to one pinned configuration and budget. */
export const runConfiguredGateway = async (request: CodaliGatewayRequest, options: ConfiguredGatewayOptions): Promise<{ result: CodaliGatewayResult; usage: ScopedModelUsage }> => {
  const resolved = pinOrchestrationConfig(options.orchestration);
  const scope = options.scope ?? new ConfiguredModelScope(resolved, { effort: options.effort, signal: options.signal, caller: options.caller, onEvent: options.onModelEvent });
  try {
    if (scope.configHash !== resolved.hash || options.effort !== undefined && scope.effort !== options.effort
      || options.caller && !scope.matchesCaller(options.caller)) throw new Error("Parent gateway scope does not match configuration, effort or caller");
    const host = await options.configure?.(scope) ?? {};
    for (const field of ["provider", "plannerProvider", "planner", "stateMachine", "finalRouteAssignments"]) if (field in host) throw new Error(`Configured gateway cannot accept a legacy ${field} override`);
    const assignments: Record<string, CodaliGatewayAgentAssignment> = Object.create(null);
    const inventory = host.agentInventory ?? host.agentResolution?.candidates ?? [];
    for (const { model } of scope.models("synthesizer")) {
      const matching = inventory.filter(raw => {
        const candidate = normalizeCodaliGatewayAgentCandidate(raw);
        return candidate && [candidate.id, candidate.slug, candidate.model].includes(model.catalogId);
      });
      const explicit = host.finalAgent ?? host.agentResolution?.assignments.final_synthesizer;
      const assignment = explicit && [explicit.candidate.id, explicit.candidate.slug, explicit.candidate.model].includes(model.catalogId) ? explicit
        : resolveCodaliGatewayAgentTiers({ inventory: matching, agentPolicy: request.agentPolicy, roles: ["final_synthesizer"], allowImageWorker: request.policy.allowImageWorker }).assignments.final_synthesizer;
      if (assignment?.candidate.tier === "large" && assignment.policy.tier === "large") assignments[model.catalogId] = assignment;
      else if (request.policy.requireFinalLargeModel) throw new Error(`Configured synthesizer ${model.catalogId} has no eligible large-model assignment`);
    }
    scope.signal.throwIfAborted();
    const gateway = new CodaliGateway({ ...host, finalAgent: Object.values(assignments)[0], finalRouteAssignments: assignments,
      provider: scope.provider("synthesizer"), plannerProvider: scope.provider("planner") });
    const result = await gateway.run({ ...request, id: request.id ?? scope.id, metadata: { ...request.metadata,
      orchestration: { configHash: scope.configHash, effort: scope.effort, scopeId: scope.id } } });
    scope.signal.throwIfAborted();
    return { result, usage: scope.snapshot() };
  } finally { if (!options.scope) scope.close(); }
};
