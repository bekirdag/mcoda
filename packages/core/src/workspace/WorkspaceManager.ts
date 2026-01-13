import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { PathHelper } from "@mcoda/shared";

export interface WorkspaceResolution {
  workspaceRoot: string;
  workspaceId: string;
  id: string;
  legacyWorkspaceIds: string[];
  mcodaDir: string;
  workspaceDbPath: string;
  globalDbPath: string;
  config?: WorkspaceConfig;
}

export interface TelemetryPreferences {
  optOut?: boolean;
  strict?: boolean;
  endpoint?: string;
  authToken?: string;
}

export interface WorkspaceConfig {
  mirrorDocs?: boolean;
  branch?: string;
  docdexUrl?: string;
  projectKey?: string;
  restrictAutoMergeWithoutScope?: boolean;
  autoMerge?: boolean;
  autoPush?: boolean;
  velocity?: {
    implementationSpPerHour?: number;
    reviewSpPerHour?: number;
    qaSpPerHour?: number;
    alpha?: number;
  };
  telemetry?: TelemetryPreferences;
}

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

const findGitRoot = async (start: string): Promise<string | undefined> => {
  // Only consider the provided directory; do not walk upward.
  const current = path.resolve(start);
  const gitPath = path.join(current, ".git");
  if (await fileExists(gitPath)) return current;
  return undefined;
};

const findWorkspaceMarker = async (start: string): Promise<string | undefined> => {
  // Only consider the provided directory; do not walk upward.
  const current = path.resolve(start);
  const marker = path.join(current, ".mcoda", "workspace.json");
  const mcoda = path.join(current, ".mcoda");
  if (await fileExists(marker)) return current;
  if (await fileExists(mcoda)) return current;
  return undefined;
};

const ensureGitignore = async (workspaceRoot: string): Promise<void> => {
  const gitignorePath = path.join(workspaceRoot, ".gitignore");
  const entry = ".mcoda/\n";
  try {
    const content = await fs.readFile(gitignorePath, "utf8");
    if (content.includes(".mcoda/")) return;
    await fs.writeFile(gitignorePath, `${content.trimEnd()}\n${entry}`, "utf8");
  } catch {
    await fs.writeFile(gitignorePath, entry, "utf8");
  }
};

const readWorkspaceConfig = async (mcodaDir: string): Promise<WorkspaceConfig | undefined> => {
  const configPath = path.join(mcodaDir, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw) as WorkspaceConfig;
  } catch {
    return undefined;
  }
};

type WorkspaceIdentity = { id: string; name?: string; createdAt?: string; legacyIds?: string[] };

const readWorkspaceIdentity = async (mcodaDir: string): Promise<WorkspaceIdentity | undefined> => {
  const workspacePath = path.join(mcodaDir, "workspace.json");
  try {
    const raw = await fs.readFile(workspacePath, "utf8");
    const parsed = JSON.parse(raw) as WorkspaceIdentity;
    if (parsed?.id) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
};

const writeWorkspaceIdentity = async (
  mcodaDir: string,
  identity: WorkspaceIdentity,
): Promise<void> => {
  const workspacePath = path.join(mcodaDir, "workspace.json");
  await fs.writeFile(workspacePath, JSON.stringify(identity, null, 2), "utf8");
};

const looksLikeWorkspaceId = (value: string): boolean =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.trim());

const migrateWorkspaceDbIds = async (workspace: WorkspaceResolution, legacyIds: string[]): Promise<void> => {
  if (!legacyIds.length) return;
  if (!(await fileExists(workspace.workspaceDbPath))) {
    return;
  }
  let conn: { db: { run: (sql: string, params?: unknown[]) => Promise<unknown> }; close: () => Promise<void> } | undefined;
  try {
    const { Connection } = await import("@mcoda/db");
    conn = await Connection.open(workspace.workspaceDbPath);
    const db = conn.db;
    const placeholders = legacyIds.map(() => "?").join(",");
    const params = [workspace.workspaceId, ...legacyIds];
    const tables = ["jobs", "command_runs", "token_usage"];
    for (const table of tables) {
      await db.run(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IN (${placeholders})`, params);
    }
  } catch {
    /* best effort */
  } finally {
    if (conn) {
      try {
        await conn.close();
      } catch {
        /* best effort */
      }
    }
  }

  const updateJsonArray = async (filePath: string) => {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as any[];
      if (!Array.isArray(parsed) || !parsed.length) return;
      let changed = false;
      const updated = parsed.map((row) => {
        if (row?.workspaceId && legacyIds.includes(row.workspaceId)) {
          changed = true;
          return { ...row, workspaceId: workspace.workspaceId };
        }
        return row;
      });
      if (changed) {
        await fs.writeFile(filePath, JSON.stringify(updated, null, 2), "utf8");
      }
    } catch {
      /* ignore */
    }
  };
  await updateJsonArray(path.join(workspace.workspaceRoot, ".mcoda", "command_runs.json"));
  await updateJsonArray(path.join(workspace.workspaceRoot, ".mcoda", "token_usage.json"));
};

export class WorkspaceResolver {
  static async resolveWorkspace(input: { cwd?: string; explicitWorkspace?: string }): Promise<WorkspaceResolution> {
    const cwd = path.resolve(input.cwd ?? process.cwd());
    let explicit = input.explicitWorkspace;
    let explicitPath: string | undefined;
    if (explicit) {
      const candidatePath = path.resolve(explicit);
      if (await fileExists(candidatePath)) {
        explicitPath = candidatePath;
      } else if (await fileExists(path.join(candidatePath, ".mcoda"))) {
        explicitPath = candidatePath;
      } else if (looksLikeWorkspaceId(explicit)) {
        throw new Error(
          `Workspace id ${explicit} not recognized. Workspace registry lookups are not yet supported; pass a workspace path instead.`,
        );
      } else {
        throw new Error(`Workspace path ${explicit} not found`);
      }
    }

    const fromMarker = await findWorkspaceMarker(explicitPath ?? cwd);
    const gitRoot = await findGitRoot(explicitPath ?? cwd);
    const workspaceRoot = explicitPath ?? fromMarker ?? gitRoot ?? cwd;
    const mcodaDir = path.join(workspaceRoot, ".mcoda");
    await PathHelper.ensureDir(mcodaDir);
    await ensureGitignore(workspaceRoot);
    const existingIdentity = await readWorkspaceIdentity(mcodaDir);
    let identity: WorkspaceIdentity;
    let legacyIds: string[] = [];
    if (existingIdentity) {
      const existingLegacy = new Set<string>(existingIdentity.legacyIds ?? []);
      let updatedIdentity = false;
      legacyIds = [...(existingIdentity.legacyIds ?? [])];
      if (existingIdentity.id && existingIdentity.id !== workspaceRoot) {
        legacyIds.push(workspaceRoot);
        updatedIdentity = true;
      }
      if (!looksLikeWorkspaceId(existingIdentity.id)) {
        legacyIds.push(existingIdentity.id);
        identity = {
          ...existingIdentity,
          id: randomUUID(),
          legacyIds: Array.from(new Set(legacyIds)),
        };
        await writeWorkspaceIdentity(mcodaDir, identity);
      } else {
        identity = {
          ...existingIdentity,
          legacyIds: Array.from(new Set(legacyIds)),
        };
        if ((identity.legacyIds?.length ?? 0) !== existingLegacy.size) {
          updatedIdentity = true;
        }
        if (updatedIdentity) {
          await writeWorkspaceIdentity(mcodaDir, identity);
        }
      }
    } else {
      identity = {
        id: randomUUID(),
        name: path.basename(workspaceRoot),
        createdAt: new Date().toISOString(),
        legacyIds: [workspaceRoot],
      };
      await writeWorkspaceIdentity(mcodaDir, identity);
    }
    const legacyWorkspaceIds = Array.from(new Set([...(identity.legacyIds ?? []), workspaceRoot].filter(Boolean)));
    const config = await readWorkspaceConfig(mcodaDir);
    const resolution: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: identity.id,
      id: identity.id,
      legacyWorkspaceIds,
      mcodaDir,
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
      config,
    };
    // Best-effort migration of workspace_id columns and JSON logs from legacy IDs.
    await migrateWorkspaceDbIds(resolution, legacyWorkspaceIds.filter((id) => id !== identity.id));
    return resolution;
  }
}
