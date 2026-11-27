import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstructionBlock {
  sourcePath: string;
  scope: string;
  precedence: number;
  content: string;
  sha256?: string;
}

export interface InstructionLoadOptions {
  workspaceRoot: string;
  focusPaths?: string[];
  includeLocal?: boolean;
  includeSystem?: boolean;
  /** Host-selected user file; false isolates automated tests from user preferences. */
  userInstructionsPath?: string | false;
}

const readInstruction = async (filePath: string, allowedRoot: string): Promise<string | undefined> => {
  try {
    const resolved = await fs.realpath(filePath);
    const root = await fs.realpath(allowedRoot);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Instruction file escapes its allowed directory: ${filePath}`);
    }
    const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`Instruction source is not a regular file: ${filePath}`);
      if (stat.size > 65536) throw new Error(`Instruction file exceeds 64 KiB; shorten it or link supporting documents: ${filePath}`);
      const buffer = Buffer.alloc(65537);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > 65536) throw new Error(`Instruction file exceeds 64 KiB: ${filePath}`);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const normalizeFocusPath = (workspaceRoot: string, value: string): string => {
  const resolved = path.resolve(workspaceRoot, value);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Instruction focus path is outside workspace root");
  }
  return resolved;
};

const focusDirForPath = async (workspaceRoot: string, value: string): Promise<string> => {
  const resolved = normalizeFocusPath(workspaceRoot, value);
  try {
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : path.dirname(resolved);
  } catch {
    return path.extname(resolved) ? path.dirname(resolved) : resolved;
  }
};

const ancestorDirs = (workspaceRoot: string, targetDir: string): string[] => {
  const dirs: string[] = [];
  let current = path.resolve(targetDir);
  const root = path.resolve(workspaceRoot);
  while (true) {
    const relative = path.relative(root, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) break;
    dirs.push(current);
    if (current === root) break;
    current = path.dirname(current);
  }
  return dirs.reverse();
};

const toRepoRelativePath = (workspaceRoot: string, filePath: string): string => {
  const relative = path.relative(workspaceRoot, filePath) || path.basename(filePath);
  return relative.split(path.sep).join("/");
};

const readBlock = async (
  workspaceRoot: string,
  filePath: string,
  precedence: number,
  sourceName?: string,
  allowedRoot = workspaceRoot,
): Promise<InstructionBlock | undefined> => {
  const content = await readInstruction(filePath, allowedRoot);
  if (!content?.trim()) return undefined;
  const relative = sourceName ?? toRepoRelativePath(workspaceRoot, filePath);
  const sourceDir = path.posix.dirname(relative);
  const scope = sourceDir === "." || [".codali/instructions.md", ".codali/local.md"].includes(relative) ? "." : sourceDir;
  return {
    sourcePath: relative,
    scope: sourceName ? "all turns in this workspace" : scope,
    precedence,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
};

export const loadInstructionBlocks = async (
  options: InstructionLoadOptions,
): Promise<InstructionBlock[]> => {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const includeLocal = options.includeLocal ?? true;
  const focusPaths = options.focusPaths?.length ? options.focusPaths : ["."];
  const blocks: InstructionBlock[] = [];
  const seen = new Set<string>();
  let precedence = 0;

  const addFile = async (filePath: string, sourceName?: string, allowedRoot?: string): Promise<void> => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const block = await readBlock(workspaceRoot, resolved, precedence, sourceName, allowedRoot);
    precedence += 1;
    if (block) {
      if (blocks.length >= 64) throw new Error("Too many instruction sources; narrow the focused paths");
      blocks.push(block);
    }
  };

  if (options.includeSystem) {
    const builtin = fileURLToPath(new URL("../../config/AGENTS.md", import.meta.url));
    await addFile(builtin, "[codali]/AGENTS.md", path.dirname(builtin));
    if (!blocks.some(block => block.sourcePath === "[codali]/AGENTS.md")) throw new Error("Packaged Codali AGENTS.md is missing; reinstall the complete package");
    if (options.userInstructionsPath !== false) {
      const user = options.userInstructionsPath ?? path.join(os.homedir(), ".codali", "AGENTS.md");
      await addFile(user, "[user]/AGENTS.md", path.dirname(user));
    }
  }
  await addFile(path.join(workspaceRoot, ".codali", "instructions.md"));

  const dirs = new Set<string>();
  for (const focusPath of focusPaths) {
    const focusDir = await focusDirForPath(workspaceRoot, focusPath);
    for (const dir of ancestorDirs(workspaceRoot, focusDir)) dirs.add(dir);
  }
  for (const dir of Array.from(dirs).sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    await addFile(path.join(dir, "AGENTS.md"));
  }

  if (includeLocal) {
    await addFile(path.join(workspaceRoot, ".codali", "local.md"));
  }

  return blocks.sort((a, b) => a.precedence - b.precedence);
};

export const formatInstructionBlocks = (blocks: InstructionBlock[], maxChars = 24000): string => {
  if (!blocks.length) return "";
  const formatted = blocks
    .map((block) =>
      [
        `Instruction source: ${block.sourcePath}`,
        `Scope: ${block.scope}`,
        block.content.trim(),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
  if (formatted.length > maxChars) throw new Error(`Instruction bundle exceeds ${maxChars} characters; shorten AGENTS.md files or link supporting documents`);
  return formatted;
};
