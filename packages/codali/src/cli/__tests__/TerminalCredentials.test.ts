import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const terminalModule = new URL("../TerminalCredentials.js", import.meta.url).href;
const credentialModule = new URL("../../runcontext/CredentialFile.js", import.meta.url).href;

const fixture = async (t: TestContext, contents: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-credential-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, ".codali", ".creds");
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, contents);
  return { root, file };
};

const inIsolatedProcess = (root: string, body: string, input?: string) => {
  // Resolve the credential location only after replacing homedir in this child.
  // Neither the user's home setting nor their credential file is touched.
  const source = `
    import assert from "node:assert/strict";
    import { promises as fs } from "node:fs";
    import os from "node:os";
    import { syncBuiltinESMExports } from "node:module";
    os.homedir = () => ${JSON.stringify(root)};
    syncBuiltinESMExports();
    const { setTerminalCredential, readTerminalCredential } = await import(${JSON.stringify(terminalModule)});
    const { credentialFilePath, loadCredentialFile, parseCredentialFile, resolveCredential } = await import(${JSON.stringify(credentialModule)});
    const file = credentialFilePath();
    assert.equal(file, ${JSON.stringify(path.join(root, ".codali", ".creds"))});
    ${body}
  `;
  const env = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"]
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env, input, encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

test("credential rotation replaces both aliases and cached values while preserving connector credentials", async t => {
  const { root } = await fixture(t, "# saved connector\nMCODA_MSWARM_API_KEY=old-key\nexport MSWARM_API_KEY=old-alias\nCODALI_MSWARM_LOGGED_OUT=1\nOTHER_TOKEN=fixture-connector\n");
  inIsolatedProcess(root, `
    assert.equal(loadCredentialFile().MCODA_MSWARM_API_KEY, "old-key");
    await setTerminalCredential("  rotated-fixture-key  ");
    const expected = { OTHER_TOKEN: "fixture-connector", MCODA_MSWARM_API_KEY: "rotated-fixture-key" };
    assert.deepEqual(loadCredentialFile(), expected);
    assert.deepEqual(parseCredentialFile(await fs.readFile(file, "utf8")), expected);
    assert.equal(resolveCredential("MCODA_MSWARM_API_KEY"), "rotated-fixture-key");
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  `);
});

test("logout clears aliases and credential cache, retains connector keys and respects explicit environment credentials", async t => {
  const { root } = await fixture(t, "MCODA_MSWARM_API_KEY=old-key\nMSWARM_API_KEY=old-alias\nOTHER_TOKEN=fixture-connector\n");
  inIsolatedProcess(root, `
    assert.equal(loadCredentialFile().MCODA_MSWARM_API_KEY, "old-key");
    await setTerminalCredential();
    const expected = { OTHER_TOKEN: "fixture-connector", CODALI_MSWARM_LOGGED_OUT: "1" };
    assert.deepEqual(loadCredentialFile(), expected);
    assert.deepEqual(parseCredentialFile(await fs.readFile(file, "utf8")), expected);
    assert.equal(resolveCredential("MCODA_MSWARM_API_KEY"), undefined);
    process.env.MCODA_MSWARM_API_KEY = "explicit-fixture-key";
    assert.equal(resolveCredential("MCODA_MSWARM_API_KEY"), "explicit-fixture-key");
  `);
});

test("invalid credentials leave the existing file unchanged", async t => {
  const { root } = await fixture(t, "MCODA_MSWARM_API_KEY=retained-fixture-key\n");
  inIsolatedProcess(root, `
    const before = await fs.readFile(file, "utf8");
    for (const key of ["", "  ", "key\\nOTHER_TOKEN=injected", "key\\r", "key\\0", "x".repeat(8193)]) {
      await assert.rejects(setTerminalCredential(key), /Invalid API key/);
      assert.equal(await fs.readFile(file, "utf8"), before);
    }
  `);
});

test("a symlink credential destination cannot overwrite its target", async t => {
  const { root, file } = await fixture(t, "unused-fixture\n");
  const target = path.join(root, "outside-credentials.txt");
  await fs.writeFile(target, "retain-target\n");
  await fs.unlink(file);
  try { await fs.symlink(target, file); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows account lacks file symlink permission"); return;
    }
    throw error;
  }
  inIsolatedProcess(root, `await assert.rejects(setTerminalCredential("new-fixture-key"), /symlink/);`);
  assert.equal(await fs.readFile(target, "utf8"), "retain-target\n");
});

test("piped credential input is bounded and never prompts or writes the credential file", async t => {
  const { root, file } = await fixture(t, "retained-fixture\n");
  inIsolatedProcess(root, `assert.equal(await readTerminalCredential(true), "piped-fixture-key");`, " piped-fixture-key\n");
  inIsolatedProcess(root, `await assert.rejects(readTerminalCredential(true), /too large/);`, "x".repeat(8193));
  inIsolatedProcess(root, `await assert.rejects(readTerminalCredential(false), /Use codali login --stdin/);`);
  assert.equal(await fs.readFile(file, "utf8"), "retained-fixture\n");
});
