import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
/**
 * Utility helpers for resolving mcoda paths in both global and workspace scopes.
 * The helpers intentionally avoid touching any other layer to keep shared free of deps.
 */
export class PathHelper {
    static getGlobalMcodaDir() {
        return path.join(os.homedir(), ".mcoda");
    }
    static getGlobalDbPath() {
        return path.join(this.getGlobalMcodaDir(), "mcoda.db");
    }
    static getWorkspaceDir(cwd = process.cwd()) {
        return path.join(cwd, ".mcoda");
    }
    static getWorkspaceDbPath(cwd = process.cwd()) {
        return path.join(this.getWorkspaceDir(cwd), "mcoda.db");
    }
    static async ensureDir(dir) {
        await fs.mkdir(dir, { recursive: true });
    }
}
