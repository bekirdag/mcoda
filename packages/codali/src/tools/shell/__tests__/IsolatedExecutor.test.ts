import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor, darwinSandboxProfile, executorStatus } from "../IsolatedExecutor.js";
import { createShellTool } from "../ShellTool.js";

test("Darwin policy confines temporary access to one owned directory and quotes hostile path syntax", () => {
  const profile = darwinSandboxProfile('/Users/test/repo"(allow default)', "/private/tmp/codali-shell-123", ["/Users/test/repo/src"], []);
  assert.ok(!profile.includes('(subpath "/private/tmp")'));
  assert.ok(!profile.includes('(subpath "/private/var/folders")'));
  assert.ok(profile.includes('(subpath "/private/tmp/codali-shell-123")'));
  assert.ok(profile.includes('repo\\"(allow default)'));
  assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(deny file-write\*.*\.mcoda/);
});

test("isolated shell has private scratch and cannot read or overwrite sibling temporary files", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-private-scratch-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codali-private-neighbor-"));
  const secret = path.join(outside, "private.txt");
  try {
    await fs.writeFile(secret, "must remain private");
    const execute = createIsolatedExecutor({ status });
    const context = { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 };
    const result = await execute("node", ["-e", `const fs=require('fs'),path=require('path'),os=require('os');
const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'probe-'));fs.writeFileSync(path.join(scratch,'a'),'ok');
console.log(JSON.stringify({scratch,home:os.homedir(),secret:process.env.MCODA_MSWARM_API_KEY??null}));`], context);
    const receipt = JSON.parse(result.output) as { scratch: string; home: string; secret: string | null };
    assert.equal(receipt.secret, null); assert.notEqual(receipt.home, os.homedir());
    if (status.backend === "sandbox-exec") assert.equal(await fs.stat(receipt.scratch).then(() => true, () => false), false);
    for (const operation of ["readFileSync", "writeFileSync"]) {
      await assert.rejects(execute("node", ["-e", `require('fs').${operation}(process.argv[1]${operation === "writeFileSync" ? ", 'changed'" : ""})`, secret], context));
    }
    assert.equal(await fs.readFile(secret, "utf8"), "must remain private");
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test("isolated commands cannot write outside task scope, through symlinks, or into Git metadata", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-isolation-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "codali-outside-"));
  try {
    await fs.mkdir(path.join(root, "allowed")); await fs.mkdir(path.join(root, ".git")); await fs.mkdir(path.join(root, ".mcoda"));
    await fs.writeFile(path.join(root, "protected.txt"), "original"); await fs.writeFile(path.join(outside, "secret.txt"), "private");
    await fs.symlink(outside, path.join(root, "escape"));
    const execute = createIsolatedExecutor({ status });
    const context = { workspaceRoot: root, allowedWritePaths: ["allowed"], shellTimeoutMs: 5000 };
    await execute("node", ["-e", "require('fs').writeFileSync('allowed/new.txt','ok')"], context);
    assert.equal(await fs.readFile(path.join(root, "allowed/new.txt"), "utf8"), "ok");
    for (const script of ["require('fs').writeFileSync('protected.txt','changed')", "require('fs').writeFileSync('.git/config','changed')", "require('fs').readFileSync('escape/secret.txt')"]) await assert.rejects(execute("node", ["-e", script], context));
    assert.equal(await fs.readFile(path.join(root, "protected.txt"), "utf8"), "original");
    await assert.rejects(execute("node", ["-e", "0"], { ...context, allowedWritePaths: ["escape"] }), /outside/);
    await assert.rejects(execute("node", ["-e", "require('fs').writeFileSync('.mcoda/mcoda.db','overwrite')"], { ...context, allowedWritePaths: ["."] }));
    await assert.rejects(execute("node", ["-e", "0"], { ...context, allowedWritePaths: [".mcoda"] }), /control metadata/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test("isolated commands have no network access by default", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-network-"));
  try {
    const execute = createIsolatedExecutor({ status });
    const result = await execute("node", ["-e", "const s=require('net').connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(9));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),500)"], { workspaceRoot: root, shellTimeoutMs: 2000 });
    assert.equal((result.data as { exitCode: number }).exitCode, 0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("module cwd retains root-relative sandbox write scopes", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-module-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "module"));
  await fs.writeFile(path.join(root, "module", "allowed.txt"), "original");
  await fs.writeFile(path.join(root, "protected.txt"), "protected");
  const tool = createShellTool();
  const context = { workspaceRoot: root, shellAllowlist: ["node"], allowShell: true, allowedWritePaths: ["module/allowed.txt"], shellExecutor: createIsolatedExecutor({ status }), shellTimeoutMs: 5000 };
  await tool.handler({ command: "node", cwd: "module", args: ["-e", "require('fs').writeFileSync('allowed.txt','changed')"] }, context);
  assert.equal(await fs.readFile(path.join(root, "module", "allowed.txt"), "utf8"), "changed");
  await assert.rejects(tool.handler({ command: "node", cwd: "module", args: ["-e", "require('fs').writeFileSync('../protected.txt','changed')"] }, context));
  assert.equal(await fs.readFile(path.join(root, "protected.txt"), "utf8"), "protected");
});
