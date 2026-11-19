import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { ToolExecutionError } from "../ToolTypes.js";

/** Resolve only the process directory; write scopes still use workspaceRoot. */
export const resolveShellWorkingDirectory = (workspaceRoot: string, requested?: string): string => {
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim())) {
    throw new ToolExecutionError("tool_invalid_args", "cwd must be a non-empty directory path inside the workspace");
  }
  const root = realpathSync.native(workspaceRoot);
  const inside = (candidate: string): boolean => {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  const candidate = path.resolve(root, requested ?? ".");
  if (!inside(candidate)) throw new ToolExecutionError("tool_permission_denied", "Shell cwd escapes the workspace");
  try {
    const resolved = realpathSync.native(candidate);
    if (!inside(resolved)) throw new ToolExecutionError("tool_permission_denied", "Shell cwd resolves outside the workspace");
    if (!statSync(resolved).isDirectory()) throw new ToolExecutionError("tool_invalid_args", "Shell cwd must be an existing directory");
    return resolved;
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throw new ToolExecutionError("tool_invalid_args", "Shell cwd is not an accessible existing directory");
  }
};
