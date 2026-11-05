import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolRegistry } from "../ToolRegistry.js";
import { createFileTools } from "../filesystem/FileTools.js";

const createRegistry = () => {
  const registry = new ToolRegistry();
  for (const tool of createFileTools()) {
    registry.register(tool);
  }
  return registry;
};

test("directory bootstrap preserves files and enforces scoped paths and host checks", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = createRegistry();
  const context = { workspaceRoot: root, allowedWritePaths: ["build/cache"] };
  assert.equal((await registry.execute("create_directory", { path: "build/cache" }, context)).ok, true);
  assert.equal((await fs.stat(path.join(root, "build/cache"))).isDirectory(), true);
  await fs.writeFile(path.join(root, "build/cache/file"), "retain");
  assert.equal((await registry.execute("create_directory", { path: "build/cache" }, context)).ok, true);
  assert.equal((await registry.execute("create_directory", { path: "build/cache/file" }, context)).ok, false);
  assert.equal(await fs.readFile(path.join(root, "build/cache/file"), "utf8"), "retain");
  assert.equal((await registry.execute("create_directory", { path: "other" }, context)).ok, false);
  assert.equal((await registry.execute("create_directory", { path: "../escape" }, context)).ok, false);
  await fs.symlink(os.tmpdir(), path.join(root, "outside"));
  assert.equal((await registry.execute("create_directory", { path: "outside/escape" }, { ...context, allowedWritePaths: ["."] })).ok, false);
  assert.equal((await registry.execute("create_directory", { path: "build/cache/denied" }, { ...context, checkPath: async () => { throw Error("denied"); } })).ok, false);
  await assert.rejects(fs.stat(path.join(root, "build/cache/denied")), { code: "ENOENT" });
});

test("workspace root aliases retain relative receipts and still reject escaped file symlinks", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codali-root-alias-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "real"); const alias = path.join(parent, "alias");
  await fs.mkdir(root); await fs.symlink(root, alias);
  await fs.writeFile(path.join(parent, "private.txt"), "secret");
  await fs.symlink(path.join(parent, "private.txt"), path.join(root, "escape.txt"));
  const touched: string[] = []; const registry = createRegistry();
  const context = { workspaceRoot: alias, allowedWritePaths: ["notes.txt"], recordTouchedFile: (file: string) => touched.push(file) };
  assert.equal((await registry.execute("write_file", { path: "notes.txt", content: "ok" }, context)).ok, true);
  assert.deepEqual(touched, ["notes.txt"]);
  assert.equal((await registry.execute("read_file", { path: "escape.txt" }, context)).ok, false);
  assert.equal((await registry.execute("write_file", { path: "escape.txt", content: "bad" }, { ...context, allowedWritePaths: ["."] })).ok, false);
  assert.equal(await fs.readFile(path.join(parent, "private.txt"), "utf8"), "secret");
});

test("FileTools write and read inside workspace", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-files-"));
  const touched: string[] = [];
  const registry = createRegistry();

  const context = {
    workspaceRoot,
    recordTouchedFile: (filePath: string) => touched.push(filePath),
  };

  const writeResult = await registry.execute("write_file", { path: "notes.txt", content: "hello" }, context);
  assert.equal(writeResult.ok, true);
  assert.deepEqual(touched, ["notes.txt"]);

  const readResult = await registry.execute("read_file", { path: "notes.txt" }, context);
  assert.equal(readResult.ok, true);
  assert.equal(readResult.output, "hello");
});

test("FileTools blocks paths outside workspace", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-files-"));
  const registry = createRegistry();
  const context = { workspaceRoot };

  writeFileSync(path.join(workspaceRoot, "safe.txt"), "ok");
  const result = await registry.execute("read_file", { path: "../outside.txt" }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "tool_permission_denied");
  assert.match(result.error?.message ?? "", /outside the workspace/);
});

test("FileTools enforces read and write scopes", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-files-"));
  const registry = createRegistry();
  writeFileSync(path.join(workspaceRoot, "allowed.txt"), "ok");
  writeFileSync(path.join(workspaceRoot, "blocked.txt"), "no");

  const allowedRead = await registry.execute(
    "read_file",
    { path: "allowed.txt" },
    { workspaceRoot, allowedReadPaths: ["allowed.txt"] },
  );
  assert.equal(allowedRead.ok, true);

  const blockedRead = await registry.execute(
    "read_file",
    { path: "blocked.txt" },
    { workspaceRoot, allowedReadPaths: ["allowed.txt"] },
  );
  assert.equal(blockedRead.ok, false);
  assert.equal(blockedRead.error?.code, "tool_permission_denied");
  assert.match(blockedRead.error?.message ?? "", /outside allowed read scopes/);

  const blockedWrite = await registry.execute(
    "write_file",
    { path: "blocked.txt", content: "new" },
    { workspaceRoot, allowedWritePaths: ["allowed.txt"] },
  );
  assert.equal(blockedWrite.ok, false);
  assert.equal(blockedWrite.error?.code, "tool_permission_denied");
  assert.match(blockedWrite.error?.message ?? "", /outside allowed write scopes/);
});

test("small exact patches preserve surrounding code, literal dollars and scope checks", async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codali-patch-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const registry = createRegistry(), touched: string[] = [];
  const context = { workspaceRoot, recordTouchedFile: (file: string) => touched.push(file) };
  await fs.writeFile(path.join(workspaceRoot, "main.js"), "before\nANCHOR\nafter\n");
  const result = await registry.execute("write_file", { path: "main.js", search: "ANCHOR", content: "$& $$ $' $`" }, context);
  assert.equal(result.ok, true); assert.match(result.output, /Patched main.js/);
  assert.equal(await fs.readFile(path.join(workspaceRoot, "main.js"), "utf8"), "before\n$& $$ $' $`\nafter\n");
  assert.deepEqual(touched, ["main.js"]);
  const denied = await registry.execute("write_file", { path: "main.js", search: "before", content: "bad" }, { ...context, allowedReadPaths: ["other"] });
  assert.equal(denied.ok, false);
  const escaped = await registry.execute("write_file", { path: "../outside", search: "x", content: "bad" }, context);
  assert.equal(escaped.ok, false);
});

test("stale, ambiguous and overlapping patches never alter the file", async t => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codali-patch-reject-"));
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  const registry = createRegistry();
  await fs.writeFile(path.join(workspaceRoot, "source"), "aaa repeated repeated");
  for (const search of ["", "missing", "repeated", "aa"]) {
    const result = await registry.execute("write_file", { path: "source", search, content: "bad" }, { workspaceRoot });
    assert.equal(result.ok, false, search);
    assert.equal(await fs.readFile(path.join(workspaceRoot, "source"), "utf8"), "aaa repeated repeated");
  }
});
