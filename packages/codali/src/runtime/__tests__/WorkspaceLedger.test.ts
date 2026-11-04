import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceLedger } from "../WorkspaceLedger.js";
import { captureWorkspace } from "../WorkspaceSnapshot.js";

test("session diffs preserve dirty preimages across reopen and later edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-ownership-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-ownership-store-"));
  try {
    await fs.writeFile(path.join(root, "feature.js"), "const userChange = 42;\nexport const result = 0;\n");
    const ledger = new WorkspaceLedger(storage, root);
    await ledger.capture(await captureWorkspace(root), ["feature.js"]);
    await fs.writeFile(path.join(root, "feature.js"), "const userChange = 42;\nexport const result = 1;\n");
    const reopened = new WorkspaceLedger(storage, root);
    await reopened.capture(await captureWorkspace(root), ["feature.js"]);
    const diff = await reopened.diff(["feature.js"]);
    assert.match(diff, /-export const result = 0/);
    assert.match(diff, /\+export const result = 1/);
    assert.doesNotMatch(diff, /[-+]const userChange/);
    assert.equal((await fs.readdir(storage)).some(file => file.startsWith("diff-")), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("concurrent changes during edit preparation reject the stale baseline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-preimage-race-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-preimage-race-store-"));
  try {
    const file = path.join(root, "feature.js"); await fs.writeFile(file, "before");
    const snapshot = await captureWorkspace(root);
    await fs.writeFile(file, "concurrent user edit");
    await assert.rejects(new WorkspaceLedger(storage, root).capture(snapshot, ["feature.js"]), /changed while preparing/);
    assert.equal(await fs.readFile(file, "utf8"), "concurrent user edit");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});

test("ownership requires a known preimage and bounds newly generated artifact diffs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-owned-inventory-"));
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "codali-owned-inventory-store-"));
  try {
    await fs.writeFile(path.join(root, "user.txt"), "pre-existing user work");
    const ledger = new WorkspaceLedger(storage, root);
    await assert.rejects(ledger.diff(["user.txt"]), /ownership cannot be established/);
    await ledger.capture(await captureWorkspace(root), ["generated"]);
    await fs.writeFile(path.join(root, "user.txt"), "concurrent user work");
    await assert.rejects(ledger.diff(["user.txt"]), /ownership cannot be established/);
    await fs.mkdir(path.join(root, "generated"));
    await fs.writeFile(path.join(root, "generated/new.txt"), "agent output\n");
    assert.match(await ledger.diff(["generated/new.txt"]), /\+agent output/);
    const artifact = await fs.open(path.join(root, "generated/large.bin"), "w");
    await artifact.truncate(9 * 1024 * 1024); await artifact.close();
    assert.match(await ledger.diff(["generated/large.bin"]), /content diff omitted above 8 MiB/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(storage, { recursive: true, force: true }); }
});
