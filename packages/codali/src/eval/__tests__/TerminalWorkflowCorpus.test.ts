import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeTerminalTask, gradeTerminalTask } from "../TerminalCorpusRunner.js";
import { terminalWorkflowCorpus, terminalWorkflowCorpusHash } from "../TerminalWorkflowCorpus.js";
import type { TerminalCorpusTask } from "../TerminalTaskCorpus.js";
import { executorStatus } from "../../tools/shell/IsolatedExecutor.js";

// General regression runners may lack an OS sandbox. Dedicated platform
// qualification requires it before running this suite, as for the coding corpus.
const isolation = executorStatus();
const isolated = { skip: isolation.available ? false : isolation.reason ?? "Isolation unavailable" };

async function reference(task: TerminalCorpusTask, workspace: string): Promise<void> {
  for (const [file, content] of Object.entries(task.reference)) {
    await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await fs.writeFile(path.join(workspace, file), content);
  }
  if (task.family === "multi-file") {
    // The harness self-check is not an agent-generated regression test. The
    // hidden behavioral checks above independently validate the implementation.
    await fs.appendFile(path.join(workspace, "test/task.test.mjs"), "test('reference exports callable entrypoint',()=>assert.ok(Object.values(m).some(x=>typeof x==='function')));\n");
  }
}
async function fixture(task: TerminalCorpusTask, action: (workspace: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-workflow-"));
  const workspace = path.join(root, "repo");
  try { await materializeTerminalTask(task, workspace); await action(workspace); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

for (const task of terminalWorkflowCorpus()) {
  test(`workflow harness: ${task.id} accepts reference and rejects starter`, { ...isolated, timeout: 30000 }, async () => {
    await fixture(task, async workspace => {
      const starter = await gradeTerminalTask(task, workspace);
      assert.equal(starter.passed, false);
      await reference(task, workspace);
      const result = await gradeTerminalTask(task, workspace);
      assert.equal(result.passed, true, JSON.stringify(result));
    });
  });
}

test("workflow IDs and content hash are stable and distinct", () => {
  const tasks = terminalWorkflowCorpus();
  assert.equal(tasks.length, 12); assert.equal(new Set(tasks.map(t => t.id)).size, 12);
  assert.match(terminalWorkflowCorpusHash(), /^[a-f0-9]{64}$/);
  assert.equal(terminalWorkflowCorpusHash(), terminalWorkflowCorpusHash());
  assert.equal(tasks.filter(t => t.family === "multi-file").length, 8);
});

for (const mutation of ["generic-error", "invalid-name", "crlf-value"] as const) {
  test(`workflow v3 header contract: ${mutation}`, { ...isolated, timeout: 30000 }, async () => {
    const task = terminalWorkflowCorpus().find(t => t.id === "header-normalization")!;
    await fixture(task, async workspace => {
      await reference(task, workspace);
      const implementation = task.reference["src/headers.mjs"].replace(/new TypeError/g, "new Error").replace("export function normalizeHeaders", "function inner");
      const bypass = mutation === "invalid-name" ? "entries.some(([name])=>name==='')"
        : mutation === "crlf-value" ? "entries.some(([,value])=>/[\\r\\n]/.test(value))" : "false";
      await fs.writeFile(path.join(workspace, "src/headers.mjs"), implementation +
        `export function normalizeHeaders(entries){if(${bypass})return Object.create(null);return inner(entries);}\n`);
      const result = await gradeTerminalTask(task, workspace);
      assert.equal(result.passed, mutation === "generic-error", JSON.stringify(result));
      assert.equal(result.contractPassed, mutation === "generic-error");
    });
  });
}

for (const mutation of ["wrong-report", "protected-source", "weaken-tests", "extra-file", "missing-report"] as const) {
  test(`workflow investigation rejects ${mutation}`, { ...isolated, timeout: 30000 }, async () => {
    const task = terminalWorkflowCorpus().find(t => t.id === "investigate-tenant-key")!;
    await fixture(task, async workspace => {
      await reference(task, workspace);
      if (mutation === "wrong-report") await fs.writeFile(path.join(workspace, "docs/report.json"), '{"isolation":"safe"}');
      if (mutation === "protected-source") await fs.appendFile(path.join(workspace, "src/cache.mjs"), "\n// repaired without authorization\n");
      if (mutation === "weaken-tests") await fs.writeFile(path.join(workspace, "test/task.test.mjs"), "import test from 'node:test';test('one',()=>{});test('two',()=>{});\n");
      if (mutation === "extra-file") await fs.writeFile(path.join(workspace, "unrequested.md"), "feature\n");
      if (mutation === "missing-report") await fs.unlink(path.join(workspace, "docs/report.json"));
      const result = await gradeTerminalTask(task, workspace);
      assert.equal(result.passed, false, JSON.stringify(result));
      if (["protected-source", "weaken-tests", "extra-file"].includes(mutation)) assert.equal(result.scopePreserved, false);
      else assert.equal(result.contractPassed, false);
    });
  });
}

test("workflow coding still requires extended tests", { ...isolated, timeout: 30000 }, async () => {
  const task = terminalWorkflowCorpus()[0];
  await fixture(task, async workspace => {
    await reference(task, workspace);
    await fs.writeFile(path.join(workspace, "test/task.test.mjs"), task.files["test/task.test.mjs"]);
    const result = await gradeTerminalTask(task, workspace);
    assert.equal(result.contractPassed, true); assert.equal(result.testsExtended, false); assert.equal(result.passed, false);
  });
});

for (const mutation of ["reverse", "duplicate", "missing", "unknown", "wrong-boundary"] as const) {
  test(`workflow v2 expiry evidence: ${mutation}`, { ...isolated, timeout: 30000 }, async () => {
    const task = terminalWorkflowCorpus().find(t => t.id === "investigate-cache-expiry")!;
    await fixture(task, async workspace => {
      const report = JSON.parse(task.reference["docs/report.json"]);
      if (mutation === "reverse") report.evidence.reverse();
      if (mutation === "duplicate") report.evidence.push(report.evidence[0]);
      if (mutation === "missing") report.evidence.pop();
      if (mutation === "unknown") report.evidence[0] = "invented.md";
      if (mutation === "wrong-boundary") report.boundary = "exclusive";
      await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
      await fs.writeFile(path.join(workspace, "docs/report.json"), JSON.stringify(report));
      assert.equal((await gradeTerminalTask(task, workspace)).passed, mutation === "reverse");
    });
  });
}

for (const citations of [
  ["vendor-docs/v1.md", "vendor-docs/v2.md"],
  ["vendor-docs/v1.md"],
  ["vendor-docs/v2.md", "vendor-docs/v1.md"],
  ["vendor-docs/v2.md", "vendor-docs/v2.md"],
  ["invented.md", "vendor-docs/v2.md"],
]) {
  test(`workflow v2 research citations: ${citations.join(",")}`, { ...isolated, timeout: 30000 }, async () => {
    const task = terminalWorkflowCorpus().find(t => t.id === "research-pinned-upgrade")!;
    await fixture(task, async workspace => {
      const report = { ...JSON.parse(task.reference["docs/report.json"]), citations };
      await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
      await fs.writeFile(path.join(workspace, "docs/report.json"), JSON.stringify(report));
      assert.equal((await gradeTerminalTask(task, workspace)).passed,
        JSON.stringify(citations) === JSON.stringify(["vendor-docs/v1.md", "vendor-docs/v2.md"]));
    });
  });
}

for (const mutation of ["code-only", "all-sources", "empty", "incident-only", "missing-server", "unsorted", "duplicate", "unknown", "wrong-cause"] as const) {
  test(`workflow v4 duplicate-submit evidence: ${mutation}`, { ...isolated, timeout: 30000 }, async () => {
    const task = terminalWorkflowCorpus().find(t => t.id === "investigate-duplicate-submit")!;
    await fixture(task, async workspace => {
      const report = JSON.parse(task.reference["docs/report.json"]);
      if (mutation === "code-only") report.evidence = ["src/client.mjs", "src/server.mjs"];
      if (mutation === "empty") report.evidence = [];
      if (mutation === "incident-only") report.evidence = ["docs/incident.md"];
      if (mutation === "missing-server") report.evidence = ["docs/incident.md", "src/client.mjs"];
      if (mutation === "unsorted") report.evidence.reverse();
      if (mutation === "duplicate") report.evidence.unshift(report.evidence[0]);
      if (mutation === "unknown") report.evidence.unshift("docs/invented.md");
      if (mutation === "wrong-cause") report.cause = "missing-dedup";
      await fs.writeFile(path.join(workspace, "docs/report.json"), JSON.stringify(report));
      const result = await gradeTerminalTask(task, workspace);
      assert.equal(result.passed, mutation === "code-only" || mutation === "all-sources", JSON.stringify(result));
    });
  });
}

for (const failure of ["sync-range", "sync-type", "resolve"] as const) {
  test(`workflow v2 pool invalid limit: ${failure}`, { ...isolated, timeout: 30000 }, async () => {
    const task = terminalWorkflowCorpus().find(t => t.id === "async-worker-pool")!;
    await fixture(task, async workspace => {
      await reference(task, workspace);
      const original = task.reference["src/pool.mjs"].replace("export async function mapPool", "async function inner");
      const invalid = failure === "sync-range" ? "throw new RangeError('limit');"
        : failure === "sync-type" ? "throw new TypeError('limit');" : "return Promise.resolve([]);";
      await fs.writeFile(path.join(workspace, "src/pool.mjs"), original +
        `export function mapPool(items,limit,worker){if(!Number.isInteger(limit)||limit<1){${invalid}}return inner(items,limit,worker);}\n`);
      assert.equal((await gradeTerminalTask(task, workspace)).passed, failure === "sync-range");
    });
  });
}

test("workflow v5 pool rejects dispatch after an observed synchronous worker throw", { ...isolated, timeout: 30000 }, async () => {
  const task = terminalWorkflowCorpus().find(t => t.id === "async-worker-pool")!;
  await fixture(task, async workspace => {
    await reference(task, workspace);
    const original = task.reference["src/pool.mjs"].replace("export async function mapPool", "async function inner");
    // Promisifying the worker hides its immediate throw until a microtask,
    // allowing the remaining lanes to invoke additional workers first.
    await fs.writeFile(path.join(workspace, "src/pool.mjs"), original +
      "export const mapPool=(items,limit,worker)=>inner(items,limit,async(...args)=>worker(...args));\n");
    const result = await gradeTerminalTask(task, workspace);
    assert.equal(result.passed, false, JSON.stringify(result));
    assert.equal(result.contractPassed, false);
    assert.equal(result.publicTestsPassed, true, "the independent oracle must detect this missing public case");
  });
});
