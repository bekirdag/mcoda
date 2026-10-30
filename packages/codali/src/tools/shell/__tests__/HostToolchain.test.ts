import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverHostToolchain, extraRuntimeMounts } from "../HostToolchain.js";
import { createIsolatedExecutor, executorStatus } from "../IsolatedExecutor.js";

test("host toolchain discovery rejects workspace executables and mismatched package manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tool-discovery-"));
  const tools = await fs.mkdtemp(path.join(os.tmpdir(), "codali-host-tools-"));
  try {
    await fs.mkdir(path.join(root, "bin")); await fs.mkdir(path.join(tools, "bin"));
    for (const directory of [root, tools]) {
      await fs.writeFile(path.join(directory, "bin", "pnpm.cjs"), "#!/usr/bin/env node\nconsole.log('fixture')\n", { mode: 0o755 });
      await fs.symlink("pnpm.cjs", path.join(directory, "bin", "pnpm"));
      await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: directory === root ? "pnpm" : "unrelated-package", bin: { pnpm: "bin/pnpm.cjs" } }));
    }
    const searchPath = [path.join(root, "bin"), path.join(tools, "bin")].join(path.delimiter);
    assert.equal(discoverHostToolchain(root, searchPath).some(runtime => runtime.name === "pnpm"), false);
    await fs.writeFile(path.join(tools, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/not-the-selected-script.cjs" } }));
    assert.equal(discoverHostToolchain(root, `${tools}/bin`).some(runtime => runtime.name === "pnpm"), false);
    await fs.writeFile(path.join(tools, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.cjs" } }));
    const pnpm = discoverHostToolchain(root, searchPath).find(runtime => runtime.name === "pnpm");
    assert.equal(pnpm?.readOnlyRoot, await fs.realpath(tools)); assert.equal(pnpm?.directory, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(tools, { recursive: true, force: true }); }
});

test("isolated user-installed tools cannot read neighboring files, inherit secrets or modify their installation", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tool-workspace-"));
  const installation = await fs.mkdtemp(path.join(os.tmpdir(), "codali-tool-installation-"));
  const tool = path.join(installation, "pnpm"); const oldPath = process.env.PATH; const oldKey = process.env.MCODA_MSWARM_API_KEY;
  try {
    await fs.mkdir(path.join(tool, "bin"), { recursive: true });
    await fs.writeFile(path.join(installation, "private.txt"), "neighbor-secret");
    await fs.writeFile(path.join(tool, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.cjs" } }));
    await fs.writeFile(path.join(tool, "bin", "pnpm.cjs"), `#!/usr/bin/env node
const fs=require('fs');
if(process.argv[2]==='write') fs.writeFileSync(__filename,'changed');
else { let readable=false; try { fs.readFileSync(process.argv[2]); readable=true; } catch {} console.log(JSON.stringify({readable,secret:process.env.MCODA_MSWARM_API_KEY??null,tool:true})); }
`, { mode: 0o755 });
    await fs.symlink("pnpm.cjs", path.join(tool, "bin", "pnpm"));
    process.env.PATH = `${tool}/bin:/usr/bin:/bin`; process.env.MCODA_MSWARM_API_KEY = "fixture-secret-must-not-inherit";
    const execute = createIsolatedExecutor({ status }); const context = { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 };
    const output = await execute("pnpm", [path.join(installation, "private.txt")], context);
    assert.deepEqual(JSON.parse(output.output), { readable: false, secret: null, tool: true });
    await assert.rejects(execute("pnpm", ["write"], context), /read-only|EROFS|EPERM|permission/i);
    assert.match(await fs.readFile(path.join(tool, "bin", "pnpm.cjs"), "utf8"), /tool:true/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldKey === undefined) delete process.env.MCODA_MSWARM_API_KEY; else process.env.MCODA_MSWARM_API_KEY = oldKey;
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(installation, { recursive: true, force: true });
  }
});

test("package-manager shims resolve a validated entry point without executing shell code", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-shim-workspace-"));
  const install = await fs.mkdtemp(path.join(os.tmpdir(), "codali-shim-install-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(install, { recursive: true, force: true }); });
  const bin = path.join(install, "node_modules", ".bin"); const pkg = path.join(install, "node_modules", "pnpm");
  await fs.mkdir(bin, { recursive: true }); await fs.mkdir(path.join(pkg, "bin"), { recursive: true });
  await fs.writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  await fs.writeFile(path.join(pkg, "bin", "pnpm.cjs"), "#!/usr/bin/env node\nconsole.log('verified-package');\n", { mode: 0o755 });
  const manifest = { name: "pnpm", bin: { pnpm: "bin/pnpm.cjs" } };
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify(manifest));
  const selected = discoverHostToolchain(root, bin).find(runtime => runtime.name === "pnpm");
  assert.equal(selected?.executable, await fs.realpath(path.join(pkg, "bin", "pnpm.cjs")));
  assert.equal(selected?.readOnlyRoot, await fs.realpath(pkg));
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify({ ...manifest, bin: { pnpm: "../../.bin/pnpm" } }));
  assert.equal(discoverHostToolchain(root, bin).some(runtime => runtime.name === "pnpm"), false);
  await fs.writeFile(path.join(pkg, "package.json"), JSON.stringify(manifest));
  assert.equal(discoverHostToolchain(install, bin).some(runtime => runtime.name === "pnpm"), false);
});

test("the installed pnpm runs a workspace Node test inside the isolation boundary", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-installed-pnpm-"));
  try {
    if (!discoverHostToolchain(root).some(runtime => runtime.name === "pnpm")) { t.skip("pnpm is not installed"); return; }
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node --test test.cjs" } }));
    await fs.writeFile(path.join(root, "test.cjs"), "require('node:test')('runtime works',()=>require('node:assert/strict').equal(2+2,4));\n");
    const result = await createIsolatedExecutor({ status })("pnpm", ["test"], { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 10000 });
    assert.match(result.output, /pass 1/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("private Python discovery mounts its library, rejects escaped libraries and never mounts the installation parent", async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codali-python-discovery-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const workspace = path.join(fixture, "workspace"); const install = path.join(fixture, "install");
  const library = path.join(install, "lib", "python3.12");
  await fs.mkdir(workspace); await fs.mkdir(path.join(install, "bin"), { recursive: true });
  await fs.mkdir(path.join(library, "encodings"), { recursive: true });
  // Native fixture is inspected, never executed during discovery.
  if (process.platform === "win32") await fs.writeFile(path.join(install, "bin", "python3"), Buffer.from("7f454c4600000000", "hex"));
  else await fs.copyFile(process.execPath, path.join(install, "bin", "python3"));
  await fs.chmod(path.join(install, "bin", "python3"), 0o755);
  await fs.writeFile(path.join(library, "os.py"), "# fixture\n");
  await fs.writeFile(path.join(library, "encodings", "__init__.py"), "# fixture\n");
  const selected = discoverHostToolchain(workspace, path.join(install, "bin")).filter(runtime => runtime.name === "python3");
  assert.equal(selected.length, 1);
  assert.deepEqual(extraRuntimeMounts(selected).map(mount => mount.readOnlyRoot), [await fs.realpath(path.join(install, "bin", "python3")), await fs.realpath(library)]);
  const outside = path.join(fixture, "external-library"); await fs.rename(library, outside); await fs.symlink(outside, library);
  assert.equal(discoverHostToolchain(workspace, path.join(install, "bin")).some(runtime => runtime.name === "python3"), false);
});

test("rustup proxies select only the installed host toolchain without exposing Cargo credentials or repository overrides", async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codali-rust-discovery-"));
  const oldHome = process.env.RUSTUP_HOME; const oldToolchain = process.env.RUSTUP_TOOLCHAIN;
  t.after(async () => {
    if (oldHome === undefined) delete process.env.RUSTUP_HOME; else process.env.RUSTUP_HOME = oldHome;
    if (oldToolchain === undefined) delete process.env.RUSTUP_TOOLCHAIN; else process.env.RUSTUP_TOOLCHAIN = oldToolchain;
    await fs.rm(fixture, { recursive: true, force: true });
  });
  const workspace = path.join(fixture, "workspace"); const proxies = path.join(fixture, "cargo", "bin");
  const rustup = path.join(fixture, "rustup"); const toolchain = path.join(rustup, "toolchains", "stable-fixture");
  await fs.mkdir(workspace); await fs.mkdir(proxies, { recursive: true });
  await fs.mkdir(path.join(toolchain, "bin"), { recursive: true }); await fs.mkdir(path.join(toolchain, "lib", "rustlib"), { recursive: true });
  await fs.writeFile(path.join(toolchain, "lib", "rustlib", "manifest-rustc-fixture"), "fixture\n");
  await fs.writeFile(path.join(rustup, "settings.toml"), 'default_toolchain = "stable-fixture"\n');
  await fs.writeFile(path.join(workspace, "rust-toolchain.toml"), '[toolchain]\nchannel = "nightly-uninstalled"\n');
  // Inspected POSIX runtime fixtures are never executed, even on Windows.
  const nativeHeader = Buffer.from("7f454c46", "hex");
  await fs.writeFile(path.join(proxies, "rustup"), Buffer.concat([nativeHeader, Buffer.from("discovery-only-proxy-fixture")]), { mode: 0o755 });
  for (const name of ["rustc", "cargo", "rustdoc"]) {
    if (name === "cargo") await fs.link(path.join(proxies, "rustup"), path.join(proxies, name));
    else if (name === "rustc") await fs.copyFile(path.join(proxies, "rustup"), path.join(proxies, name));
    else await fs.symlink("rustup", path.join(proxies, name));
    await fs.writeFile(path.join(toolchain, "bin", name), Buffer.concat([nativeHeader, Buffer.from("fixture")]), { mode: 0o755 });
  }
  process.env.RUSTUP_HOME = rustup; delete process.env.RUSTUP_TOOLCHAIN;
  const selected = discoverHostToolchain(workspace, proxies).filter(runtime => ["rustc", "cargo", "rustdoc"].includes(runtime.name));
  assert.equal(selected.length, 3);
  for (const mount of extraRuntimeMounts(selected)) assert.ok(mount.readOnlyRoot.startsWith(`${await fs.realpath(toolchain)}${path.sep}`));
  const packaged = path.join(fixture, "packaged");
  await fs.mkdir(path.join(packaged, "bin"), { recursive: true });
  await fs.mkdir(path.join(packaged, "libexec", "bin"), { recursive: true });
  await fs.copyFile(path.join(proxies, "rustup"), path.join(packaged, "libexec", "bin", "rustup"));
  for (const name of ["rustc", "cargo", "rustdoc"]) {
    await fs.writeFile(path.join(packaged, "bin", name), "#!/bin/sh\nexit 99 # must not execute this package wrapper\n", { mode: 0o755 });
    await fs.link(path.join(packaged, "libexec", "bin", "rustup"), path.join(packaged, "libexec", "bin", name));
  }
  assert.equal(discoverHostToolchain(workspace, path.join(packaged, "bin")).filter(runtime => ["rustc", "cargo", "rustdoc"].includes(runtime.name)).length, 3);
  process.env.RUSTUP_TOOLCHAIN = "../../workspace";
  assert.equal(discoverHostToolchain(workspace, proxies).some(runtime => runtime.name === "cargo"), false);
});

test("Python imports and unittest run with private bytecode caches and no host credentials", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-python-execution-"));
  const privateFile = `${root}-private.txt`; const oldKey = process.env.MCODA_MSWARM_API_KEY;
  t.after(async () => {
    if (oldKey === undefined) delete process.env.MCODA_MSWARM_API_KEY; else process.env.MCODA_MSWARM_API_KEY = oldKey;
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(privateFile, { force: true });
  });
  if (!discoverHostToolchain(root).some(runtime => runtime.name === "python3")) { t.skip("Python is not installed"); return; }
  process.env.MCODA_MSWARM_API_KEY = "fixture-host-secret"; await fs.writeFile(privateFile, "private");
  await fs.writeFile(path.join(root, "test_runtime.py"), `import json, os, pathlib, ssl, sys, unittest
class RuntimeTest(unittest.TestCase):
    def test_private_runtime(self):
        try:
            pathlib.Path(${JSON.stringify(privateFile)}).read_text()
        except (PermissionError, FileNotFoundError):
            pass
        else:
            self.fail('Host private file was readable')
        self.assertNotIn('MCODA_MSWARM_API_KEY', os.environ)
        self.assertTrue(sys.pycache_prefix.startswith(os.environ['HOME']))
        self.assertEqual(json.loads('{"answer":4}')['answer'], 4)
`);
  const result = await createIsolatedExecutor({ status })("python3", ["-m", "unittest", "discover", "-s", "."], { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 20000 });
  assert.match(result.output, /Ran 1 test/);
  assert.equal((await fs.readdir(root)).includes("__pycache__"), false);
});

test("a trusted venv retains its environment through an external interpreter alias", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "codali-venv-alias-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await fs.rm(fixture, { recursive: true, force: true });
  });
  const root = path.join(fixture, "workspace"); const hostBin = path.join(fixture, "host-bin");
  const runtime = path.join(fixture, "venv");
  await fs.mkdir(root); await fs.mkdir(hostBin);
  const python = discoverHostToolchain(root).find(runtime => runtime.name === "python3");
  if (!python) { t.skip("Python is not installed"); return; }
  const alias = path.join(hostBin, "python3"); await fs.symlink(python.executable, alias);
  const install = spawnSync(alias, ["-I", "-m", "venv", "--without-pip", runtime], { encoding: "utf8", timeout: 15000 });
  assert.equal(install.status, 0, install.stderr);
  await fs.writeFile(path.join(hostBin, "private.txt"), "must not be mounted");
  process.env.PATH = hostBin;
  const result = await createIsolatedExecutor({ status, readOnlyRuntimeRoots: [runtime] })(path.join(runtime, "bin", "python"),
    ["-I", "-B", "-c", `import json, pathlib, sys
try:
    pathlib.Path(${JSON.stringify(path.join(hostBin, "private.txt"))}).read_text()
except (FileNotFoundError, PermissionError):
    private = False
else:
    private = True
print(json.dumps({"prefix": str(pathlib.Path(sys.prefix).resolve()), "private": private}))`],
    { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 10000 });
  assert.deepEqual(JSON.parse(result.output), { prefix: await fs.realpath(runtime), private: false });
});

test("Cargo compiles and tests offline with a private home and the concrete compiler", async t => {
  const status = executorStatus(); if (!status.available) { t.skip(status.reason); return; }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-rust-execution-"));
  const privateFile = `${root}-private.txt`; const oldKey = process.env.MCODA_MSWARM_API_KEY; const oldCargo = process.env.CARGO_HOME;
  t.after(async () => {
    if (oldKey === undefined) delete process.env.MCODA_MSWARM_API_KEY; else process.env.MCODA_MSWARM_API_KEY = oldKey;
    if (oldCargo === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = oldCargo;
    await fs.rm(root, { recursive: true, force: true }); await fs.rm(privateFile, { force: true });
  });
  const runtimes = discoverHostToolchain(root);
  if (!["cargo", "rustc", "rustdoc"].every(name => runtimes.some(runtime => runtime.name === name))) { t.skip("Rust toolchain is not installed"); return; }
  process.env.MCODA_MSWARM_API_KEY = "fixture-host-secret"; process.env.CARGO_HOME = `${root}-host-cargo`;
  await fs.writeFile(privateFile, "private"); await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "Cargo.toml"), '[package]\nname="codali_isolation_fixture"\nversion="0.1.0"\nedition="2021"\n');
  await fs.writeFile(path.join(root, "rust-toolchain.toml"), '[toolchain]\nchannel="uninstalled-must-not-download"\n');
  await fs.writeFile(path.join(root, "src", "lib.rs"), `#[test] fn private_runtime() {
    assert!(!std::path::Path::new(${JSON.stringify(privateFile)}).exists());
    assert!(std::env::var("MCODA_MSWARM_API_KEY").is_err());
    assert!(std::env::var("CARGO_HOME").unwrap().starts_with(&std::env::var("HOME").unwrap()));
}\n`);
  try {
    const result = await createIsolatedExecutor({ status })("cargo", ["test", "--offline", "--verbose"], { workspaceRoot: root, allowedWritePaths: ["."], shellTimeoutMs: 60000 });
    assert.match(result.output, /1 passed/);
  } catch (error) {
    // Node's test reporter omits the captured process details on deadline errors.
    const details = typeof error === "object" && error !== null && "details" in error
      ? (error as { details?: { stdout?: unknown; stderr?: unknown } }).details : undefined;
    if (details && typeof details.stdout === "string" && typeof details.stderr === "string") {
      t.diagnostic(`Cargo stdout: ${details.stdout.slice(-4000)}`);
      t.diagnostic(`Cargo stderr: ${details.stderr.slice(-4000)}`);
    } else {
      t.diagnostic(String(error).slice(0, 1000));
    }
    throw error;
  }
});
