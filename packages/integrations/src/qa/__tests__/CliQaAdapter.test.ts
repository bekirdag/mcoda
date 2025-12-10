import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliQaAdapter } from "../CliQaAdapter.js";
import { QaProfile } from "@mcoda/shared/qa/QaProfile.js";

test("CliQaAdapter runs command and writes logs", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-cli-"));
  const adapter = new CliQaAdapter();
  const profile: QaProfile = {
    name: "unit",
    runner: "cli",
    test_command: 'node -e "console.log(\\"ok\\")"',
  };
  const ctx = {
    workspaceRoot: tmp,
    jobId: "job-1",
    taskKey: "task-1",
    env: process.env,
    artifactDir: path.join(tmp, ".mcoda", "jobs", "job-1", "qa", "task-1"),
  };
  const ensure = await adapter.ensureInstalled(profile, ctx);
  assert.equal(ensure.ok, true);
  const result = await adapter.invoke(profile, ctx);
  assert.equal(result.outcome, "pass");
  assert.equal(result.exitCode, 0);
  assert.ok(result.artifacts.length >= 2);
  const stdoutPath = path.join(tmp, result.artifacts[0]);
  const stdout = await fs.readFile(stdoutPath, "utf8");
  assert.match(stdout, /ok/);
});
