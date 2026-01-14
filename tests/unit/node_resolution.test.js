import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const read = async (relativePath) => {
  const fullPath = path.resolve(process.cwd(), relativePath);
  return fs.readFile(fullPath, "utf8");
};

const assertNoExecPath = async (label, relativePath) => {
  const content = await read(relativePath);
  assert.equal(
    content.includes("process.execPath"),
    false,
    `${label} should not hardcode process.execPath`,
  );
};

test("node resolution avoids hard-coded execPath", async () => {
  await assertNoExecPath("WorkOnTasksService", "packages/core/src/services/execution/WorkOnTasksService.ts");
  await assertNoExecPath("tests/all.js", "tests/all.js");
  await assertNoExecPath("scripts/run-node-tests.js", "scripts/run-node-tests.js");
});

test("node resolution supports NODE_BIN overrides", async () => {
  const runAll = await read("tests/all.js");
  const runNodeTests = await read("scripts/run-node-tests.js");
  assert.ok(runAll.includes("NODE_BIN"));
  assert.ok(runNodeTests.includes("NODE_BIN"));
});
