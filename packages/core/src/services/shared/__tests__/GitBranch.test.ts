import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readGitBranch, resolveWorkspaceBaseBranch } from "../GitBranch.js";
import type { WorkspaceResolution } from "../../../workspace/WorkspaceManager.js";

const setupWorkspaceRoot = async () => fs.mkdtemp(path.join(os.tmpdir(), "mcoda-git-branch-"));

const cleanupWorkspaceRoot = async (workspaceRoot: string) => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
};

const createWorkspace = (workspaceRoot: string, branch?: string): WorkspaceResolution =>
  ({
    workspaceRoot,
    workspaceId: "workspace-1",
    id: "workspace-1",
    legacyWorkspaceIds: [],
    mcodaDir: path.join(workspaceRoot, ".mcoda"),
    workspaceDbPath: path.join(workspaceRoot, ".mcoda", "workspace.db"),
    globalDbPath: path.join(workspaceRoot, ".mcoda", "global.db"),
    config: branch ? { branch } : undefined,
  }) as WorkspaceResolution;

test("resolveWorkspaceBaseBranch prefers workspace config branch", async () => {
  const workspaceRoot = await setupWorkspaceRoot();
  try {
    await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/feature/test\n", "utf8");
    const branch = await resolveWorkspaceBaseBranch(createWorkspace(workspaceRoot, "release"));
    assert.equal(branch, "release");
  } finally {
    await cleanupWorkspaceRoot(workspaceRoot);
  }
});

test("readGitBranch returns HEAD ref branch", async () => {
  const workspaceRoot = await setupWorkspaceRoot();
  try {
    await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/feature/test\n", "utf8");
    const branch = await readGitBranch(workspaceRoot);
    assert.equal(branch, "feature/test");
  } finally {
    await cleanupWorkspaceRoot(workspaceRoot);
  }
});

test("readGitBranch follows gitdir indirection", async () => {
  const workspaceRoot = await setupWorkspaceRoot();
  try {
    const actualGitDir = path.join(workspaceRoot, ".worktrees", "feature");
    await fs.mkdir(actualGitDir, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".git"), "gitdir: .worktrees/feature\n", "utf8");
    await fs.writeFile(path.join(actualGitDir, "HEAD"), "ref: refs/heads/worktree/topic\n", "utf8");
    const branch = await readGitBranch(workspaceRoot);
    assert.equal(branch, "worktree/topic");
  } finally {
    await cleanupWorkspaceRoot(workspaceRoot);
  }
});

test("resolveWorkspaceBaseBranch falls back to main for detached HEAD", async () => {
  const workspaceRoot = await setupWorkspaceRoot();
  try {
    await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, ".git", "HEAD"),
      "7f6e5d4c3b2a190817161514131211100f0e0d0c\n",
      "utf8",
    );
    const branch = await resolveWorkspaceBaseBranch(createWorkspace(workspaceRoot));
    assert.equal(branch, "main");
  } finally {
    await cleanupWorkspaceRoot(workspaceRoot);
  }
});

test("resolveWorkspaceBaseBranch maps dev alias to resolved default branch", async () => {
  const workspaceRoot = await setupWorkspaceRoot();
  try {
    await fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    const branch = await resolveWorkspaceBaseBranch(createWorkspace(workspaceRoot), "dev");
    assert.equal(branch, "main");
  } finally {
    await cleanupWorkspaceRoot(workspaceRoot);
  }
});
