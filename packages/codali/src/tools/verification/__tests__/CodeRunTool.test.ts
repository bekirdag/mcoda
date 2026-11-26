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

test("run_code always settles, even when the sandbox never returns", async () => {
  // Simulated hung sandbox/child: the runner ignores the stop signal and never settles.
  let stopped = false;
  const registry = new ToolRegistry();
  registry.register(createCodeRunTool({ settleGraceMs: 200, execute: (_command, _args, context) => {
    context.signal?.addEventListener("abort", () => { stopped = true; });
    return new Promise(() => undefined);
  } }));
  const started = Date.now();
  const result = await registry.execute("run_code", { language: "python", source: "print(1)", timeoutSeconds: 1 }, { workspaceRoot: os.tmpdir() });
  assert.ok(Date.now() - started < 5000);
  assert.equal(result.ok, true, result.error?.message);
  const data = JSON.parse(result.output);
  assert.equal(data.timedOut, true); assert.equal(data.exitCode, null);
  assert.equal(stopped, true, "the runner is told to stop");
});

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

test("the Python memory cap leaves room for a program with 200 threads", options, async () => {
  // Fresh variant: a parallel Monte Carlo with 200 worker threads.
  const source = "import threading\nresults = []\nlock = threading.Lock()\ndef work(i):\n    with lock:\n        results.append(i * i)\nthreads = [threading.Thread(target=work, args=(i,)) for i in range(200)]\nfor t in threads: t.start()\nfor t in threads: t.join()\nprint(len(results), sum(results))";
  const data = JSON.parse((await run({ language: "python", source })).output);
  assert.equal(data.exitCode, 0, data.stderr); assert.equal(data.stdout.trim(), "200 2646700");
});

// RLIMIT_AS is enforced by Linux; macOS accepts setrlimit but does not cap
// allocations, so the cap (and this check) applies on Linux only.
test("run_code caps Python memory and reports the failure as a receipt", { skip: process.platform !== "linux" ? "RLIMIT_AS is not enforced on this platform" : options.skip }, async () => {
  const hog = JSON.parse((await run({ language: "python", source: "print('start', flush=True)\nblock = bytearray(4 * 1024 ** 3)\nprint('allocated')" })).output);
  assert.notEqual(hog.exitCode, 0); assert.match(hog.stdout, /start/); assert.doesNotMatch(hog.stdout, /allocated/); assert.match(hog.stderr, /MemoryError/);
});
