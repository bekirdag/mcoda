export interface ToolContext {
  workspaceRoot: string;
  runId?: string;
  recordTouchedFile?: (path: string) => void;
  allowOutsideWorkspace?: boolean;
  allowedReadPaths?: string[];
  allowedWritePaths?: string[];
  allowShell?: boolean;
  allowDestructiveOperations?: boolean;
  shellAllowlist?: string[];
}

export type ToolSchemaPrimitiveType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface ToolSchemaDefinition extends Record<string, unknown> {
  type?: ToolSchemaPrimitiveType | ToolSchemaPrimitiveType[];
  properties?: Record<string, ToolSchemaDefinition>;
  required?: string[];
  items?: ToolSchemaDefinition;
  additionalProperties?: boolean;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ToolInputSchema extends ToolSchemaDefinition {
  type: "object";
  properties?: Record<string, ToolSchemaDefinition>;
  required?: string[];
}

export type ToolErrorCode =
  | "tool_unknown"
  | "tool_schema_invalid"
  | "tool_invalid_args"
  | "tool_permission_denied"
  | "tool_timeout"
  | "tool_execution_failed"
  | "missing_credentials"
  | "repo_access_denied"
  | "scope_denied"
  | "encrypted_operation_disabled"
  | "docdex_context_missing"
  | "docdex_api_key_missing"
  | "docdex_operation_not_allowed"
  | "docdex_auth_failed"
  | "docdex_repo_access_denied"
  | "docdex_unavailable";

export type ToolErrorCategory =
  | "lookup"
  | "schema"
  | "validation"
  | "permission"
  | "timeout"
  | "execution";

export interface ToolError {
  code: ToolErrorCode;
  category: ToolErrorCategory;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class ToolExecutionError extends Error {
  readonly code: ToolErrorCode;
  readonly category: ToolErrorCategory;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ToolErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "ToolExecutionError";
    this.code = code;
    this.category = toolErrorCategoryForCode(code);
    this.retryable = options.retryable ?? code === "tool_timeout";
    this.details = options.details;
  }

  toToolError(): ToolError {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      retryable: this.retryable,
      details: this.details,
    };
  }
}

export const toolErrorCategoryForCode = (code: ToolErrorCode): ToolErrorCategory => {
  if (code === "tool_unknown") return "lookup";
  if (code === "tool_schema_invalid") return "schema";
  if (code === "tool_invalid_args") return "validation";
  if (code === "tool_permission_denied") return "permission";
  if (code === "tool_timeout") return "timeout";
  if (code === "docdex_context_missing") return "validation";
  if (
    code === "missing_credentials" ||
    code === "repo_access_denied" ||
    code === "scope_denied" ||
    code === "encrypted_operation_disabled" ||
    code === "docdex_api_key_missing" ||
    code === "docdex_operation_not_allowed" ||
    code === "docdex_auth_failed" ||
    code === "docdex_repo_access_denied"
  ) {
    return "permission";
  }
  return "execution";
};

export interface ToolHandlerResult {
  output: string;
  data?: unknown;
}

export interface ToolExecutionResult extends ToolHandlerResult {
  ok: boolean;
  error?: ToolError;
}

export type ToolHandler = (args: unknown, context: ToolContext) => Promise<ToolHandlerResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: ToolInputSchema;
  handler: ToolHandler;
}
