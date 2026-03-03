import { spawnSync } from "node:child_process";
import path from "node:path";
import { ToolExecutionError, type ToolContext, type ToolDefinition } from "../ToolTypes.js";

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
  description: "Run a shell command from the workspace root (allowlist only).",
  inputSchema: {
    type: "object",
    required: ["command"],
    properties: {
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
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

    const result = spawnSync(command, commandArgs, {
      cwd: context.workspaceRoot,
      encoding: "utf8",
    });

    if (result.error) {
      throw result.error;
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const exitCode = result.status ?? 0;
    if (exitCode !== 0) {
      const message = stderr || stdout || `Command failed with exit code ${exitCode}`;
      throw new ToolExecutionError("tool_execution_failed", message, {
        retryable: false,
        details: { command, exitCode },
      });
    }

    return {
      output: stdout || stderr,
      data: {
        stdout,
        stderr,
        exitCode,
      },
    };
  },
});
