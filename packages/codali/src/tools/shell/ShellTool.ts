import { spawnSync } from "node:child_process";
import type { ToolContext, ToolDefinition } from "../ToolTypes.js";

const resolveAllowlist = (context: ToolContext): string[] => {
  return context.shellAllowlist ?? [];
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
      throw new Error("Shell tool is disabled");
    }
    const { command, args: commandArgs = [] } = args as { command: string; args?: string[] };
    const allowlist = resolveAllowlist(context);
    if (!allowlist.length || !allowlist.includes(command)) {
      throw new Error(`Command not allowed: ${command}`);
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
      throw new Error(message);
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
