import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathHelper } from "../../packages/shared/src/paths/PathHelper.js";

test("PathHelper workspace paths derive from cwd", () => {
  const cwd = path.join(os.tmpdir(), "mcoda-path-helper");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = path.join(os.tmpdir(), "mcoda-path-helper-home");
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    const workspaceDir = PathHelper.getWorkspaceDir(cwd);
    assert.ok(workspaceDir.startsWith(path.join(tempHome, ".mcoda", "workspaces")));
    assert.equal(workspaceDir, PathHelper.getGlobalWorkspaceDir(cwd));
    assert.equal(PathHelper.getWorkspaceDbPath(cwd), path.join(workspaceDir, "mcoda.db"));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});

test("PathHelper.ensureDir creates nested directories", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-paths-"));
  const target = path.join(base, "a", "b", "c");
  await PathHelper.ensureDir(target);
  const stat = await fs.stat(target);
  assert.equal(stat.isDirectory(), true);
});

test("PathHelper.isPathInside detects scoped paths", () => {
  const root = path.join(os.tmpdir(), "mcoda-paths-root");
  const inside = path.join(root, "subdir", "file.txt");
  const outside = path.join(root, "..", "outside.txt");
  assert.equal(PathHelper.isPathInside(root, inside), true);
  assert.equal(PathHelper.isPathInside(root, outside), false);
  const relative = PathHelper.resolveRelativePath(root, inside);
  assert.equal(relative.includes("\\"), false);
});
