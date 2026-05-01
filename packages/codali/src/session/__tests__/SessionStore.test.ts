import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../SessionStore.js";

test("SessionStore creates sessions and builds resume bundles", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-session-"));
  const store = new SessionStore({ workspaceRoot });

  const session = await store.createSession({
    sessionId: "session-1",
    repoRoot: workspaceRoot,
    task: "Investigate Codali",
    instructionSources: ["AGENTS.md"],
  });
  await store.addRun(session.sessionId, "run-1");
  await store.appendTranscript(session.sessionId, {
    type: "run_started",
    runId: "run-1",
    data: { task: session.task },
  });
  await store.appendTranscript(session.sessionId, {
    type: "tool_result",
    runId: "run-1",
    data: { name: "docdex_search", ok: true },
  });
  await store.appendTranscript(session.sessionId, {
    type: "final",
    runId: "run-1",
    data: { content: "Done" },
  });

  const summary = await store.compactSession(session.sessionId);
  assert.equal(summary.sessionId, "session-1");
  assert.match(summary.summary, /Investigate Codali/);
  assert.match(summary.summary, /tool_result=1/);

  const bundle = await store.buildResumeBundle(session.sessionId, { recentEvents: 2 });
  assert.equal(bundle.metadata.runIds[0], "run-1");
  assert.equal(bundle.metadata.instructionSources[0], "AGENTS.md");
  assert.equal(bundle.latestSummary?.eventCount, 3);
  assert.equal(bundle.recentEvents.length, 2);
  assert.equal(bundle.recentEvents[1]?.type, "final");
});

test("SessionStore lists sessions by updated time", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-session-"));
  const store = new SessionStore({ workspaceRoot });

  await store.createSession({ sessionId: "old", repoRoot: workspaceRoot, task: "old" });
  await store.createSession({ sessionId: "new", repoRoot: workspaceRoot, task: "new" });
  await store.appendTranscript("old", { type: "note", data: { value: 1 } });

  const sessions = await store.listSessions();
  assert.equal(sessions[0]?.sessionId, "old");
  assert.equal(sessions.length, 2);
});
