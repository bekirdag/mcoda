import test from "node:test";
import assert from "node:assert/strict";
import { EvalRunner, type EvalTaskExecutorLike } from "../EvalRunner.js";
import type { EvalTaskExecution } from "../EvalTaskExecutor.js";
import type { EvalTaskDefinition } from "../SuiteSchema.js";

const buildTask = (id: string): EvalTaskDefinition => ({
  id,
  title: id,
  mode: "success",
  command: "run",
  inline_task: `task ${id}`,
  args: [],
  assertions: {
    expect_success: true,
    expect_exit_code: 0,
    allow_hallucination: false,
    allow_scope_violation: false,
  },
});

const buildExecution = (task: EvalTaskDefinition, passed: boolean): EvalTaskExecution => ({
  task_id: task.id,
  title: task.title,
  command: task.command,
  mode: task.mode,
  started_at: new Date(0).toISOString(),
  ended_at: new Date(1).toISOString(),
  duration_ms: 1,
  exit_code: passed ? 0 : 1,
  run_succeeded: passed,
  task_passed: passed,
  first_pass: passed,
  patch_apply_success: passed,
  verification_outcome: passed ? "verified_passed" : "verified_failed",
  verification_passed: passed,
  hallucination_detected: false,
  scope_violation_detected: false,
  latency_ms: 1,
  tokens_used: 10,
  cost_usd: 0.01,
  assertion_results: [],
  stdout: "",
  stderr: "",
  command_line: ["node", "cli.js", task.command],
  safety_events: [],
});

test("EvalRunner executes tasks in deterministic order and summarizes outcomes", { concurrency: false }, async () => {
  const tasks = [buildTask("task-1"), buildTask("task-2"), buildTask("task-3")];
  const observedOrder: string[] = [];
  const executor: EvalTaskExecutorLike = {
    async executeTask(task): Promise<EvalTaskExecution> {
      observedOrder.push(task.id);
      return buildExecution(task, task.id !== "task-2");
    },
  };

  const runner = new EvalRunner({
    suite_id: "suite-1",
    suite_fingerprint: "abc123",
    tasks,
    executor,
  });
  const result = await runner.run();
  assert.deepEqual(observedOrder, ["task-1", "task-2", "task-3"]);
  assert.equal(result.summary.total, 3);
  assert.equal(result.summary.passed, 2);
  assert.equal(result.summary.failed, 1);
  assert.equal(result.summary.execution_errors, 0);
});
