import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverDarwinRuntimeLibraries, parseMachOLoadCommands } from "../DarwinRuntimeLibraries.js";

test("Mach-O inspection separates dependency load commands from install IDs and unrelated metadata", () => {
  const result = parseMachOLoadCommands(`/opt/python (architecture arm64):
Load command 0
          cmd LC_RPATH
      cmdsize 40
         path @loader_path/../lib (offset 12)
Load command 1
          cmd LC_LOAD_DYLIB
      cmdsize 56
         name /opt/openssl@4/lib/libssl.4.dylib (offset 24)
Load command 2
          cmd LC_ID_DYLIB
         name /not/a/dependency (offset 24)
/opt/extension.so:
Load command 0
          cmd LC_LOAD_WEAK_DYLIB
         name @rpath/liboptional.dylib (offset 24)
`, ["/opt/python", "/opt/extension.so"]);
  assert.deepEqual(result.get("/opt/python"), { libraries: ["/opt/openssl@4/lib/libssl.4.dylib"], rpaths: ["@loader_path/../lib"] });
  assert.deepEqual(result.get("/opt/extension.so"), { libraries: ["@rpath/liboptional.dylib"], rpaths: [] });
  assert.throws(() => parseMachOLoadCommands("/another/file:\n", ["/opt/python"]), /Incomplete/);
});

test("native dependency closure admits exact symlink targets and transitive rpaths without exposing neighboring files", async t => {
  const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codali-darwin-libraries-")));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const workspace = path.join(fixture, "workspace"); const home = path.join(fixture, "home");
  const library = path.join(fixture, "Cellar", "openssl@4", "4.0", "lib");
  const alias = path.join(fixture, "opt", "openssl@4");
  const executable = path.join(fixture, "python", "bin", "python3");
  const extension = path.join(fixture, "python", "lib", "_ssl.so");
  const ssl = path.join(library, "libssl.4.dylib"); const crypto = path.join(library, "libcrypto.4.dylib");
  const forbidden = path.join(workspace, "injected.dylib"); const secret = path.join(home, "credentials");
  for (const directory of [workspace, home, library, path.dirname(alias), path.dirname(executable), path.dirname(extension)]) await fs.mkdir(directory, { recursive: true });
  for (const file of [executable, extension, ssl, crypto, forbidden]) await fs.writeFile(file, Buffer.from("cffaedfe00000000", "hex"));
  await fs.writeFile(secret, "private-value"); await fs.symlink(path.dirname(library), alias);
  const sslAlias = path.join(alias, "lib", "libssl.4.dylib");
  const escaped = path.join(library, "escaped.dylib"); await fs.symlink(forbidden, escaped);
  const metadata = new Map([
    [executable, { libraries: ["/usr/lib/libSystem.B.dylib"], rpaths: [] }],
    [extension, { libraries: [sslAlias, secret, forbidden, escaped], rpaths: [] }],
    [ssl, { libraries: ["@rpath/libcrypto.4.dylib"], rpaths: ["@loader_path"] }],
    [crypto, { libraries: [sslAlias], rpaths: [] }],
  ]);
  const calls: string[][] = [];
  const mounts = discoverDarwinRuntimeLibraries(executable, [extension], workspace, home, files => {
    calls.push(files); return new Map(files.map(file => [file, metadata.get(file)!]));
  });
  assert.deepEqual(new Set(mounts.map(mount => mount.readOnlyRoot)), new Set([sslAlias, ssl, crypto]));
  assert.ok(mounts.every(mount => mount.directory === false));
  assert.equal(calls.length, 3);
  assert.throws(() => discoverDarwinRuntimeLibraries(forbidden, [], workspace, home, () => new Map()), /not an installed native/);
  assert.throws(() => discoverDarwinRuntimeLibraries(executable, [], workspace, home, () => new Map()), /Missing runtime library metadata/);
});
