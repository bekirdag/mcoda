import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { GatewayTrioService } from "@mcoda/core";
import {
  GatewayTrioCommand,
  parseGatewayTrioArgs,
  validateGatewayTrioArgs,
} from "../commands/work/GatewayTrioCommand.js";

describe("gateway-trio argument parsing", () => {
  it("defaults status and qa flags", () => {
    const parsed = parseGatewayTrioArgs([]);
    assert.deepEqual(parsed.statusFilter, ["not_started", "in_progress", "ready_to_review", "ready_to_qa"]);
    assert.equal(parsed.qaMode, "auto");
    assert.equal(parsed.qaFollowups, "auto");
    assert.equal(parsed.agentStream, true);
    assert.equal(parsed.rateAgents, false);
  });

  it("parses selectors and numeric flags", () => {
    const parsed = parseGatewayTrioArgs([
      "--task",
      "TASK-1",
      "--status",
      "in_progress,ready_to_review",
      "--limit",
      "5",
      "--max-iterations",
      "2",
      "--max-cycles",
      "4",
    ]);
    assert.deepEqual(parsed.taskKeys, ["TASK-1"]);
    assert.deepEqual(parsed.statusFilter, ["in_progress", "ready_to_review"]);
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.maxIterations, 2);
    assert.equal(parsed.maxCycles, 4);
  });

  it("parses gateway, review, and qa flags", () => {
    const parsed = parseGatewayTrioArgs([
      "--gateway-agent",
      "router",
      "--max-docs",
      "10",
      "--review-base",
      "main",
      "--qa-profile",
      "smoke",
      "--qa-level",
      "unit",
      "--qa-test-command",
      "pnpm test",
      "--qa-mode",
      "manual",
      "--qa-followups",
      "prompt",
      "--agent-stream=false",
      "--rate-agents",
    ]);
    assert.equal(parsed.gatewayAgentName, "router");
    assert.equal(parsed.maxDocs, 10);
    assert.equal(parsed.reviewBase, "main");
    assert.equal(parsed.qaProfileName, "smoke");
    assert.equal(parsed.qaLevel, "unit");
    assert.equal(parsed.qaTestCommand, "pnpm test");
    assert.equal(parsed.qaMode, "manual");
    assert.equal(parsed.qaFollowups, "prompt");
    assert.equal(parsed.agentStream, false);
    assert.equal(parsed.rateAgents, true);
  });

  it("accepts workspace alias flags", () => {
    const root = path.resolve("/tmp/gateway");
    const parsed = parseGatewayTrioArgs(["--workspace-root", root, "--project", "proj"]);
    assert.equal(parsed.workspaceRoot, root);
    assert.equal(parsed.projectKey, "proj");
  });

  it("rejects mixed selectors", () => {
    const parsed = parseGatewayTrioArgs(["--task", "TASK-1", "--epic", "EPIC-1"]);
    assert.equal(validateGatewayTrioArgs(parsed), "gateway-trio: choose only one of --task, --epic, or --story");
  });

  it("reports missing required values", () => {
    const parsed = parseGatewayTrioArgs(["--project", "--max-iterations", "nope"]);
    const error = validateGatewayTrioArgs(parsed);
    assert.ok(error?.includes("--project requires a value"));
    assert.ok(error?.includes("--max-iterations requires a number"));
  });

  it("prints help and exits", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (msg?: any) => {
      logs.push(String(msg));
    };
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as any;
    try {
      assert.throws(() => parseGatewayTrioArgs(["--help"]), /exit:0/);
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
    }
    assert.ok(logs[0]?.includes("mcoda gateway-trio"));
  });
});

describe("gateway-trio CLI output shape", () => {
  it("emits structured JSON output", async () => {
    const originalCreate = GatewayTrioService.create;
    const fakeResult = {
      jobId: "job-123",
      commandRunId: "cmd-123",
      tasks: [
        {
          taskKey: "TASK-1",
          attempts: 2,
          status: "completed",
          chosenAgents: { work: "agent-a", review: "agent-b", qa: "agent-c" },
        },
      ],
      warnings: [],
      blocked: [],
      failed: [],
      skipped: [],
    };
    // @ts-expect-error override for test
    GatewayTrioService.create = async () => ({
      run: async () => fakeResult,
      close: async () => {},
    });
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg?: any) => {
      logs.push(String(msg));
    };
    await GatewayTrioCommand.run(["--json"]);
    console.log = originalLog;
    GatewayTrioService.create = originalCreate;
    const parsed = JSON.parse(logs[0]);
    assert.equal(parsed.jobId, "job-123");
    assert.equal(parsed.commandRunId, "cmd-123");
    assert.equal(parsed.tasks[0].taskKey, "TASK-1");
    assert.equal(parsed.summary.completed, 1);
  });
});
