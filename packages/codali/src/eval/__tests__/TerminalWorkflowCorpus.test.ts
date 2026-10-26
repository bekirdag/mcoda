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
