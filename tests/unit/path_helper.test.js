import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PathHelper } from "../../packages/shared/src/paths/PathHelper.js";

test("PathHelper workspace paths derive from cwd", () => {
  const cwd = path.join(os.tmpdir(), "mcoda-path-helper");
  assert.equal(PathHelper.getWorkspaceDir(cwd), path.join(cwd, ".mcoda"));
  assert.equal(PathHelper.getWorkspaceDbPath(cwd), path.join(cwd, ".mcoda", "mcoda.db"));
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
