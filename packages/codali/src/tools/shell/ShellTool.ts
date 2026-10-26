import path from "node:path";
import { ToolExecutionError, type ToolContext, type ToolDefinition } from "../ToolTypes.js";
import { runProcess } from "./AsyncProcess.js";

const resolveAllowlist = (context: ToolContext): string[] => {
  return context.shellAllowlist ?? [];
};

const DESTRUCTIVE_COMMANDS = new Set([
  "rm",
  "rmdir",
  "del",
  "erase",
  "unlink",
  "shred",
  "truncate",
  "mkfs",
  "dd",
  "format",
]);

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/,
  /\brmdir\b/,
  /\bdel(?:ete)?\b/,
  /\berase\b/,
  /\bremove-item\b/,
  /\btruncate\b/,
  /\bshred\b/,
  /\bmkfs\b/,
  /\bdd\b/,
  /\bformat\b/,
  /\bfs\.rm(?:sync)?\s*\(/,
  /\bunlink(?:sync)?\s*\(/,
];

const isDestructiveShellAction = (command: string, args: string[]): boolean => {
  const base = path.basename(command).toLowerCase();
  if (DESTRUCTIVE_COMMANDS.has(base)) {
    return true;
  }
  const joined = [command, ...args].join(" ").toLowerCase();
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(joined));
};

export const createShellTool = (): ToolDefinition => ({
  name: "run_shell",
  description: 'Run an allowlisted executable from the workspace root. command is a single executable; arguments go in args, e.g. {"command":"npm","args":["test"]}. In terminal mode the workspace is read-only unless writePaths explicitly names paths inside the claimed task. Existing source files in those paths require current reads and structural analysis.',
  readOnly: false,
  capability: "shell",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string", description: "One executable name, without arguments or shell syntax." },
      args: { type: "array", items: { type: "string" } },
      writePaths: { type: "array", items: { type: "string" }, description: "Terminal mode: narrow existing files/directories to make writable. Default: no workspace writes. Must fit the claimed task scope." },
    },
  },
  handler: async (args, context: ToolContext) => {
    if (!context.allowShell) {
      throw new ToolExecutionError("tool_permission_denied", "Shell tool is disabled", {
        retryable: false,
      });
    }
    const { command, args: commandArgs = [] } = args as { command: string; args?: string[] };
    if (
      !context.allowDestructiveOperations
      && isDestructiveShellAction(command, commandArgs)
    ) {
      throw new ToolExecutionError(
        "tool_permission_denied",
        "Destructive operation blocked by policy",
        {
          retryable: false,
          details: {
            command,
            args: commandArgs,
            reason_code: "destructive_operation_blocked",
            policy: "allowDestructiveOperations",
          },
        },
      );
    }
    const allowlist = resolveAllowlist(context);
    if (!allowlist.length || !allowlist.includes(command)) {
      throw new ToolExecutionError("tool_permission_denied", `Command not allowed: ${command}`, {
        retryable: false,
        details: { command },
      });
    }

    return (context.shellExecutor ?? runProcess)(command, commandArgs, context);
  },
});
