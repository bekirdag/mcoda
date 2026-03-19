import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceResolution } from "../../workspace/WorkspaceManager.js";

const GITDIR_PREFIX = "gitdir:";
const DETACHED_HEAD_REGEX = /^[0-9a-f]{40}$/i;
const DEFAULT_FALLBACK_BRANCH = "main";

type WorkspaceBranchContext = Pick<WorkspaceResolution, "workspaceRoot" | "config">;

const trimToUndefined = (value?: string | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const resolveGitDir = async (workspaceRoot: string): Promise<string | undefined> => {
  const dotGitPath = path.join(workspaceRoot, ".git");
  try {
    const stat = await fs.lstat(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  try {
    const content = (await fs.readFile(dotGitPath, "utf8")).trim();
    if (!content.toLowerCase().startsWith(GITDIR_PREFIX)) {
      return undefined;
    }
    const gitDir = trimToUndefined(content.slice(GITDIR_PREFIX.length));
    return gitDir ? path.resolve(workspaceRoot, gitDir) : undefined;
  } catch {
    return undefined;
  }
};

export const readGitBranch = async (workspaceRoot: string): Promise<string | undefined> => {
  const gitDir = await resolveGitDir(workspaceRoot);
  if (!gitDir) {
    return undefined;
  }

  try {
    const content = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();
    const match = content.match(/^ref:\s+refs\/heads\/(.+)$/);
    if (match) {
      return trimToUndefined(match[1]);
    }
    if (!content || content === "HEAD" || DETACHED_HEAD_REGEX.test(content)) {
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const resolveWorkspaceBaseBranch = async (
  workspace: WorkspaceBranchContext,
  requestedBranch?: string | null,
  fallbackBranch = DEFAULT_FALLBACK_BRANCH,
): Promise<string> => {
  const configuredBranch = trimToUndefined(workspace.config?.branch);
  const effectiveFallback =
    configuredBranch ?? (await readGitBranch(workspace.workspaceRoot)) ?? fallbackBranch;
  const explicitBranch = trimToUndefined(requestedBranch);
  if (explicitBranch === "dev") {
    return effectiveFallback;
  }
  return explicitBranch ?? effectiveFallback;
};
