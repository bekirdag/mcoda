import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceLock } from "../WorkspaceLock.js";

test("WorkspaceLock blocks concurrent runs", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-lock-"));
  const lock1 = new WorkspaceLock(workspaceRoot, "run-1");
  await lock1.acquire();

  const lock2 = new WorkspaceLock(workspaceRoot, "run-2");
  await assert.rejects(async () => {
    await lock2.acquire();
  }, /Workspace is locked/);

  await lock1.release();
});

test("WorkspaceLock does not evict an unknown owner based only on age", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-lock-"));
  const lockPath = path.join(workspaceRoot, "locks", "codali.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const staleInfo = { runId: "old-run", acquiredAt: Date.now() - 10_000 };
  writeFileSync(lockPath, JSON.stringify(staleInfo), "utf8");

  const lock = new WorkspaceLock(workspaceRoot, "new-run", 1);
  await assert.rejects(lock.acquire(), /Workspace is locked/);

  const current = JSON.parse(readFileSync(lockPath, "utf8")) as { runId: string };
  assert.equal(current.runId, "old-run");

  await lock.release();
});

test("WorkspaceLock clears recent lock from dead process", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-lock-"));
  const lockPath = path.join(workspaceRoot, "locks", "codali.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      runId: "dead-run",
      acquiredAt: Date.now(),
      pid: 2147483647,
      hostname: os.hostname(),
    }),
    "utf8",
  );

  const lock = new WorkspaceLock(workspaceRoot, "new-run");
  await lock.acquire();

  const current = JSON.parse(readFileSync(lockPath, "utf8")) as { runId: string; pid?: number };
  assert.equal(current.runId, "new-run");
  assert.equal(current.pid, process.pid);

  await lock.release();
});

test("WorkspaceLock clears legacy lock after terminal run log", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-lock-"));
  const lockPath = path.join(workspaceRoot, "locks", "codali.lock");
  const logsDir = path.join(workspaceRoot, "logs");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    lockPath,
    JSON.stringify({
      runId: "legacy-run",
      acquiredAt: Date.now(),
    }),
    "utf8",
  );
  writeFileSync(
    path.join(logsDir, "legacy-run.jsonl"),
    `${JSON.stringify({ type: "run_failed", timestamp: new Date().toISOString(), data: { run_id: "legacy-run" } })}\n`,
    "utf8",
  );

  const lock = new WorkspaceLock(workspaceRoot, "new-run");
  await lock.acquire();

  const current = JSON.parse(readFileSync(lockPath, "utf8")) as { runId: string };
  assert.equal(current.runId, "new-run");

  await lock.release();
});

test("WorkspaceLock releases on signal", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-lock-"));
  const lock = new WorkspaceLock(workspaceRoot, "run-signal");
  await lock.acquire();
  const lockPath = path.join(workspaceRoot, "locks", "codali.lock");
  assert.ok(existsSync(lockPath));

  const unregister = lock.registerSignalHandlers({ exitOnSignal: false });
  process.emit("SIGINT");
  const start = Date.now();
  while (existsSync(lockPath) && Date.now() - start < 2000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(!existsSync(lockPath));
  unregister();
});

test("WorkspaceLock explains a suspended owner without evicting it", { skip: process.platform !== "linux", concurrency: false }, async () => {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-lock-stopped-"));
  const lockPath = path.join(workspaceRoot, "locks", "codali.lock");
  try {
    process.kill(child.pid!, "SIGSTOP");
    const deadline = Date.now() + 3000;
    while (!/^State:\s+T\b/m.test(readFileSync(`/proc/${child.pid}/status`, "utf8"))) {
      assert.ok(Date.now() < deadline, "child did not stop");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ runId: "paused-session", acquiredAt: Date.now(), pid: child.pid, hostname: os.hostname() }));
    const lock = new WorkspaceLock(workspaceRoot, "new-session");
    await assert.rejects(lock.acquire(), error => {
      assert.match(String(error), /suspended Codali session/);
      assert.match(String(error), /run fg/);
      assert.match(String(error), new RegExp(`process ${child.pid}`));
      return true;
    });
    assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).runId, "paused-session");
  } finally {
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.kill("SIGKILL"); await exited;
  }
  const next = new WorkspaceLock(workspaceRoot, "recovered-session");
  await next.acquire();
  await next.release();
  assert.equal(existsSync(lockPath), false);
});
