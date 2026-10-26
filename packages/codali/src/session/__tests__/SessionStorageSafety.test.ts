import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../SessionStore.js";
import { assertRegularStateFile, readStateFile } from "../SessionStoragePath.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-storage-safety-"));
  const workspace = path.join(root, "repo"); const outside = path.join(root, "outside");
  await fs.mkdir(workspace); await fs.mkdir(outside);
  const store = new SessionStore({ workspaceRoot: workspace });
  return { root, workspace, outside, store, session: path.join(workspace, ".mcoda/codali/sessions/s") };
}

test("path validation retries an inode unlinked by an atomic replacement", { skip: process.platform === "win32" ? "Windows refuses rename over an open file; this race requires POSIX replacement semantics" : false }, async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.workspace, "state.json"); const next = `${file}.next`;
  await fs.writeFile(file, "old"); await fs.writeFile(next, "current");
  const handle = await fs.open(file, "r");
  const lstat = fs.lstat; let raced = false;
  const mock = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    if (args[0] === file && !raced) {
      raced = true; await fs.rename(next, file);
      const unlinked = await handle.stat(); assert.equal(unlinked.nlink, 0);
      return unlinked;
    }
    return lstat(...args);
  });
  try { await assertRegularStateFile(file); assert.equal(raced, true); assert.equal(mock.mock.callCount(), 2); }
  finally { mock.mock.restore(); await handle.close(); }
});

test("state reads reopen after an atomic replacement without reading the unlinked inode", { skip: process.platform === "win32" ? "Windows refuses rename over an open file; this race requires POSIX replacement semantics" : false }, async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.workspace, "state.json"); const next = `${file}.next`;
  await fs.writeFile(file, "old"); await fs.writeFile(next, "current");
  const open = fs.open; let raced = false;
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (args[0] === file && !raced) {
      raced = true;
      try { await fs.rename(next, file); } catch (error) { await handle.close(); throw error; }
    }
    return handle;
  });
  try { assert.equal(await readStateFile(file), "current"); assert.equal(mock.mock.callCount(), 2); }
  finally { mock.mock.restore(); }
});

test("repeated replacements stop after bounded retries and hard links remain unsafe", async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.workspace, "state.json"); await fs.writeFile(file, "old");
  const handle = await fs.open(file, "r"); await fs.unlink(file);
  const unlinked = await handle.stat(); assert.equal(unlinked.nlink, 0);
  const mock = t.mock.method(fs, "lstat", async () => unlinked);
  try { await assert.rejects(assertRegularStateFile(file), /changed during validation/); assert.ok(mock.mock.callCount() <= 8); }
  finally { mock.mock.restore(); await handle.close(); }
  await fs.writeFile(file, "preserve"); await fs.link(file, path.join(f.outside, "linked.json"));
  await assert.rejects(assertRegularStateFile(file), /Unsafe session state/);
  await assert.rejects(readStateFile(file), /Unsafe session state/);
});

for (const component of [".mcoda", ".mcoda/codali", ".mcoda/codali/sessions", ".mcoda/codali/sessions/s"]) {
  test(`session creation refuses redirected parent ${component}`, async t => {
    const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    const redirect = path.join(f.workspace, component); await fs.mkdir(path.dirname(redirect), { recursive: true });
    await fs.symlink(f.outside, redirect, "dir");
    await assert.rejects(f.store.createSession({ sessionId: "s", repoRoot: f.workspace, task: "Preserve" }), /Unsafe session storage/);
    assert.deepEqual(await fs.readdir(f.outside), []);
  });
}

for (const file of ["metadata.json", "work.json", "transcript.jsonl", "work.json.transactions.sqlite", "work.json.transactions.sqlite-journal"]) {
  test(`session operations refuse symlink state or lock file ${file}`, async t => {
    const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
    await f.store.createSession({ sessionId: "s", repoRoot: f.workspace, task: "Preserve" });
    const state = await f.store.initializeWork("s", "Preserve");
    const target = path.join(f.outside, "user.txt"); await fs.writeFile(target, "User-owned contents");
    const alias = path.join(f.session, file); await fs.rm(alias, { force: true }); await fs.symlink(target, alias);
    const operation = file === "metadata.json" ? f.store.readSession("s") : file === "transcript.jsonl"
      ? f.store.appendTranscript("s", { type: "note", data: { unsafe: true } }) : f.store.updateWork("s", state.revision, next => { next.constraints.push("new"); });
    await assert.rejects(operation, /Unsafe session state/);
    assert.equal(await fs.readFile(target, "utf8"), "User-owned contents");
  });
}

test("hard-linked transcripts and summary traversal cannot expose or mutate outside files", async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.createSession({ sessionId: "s", repoRoot: f.workspace, task: "Preserve" });
  const target = path.join(f.outside, "user.txt"); await fs.writeFile(target, "User-owned contents");
  await fs.link(target, path.join(f.session, "transcript.jsonl"));
  await assert.rejects(f.store.appendTranscript("s", { type: "note", data: {} }), /Unsafe session state/);
  assert.equal(await fs.readFile(target, "utf8"), "User-owned contents");
  const metadata = path.join(f.session, "metadata.json"); const value = JSON.parse(await fs.readFile(metadata, "utf8"));
  value.summaryRefs = ["../../../../../outside/user.txt"]; await fs.writeFile(metadata, JSON.stringify(value));
  await assert.rejects(f.store.readLatestSummary("s"), /Unsafe session summary/);
});

test("future metadata is read-only to this client, including transcript appends", async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.createSession({ sessionId: "s", repoRoot: f.workspace, task: "Preserve" });
  await f.store.appendTranscript("s", { type: "note", data: { n: 1 } });
  const meta = path.join(f.session, "metadata.json"); const next = JSON.parse(await fs.readFile(meta, "utf8"));
  next.schemaVersion = 2; next.futureData = { required: true }; await fs.writeFile(meta, JSON.stringify(next));
  const metadataBefore = await fs.readFile(meta); const transcriptBefore = await fs.readFile(path.join(f.session, "transcript.jsonl"));
  await assert.rejects(f.store.readSession("s"), /Unsupported session metadata/);
  await assert.rejects(f.store.updateSession("s", { task: "rewrite" }), /Unsupported session metadata/);
  await assert.rejects(f.store.appendTranscript("s", { type: "note", data: {} }), /Unsupported session metadata/);
  await assert.rejects(f.store.initializeWork("s", "rewrite"), /Unsupported session metadata/);
  assert.deepEqual(await fs.readFile(meta), metadataBefore);
  assert.deepEqual(await fs.readFile(path.join(f.session, "transcript.jsonl")), transcriptBefore);
});

test("future transcript entries and middle corruption stop append without repair or truncation", async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.createSession({ sessionId: "s", repoRoot: f.workspace, task: "Preserve" });
  const transcript = path.join(f.session, "transcript.jsonl");
  for (const content of ['{"schemaVersion":2,"sessionId":"s"}\n', 'broken\n{"schemaVersion":1,"sessionId":"s"}\n']) {
    await fs.writeFile(transcript, content);
    await assert.rejects(f.store.readTranscript("s"));
    await assert.rejects(f.store.appendTranscript("s", { type: "note", data: {} }));
    assert.equal(await fs.readFile(transcript, "utf8"), content);
  }
});

test("trusted external storage and canonical workspace aliases retain normal summaries", async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const alias = path.join(f.root, "workspace-alias"); await fs.symlink(f.workspace, alias, "dir");
  for (const external of [false, true]) {
    const store = new SessionStore({ workspaceRoot: alias, ...(external ? { allowExternalStorage: true, storageDir: path.join(f.outside, "new-parent", "sessions") } : {}) });
    const id = external ? "external" : "local";
    await store.createSession({ sessionId: id, repoRoot: alias, task: "Preserve alias" });
    await store.appendTranscript(id, { type: "note", data: { n: 1 } });
    const summary = await store.compactSession(id);
    assert.deepEqual(await store.readLatestSummary(id), summary);
    assert.equal((await store.readTranscript(id)).length, 1);
  }
});
