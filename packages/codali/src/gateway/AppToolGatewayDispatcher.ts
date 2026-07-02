import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  CodaliRuntimeAppToolContract,
  CodaliRuntimeAppToolGatewayContract,
} from "../runtime/CodaliRuntime.js";
import { CODALI_GATEWAY_RESERVED_TOOL_ARG_KEYS } from "./ToolCapabilityCompiler.js";

export const CODALI_APP_TOOL_GATEWAY_VERSION = "codali.app_tool_gateway.v1";

export type AppToolGatewayDispatchErrorCode =
  | "GATEWAY_TOOL_NOT_ALLOWED"
  | "GATEWAY_TOOL_DENIED"
  | "GATEWAY_CONTRACT_NOT_READ_ONLY"
  | "GATEWAY_ENDPOINT_REQUIRED"
  | "GATEWAY_SIGNATURE_REQUIRED"
  | "GATEWAY_INVALID_ARGS"
  | "GATEWAY_SCOPE_OVERRIDE_BLOCKED"
  | "GATEWAY_HTTP_FAILED"
  | "GATEWAY_RESPONSE_MALFORMED";

export class AppToolGatewayDispatchError extends Error {
  readonly code: AppToolGatewayDispatchErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AppToolGatewayDispatchErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AppToolGatewayDispatchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export interface CodaliAppToolGatewayScope extends Record<string, unknown> {
  tenant_id?: string;
  tenant_slug?: string;
  docdex_repo_id?: string;
}

export interface CodaliAppToolGatewayRequesterScope extends Record<string, unknown> {
  request_id?: string;
  owner_user_id?: string;
  api_key_id?: string;
  agent_slug?: string;
}

export interface CodaliAppToolGatewayUnsignedRequest {
  version: typeof CODALI_APP_TOOL_GATEWAY_VERSION;
  run_id: string;
  session_id?: string;
  request_id?: string;
  tenant_scope?: CodaliAppToolGatewayScope;
  requester_scope?: CodaliAppToolGatewayRequesterScope;
  tool_name: string;
  validated_args: unknown;
  timestamp: string;
  nonce: string;
  read_only: true;
  call_schema?: Record<string, unknown>;
  result_contract?: string;
  result_sources?: string[];
  source_paths?: string[];
  source_types?: string[];
}

export interface CodaliAppToolGatewaySignedRequest extends CodaliAppToolGatewayUnsignedRequest {
  signature: string;
}

export interface AppToolGatewayDispatchInput {
  runId: string;
  sessionId?: string;
  requestId?: string;
  tenantScope?: CodaliAppToolGatewayScope;
  requesterScope?: CodaliAppToolGatewayRequesterScope;
  toolName: string;
  args: unknown;
  contract: CodaliRuntimeAppToolContract;
  gateway: CodaliRuntimeAppToolGatewayContract;
  allowedTools?: string[];
  deniedTools?: string[];
  now?: () => Date;
  nonce?: () => string;
  fetchImpl?: typeof fetch;
}

export interface AppToolGatewayDispatchResult {
  request: CodaliAppToolGatewaySignedRequest;
  redactedRequest: unknown;
  responseStatus: number;
  responseText: string;
  responsePayload: unknown;
  evidencePayload: Record<string, unknown>;
  redactedResponse: unknown;
}

const EXTRA_RESERVED_ARG_KEYS = [
  "authorization",
  "credential",
  "credentials",
  "workspaceRoot",
  "workspace_root",
] as const;

const RESERVED_ARG_KEY_SET = new Set(
  [...CODALI_GATEWAY_RESERVED_TOOL_ARG_KEYS, ...EXTRA_RESERVED_ARG_KEYS].map((key) =>
    key.toLowerCase(),
  ),
);

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|api[_-]?key|bearer|credential|password|secret|signature|token)/i;
const SENSITIVE_STRING_PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]"],
  [
    /((?:api[_-]?key|token|signature|secret|password)=)[^&\s]+/gi,
    "$1[redacted]",
  ],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const hasOwn = (record: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const readString = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined => {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const readBoolean = (
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): boolean | undefined => {
  if (!record) return undefined;
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
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    }
  }
  return [];
};

const normalizeRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const compactObject = <T extends Record<string, unknown>>(value: T): T => {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
};

const canonicalValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) {
      output[key] = canonicalValue(entry);
    }
  }
  return output;
};

export const canonicalizeAppToolGatewayPayload = (value: unknown): string =>
  JSON.stringify(canonicalValue(value));

export const signAppToolGatewayRequest = (
  request: CodaliAppToolGatewayUnsignedRequest,
  secret: string,
): string =>
  `sha256=${createHmac("sha256", secret)
    .update(canonicalizeAppToolGatewayPayload(request))
    .digest("hex")}`;

export const verifyAppToolGatewayRequestSignature = (
  request: CodaliAppToolGatewaySignedRequest,
  secret: string,
): boolean => {
  const { signature, ...unsigned } = request;
  const expected = signAppToolGatewayRequest(unsigned, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    signatureBuffer.length === expectedBuffer.length &&
    timingSafeEqual(signatureBuffer, expectedBuffer)
  );
};

const redactSensitiveString = (value: string): string =>
  SENSITIVE_STRING_PATTERNS.reduce(
    (output, [pattern, replacement]) => output.replace(pattern, replacement),
    value,
  );

export const redactAppToolGatewayPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactAppToolGatewayPayload);
  }
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (!isRecord(value)) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[redacted]"
      : redactAppToolGatewayPayload(entry);
  }
  return output;
};

const findReservedArgKeys = (
  value: unknown,
  path = "$",
  matches: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findReservedArgKeys(entry, `${path}[${index}]`, matches));
    return matches;
  }
  if (!isRecord(value)) {
    return matches;
  }
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (RESERVED_ARG_KEY_SET.has(key.toLowerCase())) {
      matches.push(childPath);
    }
    findReservedArgKeys(entry, childPath, matches);
  }
  return matches;
};

const schemaTypeMatches = (value: unknown, type: unknown): boolean => {
  const types = Array.isArray(type) ? type : [type];
  if (types.length === 0 || types.includes(undefined)) {
    return true;
  }
  return types.some((entry) => {
    if (entry === "array") return Array.isArray(value);
    if (entry === "integer") return Number.isInteger(value);
    if (entry === "null") return value === null;
    if (entry === "object") return isRecord(value);
    return typeof entry === "string" && typeof value === entry;
  });
};

const validateArgsAgainstCallSchema = (
  toolName: string,
  args: unknown,
  schema: Record<string, unknown> | undefined,
): unknown => {
  const reserved = findReservedArgKeys(args);
  if (reserved.length > 0) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_SCOPE_OVERRIDE_BLOCKED",
      "App tool gateway arguments cannot override tenant, repo, base URL, or credential scope.",
      { details: { tool: toolName, forbidden: reserved } },
    );
  }
  if (!schema) {
    return args;
  }
  if ((schema.type === undefined || schema.type === "object") && !isRecord(args)) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_INVALID_ARGS",
      "App tool gateway arguments must match the contract call schema.",
      { details: { tool: toolName, reason: "object_required" } },
    );
  }
  const record = normalizeRecord(args);
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  const missing = required.filter((key) => record[key] === undefined);
  if (missing.length > 0) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_INVALID_ARGS",
      "App tool gateway arguments are missing required contract fields.",
      { details: { tool: toolName, missing } },
    );
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  if (schema.additionalProperties === false) {
    const unexpected = Object.keys(record).filter((key) => !hasOwn(properties, key));
    if (unexpected.length > 0) {
      throw new AppToolGatewayDispatchError(
        "GATEWAY_INVALID_ARGS",
        "App tool gateway arguments include fields outside the contract schema.",
        { details: { tool: toolName, unexpected } },
      );
    }
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!isRecord(propertySchema) || record[key] === undefined) {
      continue;
    }
    if (!schemaTypeMatches(record[key], propertySchema.type)) {
      throw new AppToolGatewayDispatchError(
        "GATEWAY_INVALID_ARGS",
        "App tool gateway argument field type does not match the contract schema.",
        { details: { tool: toolName, field: key, expected: propertySchema.type } },
      );
    }
  }
  return args;
};

const gatewayEndpoint = (gateway: CodaliRuntimeAppToolGatewayContract): string | undefined =>
  readString(gateway, ["endpoint"]);

const gatewaySigningSecret = (
  gateway: CodaliRuntimeAppToolGatewayContract,
): string | undefined =>
  readString(gateway, [
    "signatureSecret",
    "signature_secret",
    "signingSecret",
    "signing_secret",
    "secret",
    "signature",
  ]);

const assertReadOnlyContract = (
  contract: CodaliRuntimeAppToolContract,
  gateway: CodaliRuntimeAppToolGatewayContract,
  toolName: string,
): void => {
  const contractReadOnly = readBoolean(contract, ["readOnly", "read_only"]);
  const gatewayReadOnly = readBoolean(gateway, ["readOnly", "read_only"]);
  if (contractReadOnly !== true || gatewayReadOnly !== true) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_CONTRACT_NOT_READ_ONLY",
      "Direct app tool gateway dispatch requires explicit read-only contract and gateway flags.",
      {
        details: {
          tool: toolName,
          contractReadOnly,
          gatewayReadOnly,
        },
      },
    );
  }
};

const resultContractFor = (contract: CodaliRuntimeAppToolContract): string | undefined =>
  readString(contract, ["resultContract", "result_contract"]);

const callSchemaFor = (
  contract: CodaliRuntimeAppToolContract,
): Record<string, unknown> | undefined => {
  const schema = contract.callSchema ?? contract.call_schema;
  return isRecord(schema) ? schema : undefined;
};

const parseResponsePayload = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_RESPONSE_MALFORMED",
      "App tool gateway returned malformed JSON.",
      {
        retryable: false,
        details: { response: redactAppToolGatewayPayload({ body: text.slice(0, 1_000) }) as Record<string, unknown> },
      },
    );
  }
};

const buildEvidencePayload = (input: {
  toolName: string;
  contract: CodaliRuntimeAppToolContract;
  request: CodaliAppToolGatewaySignedRequest;
  responseStatus: number;
  responsePayload: unknown;
  responseText: string;
}): Record<string, unknown> => {
  const responseRecord = isRecord(input.responsePayload) ? input.responsePayload : undefined;
  const payload: Record<string, unknown> = {
    sourceType: "app_tool",
    tenantScoped: true,
    tool: input.toolName,
    usedTool: input.toolName,
    resultContract: resultContractFor(input.contract),
    result_contract: resultContractFor(input.contract),
    result: input.responsePayload,
    rawExcerpt: typeof input.responsePayload === "string" ? input.responsePayload : undefined,
    metadata: {
      app_tool_gateway: {
        version: input.request.version,
        run_id: input.request.run_id,
        session_id: input.request.session_id,
        request_id: input.request.request_id,
        timestamp: input.request.timestamp,
        nonce: input.request.nonce,
        response_status: input.responseStatus,
      },
    },
  };

  if (responseRecord) {
    for (const key of [
      "evidence",
      "evidenceItems",
      "evidence_items",
      "facts",
      "sources",
      "sourceRecords",
      "source_records",
      "citations",
      "results",
      "hits",
      "items",
      "records",
    ]) {
      if (Array.isArray(responseRecord[key])) {
        payload[key] = responseRecord[key];
      }
    }
  } else if (typeof input.responsePayload === "string" && input.responsePayload.trim()) {
    payload.facts = [input.responsePayload.trim()];
  } else if (input.responseText.trim()) {
    payload.facts = [input.responseText.trim()];
  }

  return compactObject(payload);
};

export const buildAppToolGatewaySignedRequest = (input: {
  runId: string;
  sessionId?: string;
  requestId?: string;
  tenantScope?: CodaliAppToolGatewayScope;
  requesterScope?: CodaliAppToolGatewayRequesterScope;
  toolName: string;
  args: unknown;
  contract: CodaliRuntimeAppToolContract;
  timestamp: string;
  nonce: string;
  secret: string;
}): CodaliAppToolGatewaySignedRequest => {
  const unsigned: CodaliAppToolGatewayUnsignedRequest = compactObject({
    version: CODALI_APP_TOOL_GATEWAY_VERSION as typeof CODALI_APP_TOOL_GATEWAY_VERSION,
    run_id: input.runId,
    session_id: input.sessionId,
    request_id: input.requestId,
    tenant_scope: input.tenantScope,
    requester_scope: input.requesterScope,
    tool_name: input.toolName,
    validated_args: input.args,
    timestamp: input.timestamp,
    nonce: input.nonce,
    read_only: true as const,
    call_schema: callSchemaFor(input.contract),
    result_contract: resultContractFor(input.contract),
    result_sources: readStringArray(input.contract, ["resultSources", "result_sources"]),
    source_paths: readStringArray(input.contract, ["sourcePaths", "source_paths"]),
    source_types: readStringArray(input.contract, ["sourceTypes", "source_types"]),
  });
  return {
    ...unsigned,
    signature: signAppToolGatewayRequest(unsigned, input.secret),
  };
};

export const dispatchAppToolGateway = async (
  input: AppToolGatewayDispatchInput,
): Promise<AppToolGatewayDispatchResult> => {
  const allowedTools = new Set(input.allowedTools ?? []);
  const deniedTools = new Set(input.deniedTools ?? []);
  if (allowedTools.size > 0 && !allowedTools.has(input.toolName)) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_TOOL_NOT_ALLOWED",
      "App tool gateway tool is not in the allowed tool set.",
      { details: { tool: input.toolName } },
    );
  }
  if (deniedTools.has(input.toolName)) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_TOOL_DENIED",
      "App tool gateway tool is blocked by denied tools policy.",
      { details: { tool: input.toolName } },
    );
  }

  assertReadOnlyContract(input.contract, input.gateway, input.toolName);

  const endpoint = gatewayEndpoint(input.gateway);
  if (!endpoint) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_ENDPOINT_REQUIRED",
      "App tool gateway endpoint is not configured.",
      { details: { tool: input.toolName } },
    );
  }
  const secret = gatewaySigningSecret(input.gateway);
  if (!secret) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_SIGNATURE_REQUIRED",
      "App tool gateway signing material is required.",
      { details: { tool: input.toolName } },
    );
  }

  const validatedArgs = validateArgsAgainstCallSchema(
    input.toolName,
    input.args,
    callSchemaFor(input.contract),
  );
  const request = buildAppToolGatewaySignedRequest({
    runId: input.runId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    tenantScope: input.tenantScope,
    requesterScope: input.requesterScope,
    toolName: input.toolName,
    args: validatedArgs,
    contract: input.contract,
    timestamp: (input.now ?? (() => new Date()))().toISOString(),
    nonce: (input.nonce ?? randomUUID)(),
    secret,
  });
  const body = JSON.stringify(request);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codali-app-tool-version": CODALI_APP_TOOL_GATEWAY_VERSION,
      "x-codali-app-tool-signature": request.signature,
      "x-codali-app-tool-timestamp": request.timestamp,
      "x-codali-app-tool-nonce": request.nonce,
    },
    body,
  });
  const responseText = await response.text();
  if (!response.ok) {
    throw new AppToolGatewayDispatchError(
      "GATEWAY_HTTP_FAILED",
      `App tool gateway failed with HTTP ${response.status}.`,
      {
        retryable: response.status >= 500,
        details: {
          tool: input.toolName,
          status: response.status,
          request: redactAppToolGatewayPayload(request),
          response: redactAppToolGatewayPayload({ body: responseText.slice(0, 1_000) }),
        },
      },
    );
  }
  const responsePayload = parseResponsePayload(responseText);
  const evidencePayload = buildEvidencePayload({
    toolName: input.toolName,
    contract: input.contract,
    request,
    responseStatus: response.status,
    responsePayload,
    responseText,
  });
  return {
    request,
    redactedRequest: redactAppToolGatewayPayload(request),
    responseStatus: response.status,
    responseText,
    responsePayload,
    evidencePayload,
    redactedResponse: redactAppToolGatewayPayload(responsePayload),
  };
};
