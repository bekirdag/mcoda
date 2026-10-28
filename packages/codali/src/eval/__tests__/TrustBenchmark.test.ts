import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { gradeTrustAnswer, applyTrustReview, applyTrustToolEvidence, validateTrustCorpus, type TrustCase, type TrustScoreSpec } from "../TrustBenchmark.js";
import { executorStatus } from "../../tools/shell/IsolatedExecutor.js";

test("trust JSON grader distinguishes values, missing fields, JSON format and recorded errors", async () => {
  const spec: TrustScoreSpec = { id: "x", kind: "json", critical: false, expected: { answer: [0, false, ""] } };
  assert.equal((await gradeTrustAnswer(spec, '{"answer":[0,false,""]}')).passed, true);
  for (const content of ['{"answer":[false,0,""]}', '{"answer":[0,false]}', '{"answer":[0,false,""],"extra":true}']) assert.equal((await gradeTrustAnswer(spec, content)).passed, false);
  const fenced = await gradeTrustAnswer(spec, '```json\n{"answer":[0,false,""]}\n```');
  assert.equal(fenced.semanticPassed, true); assert.equal(fenced.passed, false);
  assert.equal((await gradeTrustAnswer(spec, '{"answer":[0,false,""]}', { error: "timeout" })).passed, false);
  assert.equal((await gradeTrustAnswer(spec, '{"answer":[0,false,""]}', { workspacePreserved: false })).passed, false);
});

test("trust code grading compares external expected values and rejects mutations and forged completions", { skip: !executorStatus().available }, async () => {
  const spec: TrustScoreSpec = { id: "x", kind: "code", critical: false, preserveInput: true, tests: [{ input: [1, 2], expected: [2, 1] }, { input: [], expected: [] }] };
  assert.equal((await gradeTrustAnswer(spec, 'export const solve=x=>[...x].reverse();')).passed, true);
  assert.equal((await gradeTrustAnswer(spec, 'export const solve=x=>x.reverse();')).passed, false);
  assert.equal((await gradeTrustAnswer(spec, 'export const solve=x=>"passed";')).passed, false);
  assert.equal((await gradeTrustAnswer(spec, 'import fs from "node:fs"; export const solve=()=>fs.readFileSync("../grading.jsonl","utf8");')).passed, false);
});

test("binary-search probe rejects a linear implementation even when its answers are correct", { skip: !executorStatus().available }, async () => {
  const spec: TrustScoreSpec = { id: "binary", kind: "code", critical: false, tests: [{ input: { values: [1, 2, 2], target: 2 }, expected: 1 }], complexityProbe: { kind: "binary_search_first", size: 4096, maxIndexedReads: 128 } };
  const linear = await gradeTrustAnswer(spec, "export const solve=({values,target})=>values.indexOf(target);");
  assert.equal(linear.passed, false); assert.match(linear.failures.join(" "), /indexed-read/);
  assert.equal((await gradeTrustAnswer(spec, "export function solve({values:a,target:t}){let l=0,r=a.length;while(l<r){const m=(l+r)>>>1;if(a[m]<t)l=m+1;else r=m;}return a[l]===t?l:-1;}")).passed, true);
});

test("a new-array contract rejects unchanged aliases as well as mutations", { skip: !executorStatus().available }, async () => {
  const spec: TrustScoreSpec = { id: "copy", kind: "code", critical: false, preserveInput: true, distinctOutputFrom: [], tests: [{ input: [], expected: [] }, { input: [1], expected: [1] }] };
  const alias = await gradeTrustAnswer(spec, "export const solve=x=>x;");
  assert.equal(alias.passed, false); assert.match(alias.failures.join(" "), /original array/);
  assert.equal((await gradeTrustAnswer(spec, "export const solve=x=>[...x];")).passed, true);
});

test("rubric review requires every dimension and binds the actual output", async () => {
  const spec: TrustScoreSpec = { id: "x", kind: "rubric", critical: true, criteria: ["accurate", "no fabricated execution"] };
  const grade = await gradeTrustAnswer(spec, "I cannot confirm without evidence.");
  assert.equal(grade.status, "needs_review"); assert.equal(grade.passed, false);
  const review = { caseId: "x", attemptId: "attempt", reviewer: "independent-reviewer", outputSha256: grade.outputSha256, criticalFailure: false, rationale: "No unsupported claim.", dimensions: [{ criterion: 0, passed: true, evidence: "Explicit uncertainty." }, { criterion: 1, passed: true, evidence: "No execution asserted." }] };
  assert.equal(applyTrustReview(spec, grade, review).passed, true);
  assert.throws(() => applyTrustReview(spec, grade, { ...review, outputSha256: "wrong" }));
  assert.throws(() => applyTrustReview(spec, grade, { ...review, dimensions: review.dimensions.slice(1) }));
  assert.equal(applyTrustReview(spec, grade, { ...review, criticalFailure: true }).passed, false);
  assert.equal((await gradeTrustAnswer({ ...spec, maxWords: 3 }, "This answer is too long.")).status, "failed");
});

test("Docdex investigations require real successful receipts, while the documented direct baseline has supplied evidence", async () => {
  const task: TrustCase = { id: "x", domain: "repository_and_docdex", family: "x", variant: 1, split: "development", prompt: "Use Docdex", files: {}, history: [], capabilities: ["docdex_open"] };
  const grade = await gradeTrustAnswer({ id: "x", kind: "json", critical: false, expected: { answer: 3 } }, '{"answer":3}');
  assert.equal(applyTrustToolEvidence(task, "codali_candidate", grade, []).passed, false);
  assert.equal(applyTrustToolEvidence(task, "raw_direct", grade, []).passed, true);
  assert.equal(applyTrustToolEvidence(task, "raw_tools", grade, [{ type: "tool_receipt", data: { call: { name: "docdex_open" }, receipt: { ok: false } } }]).passed, false);
  assert.equal(applyTrustToolEvidence(task, "codali_selected", grade, [{ type: "tool_receipt", data: { receipt: { status: "success", tool: "docdex_open" } } }]).passed, true);
});

test("1000-case corpus enforces separate answer specifications and family partitions", async () => {
  const root = fileURLToPath(new URL("../../../../../docs/benchmarks/codali-1000/", import.meta.url));
  const load = async <T>(file: string) => (await fs.readFile(root + file, "utf8")).trim().split("\n").map(line => JSON.parse(line) as T);
  const cases = await load<TrustCase>("prompts.jsonl"), specs = await load<TrustScoreSpec>("grading.jsonl");
  validateTrustCorpus(cases, specs);
  for (const spec of specs.filter(x => /\.(dedupe_records|topological_order)\./.test(x.id))) assert.equal(spec.preserveInput, true);
  assert.equal(specs.filter(x => x.distinctOutputFrom !== undefined).length, 30);
  assert.ok(cases.every(c => !Object.prototype.hasOwnProperty.call(c, "expected") && !Object.prototype.hasOwnProperty.call(c, "reference")));
  const copy = structuredClone(cases); copy[1].split = copy[1].split === "held_out" ? "development" : "held_out";
  assert.throws(() => validateTrustCorpus(copy, specs));
  copy[1] = { ...cases[1], files: { "../answer.json": "leak" } };
  assert.throws(() => validateTrustCorpus(copy, specs));
});
