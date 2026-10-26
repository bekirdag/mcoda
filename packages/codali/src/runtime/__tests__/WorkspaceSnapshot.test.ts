import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureWorkspace, hashWorkspacePath, workspaceGit, workspaceHash } from "../WorkspaceSnapshot.js";

test("unborn Git repositories retain staged and untracked dirty paths without filename escaping", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-unborn-"));
  try {
    await workspaceGit(root, ["init"]);
    await fs.writeFile(path.join(root, "staged.txt"), "staged content");
    await workspaceGit(root, ["add", "staged.txt"]);
    // Windows forbids control characters in filenames; spaces also exercise -z parsing.
    const untrackedName = process.platform === "win32" ? "untracked file.txt" : "untracked\nfile.txt";
    await fs.writeFile(path.join(root, untrackedName), "user content");
    const snapshot = await captureWorkspace(root);
    assert.equal(snapshot.git, true);
    assert.equal(snapshot.head, "unborn");
    assert.deepEqual(snapshot.dirtyPaths, ["staged.txt", untrackedName]);
    assert.equal(snapshot.hashes[untrackedName], workspaceHash("user content"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("large-file verification uses the same content hash as workspace capture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-hashes-"));
  try {
    const content = Buffer.alloc(3_000_000, 97);
    await fs.writeFile(path.join(root, "large.bin"), content);
    assert.equal(await hashWorkspacePath(root, "large.bin"), workspaceHash(content));
    assert.equal((await captureWorkspace(root)).hashes["large.bin"], workspaceHash(content));
    content[content.length - 1] = 98;
    await fs.writeFile(path.join(root, "large.bin"), content);
    assert.equal(await hashWorkspacePath(root, "large.bin"), workspaceHash(content));
    assert.equal(await hashWorkspacePath(root, "absent"), "missing");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("snapshot hashes link text without following it and rejects escaping parents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-links-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codali-outside-"));
  try {
    await fs.writeFile(path.join(outside, "secret"), "must not read");
    await fs.symlink(outside, path.join(root, "escape"));
    assert.equal(await hashWorkspacePath(root, "escape"), `symlink:${outside}`);
    await assert.rejects(hashWorkspacePath(root, "escape/secret"), /escapes/);
    await assert.rejects(hashWorkspacePath(root, "../secret"), /Unsafe/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});
