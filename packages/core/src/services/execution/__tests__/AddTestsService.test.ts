import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceRepository } from "@mcoda/db";
import { WorkspaceResolver } from "../../../workspace/WorkspaceManager.js";
import { AddTestsService } from "../AddTestsService.js";

const setupWorkspace = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mcoda-add-tests-"));
  const workspace = await WorkspaceResolver.resolveWorkspace({ cwd: dir, explicitWorkspace: dir });
  const repo = await WorkspaceRepository.create(workspace.workspaceRoot);
  const project = await repo.createProjectIfMissing({ key: "proj", name: "proj" });
  const [epic] = await repo.insertEpics(
    [
      {
        projectId: project.id,
        key: "proj-epic",
        title: "Epic",
        description: "",
      },
    ],
    false,
  );
  const [story] = await repo.insertStories(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        key: "proj-epic-us-01",
        title: "Story",
        description: "",
      },
    ],
    false,
  );
  const [task] = await repo.insertTasks(
    [
      {
        projectId: project.id,
        epicId: epic.id,
        userStoryId: story.id,
        key: "proj-epic-us-01-t01",
        title: "Task",
        description: "",
        status: "not_started",
        metadata: {
          test_requirements: {
            unit: ["unit coverage"],
            component: [],
            integration: [],
            api: [],
          },
          qa: {
            blockers: ["No runnable test harness discovered for required tests during planning."],
          },
        },
      },
    ],
    false,
  );
  return { dir, workspace, repo, task };
};

const cleanup = async (dir: string, repo: WorkspaceRepository) => {
  await repo.close();
  await fs.rm(dir, { recursive: true, force: true });
};

test("AddTestsService creates run-all script and patches task metadata", async () => {
  const { dir, workspace, repo, task } = await setupWorkspace();
  const service = await AddTestsService.create(workspace);
  try {
    const result = await service.addTests({
      projectKey: "proj",
      commit: false,
    });

    assert.ok(result.createdFiles.includes("tests/all.js"));
    const scriptPath = path.join(dir, "tests", "all.js");
    const script = await fs.readFile(scriptPath, "utf8");
    assert.match(script, /MCODA_RUN_ALL_TESTS_COMPLETE/);

    const updated = await repo.getTaskById(task.id);
    const metadata = (updated?.metadata as Record<string, unknown> | undefined) ?? {};
    const tests = Array.isArray(metadata.tests) ? (metadata.tests as string[]) : [];
    assert.ok(tests.length > 0);
    assert.ok(tests.some((command) => command.includes("tests/all.js")));
    const qa = (metadata.qa as Record<string, unknown> | undefined) ?? {};
    const blockers = Array.isArray(qa.blockers) ? (qa.blockers as string[]) : [];
    assert.equal(blockers.length, 0);
  } finally {
    await service.close();
    await cleanup(dir, repo);
  }
});

test("AddTestsService dry-run does not create files", async () => {
  const { dir, workspace, repo } = await setupWorkspace();
  const service = await AddTestsService.create(workspace);
  try {
    const result = await service.addTests({
      projectKey: "proj",
      dryRun: true,
      commit: false,
    });

    assert.ok(result.warnings.some((warning) => warning.includes("Dry-run")));
    const exists = await fs
      .access(path.join(dir, "tests", "all.js"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  } finally {
    await service.close();
    await cleanup(dir, repo);
  }
});
