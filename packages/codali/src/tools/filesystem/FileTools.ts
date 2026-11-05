import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ToolContext, ToolDefinition } from "../ToolTypes.js";

const resolveWorkspacePath = async (context: ToolContext, targetPath: string): Promise<string> => {
  const resolved = path.resolve(context.workspaceRoot, targetPath);
  if (context.allowOutsideWorkspace) {
    return resolved;
  }
  const relative = path.relative(context.workspaceRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path is outside the workspace root");
  }
  const root = await fs.realpath(context.workspaceRoot);
  let existing = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(existing);
      const actual = path.join(real, ...suffix.reverse());
      const rel = path.relative(root, actual);
      if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Symlink path is outside the workspace root");
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === path.dirname(existing)) throw error;
      suffix.push(path.basename(existing)); existing = path.dirname(existing);
    }
  }
};

const toRelative = (context: ToolContext, targetPath: string): string => {
  return path.relative(realpathSync.native(context.workspaceRoot), targetPath) || ".";
};

const normalizeScope = (value: string): string => {
  const normalized = path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === ".") return ".";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Path scope is outside the workspace root");
  }
  return normalized;
};

const isWithinScope = (relativePath: string, scope: string): boolean => {
  if (scope === ".") return true;
  return relativePath === scope || relativePath.startsWith(`${scope}/`);
};

const assertPathScope = (
  context: ToolContext,
  resolvedPath: string,
  scopes: string[] | undefined,
  action: "read" | "write",
): void => {
  if (!scopes?.length) return;
  const relativePath = normalizeScope(toRelative(context, resolvedPath));
  const normalizedScopes = scopes.map(normalizeScope);
  if (!normalizedScopes.some((scope) => isWithinScope(relativePath, scope))) {
    throw new Error(`Path is outside allowed ${action} scopes`);
  }
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
      name: "create_directory", description: "Create a workspace directory and missing parents before using it as a shell writePaths mount. Existing directories are unchanged; files are never replaced.",
      readOnly: false, capability: "workspace",
      inputSchema: { type: "object", required: ["path"], additionalProperties: false,
        properties: { path: { type: "string", minLength: 1, maxLength: 4096 } } },
      handler: async (args, context) => {
        context.signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath(context, (args as { path: string }).path);
        assertPathScope(context, resolved, context.allowedWritePaths, "write");
        await context.checkPath?.(resolved, "write");
        await fs.mkdir(resolved, { recursive: true });
        return { output: `Created directory ${toRelative(context, resolved)}` };
      },
    },
    {
      name: "read_file",
      description: "Read a text file from the workspace.",
      readOnly: true,
      capability: "workspace",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      handler: async (args, context) => {
        const { path: target } = args as { path: string };
        const resolved = await resolveWorkspacePath(context, target);
        assertPathScope(context, resolved, context.allowedReadPaths, "read");
        await context.checkPath?.(resolved, "read");
        const content = await fs.readFile(resolved, "utf8");
        return { output: content, data: { path: toRelative(context, resolved) } };
      },
    },
    {
      name: "write_file",
      description: "Write a small file, or patch an existing file by supplying search: one exact, nonempty, unique old-text match to replace with content. Use small patches to build larger files incrementally; omitted search replaces the whole file.",
      readOnly: false,
      capability: "workspace",
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          search: { type: "string", minLength: 1, description: "Exact unique old text to replace; omit only when writing the entire file." },
        },
      },
      handler: async (args, context) => {
        const { path: target, content, search } = args as { path: string; content: string; search?: string };
        const resolved = await resolveWorkspacePath(context, target);
        assertPathScope(context, resolved, context.allowedWritePaths, "write");
        await context.checkPath?.(resolved, "write");
        let nextContent = content;
        if (search !== undefined) {
          if (!search.length) throw new Error("Patch search must not be empty");
          assertPathScope(context, resolved, context.allowedReadPaths, "read");
          await context.checkPath?.(resolved, "read");
          const current = await fs.readFile(resolved, "utf8");
          const index = current.indexOf(search);
          if (index < 0) throw new Error("Patch search not found; read the current file before retrying");
          if (current.indexOf(search, index + 1) >= 0) throw new Error("Patch search is ambiguous; include more surrounding text");
          // Slice rather than String.replace: replacement $ tokens are literal code.
          nextContent = current.slice(0, index) + content + current.slice(index + search.length);
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, nextContent, "utf8");
        if (context.recordTouchedFile) {
          context.recordTouchedFile(toRelative(context, resolved));
        }
        return { output: `${search === undefined ? "Wrote" : "Patched"} ${toRelative(context, resolved)}`,
          data: { path: toRelative(context, resolved), contentHash: createHash("sha256").update(nextContent, "utf8").digest("hex") } };
      },
    },
    {
      name: "list_files",
      description: "List files under a directory within the workspace.",
      readOnly: true,
      capability: "workspace",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          maxDepth: { type: "number" },
        },
      },
      handler: async (args, context) => {
        const { path: target = ".", maxDepth = 2 } = (args as { path?: string; maxDepth?: number }) ?? {};
        const resolved = await resolveWorkspacePath(context, target);
        assertPathScope(context, resolved, context.allowedReadPaths, "read");
        const entries = await listFilesRecursive(resolved, maxDepth);
        const relativeEntries = entries.map((entry) => toRelative(context, entry));
        return { output: relativeEntries.join("\n"), data: { entries: relativeEntries } };
      },
    },
    {
      name: "stat_path",
      description: "Get stat info for a file or directory.",
      readOnly: true,
      capability: "workspace",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
        },
      },
      handler: async (args, context) => {
        const { path: target } = args as { path: string };
        const resolved = await resolveWorkspacePath(context, target);
        assertPathScope(context, resolved, context.allowedReadPaths, "read");
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
