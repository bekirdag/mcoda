import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../SessionStore.js";

test("concurrent session updates retain every run and transcript event", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-durable-"));
  try {
    const store = new SessionStore({ workspaceRoot: root });
    await store.createSession({ sessionId: "s", repoRoot: root, task: "Keep all records" });
    await Promise.all(Array.from({ length: 20 }, async (_, i) => {
      const other = new SessionStore({ workspaceRoot: root });
      await other.addRun("s", `r${i}`); await other.appendTranscript("s", { type: "note", data: { i } });
    }));
    assert.equal((await store.readSession("s")).runIds.length, 20);
    assert.equal(new Set((await store.readTranscript("s")).map(e => e.data.i)).size, 20);
    await assert.rejects(store.createSession({ sessionId: "s", repoRoot: root, task: "overwrite" }));
    await assert.rejects(store.readSession(".."));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("crash-tail repair retains complete records and rejects middle corruption", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tail-"));
  try {
    const store = new SessionStore({ workspaceRoot: root });
    await store.createSession({ sessionId: "s", repoRoot: root, task: "Recover" });
    await store.appendTranscript("s", { type: "note", data: { n: 1 } });
    const transcript = path.join(root, ".mcoda", "codali", "sessions", "s", "transcript.jsonl");
    await fs.appendFile(transcript, '{"partial":');
    assert.equal((await store.readTranscript("s")).length, 1);
    await store.appendTranscript("s", { type: "note", data: { n: 2 } });
    assert.deepEqual((await store.readTranscript("s")).map(e => e.data.n), [1, 2]);
    // A complete final record without a newline must be preserved, not truncated.
    await fs.writeFile(transcript, (await fs.readFile(transcript, "utf8")).trimEnd());
    await store.appendTranscript("s", { type: "note", data: { n: 3 } });
    assert.deepEqual((await store.readTranscript("s")).map(e => e.data.n), [1, 2, 3]);
    await fs.appendFile(transcript, 'broken\n{"valid":true}\n');
    await assert.rejects(store.readTranscript("s"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("work-state revisions fence concurrent clients and preserve original identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-revision-"));
  try {
    const store = new SessionStore({ workspaceRoot: root });
    await store.createSession({ sessionId: "s", repoRoot: root, task: "Original" });
    const first = await store.initializeWork("s", "Original");
    await store.updateWork("s", first.revision, state => { state.constraints.push("Keep existing edits"); });
    await assert.rejects(store.updateWork("s", first.revision, state => { state.constraints = []; }), /revision/i);
    const next = await store.readWork("s");
    await assert.rejects(store.updateWork("s", next!.revision, state => { state.originalObjective = "Rewrite"; }), /identity|original/i);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
