import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspacePermissions } from "../WorkspacePermissions.js";

test("directory permissions persist across instances, stay scoped and can be revoked", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-permissions-"));
  try {
    const a = path.join(root, "a"), b = path.join(root, "b"), storage = path.join(root, "state");
    await fs.mkdir(a); await fs.mkdir(b);
    const store = new WorkspacePermissions(a, storage);
    assert.equal(await store.read(), undefined);
    await store.save("full");
    assert.equal(await new WorkspacePermissions(a, storage).read(), "full");
    assert.equal(await new WorkspacePermissions(b, storage).read(), undefined);
    await new WorkspacePermissions(a, storage).save("ask");
    assert.equal(await store.read(), "ask");
    const key = (await fs.readdir(storage))[0];
    const file = path.join(storage, key, "permissions.json");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    record.workspace = b;
    await fs.writeFile(file, JSON.stringify(record));
    await assert.rejects(store.read(), /Invalid saved workspace permissions/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
