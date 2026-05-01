import { promises as fs } from "node:fs";
import path from "node:path";

export interface InstructionBlock {
  sourcePath: string;
  scope: string;
  precedence: number;
  content: string;
}

export interface InstructionLoadOptions {
  workspaceRoot: string;
  focusPaths?: string[];
  includeLocal?: boolean;
}

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
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
): Promise<InstructionBlock | undefined> => {
  if (!(await fileExists(filePath))) return undefined;
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) return undefined;
  const relative = toRepoRelativePath(workspaceRoot, filePath);
  const sourceDir = path.posix.dirname(relative);
  const scope = sourceDir === "." ? "." : sourceDir;
  return {
    sourcePath: relative,
    scope,
    precedence,
    content,
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

  const addFile = async (filePath: string): Promise<void> => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const block = await readBlock(workspaceRoot, resolved, precedence);
    precedence += 1;
    if (block) blocks.push(block);
  };

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

export const formatInstructionBlocks = (blocks: InstructionBlock[]): string => {
  if (!blocks.length) return "";
  return blocks
    .map((block) =>
      [
        `Instruction source: ${block.sourcePath}`,
        `Scope: ${block.scope}`,
        block.content.trim(),
      ].join("\n"),
    )
    .join("\n\n---\n\n");
};
