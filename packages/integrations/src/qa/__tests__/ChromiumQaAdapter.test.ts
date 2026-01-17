import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChromiumQaAdapter } from "../ChromiumQaAdapter.js";
import { QaProfile } from "@mcoda/shared/qa/QaProfile.js";

test("ChromiumQaAdapter runs test command and captures artifacts with install skip", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
  const adapter = new ChromiumQaAdapter();
  const profile: QaProfile = {
    name: "ui",
    runner: "chromium",
    test_command: 'node -e "console.log(\\"ui ok\\")"',
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

test("ChromiumQaAdapter ensureInstalled fails without Playwright and no test command", async () => {
  const prev = process.env.MCODA_FORCE_NO_PLAYWRIGHT;
  process.env.MCODA_FORCE_NO_PLAYWRIGHT = "1";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
  try {
    const adapter = new ChromiumQaAdapter();
    const profile: QaProfile = { name: "ui", runner: "chromium" };
    const ctx = {
      workspaceRoot: tmp,
      jobId: "job-1",
      taskKey: "task-1",
      env: {},
    };
    const ensure = await adapter.ensureInstalled(profile, ctx as any);
    assert.equal(ensure.ok, false);
    assert.ok(ensure.message?.includes("Playwright CLI"));
  } finally {
    if (prev === undefined) delete process.env.MCODA_FORCE_NO_PLAYWRIGHT;
    else process.env.MCODA_FORCE_NO_PLAYWRIGHT = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("ChromiumQaAdapter ensureInstalled allows custom test command without Playwright", async () => {
  const prev = process.env.MCODA_FORCE_NO_PLAYWRIGHT;
  process.env.MCODA_FORCE_NO_PLAYWRIGHT = "1";
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-chromium-"));
  try {
    const adapter = new ChromiumQaAdapter();
    const profile: QaProfile = {
      name: "ui",
      runner: "chromium",
      test_command: 'node -e "console.log(\\"ui ok\\")"',
    };
    const ctx = {
      workspaceRoot: tmp,
      jobId: "job-1",
      taskKey: "task-1",
      env: {},
    };
    const ensure = await adapter.ensureInstalled(profile, ctx as any);
    assert.equal(ensure.ok, true);
  } finally {
    if (prev === undefined) delete process.env.MCODA_FORCE_NO_PLAYWRIGHT;
    else process.env.MCODA_FORCE_NO_PLAYWRIGHT = prev;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
