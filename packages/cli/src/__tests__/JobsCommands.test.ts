import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { formatDocgenDetail, formatOpenapiDetail, parseJobArgs, renderJobTokens } from "../commands/jobs/JobsCommands.js";

const captureConsole = (fn: () => void): string => {
  const output: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return output.join("\n");
};

describe("job CLI parsing", () => {
  it("parses list filters and json flag", () => {
    const parsed = parseJobArgs(["list", "--project", "PROJ", "--status", "running", "--type", "work", "--since", "1h", "--limit", "5", "--json"]);
    assert.equal(parsed.subcommand, "list");
    assert.equal(parsed.project, "PROJ");
    assert.equal(parsed.status, "running");
    assert.equal(parsed.type, "work");
    assert.equal(parsed.since, "1h");
    assert.equal(parsed.limit, 5);
    assert.equal(parsed.json, true);
  });

  it("accepts positional job id for status/logs/watch", () => {
    const parsed = parseJobArgs(["status", "job-123"]);
    assert.equal(parsed.subcommand, "status");
    assert.equal(parsed.jobId, "job-123");
  });

  it("parses watch interval and no-logs with workspace root", () => {
    const root = path.resolve("/tmp/demo");
    const parsed = parseJobArgs(["watch", "job-5", "--interval", "2", "--no-logs", "--workspace-root", root]);
    assert.equal(parsed.subcommand, "watch");
    assert.equal(parsed.jobId, "job-5");
    assert.equal(parsed.intervalSeconds, 2);
    assert.equal(parsed.noLogs, true);
    assert.equal(parsed.workspaceRoot, root);
  });

  it("captures resume agent flag", () => {
    const parsed = parseJobArgs(["resume", "job-9", "--agent", "codex"]);
    assert.equal(parsed.subcommand, "resume");
    assert.equal(parsed.jobId, "job-9");
    assert.equal(parsed.agent, "codex");
  });

  it("parses logs follow and since", () => {
    const parsed = parseJobArgs(["logs", "job-10", "--since", "2025-01-01T00:00:00Z", "--follow"]);
    assert.equal(parsed.subcommand, "logs");
    assert.equal(parsed.jobId, "job-10");
    assert.equal(parsed.since, "2025-01-01T00:00:00Z");
    assert.equal(parsed.follow, true);
  });

  it("renders cached token columns in job tokens table", () => {
    const output = captureConsole(() =>
      renderJobTokens([
        {
          workspace_id: "ws-1",
          agent_id: "agent-1",
          model_name: "gpt-4",
          job_id: "job-1",
          command_run_id: "cmd-1",
          task_run_id: null,
          task_id: "task-1",
          project_id: null,
          epic_id: null,
          user_story_id: null,
          tokens_prompt: 8,
          tokens_completion: 4,
          tokens_total: 12,
          tokens_cached: 3,
          tokens_cache_read: 2,
          tokens_cache_write: 1,
          cost_estimate: 0.2,
          duration_seconds: 1.5,
          duration_ms: 1500,
          started_at: "2024-01-01T00:00:00Z",
          finished_at: "2024-01-01T00:00:01Z",
          timestamp: "2024-01-01T00:00:00Z",
          command_name: "work-on-tasks",
          action: "plan",
          invocation_kind: "chat",
          provider: "openai",
          currency: "USD",
          error_kind: null,
          metadata: {},
        },
      ]),
    );
    const header = output.split("\n")[0] ?? "";
    assert.match(header, /TOKENS_CACHED/);
    assert.match(header, /CACHE_READ/);
    assert.match(header, /CACHE_WRITE/);
    assert.match(output, /1500/);
  });

  it("formats openapi detail with iteration and variant", () => {
    const detail = formatOpenapiDetail({
      openapi_stage: "draft",
      openapi_variant: "primary",
      openapi_iteration_current: 2,
      openapi_iteration_max: 4,
    });
    assert.equal(detail, "openapi:draft variant:primary iter:2/4");
  });

  it("formats docgen detail with iteration and elapsed", () => {
    const detail = formatDocgenDetail({
      docgen_stage: "review",
      docgen_iteration_current: 1,
      docgen_iteration_max: 3,
      docgen_elapsed_seconds: 75,
      docgen_status_message: "Review iteration 1/3",
    });
    assert.equal(detail, "Review iteration 1/3 iter:1/3 elapsed:1m15s");
  });
});
