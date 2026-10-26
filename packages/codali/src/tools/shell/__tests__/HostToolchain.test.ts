import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverHostToolchain } from "../HostToolchain.js";
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
    assert.equal(discoverHostToolchain(root, `${root}/bin:${tools}/bin`).some(runtime => runtime.name === "pnpm"), false);
    await fs.writeFile(path.join(tools, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/not-the-selected-script.cjs" } }));
    assert.equal(discoverHostToolchain(root, `${tools}/bin`).some(runtime => runtime.name === "pnpm"), false);
    await fs.writeFile(path.join(tools, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.cjs" } }));
    const pnpm = discoverHostToolchain(root, `${root}/bin:${tools}/bin`).find(runtime => runtime.name === "pnpm");
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
else console.log(JSON.stringify({visible:fs.existsSync(process.argv[2]),secret:process.env.MCODA_MSWARM_API_KEY??null,tool:true}));
`, { mode: 0o755 });
    await fs.symlink("pnpm.cjs", path.join(tool, "bin", "pnpm"));
    process.env.PATH = `${tool}/bin:/usr/bin:/bin`; process.env.MCODA_MSWARM_API_KEY = "fixture-secret-must-not-inherit";
    const execute = createIsolatedExecutor({ status }); const context = { workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000 };
    const output = await execute("pnpm", [path.join(installation, "private.txt")], context);
    assert.deepEqual(JSON.parse(output.output), { visible: false, secret: null, tool: true });
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
