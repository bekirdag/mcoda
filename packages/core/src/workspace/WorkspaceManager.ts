import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { PathHelper } from "@mcoda/shared";

export interface WorkspaceResolution {
  workspaceRoot: string;
  workspaceId: string;
  id: string;
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
  let current = path.resolve(start);
  while (true) {
    const gitPath = path.join(current, ".git");
    if (await fileExists(gitPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

const findWorkspaceMarker = async (start: string): Promise<string | undefined> => {
  let current = path.resolve(start);
  while (true) {
    const marker = path.join(current, ".mcoda", "workspace.json");
    const mcoda = path.join(current, ".mcoda");
    if (await fileExists(marker)) return current;
    if (await fileExists(mcoda)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
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

const readWorkspaceIdentity = async (mcodaDir: string): Promise<{ id: string; name?: string; createdAt?: string } | undefined> => {
  const workspacePath = path.join(mcodaDir, "workspace.json");
  try {
    const raw = await fs.readFile(workspacePath, "utf8");
    const parsed = JSON.parse(raw) as { id?: string; name?: string; createdAt?: string };
    if (parsed?.id) return parsed as { id: string; name?: string; createdAt?: string };
    return undefined;
  } catch {
    return undefined;
  }
};

const writeWorkspaceIdentity = async (
  mcodaDir: string,
  identity: { id: string; name?: string; createdAt?: string },
): Promise<void> => {
  const workspacePath = path.join(mcodaDir, "workspace.json");
  await fs.writeFile(workspacePath, JSON.stringify(identity, null, 2), "utf8");
};

const looksLikeWorkspaceId = (value: string): boolean =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.trim());

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
    const identity =
      existingIdentity ??
      {
        id: randomUUID(),
        name: path.basename(workspaceRoot),
        createdAt: new Date().toISOString(),
      };
    if (!existingIdentity) {
      await writeWorkspaceIdentity(mcodaDir, identity);
    }
    const config = await readWorkspaceConfig(mcodaDir);
    return {
      workspaceRoot,
      workspaceId: identity.id,
      id: identity.id,
      mcodaDir,
      workspaceDbPath: PathHelper.getWorkspaceDbPath(workspaceRoot),
      globalDbPath: PathHelper.getGlobalDbPath(),
      config,
    };
  }
}
