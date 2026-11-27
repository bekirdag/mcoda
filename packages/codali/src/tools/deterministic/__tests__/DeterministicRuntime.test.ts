import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectDeterministicRuntime, checkDeterministicRuntime, runDeterministicRuntimeCommand } from "../DeterministicRuntime.js";
import { runTools } from "../../../cli/ToolsCommand.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";

test("runtime inspection reports missing Python independently of packaged workers", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-runtime-status-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const status = await inspectDeterministicRuntime({ pythonRoot: root });
  assert.equal(status.pythonEnvironment.installed, false);
  assert.equal(status.nodeWorker.installed, true); assert.equal(status.pythonWorker.installed, true);
  assert.match(status.nodeWorker.sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.match(status.note, /do not prove functionality/);
});

test("runtime checks expose partial installation without hiding healthy Node tools", { skip: !executorStatus().available }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-runtime-check-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const checks = await checkDeterministicRuntime({ pythonRoot: root });
  assert.equal(checks.length, 7);
  assert.deepEqual(checks.filter(check => check.passed).map(check => check.name), ["decimal_calculate", "numerical_calculate", "validate_json"]);
  for (const check of checks.filter(check => !check.passed)) assert.match(check.error ?? "", /Python tool runtime is missing/);
});

test("runtime setup rejects tenant/model arguments before connecting or installing", async () => {
  for (const argv of [["install", "--args-json", "{}"], ["check", "--context-json", "tenant.json"], ["install", "--json", "--json"]]) {
    await assert.rejects(runTools(argv, { write: () => undefined, resolveRunContext: async () => { throw new Error("Must not resolve tenant context"); } }), /host runtime commands/);
  }
  await assert.rejects(runDeterministicRuntimeCommand(["invented"], () => undefined), /host runtime commands/);
  await assert.rejects(checkDeterministicRuntime({}, AbortSignal.abort(new Error("cancel check"))), /cancel check/);
});
