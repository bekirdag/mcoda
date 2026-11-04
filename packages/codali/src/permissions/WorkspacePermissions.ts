import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson } from "../session/AtomicState.js";
import { readStateFile, sessionStoragePath } from "../session/SessionStoragePath.js";
import type { PermissionProfile } from "./PermissionGate.js";

/** Host-owned preferences, never loaded from repository instructions/config. */
export class WorkspacePermissions {
  constructor(private readonly workspace: string, private readonly storageRoot = path.join(os.homedir(), ".local", "state", "codali", "workspaces")) {}

  private async location(createParents = false) {
    const workspace = await fs.realpath(this.workspace);
    const identity = await fs.stat(workspace);
    const key = createHash("sha256").update(workspace).digest("hex");
    const file = await sessionStoragePath({ workspaceRoot: workspace, storageRoot: this.storageRoot,
      file: path.join(this.storageRoot, key, "permissions.json"), allowExternal: true, createParents });
    return { file, workspace, device: identity.dev, inode: identity.ino };
  }

  async read(): Promise<PermissionProfile | undefined> {
    try {
      const location = await this.location();
      const record = JSON.parse(await readStateFile(location.file));
      if (record.schemaVersion !== 1 || record.workspace !== location.workspace || record.device !== location.device || record.inode !== location.inode
        || !["plan", "ask", "workspace", "full"].includes(record.profile)) throw new Error("Invalid saved workspace permissions; choose an explicit --permissions profile to override");
      return record.profile;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }

  async save(profile: PermissionProfile): Promise<void> {
    if (!["plan", "ask", "workspace", "full"].includes(profile)) throw new Error("Unknown permission profile");
    const { file, ...identity } = await this.location(true);
    await atomicWriteJson(file, { schemaVersion: 1, ...identity, profile });
  }
}
