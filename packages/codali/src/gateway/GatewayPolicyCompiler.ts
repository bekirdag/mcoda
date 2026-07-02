import type {
  CodaliRuntimeDocdexInput,
  CodaliRuntimePolicy,
  CodaliRuntimeToolManifest,
} from "../runtime/CodaliRuntime.js";
import type { CodaliJobBudgets } from "../runtime/CodaliJobRuntime.js";
import type {
  CodaliGatewayMode,
  CodaliGatewayPolicy,
  CodaliGatewayRequest,
  CodaliGatewaySecurityReview,
} from "./CodaliGatewayTypes.js";
import { resolveCodaliGatewaySecurityPolicy } from "./GatewaySecurityPolicy.js";
import {
  compileToolCapabilities,
  type CodaliGatewayCompiledToolCapability,
  type CodaliGatewayCompilerIssue,
  type CodaliGatewaySkippedTool,
  type ToolCapabilityCompilation,
} from "./ToolCapabilityCompiler.js";

export interface GatewayPolicyCompilerInput {
  request?: Pick<
    CodaliGatewayRequest,
    "policy" | "docdex" | "tools" | "mode" | "tenant" | "metadata"
  >;
  policy?: CodaliGatewayPolicy;
  docdex?: CodaliRuntimeDocdexInput;
  tools?: CodaliRuntimeToolManifest;
  mode?: CodaliGatewayMode;
  runtimeMode?: CodaliRuntimePolicy["mode"];
  requiredDocdexOperations?: string[];
  maxParallelStages?: number;
}

export interface GatewayPolicyCompilation {
  ok: boolean;
  runtimePolicy: CodaliRuntimePolicy;
  jobBudgets: CodaliJobBudgets;
  effectiveAllowedTools: string[];
  effectiveDeniedTools: string[];
  skippedTools: CodaliGatewaySkippedTool[];
  toolCapabilities: CodaliGatewayCompiledToolCapability[];
  toolCompilation: ToolCapabilityCompilation;
  security: CodaliGatewaySecurityReview;
  warnings: CodaliGatewayCompilerIssue[];
  errors: CodaliGatewayCompilerIssue[];
}

const isUnsafePolicyEnabled = (
  policy: CodaliGatewayPolicy,
): Array<keyof Pick<
  CodaliGatewayPolicy,
  | "allowWrites"
  | "allowShell"
  | "allowDestructiveOperations"
  | "allowOutsideWorkspace"
>> => {
  const unsafe: Array<keyof Pick<
    CodaliGatewayPolicy,
    | "allowWrites"
    | "allowShell"
    | "allowDestructiveOperations"
    | "allowOutsideWorkspace"
  >> = [];
  if (policy.allowWrites !== false) unsafe.push("allowWrites");
  if (policy.allowShell !== false) unsafe.push("allowShell");
  if (policy.allowDestructiveOperations !== false) {
    unsafe.push("allowDestructiveOperations");
  }
  if (policy.allowOutsideWorkspace !== false) unsafe.push("allowOutsideWorkspace");
  return unsafe;
};

const issue = (
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CodaliGatewayCompilerIssue => ({
  code,
  message,
  severity: "error",
  details,
});

const modeToRuntimeMode = (
  mode: CodaliGatewayMode | undefined,
): CodaliRuntimePolicy["mode"] => {
  switch (mode) {
    case "cheap":
    case "fast":
      return "tool_loop";
    case "deep":
    case "image":
      return "smart_pipeline";
    case "balanced":
    default:
      return "tool_loop";
  }
};

const positiveOrDefault = (value: number, fallback: number): number =>
  Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

export const compileCodaliGatewayPolicy = (
  input: GatewayPolicyCompilerInput,
): GatewayPolicyCompilation => {
  const policy = input.policy ?? input.request?.policy;
  if (!policy) {
    throw new Error("GATEWAY_POLICY_REQUIRED: Gateway policy is required.");
  }
  const docdex = input.docdex ?? input.request?.docdex;
  const tools = input.tools ?? input.request?.tools ?? docdex?.toolManifest;
  const mode = input.mode ?? input.request?.mode;

  const toolCompilation = compileToolCapabilities({
    policy,
    docdex,
    tools,
    requiredDocdexOperations: input.requiredDocdexOperations,
  });
  const errors = [...toolCompilation.errors];
  const warnings = [...toolCompilation.warnings];

  const unsafeFlags = isUnsafePolicyEnabled(policy);
  if (unsafeFlags.length > 0) {
    errors.push(
      issue(
        "GATEWAY_READ_ONLY_POLICY_REQUIRED",
        "Codali gateway policies must disable shell, writes, destructive operations, and outside-workspace access.",
        { flags: unsafeFlags },
      ),
    );
  }

  if (policy.maxToolCalls < 0) {
    errors.push(
      issue("GATEWAY_INVALID_MAX_TOOL_CALLS", "maxToolCalls must be zero or greater."),
    );
  }

  const effectiveAllowedTools = toolCompilation.visibleTools;
  const effectiveDeniedTools = toolCompilation.deniedTools;
  const security = resolveCodaliGatewaySecurityPolicy({
    request: input.request ? { ...input.request, policy } : {
      policy,
      tenant: undefined,
      metadata: undefined,
    },
    effectiveAllowedTools,
    effectiveDeniedTools,
    toolCapabilities: toolCompilation.capabilities,
  });
  warnings.push(...security.warnings);
  errors.push(...security.errors);

  const runtimePolicy: CodaliRuntimePolicy = {
    allowWrites: false,
    allowShell: false,
    allowDestructiveOperations: false,
    allowOutsideWorkspace: false,
    allowedTools: effectiveAllowedTools,
    deniedTools: effectiveDeniedTools,
    appToolContracts:
      Object.keys(toolCompilation.appToolContracts).length > 0
        ? toolCompilation.appToolContracts
        : undefined,
    appVirtualTools:
      toolCompilation.appVirtualTools.length > 0
        ? toolCompilation.appVirtualTools
        : undefined,
    appToolGateway: toolCompilation.appToolGateway,
    maxSteps: positiveOrDefault(policy.maxIterations, 1),
    maxToolCalls: security.limits.maxToolCalls,
    maxTokens: positiveOrDefault(policy.maxContextPackTokens, 1),
    timeoutMs: security.limits.maxRuntimeMs,
    mode: input.runtimeMode ?? modeToRuntimeMode(mode),
  };

  const jobBudgets: CodaliJobBudgets = {
    maxRuntimeMs: runtimePolicy.timeoutMs,
    maxToolCalls: runtimePolicy.maxToolCalls,
    maxFollowups: runtimePolicy.maxSteps,
    maxParallelStages:
      input.maxParallelStages ??
      Math.max(1, Math.min(security.limits.maxModelCalls, 8)),
  };

  return {
    ok: errors.length === 0,
    runtimePolicy,
    jobBudgets,
    effectiveAllowedTools,
    effectiveDeniedTools,
    skippedTools: toolCompilation.skippedTools,
    toolCapabilities: toolCompilation.capabilities,
    toolCompilation,
    security,
    warnings,
    errors,
  };
};

export const compileGatewayPolicy = compileCodaliGatewayPolicy;
