import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Connection, WorkspaceMigrations, WorkspaceRepository } from "@mcoda/db";
import { McodaProjectTaskAuthority } from "../ProjectTaskAuthority.js";

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-project-authority-"));
  const connection = await Connection.open(path.join(root, "mcoda.db"));
  await WorkspaceMigrations.run(connection.db);
  const repo = new WorkspaceRepository(connection.db, connection);
  const project = await repo.createProjectIfMissing({ key: "project", name: "Project" });
  const [epic] = await repo.insertEpics([{ projectId: project.id, key: "epic", title: "Epic", description: "", priority: 1 }]);
  const [story] = await repo.insertStories([{ projectId: project.id, epicId: epic.id, key: "story", title: "Story", description: "" }]);
  const createTask = async (key: string) => (await repo.insertTasks([{ projectId: project.id, epicId: epic.id, userStoryId: story.id, key,
    title: "Preserve the parent objective", description: "Implement and verify the requested behavior.", status: "not_started", metadata: { owner: "user" } }]))[0];
  const task = await createTask("task");
  return { repo, task, createTask, close: async () => { await repo.close(); await fs.rm(root, { recursive: true, force: true }); } };
};

test("project task acquisition is fenced, transactional and dependent on the canonical revision", async () => {
  const f = await fixture(); let now = Date.now();
  const authority = new McodaProjectTaskAuthority(f.repo, { now: () => now, leaseMs: 1000 });
  try {
    const snapshot = await authority.read(f.task.key);
    const outcomes = await Promise.allSettled([authority.acquire(f.task.id, "one", snapshot.revision), authority.acquire(f.task.id, "two", snapshot.revision)]);
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    const first = await authority.read(f.task.id); assert.equal(first.status, "in_progress");
    await authority.check(first); now += 1001;
    await assert.rejects(authority.renew(first), /lease expired/);
    const second = await authority.acquire(f.task.id, "replacement", first.revision);
    await assert.rejects(authority.check(first), /lease expired/);
    await authority.release(first); await authority.check(second);
    await f.repo.updateTask(f.task.id, { description: "Changed by another owner" });
    await assert.rejects(authority.check(second), /Project task changed/);
    assert.equal((await f.repo.getTaskById(f.task.id))?.metadata?.owner, "user");
  } finally { await f.close(); }
});

test("project dependencies and existing foreign work prevent terminal claims", async () => {
  const f = await fixture(); const authority = new McodaProjectTaskAuthority(f.repo);
  try {
    const dependency = await f.createTask("dependency");
    await f.repo.insertTaskDependencies([{ taskId: f.task.id, dependsOnTaskId: dependency.id, relationType: "depends_on" }]);
    let snapshot = await authority.read(f.task.id);
    await assert.rejects(authority.acquire(f.task.id, "one", snapshot.revision), /dependencies/);
    await f.repo.updateTask(dependency.id, { status: "completed" });
    await assert.rejects(authority.acquire(f.task.id, "one", snapshot.revision), /changed/);
    await f.repo.updateTask(f.task.id, { status: "in_progress" }); snapshot = await authority.read(f.task.id);
    await assert.rejects(authority.acquire(f.task.id, "one", snapshot.revision), /cannot be claimed/);
  } finally { await f.close(); }
});

test("verified handoff is idempotent, records one review transition and never skips QA", async () => {
  const f = await fixture(); const authority = new McodaProjectTaskAuthority(f.repo);
  try {
    const current = await authority.read(f.task.id); const lease = await authority.acquire(f.task.id, "session", current.revision);
    const submission = { operationId: "durable-intent", sessionId: "session", evidenceDigest: "a".repeat(64), evidenceIds: ["verified-receipt"], summary: "Tests and review passed." };
    const accepted = await authority.submit(lease, submission);
    assert.equal(accepted.status, "ready_to_code_review");
    assert.deepEqual(await authority.submit(lease, submission), accepted);
    await assert.rejects(authority.submit(lease, { ...submission, evidenceDigest: "b".repeat(64) }), /Conflicting/);
    const events = await f.repo.getDb().all("SELECT to_status FROM task_status_events WHERE task_id = ?", f.task.id);
    assert.deepEqual(events.map((row: { to_status: string }) => row.to_status), ["in_progress", "ready_to_code_review"]);
    await f.repo.updateTask(f.task.id, { status: "changes_requested" });
    await assert.rejects(authority.submit(lease, submission), /changed after submission/);
  } finally { await f.close(); }
});
