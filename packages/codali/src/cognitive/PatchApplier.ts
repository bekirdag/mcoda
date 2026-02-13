import { promises as fs } from "node:fs";
import path from "node:path";
import type { PatchAction } from "./BuilderOutputParser.js";

export interface PatchApplyResult {
  touched: string[];
}

export interface PatchApplierOptions {
  workspaceRoot: string;
  validateFile?: (filePath: string) => Promise<void> | void;
}

export interface PatchRollbackEntry {
  file: string;
  resolved: string;
  existed: boolean;
  content?: string;
}

export interface PatchRollbackPlan {
  entries: PatchRollbackEntry[];
}

const resolvePath = (workspaceRoot: string, targetPath: string): string => {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside workspace root");
  }
  return resolved;
};

const buildWhitespaceCollapsed = (input: string): { compact: string; map: number[] } => {
  let compact = "";
  const map: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (/\s/.test(char)) {
      continue;
    }
    compact += char;
    map.push(index);
  }
  return { compact, map };
};

const replaceOnce = (content: string, search: string, replace: string): string => {
  const occurrences = content.split(search).length - 1;
  if (occurrences === 1) {
    return content.replace(search, replace);
  }
  if (occurrences > 1) {
    throw new Error("Ambiguous search block. Provide more context.");
  }

  const compactSearch = search.replace(/\s+/g, "");
  if (!compactSearch) {
    throw new Error("Search block not found in file.");
  }

  const collapsed = buildWhitespaceCollapsed(content);
  const firstIndex = collapsed.compact.indexOf(compactSearch);
  if (firstIndex < 0) {
    throw new Error("Search block not found in file.");
  }
  if (collapsed.compact.indexOf(compactSearch, firstIndex + 1) >= 0) {
    throw new Error("Ambiguous search block. Provide more context.");
  }

  const start = collapsed.map[firstIndex];
  const end = collapsed.map[firstIndex + compactSearch.length - 1] + 1;
  return `${content.slice(0, start)}${replace}${content.slice(end)}`;
};

export class PatchApplier {
  constructor(private options: PatchApplierOptions) {}

  async createRollback(patches: PatchAction[]): Promise<PatchRollbackPlan> {
    const entries: PatchRollbackEntry[] = [];
    for (const patch of patches) {
      const resolved = resolvePath(this.options.workspaceRoot, patch.file);
      try {
        const content = await fs.readFile(resolved, "utf8");
        entries.push({ file: patch.file, resolved, existed: true, content });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("no such file") || message.includes("ENOENT")) {
          entries.push({ file: patch.file, resolved, existed: false });
        } else {
          throw error;
        }
      }
    }
    return { entries };
  }

  async rollback(plan: PatchRollbackPlan): Promise<void> {
    for (const entry of plan.entries) {
      if (entry.existed) {
        await fs.mkdir(path.dirname(entry.resolved), { recursive: true });
        await fs.writeFile(entry.resolved, entry.content ?? "", "utf8");
      } else {
        await fs.rm(entry.resolved, { force: true });
      }
    }
  }

  async apply(patches: PatchAction[]): Promise<PatchApplyResult> {
    const touched: string[] = [];
    for (const patch of patches) {
      const resolved = resolvePath(this.options.workspaceRoot, patch.file);
      if (patch.action === "create") {
        await fs.mkdir(path.dirname(resolved), { recursive: true });
        await fs.writeFile(resolved, patch.content, "utf8");
        touched.push(patch.file);
        if (this.options.validateFile) await this.options.validateFile(resolved);
        continue;
      }
      if (patch.action === "delete") {
        await fs.rm(resolved, { force: true });
        touched.push(patch.file);
        continue;
      }
      const content = await fs.readFile(resolved, "utf8");
      const updated = replaceOnce(content, patch.search_block, patch.replace_block);
      await fs.writeFile(resolved, updated, "utf8");
      touched.push(patch.file);
      if (this.options.validateFile) await this.options.validateFile(resolved);
    }
    return { touched };
  }
}
