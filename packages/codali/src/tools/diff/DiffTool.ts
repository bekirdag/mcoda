import { spawnSync } from "node:child_process";
import type { ToolContext, ToolDefinition } from "../ToolTypes.js";

const runGitStatus = (cwd: string): { ok: boolean; output: string; error?: string } => {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (result.error) {
    return { ok: false, output: "", error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, output: result.stdout ?? "", error: result.stderr ?? "git status failed" };
  }
  return { ok: true, output: result.stdout ?? "" };
};

export const createDiffTool = (): ToolDefinition => ({
  name: "diff_summary",
  description: "Show a git status summary of workspace changes.",
  inputSchema: {
    type: "object",
    properties: {
      maxLines: { type: "number" },
    },
  },
  handler: async (args, context: ToolContext) => {
    const { maxLines = 200 } = (args as { maxLines?: number }) ?? {};
    const result = runGitStatus(context.workspaceRoot);
    if (!result.ok) {
      throw new Error(result.error ?? "git status failed");
    }
    const lines = result.output.split("\n").filter(Boolean);
    const clipped = lines.slice(0, maxLines);
    return {
      output: clipped.join("\n"),
      data: { count: clipped.length, total: lines.length },
    };
  },
});
