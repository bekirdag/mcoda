import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextStore, type ContextMessageRecord } from "../ContextStore.js";

test("ContextStore writes and loads JSONL lanes", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-store-"));
  const store = new ContextStore({
    workspaceRoot: tmpDir,
    storageDir: "codali/context",
  });
  const laneId = "job_1:task_a:architect";
  const msg1: ContextMessageRecord = { role: "user", content: "hello", ts: Date.now() };
  const msg2: ContextMessageRecord = { role: "assistant", content: "ok", ts: Date.now() + 1, model: "test" };

  await store.append(laneId, [msg1, msg2]);
  const snapshot = await store.loadLane(laneId);

  assert.equal(snapshot.messageCount, 2);
  assert.equal(snapshot.messages[0].content, "hello");
  assert.equal(snapshot.messages[1].model, "test");
  assert.equal(snapshot.byteSize > 0, true);
  assert.equal(snapshot.updatedAt > 0, true);
});

test("ContextStore replaces lane contents", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-store-"));
  const store = new ContextStore({
    workspaceRoot: tmpDir,
    storageDir: "codali/context",
  });
  const laneId = "job_2:task_b:builder";
  const msg1: ContextMessageRecord = { role: "user", content: "first", ts: Date.now() };
  const msg2: ContextMessageRecord = { role: "assistant", content: "second", ts: Date.now() + 1 };

  await store.append(laneId, [msg1, msg2]);
  await store.replace(laneId, [msg2]);
  const snapshot = await store.loadLane(laneId);

  assert.equal(snapshot.messageCount, 1);
  assert.equal(snapshot.messages[0].content, "second");
});

test("ContextStore truncates lane history", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-store-"));
  const store = new ContextStore({
    workspaceRoot: tmpDir,
    storageDir: "codali/context",
  });
  const laneId = "job_3:task_c:critic";
  const msgs: ContextMessageRecord[] = [
    { role: "user", content: "one", ts: Date.now() },
    { role: "assistant", content: "two", ts: Date.now() + 1 },
    { role: "assistant", content: "three", ts: Date.now() + 2 },
  ];

  await store.append(laneId, msgs);
  const snapshot = await store.truncate(laneId, 2);

  assert.equal(snapshot.messageCount, 2);
  assert.equal(snapshot.messages[0].content, "two");
  assert.equal(snapshot.messages[1].content, "three");
});

test("ContextStore blocks paths outside workspace root", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-store-"));
  const store = new ContextStore({
    workspaceRoot: tmpDir,
    storageDir: "../outside",
  });
  const msg: ContextMessageRecord = { role: "user", content: "nope", ts: Date.now() };

  await assert.rejects(async () => {
    await store.append("lane", msg);
  }, /outside workspace root/);
});
