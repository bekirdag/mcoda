import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceResolver } from "../WorkspaceManager.js";

const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

const withTempDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-ws-"));
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
};

test("rejects explicit workspace paths that do not exist", async () => {
  const missing = path.join(os.tmpdir(), `mcoda-missing-${Date.now()}`);
  await assert.rejects(
    () => WorkspaceResolver.resolveWorkspace({ explicitWorkspace: missing }),
    /Workspace path .* not found/,
  );
});

test("rejects explicit workspace ids without registry support", async () => {
  const fakeId = "123e4567-e89b-12d3-a456-426614174000";
  await assert.rejects(
    () => WorkspaceResolver.resolveWorkspace({ explicitWorkspace: fakeId }),
    /Workspace id .* not recognized/,
  );
});

test("migrates legacy workspace id to UUID and preserves legacy ids", async () => {
  await withTempDir(async (dir) => {
    const mcodaDir = path.join(dir, ".mcoda");
    await fs.mkdir(mcodaDir, { recursive: true });
    await fs.writeFile(
      path.join(mcodaDir, "workspace.json"),
      JSON.stringify({ id: "legacy-id" }, null, 2),
      "utf8",
    );

    const resolved = await WorkspaceResolver.resolveWorkspace({ explicitWorkspace: dir });
    const payload = JSON.parse(await fs.readFile(path.join(mcodaDir, "workspace.json"), "utf8"));

    assert.match(payload.id, uuidRegex);
    assert.ok(payload.legacyIds.includes("legacy-id"));
    assert.ok(payload.legacyIds.includes(dir));
    assert.equal(resolved.workspaceId, payload.id);
    assert.ok(resolved.legacyWorkspaceIds.includes("legacy-id"));
    assert.ok(resolved.legacyWorkspaceIds.includes(dir));
  });
});
