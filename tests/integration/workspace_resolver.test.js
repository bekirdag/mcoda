import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
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
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  const resolveWorkspaceDir = (root) => {
    const normalizedRoot = path.normalize(path.resolve(root));
    const hash = createHash("sha256").update(process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot).digest("hex").slice(0, 12);
    const rawName = path.basename(normalizedRoot) || "workspace";
    const safeName = rawName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 32) || "workspace";
    return path.join(tempHome, ".mcoda", "workspaces", `${safeName}-${hash}`);
  };
  const expectedMcodaDir = resolveWorkspaceDir(workspaceRoot);

  try {
    const resolved = await WorkspaceResolver.resolveWorkspace({
      cwd: workspaceRoot,
      explicitWorkspace: workspaceRoot,
    });

    assert.equal(resolved.workspaceRoot, workspaceRoot);
    assert.equal(resolved.mcodaDir, expectedMcodaDir);
    assert.equal(resolved.workspaceDbPath, path.join(expectedMcodaDir, "mcoda.db"));

    const workspaceJson = path.join(expectedMcodaDir, "workspace.json");
    const payload = JSON.parse(await fs.readFile(workspaceJson, "utf8"));
    assert.match(payload.id, /^[a-f0-9-]{36}$/i);

    assert.equal(await fileExists(path.join(workspaceRoot, ".gitignore")), false);
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
    await fs.rm(tempHome, { recursive: true, force: true });
  }
});
