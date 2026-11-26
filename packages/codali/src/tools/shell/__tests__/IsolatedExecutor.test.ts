import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor, darwinSandboxProfile, executorStatus } from "../IsolatedExecutor.js";
import { createShellTool, DEVELOPMENT_COMMANDS } from "../ShellTool.js";

test("isolated system Chrome renders a local app with fonts without mounting host profiles", async t => {
  const status = executorStatus();
  if (status.backend !== "bubblewrap" || !status.available) { t.skip("Linux bubblewrap only"); return; }
  if (!(await fs.stat("/opt/google/chrome/chrome").catch(() => undefined))?.isFile()) { t.skip("System Chrome is not installed"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-chrome-local-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.ok(DEVELOPMENT_COMMANDS.includes("google-chrome"));
  const script = `
    const http = require('http'), { execFile } = require('child_process'), fs = require('fs');
    if (fs.existsSync(process.argv[1])) throw Error('Host profile exposed');
    const server = http.createServer((req,res) => { res.setHeader('Content-Type','text/html'); res.end('<main id="result">waiting</main><script>document.getElementById("result").textContent="local-app-rendered"</script>'); });
    server.listen(0,'127.0.0.1', () => execFile('google-chrome', ['--headless','--no-sandbox','--disable-dev-shm-usage','--log-level=3','--dump-dom','http://127.0.0.1:'+server.address().port], {timeout:20000}, (error,stdout,stderr) => {
      server.close(); if(error){console.error(error);process.exitCode=1;} console.log(stdout);console.error(stderr);
    }));`;
  const result = await createIsolatedExecutor({ status, network: false })("node", ["-e", script, path.join(os.homedir(), ".config/google-chrome")], {
    workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 30000, shellMaxOutputBytes: 16000,
  });
  assert.match(result.output, /<main id="result">local-app-rendered<\/main>/);
  assert.doesNotMatch(result.output, /Fontconfig error/);
});

test("package caches persist across invocations without exposing state or permitting source writes", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codali-cache-test-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo"), cacheRoot = path.join(parent, "state", "package-cache");
  await fs.mkdir(root); await fs.mkdir(path.dirname(cacheRoot));
  const secret = path.join(parent, "state", "credentials.json");
  await fs.writeFile(secret, "private");
  const context = { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 };
  const execute = createIsolatedExecutor({ status, cacheRoot });
  await execute("node", ["-e", "const fs=require('fs'),p=require('path');for(const key of ['NPM_CONFIG_CACHE','GRADLE_USER_HOME','PIP_CACHE_DIR','UV_CACHE_DIR','CARGO_HOME','XDG_CACHE_HOME']){fs.mkdirSync(process.env[key],{recursive:true});fs.writeFileSync(p.join(process.env[key],'artifact'),'cached')};fs.writeFileSync(p.join(process.env.HOME,'ephemeral'),'temporary')"], context);
  const result = await createIsolatedExecutor({ status, cacheRoot })("node", ["-e", "const fs=require('fs'),p=require('path');console.log(fs.readFileSync(p.join(process.env.GRADLE_USER_HOME,'artifact'),'utf8'));if(fs.existsSync(p.join(process.env.HOME,'ephemeral')))throw Error('HOME leaked')"], context);
  assert.equal(result.output.trim(), "cached");
  await assert.rejects(execute("node", ["-e", "require('fs').writeFileSync('unexpected.txt','no')"], context));
  await assert.rejects(execute("node", ["-e", "console.log(require('fs').readFileSync(process.argv[1],'utf8'))", secret], context));
  await fs.symlink(secret, path.join(cacheRoot, "npm", "escape"));
  await assert.rejects(execute("node", ["-e", "console.log(require('fs').readFileSync(require('path').join(process.env.NPM_CONFIG_CACHE,'escape'),'utf8'))"], context));
  assert.deepEqual(await fs.readdir(root), []);
  const other = createIsolatedExecutor({ status, cacheRoot: path.join(parent, "other-cache") });
  assert.equal((await other("node", ["-e", "console.log(require('fs').existsSync(require('path').join(process.env.GRADLE_USER_HOME,'artifact')))"], context)).output.trim(), "false");
  await fs.symlink(cacheRoot, path.join(parent, "cache-alias"));
  for (const unsafe of [root, parent, os.homedir(), path.join(parent, "cache-alias")]) {
    await assert.rejects(createIsolatedExecutor({ status, cacheRoot: unsafe })("node", ["-e", "0"], context), /cache must/i);
  }
});

test("trusted runtime mounts expose libraries read-only without exposing adjacent files", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-runtime-work-"));
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codali-runtime-install-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(parent, { recursive: true, force: true }); });
  const runtime = path.join(parent, "runtime"); await fs.mkdir(runtime);
  await fs.writeFile(path.join(runtime, "library.txt"), "library"); await fs.writeFile(path.join(parent, "private.txt"), "private");
  const execute = createIsolatedExecutor({ status, readOnlyRuntimeRoots: [runtime] });
  const context = { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 };
  const result = await execute("node", ["-e", "console.log(require('fs').readFileSync(process.argv[1],'utf8'))", path.join(runtime, "library.txt")], context);
  assert.match(result.output, /library/);
  for (const [operation, target] of [["readFileSync", path.join(parent, "private.txt")], ["writeFileSync", path.join(runtime, "library.txt")]]) {
    await assert.rejects(execute("node", ["-e", `require('fs').${operation}(process.argv[1]${operation === "writeFileSync" ? ", 'changed'" : ""})`, target], context));
  }
  await assert.rejects(createIsolatedExecutor({ status, readOnlyRuntimeRoots: [os.homedir()] })("node", ["-e", ""], context), /dedicated installed/);
});

test("Linux sandbox exposes distribution identity without exposing private system files", async t => {
  const status = executorStatus();
  if (status.backend !== "bubblewrap" || !status.available) { t.skip("Linux bubblewrap only"); return; }
  const expected = await fs.readFile("/etc/os-release", "utf8");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-os-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const execute = createIsolatedExecutor({ status });
  const context = { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 };
  assert.equal((await execute("cat", ["/etc/os-release"], context)).output.trim(), expected.trim());
  await assert.rejects(execute("cat", ["/etc/shadow"], context));
});

test("immutable inputs survive broad parent write mounts, replacement and aliases", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-input-mount-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "RFP.md"), "original requirements");
  await fs.symlink("RFP.md", path.join(root, "alias.md"));
  const execute = createIsolatedExecutor({ status });
  const context = { workspaceRoot: root, allowedWritePaths: ["."], protectedPaths: ["RFP.md"], shellTimeoutMs: 5000 };
  await execute("node", ["-e", "require('fs').writeFileSync('implementation.txt','allowed')"], context);
  for (const source of ["fs.writeFileSync('RFP.md','wrong')", "fs.writeFileSync('alias.md','wrong')", "fs.unlinkSync('RFP.md')", "fs.renameSync('implementation.txt','RFP.md')"]) {
    await assert.rejects(execute("node", ["-e", `const fs=require('fs');${source}`], context));
    assert.equal(await fs.readFile(path.join(root, "RFP.md"), "utf8"), "original requirements");
  }
  await assert.rejects(execute("node", ["-e", "0"], { ...context, allowedWritePaths: ["alias.md"] }), /Authoritative input/);
  assert.equal(await fs.readFile(path.join(root, "implementation.txt"), "utf8"), "allowed");
});

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

test("isolated tools can discard IO through the null device while ordinary writes remain scoped", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-null-device-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "protected.txt"), "unchanged");
  const result = await createIsolatedExecutor({ status })("node", ["-e", `
const fs=require('fs');const fd=fs.openSync('/dev/null','r+');
try {fs.writeSync(fd,'discarded');} finally {fs.closeSync(fd);}
try {fs.writeFileSync('protected.txt','changed');process.exit(9);} catch {}
console.log('discarded safely');`], { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 });
  assert.match(result.output, /discarded safely/);
  assert.equal(await fs.readFile(path.join(root, "protected.txt"), "utf8"), "unchanged");
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


test("offline Linux commands resolve localhost without access to host loopback services", async t => {
  const status = executorStatus();
  if (!status.available || status.backend !== "bubblewrap") { t.skip("Linux namespace regression"); return; }
  const { createServer } = await import("node:net");
  const server = createServer(socket => socket.end("host-only"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())));
  const port = (server.address() as {port:number}).port;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-offline-localhost-"));
  t.after(() => fs.rm(root, { recursive:true, force:true }));
  const script = `
    const assert=require('node:assert/strict');
    require('node:dns').promises.lookup('localhost',{family:4}).then(({address})=>{
      assert.equal(address,'127.0.0.1');
      assert.equal(require('node:fs').readFileSync('/etc/hosts','utf8'),'127.0.0.1 localhost\\n::1 localhost\\n');
      const socket=require('node:net').connect({host:'localhost',family:4,port:${port}});
      socket.on('connect',()=>process.exit(9));
      socket.on('error',()=>{console.log('resolved; host loopback denied');process.exit(0)});
      setTimeout(()=>process.exit(8),1000);
    }).catch(error=>{console.error(error);process.exit(7)});`;
  const result=await createIsolatedExecutor({status})('node',['-e',script],{workspaceRoot:root,shellTimeoutMs:5000});
  assert.match(result.output,/resolved; host loopback denied/);
});

test("a declared output directory can be removed, recreated and renamed while its neighbours stay protected", async t => {
  const status = executorStatus();
  if (!status.available || status.backend !== "bubblewrap") { t.skip("Linux mount regression"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-output-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "gen")); await fs.mkdir(path.join(root, "proto"));
  await fs.writeFile(path.join(root, "gen", "inventory_pb2.py"), "# stale generated module\n");
  await fs.writeFile(path.join(root, "proto", "inventory.proto"), "syntax = \"proto3\";\n");
  await fs.writeFile(path.join(root, "setup.cfg"), "[metadata]\n");
  const execute = createIsolatedExecutor({ status });
  const context = { workspaceRoot: root, allowedWritePaths: ["gen"], shellTimeoutMs: 5000 };
  // A generator that wipes its own output root before writing it again.
  const regenerate = "const fs=require('fs');fs.rmSync('gen',{recursive:true,force:true});fs.mkdirSync('gen');fs.writeFileSync('gen/inventory_pb2.py','# regenerated\\n')";
  await execute("node", ["-e", regenerate], context);
  await execute("node", ["-e", regenerate], context);
  assert.equal(await fs.readFile(path.join(root, "gen", "inventory_pb2.py"), "utf8"), "# regenerated\n");
  await execute("sh", ["-c", "rm -rf gen && mkdir gen && echo again > gen/inventory_pb2.py"], context);
  for (const script of ["fs.writeFileSync('setup.cfg','changed')", "fs.rmSync('proto',{recursive:true})", "fs.renameSync('proto','proto.old')", "fs.unlinkSync('setup.cfg')"]) {
    await assert.rejects(execute("node", ["-e", `const fs=require('fs');${script}`], context));
  }
  assert.equal(await fs.readFile(path.join(root, "setup.cfg"), "utf8"), "[metadata]\n");
  assert.equal(await fs.readFile(path.join(root, "proto", "inventory.proto"), "utf8"), "syntax = \"proto3\";\n");
  // A rename target that does not exist yet may be declared.
  await execute("sh", ["-c", "mv gen gen.previous && mkdir gen"], { ...context, allowedWritePaths: ["gen", "gen.previous"] });
  assert.equal(await fs.readFile(path.join(root, "gen.previous", "inventory_pb2.py"), "utf8"), "again\n");
  // An undeclared new name next to the write path fails the call and names it.
  await assert.rejects(execute("sh", ["-c", "rm -rf gen.previous; echo kept > gen/inventory_pb2.py; mv gen gen.backup && mkdir gen"], { ...context, allowedWritePaths: ["gen", "gen.previous"] }), /gen\.backup.*outside its writePaths.*Kept gen\.backup/s);
  // Content moved out of the write path is kept, not deleted.
  assert.equal(await fs.readFile(path.join(root, "gen.backup", "inventory_pb2.py"), "utf8"), "kept\n");
});

test("new files a command leaves next to its write path are removed and named", async t => {
  const status = executorStatus();
  if (!status.available || status.backend !== "bubblewrap") { t.skip("Linux mount regression"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-stray-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "reports")); await fs.writeFile(path.join(root, "pyproject.toml"), "[project]\n");
  const execute = createIsolatedExecutor({ status });
  const context = { workspaceRoot: root, allowedWritePaths: ["reports"], shellTimeoutMs: 5000 };
  // A test-runner hook and a package-manager config at the root would change every later run.
  await assert.rejects(execute("sh", ["-c", "echo 'import os' > conftest.py && mkdir -p .cfg && echo x > .cfg/npmrc && echo done > reports/summary.txt"], context),
    error => /conftest\.py/.test(String(error)) && /Removed .*conftest\.py/.test(String(error)) && /\.cfg/.test(String(error)));
  assert.deepEqual((await fs.readdir(root)).sort(), ["pyproject.toml", "reports"]);
  assert.equal(await fs.readFile(path.join(root, "reports", "summary.txt"), "utf8"), "done\n");
});

test("a protected file cannot be moved away by renaming a directory that holds it", async t => {
  const status = executorStatus();
  if (!status.available || status.backend !== "bubblewrap") { t.skip("Linux mount regression"); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-protected-holder-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "lib", "core"), { recursive: true });
  await fs.writeFile(path.join(root, "lib", "core", "ledger.rb"), "class Ledger; end\n");
  const execute = createIsolatedExecutor({ status });
  const context = { workspaceRoot: root, allowedWritePaths: ["lib"], protectedPaths: ["lib/core/ledger.rb"], shellTimeoutMs: 5000 };
  await execute("sh", ["-c", "echo 'module Helpers; end' > lib/core/helpers.rb"], context);
  assert.equal(await fs.readFile(path.join(root, "lib", "core", "helpers.rb"), "utf8"), "module Helpers; end\n");
  for (const command of ["mv lib/core lib/core.bak && mkdir lib/core && echo replaced > lib/core/ledger.rb", "mv lib lib.bak", "rm -rf lib/core", "rm -f lib/core/ledger.rb"]) {
    await assert.rejects(execute("sh", ["-c", command], context));
    assert.equal(await fs.readFile(path.join(root, "lib", "core", "ledger.rb"), "utf8"), "class Ledger; end\n");
  }
});

test("Darwin policy keeps directories that hold protected files from being renamed", () => {
  const profile = darwinSandboxProfile("/Users/test/repo", "/private/tmp/codali-shell-9", ["/Users/test/repo/lib"], [], false, [], ["/Users/test/repo/lib/core/ledger.rb"]);
  assert.ok(profile.includes('(deny file-write-unlink (literal "/Users/test/repo/lib/core"))'));
  assert.ok(profile.includes('(deny file-write-unlink (literal "/Users/test/repo/lib"))'));
  assert.ok(!profile.includes('(deny file-write-unlink (literal "/Users/test/repo"))'));
});
