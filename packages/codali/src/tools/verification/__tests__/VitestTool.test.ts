import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeTestFiles, createVitestTool, isTestFile, testFailureSummary } from "../VitestTool.js";
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
  for (const [content, expected] of [["import package_that_does_not_exist\n", /ModuleNotFoundError/], ["def helper(): return True\n", /Zero executed tests/]] as const) {
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

test("the Python runner accepts pytest-style tests without pytest installed", options, async () => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  const run = async (testSource: string) => {
    const result = await registry.execute("verify_tests", { runner: "python", files: [
      { path: "interval.py", content: "def merge(a):\n    out=[]\n    for s,e in sorted(a):\n        if out and s<=out[-1][1]: out[-1][1]=max(out[-1][1],e)\n        else: out.append([s,e])\n    return out\n\ndef mean(xs):\n    if not xs: raise ValueError('empty input')\n    return sum(xs)/len(xs)\n" },
      { path: "test_interval.py", content: testSource }] }, { workspaceRoot: os.tmpdir() });
    return { ok: result.ok, body: result.ok ? JSON.parse(result.output) : undefined, message: result.error?.message ?? "" };
  };
  const passing = await run(`import pytest
from interval import merge, mean

def test_merges_overlaps():
    assert merge([[1, 3], [2, 6], [8, 10]]) == [[1, 6], [8, 10]]

@pytest.mark.parametrize("values,expected", [([1, 2, 3], 2.0), ([0.1, 0.2], 0.15), ([5], 5)])
def test_mean(values, expected):
    assert mean(values) == pytest.approx(expected)

def test_empty_mean_is_refused():
    with pytest.raises(ValueError, match="empty"):
        mean([])
`);
  assert.equal(passing.ok, true, passing.message);
  assert.equal(passing.body.passed, true, JSON.stringify(passing.body));
  assert.equal(passing.body.total, 5);
  // A wrong expectation still fails; a stand-in must not turn tests into no-ops.
  const failing = await run(`import pytest
from interval import mean

def test_wrong():
    assert mean([1, 2]) == pytest.approx(2.0)

def test_not_raised():
    with pytest.raises(ValueError):
        mean([1])
`);
  assert.equal(failing.ok, true, failing.message);
  assert.equal(failing.body.passed, false);
  assert.equal(failing.body.failedTests, 2);
  // Forms an independent review found reported as passed by the first version.
  const classes = await run(`import pytest
from interval import mean

def test_passes():
    assert mean([2, 4]) == 3

class TestMean:
    def setup_method(self, method):
        self.values = [1, 2, 3]
    def test_ok(self):
        assert mean(self.values) == 2
    def test_failing_method(self):
        assert mean(self.values) == 99
    @pytest.mark.parametrize("n", [1, 2])
    def test_each(self, n):
        assert mean([n]) == n

async def test_async_is_not_silently_passed():
    assert False

def test_generator_is_not_silently_passed():
    yield
    assert False
`);
  assert.equal(classes.ok, true, classes.message);
  assert.equal(classes.body.passed, false);
  assert.equal(classes.body.total, 7);
  assert.equal(classes.body.failedTests, 3);
  assert.match(classes.body.diagnostic, /async test|generator test|99/);
  // What the stand-in does not provide is reported by name instead of passing silently.
  const fixture = await run(`import pytest

def test_needs_fixture(tmp_path):
    assert tmp_path
`);
  assert.equal(fixture.body?.passed, false);
  assert.match(fixture.body.diagnostic, /fixture tmp_path is not available/);
});

// Cycle 7 (.43 WP-F2): test_x.js with runner node was refused by a message
// that never named the naming rule. Fresh variant: a ring buffer.
test("node runs explicitly listed tests named by common conventions", options, async () => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  const source = { path: "ringbuffer.js", content: "export class Ring{constructor(n){this.n=n;this.items=[]}push(x){this.items.push(x);if(this.items.length>this.n)this.items.shift()}toArray(){return [...this.items]}}" };
  const tests = "import test from 'node:test';import assert from 'node:assert/strict';import {Ring} from './ringbuffer.js';test('drops oldest',()=>{const r=new Ring(2);r.push(1);r.push(2);r.push(3);assert.deepEqual(r.toArray(),[2,3])});";
  for (const [name, content] of [["test_ringbuffer.js", tests], ["test-ringbuffer.mjs", tests], ["ringbuffer_test.js", tests], ["checks/ring_cases.js", tests.replace("./ringbuffer.js", "../ringbuffer.js")]]) {
    const result = await registry.execute("verify_tests", { runner: "node", files: [source, { path: name, content }] }, { workspaceRoot: os.tmpdir() });
    assert.equal(result.ok, true, `${name}: ${result.error?.message}`);
    assert.equal(JSON.parse(result.output).passed, true, name);
    assert.equal(JSON.parse(result.output).total, 1, name);
  }
});

test("verify_tests rejections name the file and the rule it broke", async () => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  const reject = async (args: unknown) => { const result = await registry.execute("verify_tests", args, { workspaceRoot: os.tmpdir() }); assert.equal(result.ok, false); return result.error!.message; };
  assert.match(await reject({ runner: "python", files: [{ path: "probe_ledger.py", content: "print(1)\n" }] }), /probe_ledger\.py is recognized as a test.*test_<name>\.py or <name>_test\.py/);
  assert.match(await reject({ runner: "node", files: [{ path: "ledger.ts", content: "export {}" }, { path: "ledger.test.js", content: "import test from 'node:test'" }] }), /"ledger\.ts": runner node cannot load TypeScript/);
  assert.match(await reject({ runner: "node", files: [{ path: "ledger.test.js", content: "import test from 'node:test';import {total} from './ledger.js';" }] }), /ledger\.test\.js imports "\.\/ledger\.js", which is not among the files; include ledger\.js/);
  assert.match(await reject({ runner: "python", files: [{ path: "test_ledger.py", content: "x" }, { path: "test_ledger.py", content: "y" }] }), /same path/);
});

test("test-file recognition covers the runner conventions and nothing else", () => {
  const file = (name: string, content = "") => ({ path: name, content });
  for (const name of ["a.test.js", "a.spec.mjs", "test_a.cjs", "test-a.js", "a_test.js", "a-test.js", "test.js", "test/a.js"]) assert.equal(isTestFile(file(name), "node"), true, name);
  for (const name of ["a.js", "contest.js", "latest_build.js", "attest.mjs"]) assert.equal(isTestFile(file(name), "node"), false, name);
  assert.equal(isTestFile(file("cases.js", "import test from 'node:test'"), "node"), true);
  assert.equal(isTestFile(file("cases.ts", "import {test} from \"vitest\""), "vitest"), true);
  assert.equal(isTestFile(file("ledger_test.py"), "python"), true);
  assert.equal(isTestFile(file("ledger.py"), "python"), false);
});

// Cycle 7 (.43 WP-F3): five verify rounds sent only the test file and failed
// on the missing module. Fresh variant: a later call that omits the module.
test("a test sent without the module it imports gets the session's latest version of it", () => {
  const earlier = new Map([["tally.py", "def tally(xs):\n    return len(xs)\n"], ["lib/fmt.js", "export const f = 1;"]]);
  const python = completeTestFiles({ runner: "python", files: [{ path: "test_tally.py", content: "import unittest\nfrom tally import tally\n" }] }, earlier);
  assert.deepEqual(python.carried, ["tally.py"]);
  assert.deepEqual((python.args as { files: Array<{ path: string }> }).files.map(item => item.path), ["test_tally.py", "tally.py"]);
  const node = completeTestFiles({ runner: "node", files: [{ path: "lib/fmt.test.js", content: "import {f} from './fmt.js';" }] }, earlier);
  assert.deepEqual(node.carried, ["lib/fmt.js"]);
  // A module sent again is never replaced; unknown imports are left alone.
  const fresh = { runner: "python", files: [{ path: "tally.py", content: "def tally(xs):\n    return 0\n" }, { path: "test_tally.py", content: "import os\nfrom tally import tally\n" }] };
  assert.deepEqual(completeTestFiles(fresh, earlier), { args: fresh, carried: [] });
});

test("a Python run missing the code under test says to include it", options, async () => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  const result = await registry.execute("verify_tests", { runner: "python", files: [{ path: "test_tally.py", content: "import unittest\nfrom tally import tally\nclass T(unittest.TestCase):\n def test_a(self): self.assertEqual(tally([1]),1)\n" }] }, { workspaceRoot: os.tmpdir() });
  assert.equal(result.ok, false);
  assert.match(result.error!.message, /Module 'tally' is not among the files.*include tally\.py/);
});
