import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { terminalTaskCorpus, terminalCorpusHash } from "../TerminalTaskCorpus.js";
import { gradeTerminalTask, materializeTerminalTask } from "../TerminalCorpusRunner.js";
import { executorStatus } from "../../tools/shell/IsolatedExecutor.js";

// Dedicated platform qualification requires an available backend before this
// suite runs. General regression runners may lack OS sandbox support.
const isolation = executorStatus();
const isolated = { skip: isolation.available ? false : isolation.reason ?? "Isolation unavailable" };

test("versioned corpus has sixty held-out cases, twelve development cases and twelve correlated families", () => {
  const tasks = terminalTaskCorpus(); assert.equal(tasks.length, 72); assert.equal(new Set(tasks.map(task => task.id)).size, 72);
  assert.equal(tasks.filter(task => task.split === "held-out").length, 60); assert.equal(tasks.filter(task => task.split === "development").length, 12);
  assert.equal(new Set(tasks.map(task => task.family)).size, 12); assert.match(terminalCorpusHash(), /^[a-f0-9]{64}$/);
  assert.equal(terminalCorpusHash(), terminalCorpusHash());
  for (const task of tasks) assert.ok(Object.values(task.files).every(text => !text.includes("hiddenChecks")));
});

// Bound each independent grader invocation instead of the aggregate duration of
// 72 cases: loaded platform runners must still exercise every reference/starter.
for (const task of terminalTaskCorpus()) {
  test(`${task.id}: reference passes isolated independent grading and starter fails`, { ...isolated, timeout: 30000 }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `codali-corpus-selfcheck-${task.id}-`));
    try {
      const workspace = path.join(root, task.id); await materializeTerminalTask(task, workspace);
      const starter = await gradeTerminalTask(task, workspace);
      assert.equal(starter.contractPassed, false, `${task.id}: starter unexpectedly satisfies held-out contract`);
      for (const [file, content] of Object.entries(task.reference)) await fs.writeFile(path.join(workspace, file), content);
      await fs.appendFile(path.join(workspace, "test/task.test.mjs"), `test('additional edge cases',async()=>{${task.hiddenChecks}});\n`);
      const grade = await gradeTerminalTask(task, workspace);
      assert.equal(grade.passed, true, `${task.id}: ${grade.failures.join("; ")}`);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
}

test("grading rejects preservation/scope violations even when implementation passes", isolated, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-corpus-scope-"));
  try {
    const task = terminalTaskCorpus()[0]!; const workspace = path.join(root, task.id); await materializeTerminalTask(task, workspace);
    await fs.writeFile(path.join(workspace, "src/task.mjs"), task.reference["src/task.mjs"]!);
    await fs.appendFile(path.join(workspace, "test/task.test.mjs"), `test('edge cases',async()=>{${task.hiddenChecks}});\n`);
    await fs.writeFile(path.join(workspace, "USER_NOTES.txt"), "overwritten");
    const grade = await gradeTerminalTask(task, workspace);
    assert.equal(grade.contractPassed, true); assert.equal(grade.passed, false); assert.equal(grade.protectedFilesPreserved, false);
    assert.equal(grade.scopePreserved, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("lower-bound grading rejects a correct linear scan and an input-mutating implementation", isolated, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-corpus-mutations-"));
  try {
    const task = terminalTaskCorpus().find(task => task.id === "lower-bound-1")!;
    const mutations = [
      "export function lowerBound(a,value){let i=0;while(i<a.length&&a[i]<value)i++;return i;}",
      "export function lowerBound(a,value){a.sort((x,y)=>x-y);let lo=0,hi=a.length;while(lo<hi){const m=(lo+hi)>>>1;if(a[m]<value)lo=m+1;else hi=m;}return lo;}",
    ];
    for (const [index, source] of mutations.entries()) {
      const workspace = path.join(root, String(index)); await materializeTerminalTask(task, workspace);
      await fs.writeFile(path.join(workspace, "src/task.mjs"), source);
      const grade = await gradeTerminalTask(task, workspace);
      assert.equal(grade.contractPassed, false, `mutation ${index} escaped hidden checks`);
      if (index === 0) assert.match(grade.failures.join("\n"), /logarithmic indexed reads/);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("grading accepts any error class where the published contract does not specify one", isolated, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-corpus-error-contract-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const id of ["ttl-lru-1", "stable-unique-1"]) {
    const task = terminalTaskCorpus().find(task => task.id === id)!;
    const workspace = path.join(root, id); await materializeTerminalTask(task, workspace);
    await fs.writeFile(path.join(workspace, "src/task.mjs"), task.reference["src/task.mjs"]!.replace(/new (RangeError|TypeError)\(/g, "new Error("));
    await fs.appendFile(path.join(workspace, "test/task.test.mjs"), `test('published edge cases',async()=>{${task.hiddenChecks}});\n`);
    const grade = await gradeTerminalTask(task, workspace);
    assert.equal(grade.passed, true, `${id}: ${grade.failures.join("; ")}`);
  }
});
