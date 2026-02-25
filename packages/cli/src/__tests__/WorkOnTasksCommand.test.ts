import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { parseWorkOnTasksArgs, pickWorkOnTasksProjectKey } from "../commands/work/WorkOnTasksCommand.js";

describe("work-on-tasks argument parsing", () => {
  it("applies defaults for booleans and statuses", () => {
    const parsed = parseWorkOnTasksArgs([]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.noCommit, false);
    assert.equal(parsed.dryRun, false);
    assert.equal(parsed.rateAgents, false);
    assert.equal(parsed.executionContextPolicy, "require_sds_or_openapi");
    assert.deepEqual(parsed.statusFilter, ["not_started", "in_progress", "changes_requested"]);
  });

  it("captures tasks and explicit statuses", () => {
    const parsed = parseWorkOnTasksArgs([
      "--task",
      "alpha",
      "--task=beta",
      "--status",
      "blocked,in_progress",
    ]);
    assert.deepEqual(parsed.taskKeys, ["alpha", "beta"]);
    assert.deepEqual(parsed.statusFilter, ["in_progress"]);
  });

  it("parses numeric flags and agent stream overrides", () => {
    const parsed = parseWorkOnTasksArgs([
      "--agent-stream=false",
      "--limit",
      "5",
      "--parallel",
      "2",
      "--no-commit",
      "--dry-run",
      "--rate-agents",
    ]);
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.parallel, 2);
    assert.equal(parsed.noCommit, true);
    assert.equal(parsed.dryRun, true);
    assert.equal(parsed.rateAgents, true);
  });

  it("captures auto-merge and auto-push overrides", () => {
    const parsed = parseWorkOnTasksArgs([
      "--no-auto-merge",
      "--auto-push=false",
    ]);
    assert.equal(parsed.autoMerge, false);
    assert.equal(parsed.autoPush, false);
  });

  it("accepts workspace alias flags", () => {
    const root = path.resolve("/tmp/demo");
    const parsed = parseWorkOnTasksArgs(["--workspace-root", root, "--project", "proj"]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
  });

  it("parses work runner overrides", () => {
    const parsed = parseWorkOnTasksArgs(["--work-runner", "codali"]);
    assert.equal(parsed.workRunner, "codali");
    assert.equal(parsed.useCodali, true);
    assert.equal(parsed.agentAdapterOverride, "codali-cli");
  });

  it("parses missing test harness policy flags", () => {
    const parsed = parseWorkOnTasksArgs([
      "--missing-tests-policy",
      "fail_task",
      "--allow-missing-tests=false",
    ]);
    assert.equal(parsed.missingTestsPolicy, "fail_task");
    assert.equal(parsed.allowMissingTests, false);
  });

  it("parses missing context policy flag", () => {
    const parsed = parseWorkOnTasksArgs([
      "--missing-context-policy",
      "warn",
    ]);
    assert.equal(parsed.missingContextPolicy, "warn");
  });

  it("parses execution context policy flag", () => {
    const parsed = parseWorkOnTasksArgs([
      "--execution-context-policy",
      "best_effort",
    ]);
    assert.equal(parsed.executionContextPolicy, "best_effort");
  });

  it("treats allow-missing-tests as boolean alias", () => {
    const parsed = parseWorkOnTasksArgs(["--allow-missing-tests"]);
    assert.equal(parsed.allowMissingTests, true);
  });

  it("derives runner from use-codali flag", () => {
    const parsed = parseWorkOnTasksArgs(["--use-codali"]);
    assert.equal(parsed.useCodali, true);
    assert.equal(parsed.workRunner, "codali");
    assert.equal(parsed.agentAdapterOverride, "codali-cli");
  });

  it("respects environment runner defaults", () => {
    const originalRunner = process.env.MCODA_WORK_ON_TASKS_ADAPTER;
    const originalUse = process.env.MCODA_WORK_ON_TASKS_USE_CODALI;
    try {
      process.env.MCODA_WORK_ON_TASKS_ADAPTER = "codali-cli";
      delete process.env.MCODA_WORK_ON_TASKS_USE_CODALI;
      const parsed = parseWorkOnTasksArgs([]);
      assert.equal(parsed.workRunner, "codali-cli");
      assert.equal(parsed.useCodali, true);
      assert.equal(parsed.agentAdapterOverride, "codali-cli");

      delete process.env.MCODA_WORK_ON_TASKS_ADAPTER;
      process.env.MCODA_WORK_ON_TASKS_USE_CODALI = "1";
      const parsedUse = parseWorkOnTasksArgs([]);
      assert.equal(parsedUse.workRunner, "codali");
      assert.equal(parsedUse.useCodali, true);
      assert.equal(parsedUse.agentAdapterOverride, "codali-cli");
    } finally {
      if (originalRunner === undefined) {
        delete process.env.MCODA_WORK_ON_TASKS_ADAPTER;
      } else {
        process.env.MCODA_WORK_ON_TASKS_ADAPTER = originalRunner;
      }
      if (originalUse === undefined) {
        delete process.env.MCODA_WORK_ON_TASKS_USE_CODALI;
      } else {
        process.env.MCODA_WORK_ON_TASKS_USE_CODALI = originalUse;
      }
    }
  });

  it("picks explicit project key over configured and existing", () => {
    const selected = pickWorkOnTasksProjectKey({
      requestedKey: "explicit",
      configuredKey: "configured",
      existing: [{ key: "existing", createdAt: "2026-02-01T00:00:00.000Z" }],
    });
    assert.equal(selected.projectKey, "explicit");
    assert.ok(selected.warnings.some((warning) => warning.includes("overriding configured project key")));
  });

  it("falls back to configured project key when request is missing", () => {
    const selected = pickWorkOnTasksProjectKey({
      configuredKey: "configured",
      existing: [{ key: "existing", createdAt: "2026-02-01T00:00:00.000Z" }],
    });
    assert.equal(selected.projectKey, "configured");
  });

  it("falls back to first existing workspace project when no request/config", () => {
    const selected = pickWorkOnTasksProjectKey({
      existing: [
        { key: "proj-a", createdAt: "2026-01-01T00:00:00.000Z" },
        { key: "proj-b", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    });
    assert.equal(selected.projectKey, "proj-a");
    assert.ok(selected.warnings.some((warning) => warning.includes("defaulting to first workspace project")));
  });
});
