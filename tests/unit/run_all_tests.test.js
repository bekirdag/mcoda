import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("run-all tests emits completion marker and uses node command", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const result = spawnSync(process.execPath, [path.join("tests", "all.js")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MCODA_SKIP_WORKSPACE_TESTS: "1",
      MCODA_REPO_TEST_FILES: path.join("tests", "unit", "path_helper.test.js"),
    },
  });

  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("MCODA_RUN_ALL_TESTS_COMPLETE status="));

  const summaryPath = path.join(root, "tests", "results", "test-summary.json");
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const repoEntry = summary.results.find((entry) => entry.label === "repo-tests");
  assert.ok(repoEntry);
  const firstToken = repoEntry.cmd.split(" ")[0];
  assert.equal(path.isAbsolute(firstToken), false);
  assert.ok(firstToken.toLowerCase().includes("node"));
  assert.ok(!repoEntry.cmd.includes(process.execPath));
});
