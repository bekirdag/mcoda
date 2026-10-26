import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureManagedDocdexRuntime, inspectManagedDocdexRuntime, runtimeFileHash, runtimePlatformKey, validateRuntimeManifest, type ManagedRuntimeManifest } from "../ManagedRuntime.js";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const features = { workspace_metadata_control: true, embedding_input_type: true, strict_repo_embeddings: true, deterministic_profile_embeddings: true };
const script = (version = "0.0.0-test", capabilities = features) => Buffer.from(`#!${process.execPath}\nif(process.argv[2]!=="runtime-info")process.exit(3);process.stdout.write(JSON.stringify({schema_version:1,version:${JSON.stringify(version)},executable:process.argv[1],managed_clients:${JSON.stringify(capabilities)}}));\n`);
const fixture = async (t: { after(callback: () => Promise<void>): void }, bytes = script()) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali-runtime-test-")));
  const originalFetch = globalThis.fetch;
  t.after(async () => { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); });
  const source = path.join(root, "source"); await fs.mkdir(source); await fs.writeFile(path.join(source, "docdexd"), bytes, { mode: 0o700 });
  const archive = path.join(root, "fixture.tar.gz"); await promisify(execFile)("tar", ["-czf", archive, "-C", source, "docdexd"]);
  const packed = await fs.readFile(archive); const key = runtimePlatformKey();
  const manifest: ManagedRuntimeManifest = { schemaVersion: 1, version: "0.0.0-test", artifacts: { [key]: { url: "https://github.com/bekirdag/docdex/releases/download/v0.0.0-test/docdexd-fixture.tar.gz", archiveSha256: hash(packed), binarySha256: hash(bytes) } } };
  let downloads = 0;
  globalThis.fetch = async (_input, init) => { downloads++; assert.equal(init?.credentials, "omit"); return new Response(packed); };
  return { root, manifest, stateRoot: path.join(root, "private"), artifact: manifest.artifacts[key], source: path.join(source, "docdexd"), downloads: () => downloads };
};

test("private runtime installs once, verifies cached bytes, and preserves existing releases", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.stateRoot, "old-version"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(f.stateRoot, "old-version", "receipt"), "keep");
  await fs.mkdir(path.join(f.stateRoot, ".install-interrupted"));
  await fs.writeFile(path.join(f.stateRoot, ".install-interrupted", "partial"), "unfinished");
  const identity = await ensureManagedDocdexRuntime(f);
  await assert.rejects(fs.stat(path.join(f.stateRoot, ".install-interrupted")), /ENOENT/);
  assert.equal(identity.binarySha256, f.artifact.binarySha256);
  assert.equal(identity.version, "0.0.0-test");
  assert.equal(identity.binary, path.join(f.stateRoot, f.artifact.binarySha256, "docdexd"));
  assert.equal((await fs.stat(identity.binary)).mode & 0o777, 0o700);
  assert.deepEqual(await ensureManagedDocdexRuntime(f), identity);
  assert.equal(f.downloads(), 1);
  assert.equal(await fs.readFile(path.join(f.stateRoot, "old-version", "receipt"), "utf8"), "keep");
  await fs.appendFile(identity.binary, "corruption");
  await assert.rejects(ensureManagedDocdexRuntime(f), /checksum mismatch/);
  assert.equal(f.downloads(), 1);
});

test("runtime installation rejects mismatches before promotion and cleans partial downloads", async t => {
  const f = await fixture(t); const original = { ...f.artifact };
  for (const [patch, pattern] of [
    [{ archiveSha256: "0".repeat(64) }, /archive checksum mismatch/],
    [{ binarySha256: "0".repeat(64) }, /binary checksum mismatch/],
  ] as const) {
    Object.assign(f.artifact, original, patch);
    await assert.rejects(ensureManagedDocdexRuntime(f), pattern);
    assert.equal((await fs.readdir(f.stateRoot)).some(name => name.startsWith(".install-") || /^[a-f0-9]{64}$/.test(name)), false);
  }
  Object.assign(f.artifact, original);
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.error(new Error("connection interrupted")); } }));
  await assert.rejects(ensureManagedDocdexRuntime(f), /connection interrupted/);
  assert.equal((await fs.readdir(f.stateRoot)).some(name => name.startsWith(".install-")), false);
  globalThis.fetch = async () => new Response("oversized", { headers: { "content-length": String(129 * 1024 * 1024) } });
  await assert.rejects(ensureManagedDocdexRuntime(f), /exceeds the download limit/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(ensureManagedDocdexRuntime({ ...f, signal: aborted.signal }), { name: "AbortError" });
});

test("capabilities and reported version are required before a runtime becomes usable", async t => {
  const f = await fixture(t, script("0.0.0-other"));
  await assert.rejects(ensureManagedDocdexRuntime(f), /version does not match/);
  await fs.writeFile(f.source, script("0.0.0-test", { ...features, embedding_input_type: false }));
  await assert.rejects(inspectManagedDocdexRuntime(f.source), /lacks required/);
  await fs.writeFile(f.source, script());
  const identity = await ensureManagedDocdexRuntime({ binary: f.source });
  assert.equal(identity.binarySha256, await runtimeFileHash(f.source));
  await assert.rejects(inspectManagedDocdexRuntime(f.source, "0".repeat(64)), /checksum mismatch/);
});

test("runtime cache refuses symlink roots, writable roots and concurrent duplicate installs", async t => {
  const f = await fixture(t); const outside = path.join(f.root, "outside"); await fs.mkdir(outside, { mode: 0o700 });
  await fs.symlink(outside, f.stateRoot);
  await assert.rejects(ensureManagedDocdexRuntime(f), /must be private/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(f.stateRoot); await fs.mkdir(f.stateRoot, { mode: 0o700 }); await fs.chmod(f.stateRoot, 0o777);
  await assert.rejects(ensureManagedDocdexRuntime(f), /must be private/);
  await fs.chmod(f.stateRoot, 0o700);
  const [first, second] = await Promise.all([ensureManagedDocdexRuntime(f), ensureManagedDocdexRuntime(f)]);
  assert.deepEqual(first, second); assert.equal(f.downloads(), 1);
});

test("runtime manifest never accepts unpinned releases or alternate download authorities", async t => {
  const f = await fixture(t); const original = f.artifact.url;
  for (const url of ["http://github.com/bekirdag/docdex/releases/download/v0.0.0-test/a.tar.gz", "https://evil.test/a.tar.gz", original.replace("v0.0.0-test", "vlatest"), original + "?token=secret", original.replace("/docdexd-fixture", "/../docdexd-fixture"), original.replace("github.com/", "name:secret@github.com/")]) {
    f.artifact.url = url; assert.throws(() => validateRuntimeManifest(f.manifest));
  }
  f.artifact.url = original;
  await assert.rejects(ensureManagedDocdexRuntime({ manifest: { schemaVersion: 1, artifacts: {} } }), /no qualified Docdex release/);
  assert.equal(f.downloads(), 0);
});
