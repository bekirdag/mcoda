import path from "node:path";
import { promises as fs } from "node:fs";
import { hashWorkspacePath } from "./WorkspaceSnapshot.js";

export interface StructuralAnalysis {
  kind: "structure" | "impact";
  file: string;
  hash: string;
  valid: boolean;
}

export const isSourcePath = (file: string): boolean => /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|c|cc|cpp|cxx|h|hpp|cs|rb|php|swift|sh|bash|lua|ex|exs|scala|sc|vue|svelte)$/i.test(file);

export const workspaceRelativePath = (root: string, file: string): string => {
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join("/");
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Path escapes the workspace");
  return relative || ".";
};

export const isWithinScope = (file: string, scope: string[]): boolean => scope.some(p => p === "." || p === file || file.startsWith(`${p}/`));

/** Git ignores cannot hide existing source from an explicitly writable directory. */
export const writableInventory = async (root: string, scopes: string[], maxEntries = 20_000): Promise<Record<string, string>> => {
  const hashes: Record<string, string> = {}; const visited = new Set<string>();
  const walk = async (file: string): Promise<void> => {
    if ([".git", ".mcoda"].some(dir => file === dir || file.startsWith(`${dir}/`)) || visited.has(file)) return;
    visited.add(file);
    if (visited.size > maxEntries) throw new Error("Shell write inventory exceeds its bound; declare narrower writePaths");
    const absolute = path.resolve(root, file);
    let stat; try { stat = await fs.lstat(absolute); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(absolute)) await walk(workspaceRelativePath(root, path.join(absolute, entry)));
    } else {
      if (stat.isFile() && stat.nlink > 1) throw new Error(`Hard-linked writable file requires an independent copy: ${file}`);
      hashes[file] = await hashWorkspacePath(root, file);
    }
  };
  for (const scope of scopes) {
    const relative = workspaceRelativePath(root, scope);
    const requested = path.resolve(root, relative);
    try { if (await fs.realpath(requested) !== requested) throw new Error("Shell write paths must be canonical and cannot be symlink aliases"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await walk(relative);
  }
  return hashes;
};

export const analysisTarget = (tool: string, args: Record<string, unknown>): { kind: StructuralAnalysis["kind"]; file: string } | undefined => {
  if (["docdex_symbols", "docdex_ast"].includes(tool) && typeof args.path === "string") return { kind: "structure", file: args.path };
  if (tool === "docdex_impact_graph" && typeof args.file === "string") return { kind: "impact", file: args.file };
  return undefined;
};

/** A successful transport alone is not structural evidence (parsers can skip files). */
export const validAnalysisResult = (kind: StructuralAnalysis["kind"], data: unknown, file: string): boolean => {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const value = data as Record<string, unknown>;
  if (value.error || value.isError) return false;
  if (kind === "impact") return value.source === file && Array.isArray(value.edges) && Array.isArray(value.inbound) && Array.isArray(value.outbound);
  const outcome = value.outcome as { status?: string } | undefined;
  return value.file === file && outcome?.status === "ok" && (Array.isArray(value.symbols) || Array.isArray(value.nodes));
};

export const missingStructuralEvidence = (file: string, hash: string, receipts: Iterable<{ status: string; analysis?: StructuralAnalysis }>): string[] => {
  if (hash === "missing" || !isSourcePath(file)) return [];
  const present = new Set<string>();
  for (const receipt of receipts) {
    const a = receipt.analysis;
    if (receipt.status === "success" && a?.valid && a.file === file && a.hash === hash) present.add(a.kind);
  }
  return ["structure", "impact"].filter(kind => !present.has(kind));
};
