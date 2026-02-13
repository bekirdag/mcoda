import { spawnSync } from "node:child_process";
import type { ToolContext, ToolDefinition } from "../ToolTypes.js";

const runCommand = (cmd: string, args: string[], cwd: string): { ok: boolean; output: string; error?: string } => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.error) {
    return { ok: false, output: "", error: result.error.message };
  }
  if (result.status !== 0 && result.status !== 1) {
    return { ok: false, output: result.stdout ?? "", error: result.stderr ?? "" };
  }
  return { ok: true, output: result.stdout ?? "" };
};

const runRipgrep = (query: string, glob: string | undefined, cwd: string): { ok: boolean; output: string; error?: string } => {
  const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
  if (glob) {
    args.push("--glob", glob);
  }
  args.push(query, ".");
  return runCommand("rg", args, cwd);
};

const runGrepFallback = (query: string, cwd: string): { ok: boolean; output: string; error?: string } => {
  return runCommand("grep", ["-R", "-n", query, "."], cwd);
};

export const createSearchTool = (): ToolDefinition => ({
  name: "search_repo",
  description: "Search for text in the workspace using rg when available.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string" },
      glob: { type: "string" },
    },
  },
  handler: async (args, context: ToolContext) => {
    const { query, glob } = args as { query: string; glob?: string };
    let result = runRipgrep(query, glob, context.workspaceRoot);
    if (!result.ok) {
      const fallback = runGrepFallback(query, context.workspaceRoot);
      if (fallback.ok) {
        result = fallback;
      }
    }

    const lines = result.output.split("\n").filter(Boolean).slice(0, 200);
    return { output: lines.join("\n"), data: { count: lines.length } };
  },
});
