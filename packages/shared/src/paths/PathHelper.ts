import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Utility helpers for resolving mcoda paths in both global and workspace scopes.
 * The helpers intentionally avoid touching any other layer to keep shared free of deps.
 */
export class PathHelper {
  static getGlobalMcodaDir(): string {
    const envHome = process.env.HOME ?? process.env.USERPROFILE;
    const homeDir = envHome && envHome.trim().length > 0 ? envHome : os.homedir();
    return path.join(homeDir, ".mcoda");
  }

  static getGlobalDbPath(): string {
    return path.join(this.getGlobalMcodaDir(), "mcoda.db");
  }

  static getWorkspaceDir(cwd: string = process.cwd()): string {
    return path.join(cwd, ".mcoda");
  }

  static getWorkspaceDbPath(cwd: string = process.cwd()): string {
    return path.join(this.getWorkspaceDir(cwd), "mcoda.db");
  }

  static async ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }
}
