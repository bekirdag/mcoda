import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MaestroQaAdapter } from "../MaestroQaAdapter.js";
import { QaProfile } from "@mcoda/shared/qa/QaProfile.js";

test("MaestroQaAdapter runs test command and captures artifacts with install skip", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-maestro-"));
  const adapter = new MaestroQaAdapter();
  const profile: QaProfile = {
    name: "mobile",
    runner: "maestro",
    test_command: 'node -e "console.log(\\"mobile ok\\")"',
  };
  const ctx = {
    workspaceRoot: tmp,
    jobId: "job-1",
    taskKey: "task-1",
    env: { ...process.env, MCODA_QA_SKIP_INSTALL: "1" },
    artifactDir: path.join(tmp, ".mcoda", "jobs", "job-1", "qa", "task-1"),
  };
  const ensure = await adapter.ensureInstalled(profile, ctx);
  assert.equal(ensure.ok, true);
  const result = await adapter.invoke(profile, ctx);
  assert.equal(result.outcome, "pass");
  assert.equal(result.exitCode, 0);
  assert.ok(result.artifacts.length >= 2);
});
