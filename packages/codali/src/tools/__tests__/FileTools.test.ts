import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  assert.match(result.error ?? "", /outside the workspace/);
});
