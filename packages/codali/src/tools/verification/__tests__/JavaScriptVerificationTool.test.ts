import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJavaScriptVerificationTool, javaScriptAnswerSource } from "../JavaScriptVerificationTool.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";
import { ToolRegistry } from "../../ToolRegistry.js";

const isolated = executorStatus();
const options = { skip: isolated.available ? false : isolated.reason };
const run = async (source: string, cases = [{ args: [] as unknown[], expected: 3 as unknown }], extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
  const registry = new ToolRegistry(); registry.register(createJavaScriptVerificationTool());
  return registry.execute("verify_javascript", { source, entry: "solve", cases, ...extra }, { workspaceRoot: os.tmpdir(), signal });
};

test("verification compares actual observations, keeps expected values outside the program, and identifies source", options, async () => {
  const source = "export function solve(x) { return { doubled: x * 2 }; }";
  const result = await run(source, [{ args: [4], expected: { doubled: 8 } }, { args: [-2], expected: { doubled: -4 } }]);
  assert.equal(result.ok, true, result.error?.message || result.output);
  const data = JSON.parse(result.output);
  assert.equal(data.passed, true); assert.equal(data.checks.length, 2);
  assert.match(data.sourceSha256, /^[a-f0-9]{64}$/); assert.match(data.scope, /Only the supplied cases/);
  const wrong = await run(source, [{ args: [4], expected: { doubled: 9 } }]);
  assert.equal(wrong.ok, true); assert.equal(JSON.parse(wrong.output).passed, false);
});

test("verification detects mutation and uses fresh module state for each case", options, async () => {
  const mutating = await run("export function solve(xs) { xs.sort(); return xs; }", [{ args: [[2, 1]], expected: [1, 2] }], { preserveInput: true });
  assert.equal(JSON.parse(mutating.output).passed, false); assert.match(mutating.output, /mutated/);
  const fresh = await run("let n=0; export function solve() { return ++n; }", [{ args: [], expected: 1 }, { args: [], expected: 1 }]);
  assert.equal(JSON.parse(fresh.output).passed, true);
});

test("module promise queues settle while guest microtasks remain bounded", options, async () => {
  const settled = await run("await Promise.resolve(); export function solve(){return 3}");
  assert.equal(settled.ok, true, settled.error?.message || settled.output);
  assert.equal(JSON.parse(settled.output).passed, true);
  const runaway = await run("Promise.resolve().then(()=>{while(true){}}); export function solve(){return 3}");
  assert.equal(runaway.ok, true, runaway.error?.message || runaway.output);
  assert.equal(JSON.parse(runaway.output).passed, false);
});

test("verification rejects non-JSON outputs instead of accepting lossy JSON coercion", options, async () => {
  for (const expression of ["NaN", "Infinity", "undefined", "({x:undefined})", "[,1]", "Promise.resolve(null)", "({get x(){return 1}})", "1n"]) {
    const result = await run(`export function solve(){ return ${expression}; }`, [{ args: [], expected: null }]);
    assert.equal(result.ok, true, expression); assert.equal(JSON.parse(result.output).passed, false, expression);
  }
});

test("verification refuses imports and host APIs; workspace files remain untouched", options, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-verification-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "private.txt"); await fs.writeFile(file, "sentinel");
  const unavailable = await run("export function solve(){return [typeof process,typeof require,typeof fetch,typeof Buffer];}",
    [{ args: [], expected: ["undefined", "undefined", "undefined", "undefined"] }]);
  assert.equal(JSON.parse(unavailable.output).passed, true);
  for (const source of [
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(file)},'changed'); export function solve(){return 3}`,
    "export function solve(){return (()=>{}).constructor('return process')().pid}",
    "export function solve(){throw {toString(){while(true){}}}}",
    "export function solve(){while(true){}}",
  ]) {
    const result = await run(source); assert.equal(result.ok, true); assert.equal(JSON.parse(result.output).passed, false);
  }
  assert.equal(await fs.readFile(file, "utf8"), "sentinel");
});

test("guest serialization hooks cannot forge observed results", options, async () => {
  const result = await run("export function solve(){return {toJSON(){return 3},actual:7}}", [{ args: [], expected: 3 }]);
  assert.equal(result.ok, true); assert.equal(JSON.parse(result.output).passed, false);
  const polluted = await run("Object.prototype.toJSON=()=>3; export function solve(){return 7}");
  assert.equal(polluted.ok, true); assert.equal(JSON.parse(polluted.output).passed, false);
});

test("verification cancellation terminates execution and never returns passed", options, async () => {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(Error("cancel verification")), 50);
  try {
    await assert.rejects(run("export function solve(){while(true){}}", undefined, {}, abort.signal), /cancel verification/);
  } finally { clearTimeout(timer); }
});

test("verification validates limits before launching code and extracts only one module", async () => {
  const empty = await run("export function solve(){return 3}", []); assert.equal(empty.ok, false);
  const excessive = await run("export function solve(){return 3}", Array.from({ length: 17 }, () => ({ args: [], expected: 3 }))); assert.equal(excessive.ok, false);
  const large = await run("x".repeat(24001)); assert.equal(large.ok, false);
  assert.equal(javaScriptAnswerSource("```js\nexport const solve=()=>3;\n```"), "export const solve=()=>3;");
  assert.throws(() => javaScriptAnswerSource("```js\na\n```\n```js\nb\n```"), /one complete/);
  assert.throws(() => javaScriptAnswerSource("```python\nprint(3)\n```"), /JavaScript/);
});
