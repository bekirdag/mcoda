import os from "node:os";
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
  noRepoWrites?: boolean;
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
  docdexRepoId?: string;
  reviewJsonAgent?: string;
  projectKey?: string;
  restrictAutoMergeWithoutScope?: boolean;
  autoMerge?: boolean;
  autoPush?: boolean;
  codexNoSandbox?: boolean;
  qa?: {
    cleanIgnorePaths?: string[];
    runAllMarkerRequired?: boolean;
  };
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

const dirHasEntries = async (candidate: string): Promise<boolean> => {
  try {
    const entries = await fs.readdir(candidate);
    return entries.length > 0;
  } catch {
    return false;
  }
};

const STATE_DIR_NAMES = [".mcoda", ".mcoda-state", ".mcoda_state"];

const resolveUniqueTarget = async (base: string): Promise<string> => {
  if (!(await fileExists(base))) return base;
  const parent = path.dirname(base);
  const stem = path.basename(base);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = path.join(parent, `${stem}-${randomUUID().slice(0, 8)}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return path.join(parent, `${stem}-${Date.now()}`);
};

const copyLegacyConfigIfMissing = async (
  sourceDir: string,
  targetDir: string,
  warnings: string[],
): Promise<void> => {
  const sourceConfig = path.join(sourceDir, "config.json");
  const targetConfig = path.join(targetDir, "config.json");
  if (!(await fileExists(sourceConfig))) return;
  if (await fileExists(targetConfig)) return;
  try {
    await PathHelper.ensureDir(targetDir);
    await fs.copyFile(sourceConfig, targetConfig);
    warnings.push(`Copied legacy workspace config from ${sourceConfig} to ${targetConfig}.`);
  } catch (error) {
    warnings.push(
      `Unable to copy legacy workspace config from ${sourceConfig}: ${(error as Error).message ?? String(error)}`,
    );
  }
};

export const cleanupWorkspaceStateDirs = async (input: {
  workspaceRoot: string;
  mcodaDir: string;
}): Promise<string[]> => {
  const warnings: string[] = [];
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const mcodaDir = path.resolve(input.mcodaDir);

  for (const name of STATE_DIR_NAMES) {
    const source = path.join(workspaceRoot, name);
    if (!(await fileExists(source))) continue;
    if (PathHelper.normalizePathCase(source) === PathHelper.normalizePathCase(mcodaDir)) {
      continue;
    }
    let stat;
    try {
      stat = await fs.lstat(source);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`Skipped legacy state directory symlink at ${source}.`);
      continue;
    }
    if (!stat.isDirectory()) {
      warnings.push(`Skipped legacy state path ${source} because it is not a directory.`);
      continue;
    }
    if (!(await dirHasEntries(source))) {
      try {
        await fs.rm(source, { recursive: true, force: true });
        warnings.push(`Removed empty legacy state directory at ${source}.`);
      } catch (error) {
        warnings.push(
          `Unable to remove empty legacy state directory at ${source}: ${(error as Error).message ?? String(error)}`,
        );
      }
      continue;
    }

    if (name === ".mcoda") {
      await copyLegacyConfigIfMissing(source, mcodaDir, warnings);
    }

    const targetName = name.startsWith(".") ? name.slice(1) : name;
    const targetBase = path.join(mcodaDir, "legacy", targetName);
    const target = await resolveUniqueTarget(targetBase);
    await PathHelper.ensureDir(path.dirname(target));
    try {
      await fs.rename(source, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        try {
          await fs.cp(source, target, { recursive: true });
          await fs.rm(source, { recursive: true, force: true });
        } catch (copyError) {
          warnings.push(
            `Unable to relocate legacy state directory from ${source}: ${(copyError as Error).message ?? String(copyError)}`,
          );
          continue;
        }
      } else {
        warnings.push(
          `Unable to relocate legacy state directory from ${source}: ${(error as Error).message ?? String(error)}`,
        );
        continue;
      }
    }
    warnings.push(`Relocated legacy state directory from ${source} to ${target}.`);
  }

  return warnings;
};

export const resolveDocgenStatePath = (input: {
  outputPath: string;
  mcodaDir: string;
  jobId: string;
  commandName: string;
}): { statePath: string; warnings: string[] } => {
  const warnings: string[] = [];
  const outputPath = path.resolve(input.outputPath);
  const mcodaDir = path.resolve(input.mcodaDir);
  const tempDir = path.resolve(os.tmpdir());
  const allowedRoots = [mcodaDir, tempDir];
  const isAllowed = allowedRoots.some((root) => PathHelper.isPathInside(root, outputPath));
  if (isAllowed) {
    return { statePath: outputPath, warnings };
  }
  const basename = path.basename(outputPath) || "docgen.md";
  const statePath = path.join(
    mcodaDir,
    "state",
    "docgen",
    input.commandName,
    input.jobId,
    basename,
  );
  warnings.push(
    `Intermediate state redirected from ${outputPath} to ${statePath} to keep docgen state under .mcoda or OS temp directories.`,
  );
  return { statePath, warnings };
};

const maybeCopyLegacyWorkspace = async (sourceDir: string, targetDir: string): Promise<void> => {
  if (!(await fileExists(sourceDir))) return;
  if (await dirHasEntries(targetDir)) return;
  try {
    await fs.cp(sourceDir, targetDir, { recursive: true });
  } catch {
    /* best effort */
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

const readWorkspaceConfig = async (mcodaDir: string, fallbackDir?: string): Promise<WorkspaceConfig | undefined> => {
  const readConfig = async (dir: string): Promise<WorkspaceConfig | undefined> => {
    const configPath = path.join(dir, "config.json");
    try {
      const raw = await fs.readFile(configPath, "utf8");
      return JSON.parse(raw) as WorkspaceConfig;
    } catch {
      return undefined;
    }
  };
  const primary = await readConfig(mcodaDir);
  if (primary) return primary;
  if (fallbackDir && fallbackDir !== mcodaDir) {
    return readConfig(fallbackDir);
  }
  return undefined;
};

const applyWorkspaceEnvOverrides = (config?: WorkspaceConfig): void => {
  if (!config) return;
  if (config.codexNoSandbox === true) {
    process.env.MCODA_CODEX_NO_SANDBOX = "1";
    return;
  }
  if (config.codexNoSandbox === false && process.env.MCODA_CODEX_NO_SANDBOX === undefined) {
    process.env.MCODA_CODEX_NO_SANDBOX = "0";
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
  await updateJsonArray(path.join(workspace.mcodaDir, "command_runs.json"));
  await updateJsonArray(path.join(workspace.mcodaDir, "token_usage.json"));
};

export class WorkspaceResolver {
  static async resolveWorkspace(input: {
    cwd?: string;
    explicitWorkspace?: string;
    noRepoWrites?: boolean;
  }): Promise<WorkspaceResolution> {
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const noRepoWrites = Boolean(input.noRepoWrites);
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
    const repoMcodaDir = path.join(workspaceRoot, ".mcoda");
    const mcodaDir = PathHelper.getGlobalWorkspaceDir(workspaceRoot);
    await PathHelper.ensureDir(mcodaDir);
    await maybeCopyLegacyWorkspace(repoMcodaDir, mcodaDir);
    const repoIdentity = await readWorkspaceIdentity(repoMcodaDir);
    const globalIdentity = await readWorkspaceIdentity(mcodaDir);
    const existingIdentity = globalIdentity ?? repoIdentity;
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
      if (repoIdentity) {
        if (repoIdentity.id && repoIdentity.id !== existingIdentity.id) {
          legacyIds.push(repoIdentity.id);
          updatedIdentity = true;
        }
        if (repoIdentity.legacyIds?.length) {
          legacyIds.push(...repoIdentity.legacyIds);
          updatedIdentity = true;
        }
        if (!globalIdentity) {
          updatedIdentity = true;
        }
      }
      if (!looksLikeWorkspaceId(existingIdentity.id)) {
        legacyIds.push(existingIdentity.id);
        identity = {
          ...existingIdentity,
          id: randomUUID(),
          legacyIds: Array.from(new Set(legacyIds)),
        };
        updatedIdentity = true;
      } else {
        identity = {
          ...existingIdentity,
          legacyIds: Array.from(new Set(legacyIds)),
        };
        if ((identity.legacyIds?.length ?? 0) !== existingLegacy.size) {
          updatedIdentity = true;
        }
      }
      if (updatedIdentity) {
        await writeWorkspaceIdentity(mcodaDir, identity);
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
    const config = await readWorkspaceConfig(mcodaDir, repoMcodaDir);
    applyWorkspaceEnvOverrides(config);
    const resolution: WorkspaceResolution = {
      workspaceRoot,
      workspaceId: identity.id,
      id: identity.id,
      legacyWorkspaceIds,
      mcodaDir,
      workspaceDbPath: path.join(mcodaDir, "mcoda.db"),
      globalDbPath: PathHelper.getGlobalDbPath(),
      noRepoWrites,
      config,
    };
    // Best-effort migration of workspace_id columns and JSON logs from legacy IDs.
    if (!noRepoWrites) {
      await migrateWorkspaceDbIds(resolution, legacyWorkspaceIds.filter((id) => id !== identity.id));
    }
    return resolution;
  }
}
