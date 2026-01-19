import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
/**
 * Utility helpers for resolving mcoda paths in both global and workspace scopes.
 * The helpers intentionally avoid touching any other layer to keep shared free of deps.
 */
export class PathHelper {
    static normalizePathCase(value) {
        const normalized = path.normalize(value);
        return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    }
    static resolveRelativePath(root, target) {
        const resolvedRoot = this.normalizePathCase(path.resolve(root));
        const resolvedTarget = this.normalizePathCase(path.resolve(root, target));
        return path.relative(resolvedRoot, resolvedTarget).replace(/\\/g, "/");
    }
    static isPathInside(root, target) {
        const relative = this.resolveRelativePath(root, target);
        if (relative === "")
            return true;
        return !relative.startsWith("..") && !path.isAbsolute(relative);
    }
    static getGlobalMcodaDir() {
        const envHome = process.env.HOME ?? process.env.USERPROFILE;
        const homeDir = envHome && envHome.trim().length > 0 ? envHome : os.homedir();
        return path.join(homeDir, ".mcoda");
    }
    static getGlobalDbPath() {
        return path.join(this.getGlobalMcodaDir(), "mcoda.db");
    }
    static getGlobalWorkspaceDir(workspaceRoot) {
        const normalizedRoot = this.normalizePathCase(path.resolve(workspaceRoot));
        const hash = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 12);
        const rawName = path.basename(normalizedRoot) || "workspace";
        const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 32) || "workspace";
        return path.join(this.getGlobalMcodaDir(), "workspaces", `${safeName}-${hash}`);
    }
    static getWorkspaceDir(workspaceRoot = process.cwd()) {
        return this.getGlobalWorkspaceDir(workspaceRoot);
    }
    static getWorkspaceDbPath(cwd = process.cwd()) {
        return path.join(this.getWorkspaceDir(cwd), "mcoda.db");
    }
    static async ensureDir(dir) {
        await fs.mkdir(dir, { recursive: true });
    }
}
