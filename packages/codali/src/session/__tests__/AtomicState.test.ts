import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { atomicWriteJson, syncStateDirectory, withStateLock } from "../AtomicState.js";
import { SessionStore } from "../SessionStore.js";

test("transient Windows rename sharing failures retain the original state until atomic publication succeeds", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-rename-sharing-"));
  const file = path.join(root, "state.json");
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const originalRename = fs.rename.bind(fs);
  try {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      await atomicWriteJson(file, { revision: 1 }); let attempts = 0;
      const injected = Object.assign(new Error("Transient sharing conflict"), { code });
      const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 1 });
        assert.deepEqual(JSON.parse(await fs.readFile(args[0], "utf8")), { revision: 2 });
        if (++attempts <= 2) throw injected;
        return originalRename(...args);
      });
      try {
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        await atomicWriteJson(file, { revision: 2 });
        assert.equal(attempts, 3);
        assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 2 });
        assert.deepEqual(await fs.readdir(root), ["state.json"]);
      } finally { mock.mock.restore(); Object.defineProperty(process, "platform", platform); }
    }
  } finally { Object.defineProperty(process, "platform", platform); await fs.rm(root, { recursive: true, force: true }); }
});

test("permanent rename failures exhaust a bounded retry only on Windows and never delete the previous state", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-rename-failure-"));
  const file = path.join(root, "state.json"); await atomicWriteJson(file, { revision: 1 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    for (const [target, code, expectedAttempts] of [
      ["win32", "EPERM", 8], ["win32", "EACCES", 8], ["win32", "EBUSY", 8],
      ["win32", "EIO", 1], ["win32", "ENOSPC", 1], ["win32", "ENOENT", 1],
      ["linux", "EPERM", 1], ["darwin", "EACCES", 1],
    ] as const) {
      let attempts = 0; const injected = Object.assign(new Error("Persistent rename failure"), { code });
      const mock = t.mock.method(fs, "rename", async () => { attempts++; throw injected; });
      try {
        Object.defineProperty(process, "platform", { ...platform, value: target });
        await assert.rejects(atomicWriteJson(file, { revision: 2 }), error => error === injected);
        assert.equal(attempts, expectedAttempts, `${target}/${code}`);
        assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 1 });
        assert.deepEqual(await fs.readdir(root), ["state.json"]);
      } finally { mock.mock.restore(); Object.defineProperty(process, "platform", platform); }
    }
  } finally { Object.defineProperty(process, "platform", platform); await fs.rm(root, { recursive: true, force: true }); }
});

test("Windows replacement recovers after a real reader releases its non-delete-sharing handle", { skip: process.platform !== "win32", timeout: 15000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-windows-reader-"));
  const file = path.join(root, "state.json"); await atomicWriteJson(file, { revision: 1 });
  const script = "$stream=[System.IO.File]::Open($env:CODALI_TEST_STATE_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); [Console]::WriteLine('HELD'); [Console]::ReadLine() | Out-Null; $stream.Dispose(); [Console]::WriteLine('RELEASED')";
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, CODALI_TEST_STATE_FILE: file }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let output = ""; let errors = ""; let childClosed = false;
  child.stdout.on("data", data => { output = (output + String(data)).slice(-4096); });
  child.stderr.on("data", data => { errors = (errors + String(data)).slice(-4096); });
  const closed = new Promise<void>(resolve => child.once("close", () => { childClosed = true; resolve(); }));
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; await fs.rm(root, { recursive: true, force: true }); });
  const awaitMarker = (marker: string, timeoutMs: number) => new Promise<void>((resolve, reject) => {
    const diagnostic = (reason: string) => new Error(`Windows sharing fixture ${reason} before ${marker}; stdout=${output}; stderr=${errors}`);
    const cleanup = () => {
      clearTimeout(timer); child.stdout.off("data", check); child.off("error", fail);
      child.stdin.off("error", fail); child.off("close", onClose);
    };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const check = () => { if (output.includes(marker)) { cleanup(); resolve(); } };
    const onClose = () => { if (output.includes(marker)) check(); else fail(diagnostic("closed")); };
    const timer = setTimeout(() => fail(diagnostic("timed out")), timeoutMs);
    child.stdout.on("data", check); child.once("error", fail);
    child.stdin.once("error", fail); child.once("close", onClose);
    if (childClosed) onClose(); else check();
  });
  await awaitMarker("HELD", 8000);
  const original = fs.rename.bind(fs); let attempts = 0; let observedSharingFailure = false;
  const mock = t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    attempts++;
    try { return await original(...args); }
    catch (error) {
      if (attempts === 1) {
        assert.ok(["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? ""));
        observedSharingFailure = true;
        // Confirm actual handle disposal before testing recovery. The injected
        // tests above independently exercise the unchanged bounded retry policy.
        const releaseStarted = Date.now();
        const released = awaitMarker("RELEASED", 4000);
        child.stdin.end("release\n");
        await released;
        t.diagnostic(`Reader confirmed handle release in ${Date.now() - releaseStarted} ms before the rename retry`);
      }
      throw error;
    }
  });
  try {
    await atomicWriteJson(file, { revision: 2 });
    assert.equal(observedSharingFailure, true); assert.ok(attempts >= 2 && attempts <= 8);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 2 });
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  } finally { mock.mock.restore(); }
});

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

test("directory-only Windows fsync compatibility never hides data flush, open or POSIX permission failures", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-sync-platform-"));
  const file = path.join(root, "state.json"); await atomicWriteJson(file, { revision: 1 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const original = fs.open.bind(fs); let mode = "directory"; let code = "EPERM";
  const injected = () => Object.assign(new Error("Injected filesystem error"), { code });
  const mock = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (mode === "open" && args[0] === root) throw injected();
    const handle = await original(...args);
    if (mode === "directory" && args[0] === root || mode === "file" && String(args[0]).endsWith(".tmp")) handle.sync = async () => { throw injected(); };
    return handle;
  });
  try {
    for (const target of ["linux", "darwin", "win32"]) {
      Object.defineProperty(process, "platform", { ...platform, value: target });
      for (code of ["EPERM", "EIO", "ENOSPC", "EACCES"]) {
        if (target === "win32" && code === "EPERM") await syncStateDirectory(root);
        else await assert.rejects(syncStateDirectory(root), { code });
      }
    }
    code = "EPERM"; mode = "open";
    await assert.rejects(syncStateDirectory(root), { code });
    mode = "file";
    await assert.rejects(atomicWriteJson(file, { revision: 2 }), { code });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { revision: 1 });
    assert.deepEqual(await fs.readdir(root), ["state.json"]);
  } finally {
    Object.defineProperty(process, "platform", platform); mock.mock.restore();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read-only session directories reject updates without replacing durable work", { skip: process.platform === "win32" ? "POSIX directory modes are not Windows ACLs" : process.getuid?.() === 0 }, async t => {
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
