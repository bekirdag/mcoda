import type {
  CodaliRuntimeAppToolContract,
  CodaliRuntimeAppToolContracts,
  CodaliRuntimeAppToolGatewayContract,
  CodaliRuntimeDocdexInput,
  CodaliRuntimeToolManifest,
} from "../runtime/CodaliRuntime.js";
import type {
  CodaliGatewayPolicy,
  CodaliGatewayToolRiskCategory,
} from "./CodaliGatewayTypes.js";

export type CodaliGatewayToolCapabilityKind =
  | "actual"
  | "virtual"
  | "app_contract"
  | "app_gateway"
  | "builtin";

export type CodaliGatewayToolCapabilityStatus =
  | "allowed"
  | "denied"
  | "skipped";

export interface CodaliGatewayCompilerIssue {
  code: string;
  message: string;
  tool?: string;
  severity: "warning" | "error";
  details?: Record<string, unknown>;
}

export interface CodaliGatewaySkippedTool {
  name: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface CodaliGatewayCompiledToolCapability {
  name: string;
  kind: CodaliGatewayToolCapabilityKind;
  status: CodaliGatewayToolCapabilityStatus;
  readOnly: boolean;
  riskCategory: CodaliGatewayToolRiskCategory;
  approvalRequired: boolean;
  backingTools: string[];
  reasons: string[];
}

export interface ToolCapabilityCompilerInput {
  policy: CodaliGatewayPolicy;
  docdex?: CodaliRuntimeDocdexInput;
  tools?: CodaliRuntimeToolManifest;
  requiredDocdexOperations?: string[];
  allowedBackingTools?: string[];
}

export interface ToolCapabilityCompilation {
  allowedTools: string[];
  deniedTools: string[];
  visibleTools: string[];
  appVirtualTools: string[];
  appToolContracts: Record<string, CodaliRuntimeAppToolContract>;
  appToolGateway?: CodaliRuntimeAppToolGatewayContract;
  capabilities: CodaliGatewayCompiledToolCapability[];
  skippedTools: CodaliGatewaySkippedTool[];
  warnings: CodaliGatewayCompilerIssue[];
  errors: CodaliGatewayCompilerIssue[];
  requiredDocdexOperations: string[];
}

export const CODALI_GATEWAY_READ_ONLY_BACKING_TOOLS = [
  "docdex_search",
  "docdex_batch_search",
  "docdex_open",
  "docdex_files",
  "docdex_tree",
  "docdex_stats",
] as const;

export const CODALI_GATEWAY_RESERVED_TOOL_ARG_KEYS = [
  "apiKey",
  "api_key",
  "baseUrl",
  "base_url",
  "credentialSource",
  "credential_source",
  "docdex",
  "repo",
  "repoId",
  "repo_id",
  "repoRoot",
  "repo_root",
  "tenant",
  "tenantId",
  "tenant_id",
] as const;

const DOCDEX_OPERATION_BY_TOOL: Record<string, string> = {
  docdex_batch_search: "batch_search",
  docdex_files: "files",
  docdex_open: "open",
  docdex_search: "search",
  docdex_stats: "stats",
  docdex_tree: "tree",
};

const READ_ONLY_BUILTIN_TOOLS = new Set<string>(
  CODALI_GATEWAY_READ_ONLY_BACKING_TOOLS,
);

const DESTRUCTIVE_TOOL_TOKENS = new Set([
  "delete",
  "destroy",
  "drop",
  "exec",
  "execute",
  "purge",
  "remove",
  "reset",
  "rm",
  "shell",
  "terminal",
  "truncate",
  "wipe",
]);

const WRITE_TOOL_TOKENS = new Set([
  "add",
  "approve",
  "assign",
  "cancel",
  "commit",
  "create",
  "dispatch",
  "edit",
  "merge",
  "mutate",
  "post",
  "publish",
  "push",
  "send",
  "submit",
  "sync",
  "transition",
  "update",
  "upload",
  "write",
]);

const RESERVED_TOOL_ARG_KEY_SET = new Set(
  CODALI_GATEWAY_RESERVED_TOOL_ARG_KEYS.map((key) => key.toLowerCase()),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeName = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const unique = (values: Iterable<string | undefined>): string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeName(value);
    if (normalized) {
      seen.add(normalized);
    }
  }
  return [...seen];
};

const toolNameTokens = (tool: string): string[] =>
  tool
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);

const hasRiskToken = (tool: string, tokens: Set<string>): boolean => {
  const normalized = tool.toLowerCase();
  return toolNameTokens(tool).some((token) => tokens.has(token)) ||
    [...tokens].some((token) => normalized === token || normalized.endsWith(`_${token}`));
};

const classifyCapabilityRisk = (
  name: string,
  readOnly: boolean,
): CodaliGatewayToolRiskCategory => {
  if (hasRiskToken(name, DESTRUCTIVE_TOOL_TOKENS)) {
    return "destructive_blocked";
  }
  if (!readOnly || hasRiskToken(name, WRITE_TOOL_TOKENS)) {
    return "write_with_approval";
  }
  return "read_only";
};

const readString = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined => {
  for (const key of keys) {
    const value = normalizeName(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
};

const readBoolean = (
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
};

const readStringArray = (
  record: Record<string, unknown>,
  keys: readonly string[],
): string[] => {
  for (const key of keys) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    return unique(value.map(normalizeName));
  }
  return [];
};

const readRecord = (
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
};

const extractToolName = (tool: unknown): string | undefined => {
  if (typeof tool === "string") {
    return normalizeName(tool);
  }
  if (!isRecord(tool)) {
    return undefined;
  }
  return readString(tool, ["name", "tool", "toolName", "tool_name", "slug", "id"]);
};

const readManifestTools = (
  tools: CodaliRuntimeToolManifest | undefined,
  keys: readonly string[],
): string[] => {
  if (!tools) {
    return [];
  }
  const names: string[] = [];
  for (const key of keys) {
    const value = tools[key];
    if (Array.isArray(value)) {
      names.push(...value.map(extractToolName).filter(Boolean) as string[]);
    }
  }
  return unique(names);
};

const addIssue = (
  target: CodaliGatewayCompilerIssue[],
  severity: "warning" | "error",
  code: string,
  message: string,
  tool?: string,
  details?: Record<string, unknown>,
): void => {
  target.push({ code, message, tool, severity, details });
};

const addSkippedTool = (
  skippedTools: CodaliGatewaySkippedTool[],
  warnings: CodaliGatewayCompilerIssue[],
  name: string,
  reason: string,
  details?: Record<string, unknown>,
): void => {
  skippedTools.push({ name, reason, details });
  addIssue(
    warnings,
    "warning",
    `GATEWAY_TOOL_SKIPPED_${reason.toUpperCase()}`,
    `Skipped tool ${name}: ${reason}.`,
    name,
    details,
  );
};

const normalizeAppToolContracts = (
  contracts: CodaliRuntimeAppToolContracts | undefined,
  warnings: CodaliGatewayCompilerIssue[],
): Map<string, CodaliRuntimeAppToolContract> => {
  const normalized = new Map<string, CodaliRuntimeAppToolContract>();
  if (!contracts) {
    return normalized;
  }

  if (Array.isArray(contracts)) {
    for (const contract of contracts) {
      if (!isRecord(contract)) {
        continue;
      }
      const name = extractToolName(contract);
      if (!name) {
        addIssue(
          warnings,
          "warning",
          "GATEWAY_TOOL_CONTRACT_NAME_REQUIRED",
          "Skipped an app tool contract without a tool name.",
        );
        continue;
      }
      normalized.set(name, { ...contract, name });
    }
    return normalized;
  }

  for (const [key, value] of Object.entries(contracts)) {
    if (!isRecord(value)) {
      addIssue(
        warnings,
        "warning",
        "GATEWAY_TOOL_CONTRACT_INVALID",
        `Skipped app tool contract ${key}: contract must be an object.`,
        key,
      );
      continue;
    }
    const name = extractToolName(value) ?? normalizeName(key);
    if (!name) {
      continue;
    }
    normalized.set(name, { ...value, name });
  }
  return normalized;
};

const callSchemaReservedProperties = (
  contract: CodaliRuntimeAppToolContract,
): string[] => {
  const schema = readRecord(contract, ["callSchema", "call_schema"]);
  const properties = schema ? readRecord(schema, ["properties"]) : undefined;
  if (!properties) {
    return [];
  }
  return Object.keys(properties).filter((key) =>
    RESERVED_TOOL_ARG_KEY_SET.has(key.toLowerCase()),
  );
};

const contractGateway = (
  contract: CodaliRuntimeAppToolContract,
  policyGateway?: CodaliRuntimeAppToolGatewayContract,
): CodaliRuntimeAppToolGatewayContract | undefined => {
  const gateway = readRecord(contract, ["gateway"]);
  if (!gateway && !policyGateway) return undefined;
  return { ...(policyGateway ?? {}), ...(gateway ?? {}) };
};

const gatewayEndpoint = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
): string | undefined => readString(gateway ?? {}, ["endpoint"]);

const gatewayHasSigningMaterial = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
): boolean =>
  Boolean(
    readString(gateway ?? {}, [
      "signatureSecret",
      "signature_secret",
      "signingSecret",
      "signing_secret",
      "secret",
      "signature",
    ]),
  );

const gatewayRequiresMissingSignature = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
): boolean =>
  Boolean(
    gateway &&
      (gatewayEndpoint(gateway) ||
        gateway.signatureRequired === true ||
        gateway.signature_required === true) &&
      !gatewayHasSigningMaterial(gateway),
  );

const isGatewayReadOnly = (
  gateway: CodaliRuntimeAppToolGatewayContract | undefined,
): boolean => {
  if (!gateway) return true;
  return readBoolean(gateway, ["readOnly", "read_only"]) === true;
};

const isOperationAllowed = (
  tool: string,
  operation: string,
  allowedOperations: Set<string>,
): boolean =>
  allowedOperations.size === 0 ||
  allowedOperations.has(operation) ||
  allowedOperations.has(tool);

const requireDocdexOperation = (
  operations: Set<string>,
  tool: string,
): void => {
  const operation = DOCDEX_OPERATION_BY_TOOL[tool];
  if (operation) {
    operations.add(operation);
  }
};

const isImmutableDocdexRuntimeContext = (
  docdex: CodaliRuntimeDocdexInput | undefined,
): boolean =>
  docdex?.immutableRuntimeContext === true ||
  docdex?.credentialSource === "attached_mswarm_api_key";

export const compileToolCapabilities = (
  input: ToolCapabilityCompilerInput,
): ToolCapabilityCompilation => {
  const warnings: CodaliGatewayCompilerIssue[] = [];
  const errors: CodaliGatewayCompilerIssue[] = [];
  const skippedTools: CodaliGatewaySkippedTool[] = [];
  const capabilities: CodaliGatewayCompiledToolCapability[] = [];
  const visibleTools: string[] = [];
  const appVirtualTools: string[] = [];
  const appToolContracts: Record<string, CodaliRuntimeAppToolContract> = {};

  const allowedTools = unique(input.policy.allowedTools);
  const allowedSet = new Set(allowedTools);
  const deniedTools = unique(input.policy.deniedTools ?? []);
  const deniedSet = new Set(deniedTools);
  const actualTools = new Set(
    readManifestTools(input.tools ?? input.docdex?.toolManifest, [
      "actualTools",
      "actual_tools",
    ]),
  );
  const virtualTools = new Set([
    ...readManifestTools(input.tools ?? input.docdex?.toolManifest, [
      "virtualTools",
      "virtual_tools",
    ]),
    ...unique(input.policy.appVirtualTools ?? []),
  ]);
  const contracts = normalizeAppToolContracts(input.policy.appToolContracts, warnings);
  const allowedBackingTools = new Set(
    unique(input.allowedBackingTools ?? CODALI_GATEWAY_READ_ONLY_BACKING_TOOLS),
  );
  const requiredDocdexOperations = new Set(
    unique(input.requiredDocdexOperations ?? []),
  );

  const addCapability = (
    name: string,
    kind: CodaliGatewayToolCapabilityKind,
    status: CodaliGatewayToolCapabilityStatus,
    readOnly: boolean,
    backingTools: string[],
    reasons: string[],
  ): void => {
    const riskCategory = classifyCapabilityRisk(name, readOnly);
    capabilities.push({
      name,
      kind,
      status,
      readOnly,
      riskCategory,
      approvalRequired: riskCategory !== "read_only",
      backingTools,
      reasons,
    });
  };

  for (const tool of allowedTools) {
    const contract = contracts.get(tool);
    const isActual = actualTools.has(tool);
    const isVirtual = virtualTools.has(tool);
    const isBuiltin = READ_ONLY_BUILTIN_TOOLS.has(tool);
    const kind: CodaliGatewayToolCapabilityKind =
      contract ? "app_contract" : isActual ? "actual" : isVirtual ? "virtual" : "builtin";

    if (deniedSet.has(tool)) {
      addCapability(tool, kind, "denied", true, [], ["denied_by_policy"]);
      addSkippedTool(skippedTools, warnings, tool, "denied_by_policy");
      continue;
    }

    if (!contract && !isActual && !isVirtual && !isBuiltin) {
      addCapability(tool, kind, "skipped", true, [], ["not_declared"]);
      addSkippedTool(skippedTools, warnings, tool, "not_declared");
      continue;
    }

    if (!contract) {
      visibleTools.push(tool);
      addCapability(tool, kind, "allowed", true, [], []);
      requireDocdexOperation(requiredDocdexOperations, tool);
      continue;
    }

    if (contract.enabled === false) {
      addCapability(tool, "app_contract", "skipped", true, [], ["disabled"]);
      addSkippedTool(skippedTools, warnings, tool, "disabled");
      continue;
    }

    const contractReadOnly =
      readBoolean(contract, ["readOnly", "read_only"]) ?? true;
    if (!contractReadOnly) {
      addCapability(tool, "app_contract", "skipped", false, [], ["not_read_only"]);
      addSkippedTool(skippedTools, warnings, tool, "not_read_only");
      continue;
    }

    const gateway = contractGateway(contract, input.policy.appToolGateway);
    const hasGateway = Boolean(gatewayEndpoint(gateway));
    if (hasGateway && !isGatewayReadOnly(gateway)) {
      addCapability(tool, "app_gateway", "skipped", false, [], ["gateway_not_read_only"]);
      addSkippedTool(skippedTools, warnings, tool, "gateway_not_read_only");
      continue;
    }

    if (gatewayRequiresMissingSignature(gateway)) {
      addCapability(tool, "app_gateway", "skipped", true, [], ["gateway_signature_required"]);
      addSkippedTool(skippedTools, warnings, tool, "gateway_signature_required");
      continue;
    }

    const reservedProperties = callSchemaReservedProperties(contract);
    if (reservedProperties.length > 0) {
      addCapability(tool, "app_contract", "skipped", true, [], [
        "reserved_call_schema_properties",
      ]);
      addSkippedTool(skippedTools, warnings, tool, "reserved_call_schema_properties", {
        properties: reservedProperties,
      });
      continue;
    }

    const backingTools = readStringArray(contract, ["backingTools", "backing_tools"]);
    if (backingTools.length === 0 && !hasGateway) {
      addCapability(tool, "app_contract", "skipped", true, [], ["missing_backing_tools"]);
      addSkippedTool(skippedTools, warnings, tool, "missing_backing_tools");
      continue;
    }

    const deniedBackingTools = backingTools.filter((backingTool) =>
      deniedSet.has(backingTool),
    );
    if (deniedBackingTools.length > 0) {
      addCapability(tool, "app_contract", "skipped", true, backingTools, [
        "denied_backing_tools",
      ]);
      addSkippedTool(skippedTools, warnings, tool, "denied_backing_tools", {
        backingTools: deniedBackingTools,
      });
      continue;
    }

    const disallowedBackingTools = backingTools.filter(
      (backingTool) => !allowedSet.has(backingTool),
    );
    if (disallowedBackingTools.length > 0) {
      addCapability(tool, "app_contract", "skipped", true, backingTools, [
        "backing_tools_not_allowed",
      ]);
      addSkippedTool(skippedTools, warnings, tool, "backing_tools_not_allowed", {
        backingTools: disallowedBackingTools,
      });
      continue;
    }

    const unsafeBackingTools = backingTools.filter(
      (backingTool) => !allowedBackingTools.has(backingTool),
    );
    if (unsafeBackingTools.length > 0) {
      addCapability(tool, "app_contract", "skipped", true, backingTools, [
        "unsafe_backing_tools",
      ]);
      addSkippedTool(skippedTools, warnings, tool, "unsafe_backing_tools", {
        backingTools: unsafeBackingTools,
      });
      continue;
    }

    visibleTools.push(tool);
    appToolContracts[tool] = { ...contract, name: tool };
    if (virtualTools.has(tool)) {
      appVirtualTools.push(tool);
    }
    addCapability(tool, hasGateway ? "app_gateway" : "app_contract", "allowed", true, backingTools, []);
    for (const backingTool of backingTools) {
      requireDocdexOperation(requiredDocdexOperations, backingTool);
    }
  }

  const allowedOperations = new Set(
    unique(input.docdex?.allowedOperations ?? []),
  );
  const immutableDocdexContext = isImmutableDocdexRuntimeContext(input.docdex);
  const needsDocdex =
    requiredDocdexOperations.size > 0 ||
    visibleTools.some((tool) => DOCDEX_OPERATION_BY_TOOL[tool]);
  const docdexRequired = input.docdex?.required === true || requiredDocdexOperations.size > 0;
  if (docdexRequired && !input.docdex) {
    addIssue(
      errors,
      "error",
      "GATEWAY_DOCDEX_REQUIRED",
      "Docdex context is required by the compiled tool surface.",
    );
  }
  if (docdexRequired && input.docdex?.enabled === false) {
    addIssue(
      errors,
      "error",
      "GATEWAY_DOCDEX_DISABLED",
      "Docdex context is required but disabled.",
    );
  }
  if (
    needsDocdex &&
    input.docdex?.required === true &&
    !input.docdex.repoId &&
    !input.docdex.repoRoot
  ) {
    addIssue(
      errors,
      "error",
      "GATEWAY_DOCDEX_SCOPE_REQUIRED",
      "Docdex context is required but no repoId or repoRoot was supplied.",
    );
  }
  if (needsDocdex && immutableDocdexContext) {
    const missing: string[] = [];
    if (!input.docdex?.baseUrl) missing.push("baseUrl");
    if (!input.docdex?.repoId) missing.push("repoId");
    if (allowedOperations.size === 0) missing.push("allowedOperations");
    if (!input.docdex?.capabilities) missing.push("capabilities");
    if (
      input.docdex?.credentialSource === "attached_mswarm_api_key" &&
      (!input.docdex.apiKey || input.docdex.apiKey.trim().length === 0)
    ) {
      missing.push("apiKey");
    }
    if (missing.length > 0) {
      addIssue(
        errors,
        "error",
        "GATEWAY_DOCDEX_IMMUTABLE_CONTEXT_REQUIRED",
        "Encrypted Docdex gateway jobs require an immutable runtime context.",
        undefined,
        { missing },
      );
    }
  }

  for (const operation of [...requiredDocdexOperations].sort()) {
    const matchingTool =
      Object.entries(DOCDEX_OPERATION_BY_TOOL).find(
        ([, value]) => value === operation,
      )?.[0] ?? operation;
    if (!isOperationAllowed(matchingTool, operation, allowedOperations)) {
      addIssue(
        errors,
        "error",
        "GATEWAY_DOCDEX_OPERATION_BLOCKED",
        `Docdex operation ${operation} is not allowed by policy.`,
        matchingTool,
        { operation },
      );
    }
  }

  const gateway =
    input.policy.appToolGateway && isGatewayReadOnly(input.policy.appToolGateway)
      ? input.policy.appToolGateway
      : undefined;

  return {
    allowedTools,
    deniedTools,
    visibleTools: unique(visibleTools),
    appVirtualTools: unique(appVirtualTools),
    appToolContracts,
    appToolGateway: gateway,
    capabilities,
    skippedTools,
    warnings,
    errors,
    requiredDocdexOperations: [...requiredDocdexOperations].sort(),
  };
};
