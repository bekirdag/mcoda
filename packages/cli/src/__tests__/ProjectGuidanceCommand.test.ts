import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseProjectGuidanceArgs, ProjectGuidanceCommand } from "../commands/workspace/ProjectGuidanceCommand.js";

const captureLogs = async (fn: () => Promise<void> | void): Promise<string[]> => {
  const logs: string[] = [];
  const originalLog = console.log;
  // @ts-ignore test override
  console.log = (...args: any[]) => {
    logs.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    // @ts-ignore restore
    console.log = originalLog;
  }
  return logs;
};

const withTempHome = async (
  fn: (workspaceRoot: string) => Promise<void>,
): Promise<void> => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-guidance-home-"));
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-guidance-ws-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  try {
    await fn(workspaceRoot);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
    await fs.rm(tempHome, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
};

test("parseProjectGuidanceArgs defaults", () => {
  const parsed = parseProjectGuidanceArgs([]);
  assert.equal(parsed.workspaceRoot, undefined);
  assert.equal(parsed.projectKey, undefined);
  assert.equal(parsed.force, false);
  assert.equal(parsed.json, false);
  assert.equal(parsed.help, false);
});

test("parseProjectGuidanceArgs parses workspace aliases and flags", () => {
  const root = path.resolve("/tmp/project-guidance-demo");
  const parsed = parseProjectGuidanceArgs([
    "--workspace",
    root,
    "--project",
    "demo",
    "--force",
    "--json=true",
  ]);
  assert.equal(parsed.workspaceRoot, root);
  assert.equal(parsed.projectKey, "demo");
  assert.equal(parsed.force, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.help, false);
});

test(
  "ProjectGuidanceCommand creates guidance file and reports JSON status",
  { concurrency: false },
  async () => {
    await withTempHome(async (workspaceRoot) => {
      const firstRun = await captureLogs(() =>
        ProjectGuidanceCommand.run(["--workspace-root", workspaceRoot, "--json"]),
      );
      const firstPayload = JSON.parse(firstRun.join("\n"));
      assert.equal(firstPayload.status, "created");
      assert.equal(firstPayload.projectKey, null);
      assert.equal(typeof firstPayload.path, "string");
      const firstContent = await fs.readFile(firstPayload.path, "utf8");
      assert.ok(firstContent.includes("# Project Guidance"));

      const secondRun = await captureLogs(() =>
        ProjectGuidanceCommand.run(["--workspace-root", workspaceRoot, "--json"]),
      );
      const secondPayload = JSON.parse(secondRun.join("\n"));
      assert.equal(secondPayload.status, "existing");
      assert.equal(secondPayload.path, firstPayload.path);
    });
  },
);

test(
  "ProjectGuidanceCommand supports project-scoped guidance path",
  { concurrency: false },
  async () => {
    await withTempHome(async (workspaceRoot) => {
      const run = await captureLogs(() =>
        ProjectGuidanceCommand.run(["--workspace-root", workspaceRoot, "--project", "WEB-01", "--json"]),
      );
      const payload = JSON.parse(run.join("\n"));
      assert.equal(payload.projectKey, "WEB-01");
      assert.equal(payload.status, "created");
      assert.ok(payload.path.includes(path.join("docs", "projects", "web-01", "project-guidance.md")));
    });
  },
);
