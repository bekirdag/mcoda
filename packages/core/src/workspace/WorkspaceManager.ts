import path from "node:path";
import { promises as fs } from "node:fs";
import { PathHelper } from "@mcoda/shared";

export interface WorkspaceResolution {
  workspaceRoot: string;
  workspaceId: string;
  mcodaDir: string;
  config?: WorkspaceConfig;
}

export interface WorkspaceConfig {
  mirrorDocs?: boolean;
  branch?: string;
  docdexUrl?: string;
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

export class WorkspaceResolver {
  static async resolveWorkspace(input: { cwd?: string; explicitWorkspace?: string }): Promise<WorkspaceResolution> {
    const cwd = path.resolve(input.cwd ?? process.cwd());
    const explicit = input.explicitWorkspace ? path.resolve(input.explicitWorkspace) : undefined;
    const fromMarker = await findWorkspaceMarker(explicit ?? cwd);
    const gitRoot = await findGitRoot(explicit ?? cwd);
    const workspaceRoot = explicit ?? fromMarker ?? gitRoot ?? cwd;
    const mcodaDir = path.join(workspaceRoot, ".mcoda");
    await PathHelper.ensureDir(mcodaDir);
    await ensureGitignore(workspaceRoot);
    const config = await readWorkspaceConfig(mcodaDir);
    return {
      workspaceRoot,
      workspaceId: workspaceRoot,
      mcodaDir,
      config,
    };
  }
}
