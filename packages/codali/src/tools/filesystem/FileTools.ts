import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ToolContext, ToolDefinition } from "../ToolTypes.js";
import { isWithinScope } from "../../session/WorkspaceScope.js";

// Resolve every replacement against the same original file before writing any
// bytes. Batched patches retain one fresh read/analysis boundary.
function applyExactEdits(current: string, edits: Array<{ search: string; content: string }>): string {
  const ranges = edits.map(edit => {
    if (!edit.search.length) throw new Error("Patch search must not be empty");
    const start = current.indexOf(edit.search);
    if (start < 0) throw new Error("Patch search not found; read the current file before retrying");
    if (current.indexOf(edit.search, start + 1) >= 0) throw new Error("Patch search is ambiguous; include more surrounding text");
    return { start, end: start + edit.search.length, content: edit.content };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) throw new Error("Patch searches overlap; combine them into one replacement");
  }
  for (const edit of ranges.reverse()) current = current.slice(0, edit.start) + edit.content + current.slice(edit.end);
  return current;
}

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

const assertPathScope = (
  context: ToolContext,
  resolvedPath: string,
  scopes: string[] | undefined,
  action: "read" | "write",
): void => {
  if (!scopes?.length) return;
  const relativePath = normalizeScope(toRelative(context, resolvedPath));
  const normalizedScopes = scopes.map(normalizeScope);
  if (!isWithinScope(relativePath, normalizedScopes)) {
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
      description: "Write a file with content, patch one unique search with content, or supply edits:[{search,content}] for multiple nonoverlapping replacements against the same original file. Combine same-file patches in one call after prepare_edit; all matches are validated before writing.",
      readOnly: false,
      capability: "workspace",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          draftId: { type: "string", maxLength: 64, description: "Write the specialist draft with this id as the whole file instead of sending content. Only for the targetPath the draft was requested for." },
          search: { type: "string", minLength: 1, description: "Exact unique old text to replace; omit only when writing the entire file." },
          edits: { type: "array", minItems: 1, maxItems: 20, items: { type: "object", required: ["search", "content"], additionalProperties: false,
            properties: { search: { type: "string", minLength: 1 }, content: { type: "string" } } } },
        },
      },
      handler: async (args, context) => {
        const { path: target, content, search, edits } = args as { path: string; content?: string; search?: string; edits?: Array<{ search: string; content: string }> };
        // A host that keeps specialist drafts replaces draftId with content before this point.
        if ((args as { draftId?: unknown }).draftId !== undefined) throw new Error("Unknown draftId; supply content, or request a specialist draft for this path first");
        if (edits !== undefined ? content !== undefined || search !== undefined || !Array.isArray(edits) || !edits.length || edits.length > 20
          || edits.some(edit => !edit || typeof edit.search !== "string" || !edit.search.length || typeof edit.content !== "string")
          : typeof content !== "string") throw new Error("Supply either content (and optional search), or edits; do not combine these forms");
        const resolved = await resolveWorkspacePath(context, target);
        assertPathScope(context, resolved, context.allowedWritePaths, "write");
        await context.checkPath?.(resolved, "write");
        let nextContent = content!;
        if (search !== undefined || edits !== undefined) {
          assertPathScope(context, resolved, context.allowedReadPaths, "read");
          await context.checkPath?.(resolved, "read");
          const current = await fs.readFile(resolved, "utf8");
          nextContent = applyExactEdits(current, edits ?? [{ search: search!, content: content! }]);
        }
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, nextContent, "utf8");
        if (context.recordTouchedFile) {
          context.recordTouchedFile(toRelative(context, resolved));
        }
        return { output: `${search === undefined && edits === undefined ? "Wrote" : "Patched"} ${toRelative(context, resolved)}`,
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
