import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { SessionStore } from "../SessionStore.js";
import { replaceWorkPlan } from "../WorkState.js";

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

test("separate processes fence competing work revisions and retain every session record", { timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-process-writers-"));
  const store = new SessionStore({ workspaceRoot: root });
  await store.createSession({ sessionId: "s", repoRoot: root, task: "Original" });
  const initial = await store.initializeWork("s", "Original");
  const moduleUrl = new URL("../SessionStore.js", import.meta.url).href;
  const script = `
    import { SessionStore } from ${JSON.stringify(moduleUrl)};
    const [root, revision, owner] = process.argv.slice(1);
    const store = new SessionStore({ workspaceRoot: root });
    const go = new Promise(resolve => process.once('message', resolve));
    process.send({ type: 'ready' }); await go;
    let outcome;
    try {
      await store.updateWork('s', Number(revision), state => { state.constraints.push(owner); });
      outcome = 'committed';
    } catch (error) {
      if (!/revision conflict/i.test(error.message)) throw error;
      outcome = 'conflict';
    }
    await store.addRun('s', owner);
    await store.appendTranscript('s', { type: 'note', data: { owner } });
    process.send({ type: 'result', owner, outcome }, () => process.disconnect());
  `;
  const workers = Array.from({ length: 4 }, (_, i) => {
    const owner = `writer-${i}`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, root, String(initial.revision), owner], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr!.on("data", chunk => { stderr += chunk; });
    let ready!: () => void; let rejectReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { ready = resolve; rejectReady = reject; });
    let result: { owner: string; outcome: string } | undefined;
    child.on("message", message => {
      const value = message as { type: string; owner: string; outcome: string };
      if (value.type === "ready") ready();
      if (value.type === "result") result = value;
    });
    const closed = new Promise<{ owner: string; outcome: string }>((resolve, reject) => {
      child.once("error", error => { rejectReady(error); reject(error); });
      child.once("close", code => {
        if (code !== 0 || !result) {
          const error = new Error(`Writer ${owner} failed (${code}): ${stderr}`);
          rejectReady(error); reject(error);
        } else resolve(result);
      });
    });
    const abort = () => { child.kill("SIGKILL"); rejectReady(new Error("Writer test aborted")); };
    t.signal.addEventListener("abort", abort, { once: true });
    return { child, started, closed, abort };
  });
  t.after(async () => {
    for (const worker of workers) {
      t.signal.removeEventListener("abort", worker.abort);
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    }
    await Promise.allSettled(workers.map(worker => worker.closed));
    await fs.rm(root, { recursive: true, force: true });
  });
  const [, results] = await Promise.all([
    Promise.all(workers.map(worker => worker.started)).then(() => {
      for (const worker of workers) worker.child.send({ type: "go" });
    }),
    Promise.all(workers.map(worker => worker.closed)),
  ]);
  const winners = results.filter(result => result.outcome === "committed");
  assert.equal(winners.length, 1);
  assert.equal(results.filter(result => result.outcome === "conflict").length, 3);
  const final = await store.readWork("s");
  assert.equal(final.revision, initial.revision + 1);
  assert.deepEqual(final.constraints, [winners[0].owner]);
  assert.equal(final.goalId, initial.goalId);
  assert.equal(final.originalObjective, "Original");
  assert.deepEqual((await store.readSession("s")).runIds.sort(), results.map(result => result.owner).sort());
  assert.deepEqual((await store.readTranscript("s")).map(event => event.data.owner).sort(), results.map(result => result.owner).sort());
});

test("flat v1 work records upgrade additively without discarding goals, evidence or extensions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-flat-migration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ workspaceRoot: root });
  await store.createSession({ sessionId: "s", repoRoot: root, task: "Original" });
  const legacy = await store.initializeWork("s", "Original");
  delete legacy.phases; delete legacy.planRevision; delete legacy.planHistory;
  legacy.constraints.push("Keep the original objective");
  legacy.evidence.push({ id: "proof-1", taskId: "T1", criterionIds: ["R1"], kind: "tool", ok: false,
    summary: "Prior attempt failed; retain its receipt", invocationId: "invocation-1", inputHashes: { "main.ts": "original-hash" }, at: legacy.createdAt });
  legacy.decisions.push({ id: "decision-1", title: "Keep the public API", rationale: "Compatibility", alternatives: ["Breaking replacement"], paths: ["main.ts"] });
  legacy.checkpoints.push({ id: "checkpoint-1", at: legacy.createdAt, goalRevision: 1, note: "Resume here", uncertainInvocationIds: ["pending-1"] });
  const extended = { ...legacy, futureExtension: { opaque: ["preserve"] } };
  const file = path.join(root, ".mcoda/codali/sessions/s/work.json");
  await fs.writeFile(file, JSON.stringify(extended));
  assert.deepEqual(await store.readWork("s"), extended);
  const updated = await store.updateWork("s", legacy.revision, state => {
    replaceWorkPlan(state, [{ ...state.tasks[0], phaseId: "phase-1" }], [
      { id: "phase-1", title: "First phase", dependsOn: [], exitRequirementIds: ["R1"] },
    ], "Add explicit phases");
  });
  assert.equal(updated.planRevision, 2);
  assert.equal(updated.planHistory?.[0].revision, 1);
  assert.deepEqual(updated.planHistory?.[0].phases, []);
  assert.deepEqual(updated.checkpoints, legacy.checkpoints);
  assert.deepEqual(updated.evidence, legacy.evidence);
  assert.deepEqual(updated.decisions, legacy.decisions);
  assert.deepEqual(updated.constraints, legacy.constraints);
  assert.equal(updated.goalId, legacy.goalId);
  assert.equal(updated.originalObjective, legacy.originalObjective);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")).futureExtension, extended.futureExtension);
  assert.deepEqual(await new SessionStore({ workspaceRoot: root }).readWork("s"), updated);
});

test("future work schemas reject initialization and updates without touching the record", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-future-work-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SessionStore({ workspaceRoot: root });
  await store.createSession({ sessionId: "s", repoRoot: root, task: "Original" });
  const state = await store.initializeWork("s", "Original");
  const file = path.join(root, ".mcoda/codali/sessions/s/work.json");
  const bytes = JSON.stringify({ ...state, schemaVersion: 2, futureData: { required: true } });
  await fs.writeFile(file, bytes);
  await assert.rejects(store.readWork("s"), /Unsupported/);
  await assert.rejects(store.initializeWork("s", "Replacement"), /Unsupported/);
  let mutationCalled = false;
  await assert.rejects(store.updateWork("s", state.revision, () => { mutationCalled = true; }), /Unsupported/);
  assert.equal(mutationCalled, false);
  assert.equal(await fs.readFile(file, "utf8"), bytes);
});
