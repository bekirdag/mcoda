import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolContext, ToolDefinition } from "../ToolTypes.js";

const resolveWorkspacePath = (context: ToolContext, targetPath: string): string => {
  const resolved = path.resolve(context.workspaceRoot, targetPath);
  if (context.allowOutsideWorkspace) {
    return resolved;
  }
  const relative = path.relative(context.workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace root");
  }
  return resolved;
};

const toRelative = (context: ToolContext, targetPath: string): string => {
  return path.relative(context.workspaceRoot, targetPath) || ".";
};

const listFilesRecursive = async (
  basePath: string,
  maxDepth: number,
  currentDepth = 0,
  entries: string[] = [],
): Promise<string[]> => {
  if (currentDepth > maxDepth) return entries;
  const dirEntries = await fs.readdir(basePath, { withFileTypes: true });
  for (const entry of dirEntries) {
    const fullPath = path.join(basePath, entry.name);
    entries.push(fullPath);
    if (entry.isDirectory()) {
      await listFilesRecursive(fullPath, maxDepth, currentDepth + 1, entries);
    }
  }
  return entries;
};

export const createFileTools = (): ToolDefinition[] => {
  return [
    {
      name: "read_file",
      description: "Read a text file from the workspace.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      handler: async (args, context) => {
        const { path: target } = args as { path: string };
        const resolved = resolveWorkspacePath(context, target);
        const content = await fs.readFile(resolved, "utf8");
        return { output: content };
      },
    },
    {
      name: "write_file",
      description: "Write content to a file inside the workspace.",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
      },
      handler: async (args, context) => {
        const { path: target, content } = args as { path: string; content: string };
        const resolved = resolveWorkspacePath(context, target);
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, content, "utf8");
        if (context.recordTouchedFile) {
          context.recordTouchedFile(toRelative(context, resolved));
        }
        return { output: `Wrote ${toRelative(context, resolved)}` };
      },
    },
    {
      name: "list_files",
      description: "List files under a directory within the workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxDepth: { type: "number" },
        },
      },
      handler: async (args, context) => {
        const { path: target = ".", maxDepth = 2 } = (args as { path?: string; maxDepth?: number }) ?? {};
        const resolved = resolveWorkspacePath(context, target);
        const entries = await listFilesRecursive(resolved, maxDepth);
        const relativeEntries = entries.map((entry) => toRelative(context, entry));
        return { output: relativeEntries.join("\n"), data: { entries: relativeEntries } };
      },
    },
    {
      name: "stat_path",
      description: "Get stat info for a file or directory.",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      handler: async (args, context) => {
        const { path: target } = args as { path: string };
        const resolved = resolveWorkspacePath(context, target);
        const stats = await fs.stat(resolved);
        const info = {
          path: toRelative(context, resolved),
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          size: stats.size,
          mtimeMs: stats.mtimeMs,
        };
        return { output: JSON.stringify(info, null, 2), data: info };
      },
    },
  ];
};
