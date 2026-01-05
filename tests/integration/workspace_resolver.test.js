import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workspaceManagerPath = path.join(root, "packages", "core", "dist", "workspace", "WorkspaceManager.js");

const fileExists = async (candidate) => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

test("WorkspaceResolver initializes mcoda workspace state", async (t) => {
  if (!(await fileExists(workspaceManagerPath))) {
    t.skip("Core dist output not found; run pnpm -r run build first.");
    return;
  }

  const { WorkspaceResolver } = await import(pathToFileURL(workspaceManagerPath).href);
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-workspace-"));

  const resolved = await WorkspaceResolver.resolveWorkspace({
    cwd: workspaceRoot,
    explicitWorkspace: workspaceRoot,
  });

  assert.equal(resolved.workspaceRoot, workspaceRoot);
  assert.equal(resolved.mcodaDir, path.join(workspaceRoot, ".mcoda"));
  assert.equal(resolved.workspaceDbPath, path.join(workspaceRoot, ".mcoda", "mcoda.db"));

  const workspaceJson = path.join(workspaceRoot, ".mcoda", "workspace.json");
  const payload = JSON.parse(await fs.readFile(workspaceJson, "utf8"));
  assert.match(payload.id, /^[a-f0-9-]{36}$/i);

  const gitignore = await fs.readFile(path.join(workspaceRoot, ".gitignore"), "utf8");
  assert.ok(gitignore.includes(".mcoda/"));
});
