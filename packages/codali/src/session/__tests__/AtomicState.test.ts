import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson, withStateLock } from "../AtomicState.js";
import { SessionStore } from "../SessionStore.js";

test("disk-full partial temporary write preserves the previous state and removes its incomplete file", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-enospc-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json"); await atomicWriteJson(file, { revision: 1 });
  const original = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (typeof args[0] === "string" && args[0].endsWith(".tmp")) {
      handle.writeFile = async () => { await handle.write('{"revision":'); throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" }); };
    }
    return handle;
  });
  await assert.rejects(atomicWriteJson(file, { revision: 2 }), { code: "ENOSPC" }); mock.mock.restore();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 1 });
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
  await atomicWriteJson(file, { revision: 2 }); assert.equal(JSON.parse(await fs.readFile(file, "utf8")).revision, 2);
});

test("directory fsync failure is reported even when rename already made the new state visible", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-fsync-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json"); await atomicWriteJson(file, { revision: 1 });
  const original = fs.open.bind(fs);
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (args[0] === root) handle.sync = async () => { throw Object.assign(new Error("I/O failure"), { code: "EIO" }); };
    return handle;
  });
  await assert.rejects(atomicWriteJson(file, { revision: 2 }), { code: "EIO" }); mock.mock.restore();
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 2 });
  assert.deepEqual(await fs.readdir(root), ["state.json"]);
});

test("read-only session directories reject updates without replacing durable work", { skip: process.getuid?.() === 0 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-readonly-"));
  const store = new SessionStore({ workspaceRoot: root });
  await store.createSession({ sessionId: "s", repoRoot: root, task: "Preserve" });
  const state = await store.initializeWork("s", "Preserve"); const directory = path.join(root, ".mcoda/codali/sessions/s");
  t.after(async () => { await fs.chmod(directory, 0o700); await fs.rm(root, { recursive: true, force: true }); });
  await fs.chmod(directory, 0o500);
  await assert.rejects(store.updateWork("s", state.revision, current => { current.constraints.push("Must not commit"); }));
  assert.deepEqual(await store.readWork("s"), state);
});

test("a killed process releases its SQLite transaction lock without stale PID cleanup", { skip: process.platform === "win32", timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-killed-lock-"));
  const file = path.join(root, "state.json");
  const moduleUrl = new URL("../AtomicState.js", import.meta.url).href;
  const script = `import {withStateLock} from ${JSON.stringify(moduleUrl)};setInterval(()=>{},1000);await withStateLock(process.argv[1],async()=>{console.log('locked');await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, file], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  t.after(async () => { child.kill("SIGKILL"); await closed; await fs.rm(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    let output = ""; let error = "";
    child.stdout.on("data", data => { output += data; if (output.includes("locked\n")) resolve(); });
    child.stderr.on("data", data => { error += data; });
    child.once("error", reject); child.once("exit", () => reject(new Error(`Lock child exited before acquisition: ${error}`)));
  });
  child.kill("SIGKILL"); await closed;
  const result = await withStateLock(file, async () => { await atomicWriteJson(file, { recovered: true }); return true; }, 1000);
  assert.equal(result, true); assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { recovered: true });
});
