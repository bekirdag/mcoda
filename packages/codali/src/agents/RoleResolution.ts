import {
  resolveCodaliGatewayAgentTiers,
  type AgentTierResolution,
  type CodaliGatewayAgentAssignment,
} from "../gateway/AgentTierResolver.js";
import type {
  CodaliAgentTierPolicy,
  CodaliGatewayModelTier,
} from "../gateway/CodaliGatewayTypes.js";
import type { RunContextAgentRoles } from "../runcontext/RunContextResolver.js";
import type { AgentInventoryEntry } from "./AgentInventory.js";

/**
 * Codali's configurable model roles.
 *
 * `AgentTierResolver` knows twelve internal roles, each with a working default.
 * Requiring an operator to configure twelve agents to ask one question is a
 * burden with no payoff, so only three are exposed:
 *
 *   orchestrator — routes, plans, assesses completeness, repairs
 *   synthesizer  — produces multi-source answers
 *   media        — generates images and other artifacts
 *
 * "Classifier", "planner", "verifier" and "repair" remain distinct *prompts*,
 * but they run against the orchestrator model. The internal roles are still
 * available for advanced tuning; they simply are not part of configuration.
 */

export type CodaliConfigurableRole =
  | "orchestrator"
  | "worker"
  | "synthesizer"
  | "media";

/** Internal roles each configurable role stands in for. */
const ROLE_EXPANSION: Record<CodaliConfigurableRole, string[]> = {
  // Thinking stages: JSON in, JSON out, no tool calls. A small fast model is
  // usually enough, and these run on every question.
  orchestrator: [
    "router",
    "classifier",
    "planner",
    "query_expander",
    "context_refiner",
    "verifier",
    "repair",
  ],
  // Tool-calling stages. Accuracy here decides whether a run gathers anything:
  // a weak model invents dates and empty ids. Split out so a bigger model can
  // be put exactly here without slowing down planning.
  worker: ["rag_worker", "tool_worker", "extractor"],
  synthesizer: ["final_synthesizer"],
  media: ["image_worker"],
};

/** Phase 1 resolves only these; media arrives with image generation. */
export const PHASE_ONE_ROLES: CodaliConfigurableRole[] = [
  "orchestrator",
  "worker",
  "synthesizer",
];

export interface RoleResolutionInput {
  inventory: AgentInventoryEntry[];
  /** Explicit slug bindings from run context, e.g. `synthesizer = "suku-large"`. */
  bindings?: RunContextAgentRoles;
  roles?: CodaliConfigurableRole[];
  allowImageWorker?: boolean;
}

export interface RoleResolutionResult {
  resolution: AgentTierResolution;
  /** Configurable role -> the assignment that will serve it. */
  assignments: Partial<Record<CodaliConfigurableRole, CodaliGatewayAgentAssignment>>;
  /** Configurable role -> agent slug, for display in `codali doctor`. */
  bindings: Partial<Record<CodaliConfigurableRole, string>>;
  /**
   * An assignment whose agent can actually emit tool calls.
   *
   * The orchestrator model is chosen for planning quality, and plenty of
   * capable small models report `supportsTools: false`. Running worker tasks on
   * one of those produces a plan full of correct tool tasks and then zero tool
   * calls — the run "succeeds" having gathered nothing. So tool execution gets
   * its own assignment, and its absence is reported rather than discovered
   * through an empty answer.
   */
  toolCapable?: CodaliGatewayAgentAssignment;
  warnings: string[];
}

/** Internal roles whose policies already demand tool support, best first. */
const TOOL_CAPABLE_PREFERENCE = ["tool_worker", "rag_worker"];

/**
 * Adapters driven through a text CLI. They advertise `supportsTools: true`
 * because the CLI itself has tools, but Codali's provider for them cannot
 * surface a structured tool call — so choosing one as the tool worker yields a
 * correct plan and zero tool calls.
 */
const NON_TOOL_CALLING_ADAPTERS = new Set(["claude-cli", "codex-cli", "gemini-cli"]);

const canEmitToolCalls = (
  assignment: CodaliGatewayAgentAssignment | undefined,
): boolean =>
  assignment?.candidate.supportsTools === true &&
  !NON_TOOL_CALLING_ADAPTERS.has((assignment.candidate.adapter ?? "").toLowerCase());

const findToolCapableAssignment = (
  resolution: AgentTierResolution,
  preferred: CodaliGatewayAgentAssignment | undefined,
): CodaliGatewayAgentAssignment | undefined => {
  if (canEmitToolCalls(preferred)) return preferred;
  for (const role of TOOL_CAPABLE_PREFERENCE) {
    const assignment = resolution.assignments[role];
    if (canEmitToolCalls(assignment)) return assignment;
  }
  return Object.values(resolution.assignments).find((assignment) =>
    canEmitToolCalls(assignment));
};

const findBySlug = (
  inventory: AgentInventoryEntry[],
  slug: string,
): AgentInventoryEntry | undefined =>
  inventory.find((agent) => agent.slug === slug || agent.id === slug);

/**
 * Builds the tier policy the resolver consumes. An explicitly bound slug is
 * honoured for every internal role the configurable role stands in for, so
 * binding `orchestrator` really does move planning, verification and repair
 * onto that agent.
 */
const buildAgentPolicy = (
  bindings: RunContextAgentRoles | undefined,
  inventory: AgentInventoryEntry[],
  warnings: string[],
): CodaliAgentTierPolicy | undefined => {
  if (!bindings) return undefined;

  const roles: CodaliAgentTierPolicy["roles"] = {};
  let hasBinding = false;

  for (const [role, slug] of Object.entries(bindings) as Array<
    [CodaliConfigurableRole, string | undefined]
  >) {
    if (!slug) continue;
    const agent = findBySlug(inventory, slug);
    if (!agent) {
      warnings.push(`agent_binding_not_found:${role}:${slug}`);
      continue;
    }
    hasBinding = true;
    // Use the bound agent's *own* tier for the role. Imposing the role's
    // nominal tier here silently discards the operator's choice: binding
    // `orchestrator` to a large agent left it failing a "medium" requirement
    // and falling back to whatever the resolver preferred, with the config
    // appearing to have no effect.
    const boundTier =
      (typeof agent.tier === "string" ? agent.tier : undefined) ??
      (role === "synthesizer" ? "large" : role === "media" ? "image" : "medium");
    for (const internalRole of ROLE_EXPANSION[role] ?? []) {
      roles[internalRole] = {
        tier: boundTier as CodaliGatewayModelTier,
        preferredRunnerKinds: undefined,
      };
    }
  }

  return hasBinding ? { resolver: "mcoda_inventory", roles } : undefined;
};

export const resolveConfigurableRoles = (
  input: RoleResolutionInput,
): RoleResolutionResult => {
  const warnings: string[] = [];
  const roles = input.roles ?? PHASE_ONE_ROLES;
  const internalRoles = roles.flatMap((role) => ROLE_EXPANSION[role] ?? []);

  const agentPolicy = buildAgentPolicy(input.bindings, input.inventory, warnings);

  const resolution = resolveCodaliGatewayAgentTiers({
    inventory: input.inventory,
    agentPolicy,
    roles: internalRoles,
    allowImageWorker: input.allowImageWorker ?? roles.includes("media"),
  });

  const assignments: RoleResolutionResult["assignments"] = {};
  const bindingsOut: RoleResolutionResult["bindings"] = {};

  for (const role of roles) {
    // An explicit binding is the operator's decision and overrides tier
    // matching outright. Routing it through the tier policy silently discarded
    // the choice: mcoda's inventory carries no `tier` field — the resolver
    // infers one — so a bound large agent failed a nominal "medium"
    // requirement and the config appeared to do nothing.
    const boundSlug = input.bindings?.[role];
    if (boundSlug) {
      const candidate = resolution.candidates.find(
        (entry) => entry.slug === boundSlug || entry.id === boundSlug,
      );
      if (candidate) {
        const existing = Object.values(resolution.assignments).find(
          (assignment) => assignment.candidate.slug === candidate.slug,
        );
        assignments[role] = existing ?? {
          role,
          policy: { tier: candidate.tier },
          candidate,
          agent: {
            slug: candidate.slug,
            adapter: candidate.adapter ?? "",
            model: candidate.model ?? "",
            supportsTools: candidate.supportsTools,
            contextWindow: candidate.contextWindow,
            maxOutputTokens: candidate.maxOutputTokens,
          },
          score: 0,
          reasons: ["explicit_binding"],
        } as CodaliGatewayAgentAssignment;
        bindingsOut[role] = candidate.slug;
        continue;
      }
      warnings.push(`agent_binding_unavailable:${role}:${boundSlug}`);
    }

    // Otherwise the role is served by the first of its internal roles that
    // resolved. They share a tier, so any is a valid stand-in.
    for (const internalRole of ROLE_EXPANSION[role] ?? []) {
      const assignment = resolution.assignments[internalRole];
      if (assignment) {
        assignments[role] = assignment;
        bindingsOut[role] = assignment.candidate.slug;
        break;
      }
    }
    if (!assignments[role]) {
      warnings.push(`agent_role_unresolved:${role}`);
    }
  }

  // An internal role that failed to resolve is only worth reporting when the
  // configurable role standing in for it also failed. Otherwise every run on a
  // sparse inventory emits a wall of errors for roles that fell back correctly
  // and never affected the answer.
  const servedInternalRoles = new Set(
    roles
      .filter((role) => assignments[role])
      .flatMap((role) => ROLE_EXPANSION[role] ?? []),
  );
  for (const error of resolution.errors) {
    if (error.role && servedInternalRoles.has(error.role)) continue;
    warnings.push(`agent_resolution_error:${error.code}${error.role ? `:${error.role}` : ""}`);
  }

  const toolCapable = findToolCapableAssignment(
    resolution,
    // An explicitly bound worker wins; otherwise fall back to the orchestrator.
    assignments.worker ?? assignments.orchestrator,
  );
  if (!toolCapable) {
    warnings.push("no_tool_capable_agent");
  } else if (toolCapable !== assignments.orchestrator) {
    warnings.push(`tool_worker_substituted:${toolCapable.candidate.slug}`);
  }

  return { resolution, assignments, bindings: bindingsOut, toolCapable, warnings };
};
