import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliQaAdapter } from "../CliQaAdapter.js";
import { QaProfile } from "@mcoda/shared/qa/QaProfile.js";
import { PathHelper } from "@mcoda/shared";

const withTempHome = async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
  const originalHome = process.env.HOME;
  const originalProfile = process.env.USERPROFILE;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn(home);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalProfile;
    await fs.rm(home, { recursive: true, force: true });
  }
};

test("CliQaAdapter runs command and writes logs", async () => {
  await withTempHome(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-cli-"));
    try {
      const adapter = new CliQaAdapter();
      const profile: QaProfile = {
        name: "unit",
        runner: "cli",
        test_command: 'node -e "console.log(\\"ok\\")"',
      };
      const mcodaDir = PathHelper.getWorkspaceDir(tmp);
      const ctx = {
        workspaceRoot: tmp,
        jobId: "job-1",
        taskKey: "task-1",
        env: process.env,
        artifactDir: path.join(mcodaDir, "jobs", "job-1", "qa", "task-1"),
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
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

test("CliQaAdapter runs multiple commands and aggregates logs", async () => {
  await withTempHome(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-cli-"));
    try {
      const adapter = new CliQaAdapter();
      const profile: QaProfile = { name: "unit", runner: "cli", test_command: "echo ok" };
      const mcodaDir = PathHelper.getWorkspaceDir(tmp);
      const ctx = {
        workspaceRoot: tmp,
        jobId: "job-1",
        taskKey: "task-1",
        env: process.env,
        commands: [
          "node -e \"console.log('one')\"",
          "node -e \"console.log('two')\"",
        ],
        artifactDir: path.join(mcodaDir, "jobs", "job-1", "qa", "task-1"),
      };
      const result = await adapter.invoke(profile, ctx as any);
      assert.equal(result.outcome, "pass");
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /one/);
      assert.match(result.stdout, /two/);
      assert.ok(result.artifacts.length >= 4);
      assert.ok(result.artifacts.some((entry) => entry.endsWith("stdout-1.log")));
      assert.ok(result.artifacts.some((entry) => entry.endsWith("stdout-2.log")));
      for (const artifact of result.artifacts) {
        const artifactPath = path.join(tmp, artifact);
        await fs.access(artifactPath);
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

test("CliQaAdapter fails if any command fails", async () => {
  await withTempHome(async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-qa-cli-"));
    try {
      const adapter = new CliQaAdapter();
      const profile: QaProfile = { name: "unit", runner: "cli", test_command: "echo ok" };
      const mcodaDir = PathHelper.getWorkspaceDir(tmp);
      const ctx = {
        workspaceRoot: tmp,
        jobId: "job-1",
        taskKey: "task-1",
        env: process.env,
        commands: [
          "node -e \"process.exit(1)\"",
          "node -e \"console.log('still ran')\"",
        ],
        artifactDir: path.join(mcodaDir, "jobs", "job-1", "qa", "task-1"),
      };
      const result = await adapter.invoke(profile, ctx as any);
      assert.equal(result.outcome, "fail");
      assert.ok(result.exitCode && result.exitCode !== 0);
      assert.match(result.stdout, /still ran/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
