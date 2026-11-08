import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVitestTool, testFailureSummary } from "../VitestTool.js";
import { ToolRegistry } from "../../ToolRegistry.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";
const status = executorStatus(); const options = { skip: !status.available && status.reason };
test("verification diagnostics preserve timeout and caused-by evidence beyond runner stacks", () => {
  const message = "Error: STACK_TRACE_ERROR\n" + "    at runner (/runtime/runner.js:11:22)\n".repeat(80) + "Caused by: Test timed out in 1000ms";
  assert.match(testFailureSummary(message), /timed out in 1000ms/);
  assert.ok(testFailureSummary(message).length < 200);
  assert.match(testFailureSummary("x".repeat(2000) + "Expected 4, received 9"), /Expected 4, received 9/);
});
test("whitespace-only failure summary returns empty", () => assert.equal(testFailureSummary("\n  at foo\n"), ""));

test("native Node and Python test suites execute without translating their assertion APIs", options, async () => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  const node = await registry.execute("verify_tests", { runner: "node", files: [
    { path: "subject.js", content: "export async function fail(){throw null}" },
    { path: "subject.test.js", content: "import test from 'node:test';import assert from 'node:assert/strict';import {fail} from './subject.js';test('null rejection',async()=>{await assert.rejects(fail(),e=>e===null)});" },
  ] }, { workspaceRoot: os.tmpdir() });
  assert.equal(node.ok, true, node.output || node.error?.message);
  assert.equal(JSON.parse(node.output).passed, true);
  const python = await registry.execute("verify_tests", { runner: "python", files: [
    { path: "subject.py", content: "def interval(a,b):\n return max(0,b-a)\n" },
    { path: "test_subject.py", content: "import unittest\nfrom subject import interval\nclass IntervalTests(unittest.TestCase):\n def test_empty(self): self.assertEqual(interval(3,3),0)\n def test_negative(self): self.assertEqual(interval(-4,2),6)\n" },
  ] }, { workspaceRoot: os.tmpdir() });
  assert.equal(python.ok, true, python.output || python.error?.message);
  assert.equal(JSON.parse(python.output).passed, true);
  assert.equal(JSON.parse(python.output).total, 2);
  const failing = await registry.execute("verify_tests", { runner: "python", files: [
    { path: "test_bad.py", content: "import unittest\nclass Bad(unittest.TestCase):\n def test_bad(self): self.assertEqual(2,3)\n" },
  ] }, { workspaceRoot: os.tmpdir() });
  assert.equal(failing.ok, true, failing.output || failing.error?.message);
  assert.equal(JSON.parse(failing.output).passed, false);
});
const run = (content: string, signal?: AbortSignal) => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  return registry.execute("verify_tests", { files: [{ path: "subject.ts", content: "export const add=(a:number,b:number)=>a+b;" }, { path: "subject.test.ts", content }] }, { workspaceRoot: os.tmpdir(), signal });
};
test("Python startup and empty-suite errors retain the actionable cause", options, async () => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  for (const [content, expected] of [["import package_that_does_not_exist\n", /ModuleNotFoundError/], ["def test_example(): assert True\n", /Zero executed tests/]] as const) {
    const result = await registry.execute("verify_tests", { runner: "python", files: [{ path: "test_subject.py", content }] }, { workspaceRoot: os.tmpdir() });
    assert.equal(result.ok, false);
    assert.match(result.error!.message, expected);
    assert.doesNotMatch(result.error!.message, /ENOENT/);
    assert.match(result.error!.message, /unittest/);
  }
});
test("Vitest executes real TypeScript assertions and distinguishes failures/skips", options, async () => {
  const prefix = "import {test,expect} from 'vitest'; import {add} from './subject';";
  const passing = await run(prefix + "test('addition',()=>expect(add(2,3)).toBe(5));");
  assert.equal(passing.ok, true, passing.error?.message || passing.output); assert.equal(JSON.parse(passing.output).passed, true);
  const failing = await run(prefix + "test('wrong expectation',()=>expect(add(2,3)).toBe(6));");
  assert.equal(failing.ok, true, failing.error?.message || failing.output); assert.equal(JSON.parse(failing.output).passed, false); assert.equal(JSON.parse(failing.output).failedTests, 1);
  const skipped = await run(prefix + "test.skip('pending',()=>expect(add(2,3)).toBe(6));");
  assert.equal(skipped.ok, true, skipped.error?.message || skipped.output); assert.equal(JSON.parse(skipped.output).passed, false);
});
test("Vitest cannot read workspace neighbors or credentials and honors cancellation", options, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-test-private-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = path.join(root, "private"); await fs.writeFile(secret, "sentinel");
  const result = await run(`import {test,expect} from 'vitest'; import fs from 'node:fs';test('boundary',()=>{expect(()=>fs.readFileSync(${JSON.stringify(secret)})).toThrow();expect(process.env.MCODA_MSWARM_API_KEY).toBeUndefined();});`);
  assert.equal(result.ok, true, result.error?.message || result.output); assert.equal(JSON.parse(result.output).passed, true);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(Error("cancel tests")), 30);
  try { await assert.rejects(run("while(true){}", abort.signal), /cancel tests/); } finally { clearTimeout(timer); }
});
