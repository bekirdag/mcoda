import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

/**
 * Utility helpers for resolving mcoda paths in both global and workspace scopes.
 * The helpers intentionally avoid touching any other layer to keep shared free of deps.
 */
export class PathHelper {
  static normalizePathCase(value: string): string {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  static resolveRelativePath(root: string, target: string): string {
    const resolvedRoot = this.normalizePathCase(path.resolve(root));
    const resolvedTarget = this.normalizePathCase(path.resolve(root, target));
    return path.relative(resolvedRoot, resolvedTarget).replace(/\\/g, "/");
  }

  static isPathInside(root: string, target: string): boolean {
    const relative = this.resolveRelativePath(root, target);
    if (relative === "") return true;
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  static getGlobalMcodaDir(): string {
    const envHome = process.env.HOME ?? process.env.USERPROFILE;
    const homeDir = envHome && envHome.trim().length > 0 ? envHome : os.homedir();
    return path.join(homeDir, ".mcoda");
  }

  static getGlobalDbPath(): string {
    return path.join(this.getGlobalMcodaDir(), "mcoda.db");
  }

  static getGlobalWorkspaceDir(workspaceRoot: string): string {
    const normalizedRoot = this.normalizePathCase(path.resolve(workspaceRoot));
    const hash = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 12);
    const rawName = path.basename(normalizedRoot) || "workspace";
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 32) || "workspace";
    return path.join(this.getGlobalMcodaDir(), "workspaces", `${safeName}-${hash}`);
  }

  static getWorkspaceDir(workspaceRoot: string = process.cwd()): string {
    return this.getGlobalWorkspaceDir(workspaceRoot);
  }

  static getWorkspaceDbPath(workspaceRoot: string = process.cwd()): string {
    return path.join(this.getWorkspaceDir(workspaceRoot), "mcoda.db");
  }

  static async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }
}
