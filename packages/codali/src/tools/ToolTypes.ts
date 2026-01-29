export interface ToolContext {
  workspaceRoot: string;
  runId?: string;
  recordTouchedFile?: (path: string) => void;
  allowOutsideWorkspace?: boolean;
  allowShell?: boolean;
  shellAllowlist?: string[];
}

export interface ToolHandlerResult {
  output: string;
  data?: unknown;
}

export interface ToolExecutionResult extends ToolHandlerResult {
  ok: boolean;
  error?: string;
}

export type ToolHandler = (args: unknown, context: ToolContext) => Promise<ToolHandlerResult>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  handler: ToolHandler;
}
