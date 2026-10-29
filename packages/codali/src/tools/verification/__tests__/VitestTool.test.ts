import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createVitestTool } from "../VitestTool.js";
import { ToolRegistry } from "../../ToolRegistry.js";
import { executorStatus } from "../../shell/IsolatedExecutor.js";
const status = executorStatus(); const options = { skip: !status.available && status.reason };
const run = (content: string, signal?: AbortSignal) => {
  const registry = new ToolRegistry(); registry.register(createVitestTool());
  return registry.execute("verify_tests", { files: [{ path: "subject.ts", content: "export const add=(a:number,b:number)=>a+b;" }, { path: "subject.test.ts", content }] }, { workspaceRoot: os.tmpdir(), signal });
};
test("Vitest executes real TypeScript assertions and distinguishes failures/skips", options, async () => {
  const prefix = "import {test,expect} from 'vitest'; import {add} from './subject';";
  const passing = await run(prefix + "test('addition',()=>expect(add(2,3)).toBe(5));");
  assert.equal(passing.ok, true, passing.output); assert.equal(JSON.parse(passing.output).passed, true);
  const failing = await run(prefix + "test('wrong expectation',()=>expect(add(2,3)).toBe(6));");
  assert.equal(failing.ok, true, failing.output); assert.equal(JSON.parse(failing.output).passed, false); assert.equal(JSON.parse(failing.output).failedTests, 1);
  const skipped = await run(prefix + "test.skip('pending',()=>expect(add(2,3)).toBe(6));");
  assert.equal(skipped.ok, true, skipped.output); assert.equal(JSON.parse(skipped.output).passed, false);
});
test("Vitest cannot read workspace neighbors or credentials and honors cancellation", options, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-test-private-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const secret = path.join(root, "private"); await fs.writeFile(secret, "sentinel");
  const result = await run(`import {test,expect} from 'vitest'; import fs from 'node:fs';test('boundary',()=>{expect(()=>fs.readFileSync(${JSON.stringify(secret)})).toThrow();expect(process.env.MCODA_MSWARM_API_KEY).toBeUndefined();});`);
  assert.equal(result.ok, true, result.output); assert.equal(JSON.parse(result.output).passed, true);
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(Error("cancel tests")), 30);
  try { await assert.rejects(run("while(true){}", abort.signal), /cancel tests/); } finally { clearTimeout(timer); }
});
