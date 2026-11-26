import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { createCodeRunTool } from "../CodeRunTool.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";
import { ToolRegistry, toolDescriptorFor } from "../../ToolRegistry.js";
import { permissionKind } from "../../../permissions/PermissionGate.js";

const isolated = executorStatus();
const options = { skip: isolated.available ? false : isolated.reason };
const run = (args: Record<string, unknown>) => {
  const registry = new ToolRegistry(); registry.register(createCodeRunTool());
  return registry.execute("run_code", args, { workspaceRoot: os.tmpdir() });
};

test("run_code is a read-only sandboxed tool", () => {
  assert.equal(permissionKind(toolDescriptorFor(createCodeRunTool())), "read");
});

test("run_code returns what a Python program printed, also when it then crashes", options, async () => {
  // Fresh variant: exact MVA for a two-station closed network, printed, then a bug.
  const source = [
    "demands = [0.04, 0.03]", "q = [0.0, 0.0]",
    "for n in range(1, 6):",
    "    r = [d * (1 + qk) for d, qk in zip(demands, q)]",
    "    x = n / sum(r)", "    q = [x * rk for rk in r]",
    "print(f'throughput = {x:.6f}')", "print({'missing': 1}['key'])",
  ].join("\n");
  const result = await run({ language: "python", source });
  assert.equal(result.ok, true, result.error?.message);
  const data = JSON.parse(result.output);
  assert.equal(data.exitCode, 1); assert.equal(data.timedOut, false);
  assert.match(data.stdout, /throughput = 2\d\.\d{6}/);
  assert.match(data.stderr, /KeyError/);
  const clean = JSON.parse((await run({ language: "python", source: "import math\nprint(round(math.erf(0.5), 6))" })).output);
  assert.equal(clean.exitCode, 0); assert.equal(clean.stdout.trim(), "0.5205");
});

test("run_code runs a JavaScript module offline and bounds time", options, async () => {
  const result = await run({ language: "javascript", source: "const fib = n => n < 2 ? n : fib(n - 1) + fib(n - 2);\nconsole.log(JSON.stringify({ fib20: fib(20) }));" });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(JSON.parse(JSON.parse(result.output).stdout), { fib20: 6765 });
  const offline = JSON.parse((await run({ language: "javascript", source: "try { await fetch('http://example.com'); console.log('online'); } catch { console.log('offline'); }" })).output);
  assert.equal(offline.stdout.trim(), "offline");
  const slow = JSON.parse((await run({ language: "python", source: "while True: pass", timeoutSeconds: 1 })).output);
  assert.equal(slow.timedOut, true);
  assert.equal((await run({ language: "ruby", source: "puts 1" })).ok, false);
});
