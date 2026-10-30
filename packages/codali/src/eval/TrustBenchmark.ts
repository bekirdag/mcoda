import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createIsolatedExecutor } from "../tools/shell/IsolatedExecutor.js";

export interface TrustCase {
  id: string; domain: string; family: string; variant: number;
  split: "development" | "validation" | "held_out";
  prompt: string; files: Record<string, string>;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  capabilities: string[];
}
export interface TrustScoreSpec {
  id: string; kind: "json" | "code" | "rubric"; critical: boolean;
  expected?: unknown; criteria?: string[]; reference?: string;
  alternatives?: unknown[];
  preserveInput?: boolean;
  /** The contract requires a new array rather than returning this input array. */
  distinctOutputFrom?: string[];
  maxWords?: number;
  complexityProbe?: { kind: "binary_search_first"; size: number; maxIndexedReads: number };
  tests?: Array<{ input: unknown; expected: unknown }>;
}
export interface TrustGrade {
  status: "passed" | "failed" | "needs_review";
  passed: boolean; semanticPassed?: boolean; formatPassed?: boolean;
  checks?: number; failures: string[]; criteria?: string[];
  outputSha256: string;
  toolEvidence?: { required: boolean; passed: boolean; successfulTools: string[]; expectedTools: string[] };
}

/** A correct-looking guess does not satisfy an explicit request to inspect with Docdex.
 * raw_direct receives the entire fixture in its prompt and explicitly has no tools.
 */
export function applyTrustToolEvidence(task: TrustCase, arm: string, grade: TrustGrade, events: Array<{ type: string; data: Record<string, unknown> }>): TrustGrade {
  if (task.domain !== "repository_and_docdex" || arm === "raw_direct") return grade;
  const names = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool_receipt") continue;
    const receipt = event.data.receipt as { status?: string; tool?: string; ok?: boolean } | undefined;
    const call = event.data.call as { name?: string } | undefined;
    if (receipt?.status === "success" && receipt.tool) names.add(receipt.tool);
    if (receipt?.ok === true && call?.name) names.add(call.name);
  }
  const passed = [...names].some(name => /^docdex_(search|open|symbols|ast|impact_graph|tree|stats|files)$/.test(name));
  return { ...grade, toolEvidence: { required: true, passed, successfulTools: [...names].sort(), expectedTools: task.capabilities },
    ...(!passed ? { passed: false, status: "failed" as const, failures: [...grade.failures, "No successful Docdex evidence call for the explicitly requested investigation"] } : {}) };
}
export const trustHash = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

export function equalTrustValue(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") return Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected));
  if (actual === expected) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) return actual.length === expected.length && actual.every((x, i) => equalTrustValue(x, expected[i]));
  if (actual && expected && typeof actual === "object" && typeof expected === "object" && !Array.isArray(actual) && !Array.isArray(expected)) {
    const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
    return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => Object.prototype.hasOwnProperty.call(a, k) && equalTrustValue(a[k], b[k]));
  }
  return false;
}

/** No answer keys, grading code or host credentials are mounted in the submission sandbox.
 * The sandbox returns observations. Expected values are compared here, in the host.
 */
export async function gradeTrustAnswer(spec: TrustScoreSpec, content: string, options: { error?: string; workspacePreserved?: boolean } = {}): Promise<TrustGrade> {
  const grade: TrustGrade = { status: "failed", passed: false, failures: [], outputSha256: trustHash(content) };
  if (options.error) grade.failures.push(`attempt_error: ${options.error.slice(0, 1000)}`);
  if (options.workspacePreserved === false) grade.failures.push("Read-only fixture changed");
  if (grade.failures.length) return grade;
  if (!content.trim()) { grade.failures.push("Empty answer"); return grade; }
  if (spec.maxWords !== undefined) {
    const words = content.trim().split(/\s+/u).filter(token => /[\p{L}\p{N}]/u.test(token)).length;
    if (words > spec.maxWords) { grade.failures.push(`Requested word limit exceeded: ${words} > ${spec.maxWords}`); return grade; }
  }
  if (spec.kind === "rubric") {
    grade.status = "needs_review"; grade.criteria = spec.criteria;
    return grade;
  }
  if (spec.kind === "json") {
    let actual: unknown;
    try { actual = JSON.parse(content.trim()); grade.formatPassed = true; }
    catch {
      grade.formatPassed = false;
      const match = content.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
      try { actual = match ? JSON.parse(match[1]) : undefined; } catch { /* malformed remains failed */ }
    }
    grade.semanticPassed = equalTrustValue(actual, spec.expected) || (spec.alternatives ?? []).some(value => equalTrustValue(actual, value));
    if (!grade.semanticPassed) grade.failures.push("Answer differs from the independently specified value");
    if (!grade.formatPassed) grade.failures.push("Requested JSON-only format not followed");
  } else {
    const blocks = [...content.matchAll(/```(?:javascript|js|mjs)?\s*\n([\s\S]*?)\n```/g)];
    const source = blocks.length === 1 ? blocks[0][1] : blocks.length ? "" : content;
    if (!source || Buffer.byteLength(source) > 65536) { grade.failures.push("Missing, ambiguous or oversized code"); return grade; }
    if (!spec.tests?.length) throw new Error("Code score specification has no independent inputs");
    const tests = [...spec.tests];
    if (spec.complexityProbe) {
      const { size, maxIndexedReads } = spec.complexityProbe;
      if (spec.complexityProbe.kind !== "binary_search_first" || !Number.isSafeInteger(size) || size < 1000 || size > 100000 || !Number.isSafeInteger(maxIndexedReads) || maxIndexedReads < 1) throw new Error("Invalid complexity probe");
      const target = Math.floor((size - 3) / 3);
      tests.push({ input: { values: Array.from({ length: size }, (_, i) => Math.floor(i / 3)), target }, expected: target * 3 });
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codali-trust-grade-"));
    try {
      await fs.chmod(root, 0o700);
      await fs.writeFile(path.join(root, "submission.mjs"), source, { flag: "wx", mode: 0o600 });
      // Inputs only. A deliberately wrong submission cannot read expected answers.
      await fs.writeFile(path.join(root, "inputs.json"), JSON.stringify({ inputs: tests.map(t => t.input), instrumentIndex: spec.complexityProbe ? tests.length - 1 : -1, distinctOutputPath: spec.distinctOutputFrom ?? null }), { flag: "wx", mode: 0o600 });
      await fs.writeFile(path.join(root, "observe.mjs"), `import { readFileSync } from 'node:fs';
const stringify=JSON.stringify.bind(JSON); const parse=JSON.parse.bind(JSON); const output=process.stdout.write.bind(process.stdout);
const {inputs,instrumentIndex,distinctOutputPath}=parse(readFileSync(new URL('./inputs.json',import.meta.url),'utf8'));const get=Reflect.get.bind(Reflect);
const {solve}=await import('./submission.mjs');
if(typeof solve!=='function')throw Error('Export solve(input)');
const results=[];for(let index=0;index<inputs.length;index++){const input=inputs[index];let reads=0;
if(index===instrumentIndex)input.values=new Proxy(input.values,{get(t,p,r){if(typeof p==='string'&&/^[0-9]+$/.test(p))reads++;return get(t,p,r);}});
const originalArray=distinctOutputPath===null?undefined:distinctOutputPath.reduce((v,k)=>v[k],input);
const before=stringify(input);reads=0;const value=await solve(input);const indexedReads=reads;results.push({value,indexedReads,distinctOutput:distinctOutputPath===null||value!==originalArray,unchanged:before===stringify(input)});}
output(stringify(results));`, { flag: "wx", mode: 0o600 });
      const execute = createIsolatedExecutor({ network: false });
      const observed = await execute(process.execPath, ["--max-old-space-size=96", "observe.mjs"], {
        workspaceRoot: root, allowedWritePaths: [], shellTimeoutMs: 5000, shellMaxOutputBytes: 131072,
      });
      const actual = JSON.parse(observed.output) as Array<{ value: unknown; unchanged: boolean; indexedReads: number; distinctOutput: boolean }>;
      if (!Array.isArray(actual) || actual.length !== tests.length) throw new Error("Incomplete observations");
      grade.checks = actual.length;
      for (let i = 0; i < actual.length; i++) {
        if (!equalTrustValue(actual[i]?.value, tests[i].expected)) grade.failures.push(`Independent input ${i + 1}: wrong value`);
        if (spec.preserveInput && actual[i]?.unchanged !== true) grade.failures.push(`Independent input ${i + 1}: input mutated`);
        if (spec.distinctOutputFrom !== undefined && actual[i]?.distinctOutput !== true) grade.failures.push(`Independent input ${i + 1}: returned the original array instead of a new one`);
      }
      if (spec.complexityProbe && (!Number.isSafeInteger(actual[actual.length - 1].indexedReads) || actual[actual.length - 1].indexedReads > spec.complexityProbe.maxIndexedReads)) grade.failures.push("Binary search exceeded its bounded indexed-read probe");
      grade.semanticPassed = !grade.failures.length;
      grade.formatPassed = blocks.length === 1 && content.trim() === blocks[0][0];
      // Code fencing is presentational; runnable correct code is accepted without a fence.
    } catch (error) { grade.failures.push(`Sandbox/check failure: ${String(error).slice(0, 1200)}`); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }
  grade.passed = !grade.failures.length; grade.status = grade.passed ? "passed" : "failed";
  return grade;
}

export interface TrustCorpusContract {
  count: number; families: number;
  splits: { development: number; validation: number; held_out: number };
}
export function validateTrustCorpus(cases: TrustCase[], specs: TrustScoreSpec[], contract: TrustCorpusContract = { count: 1000, families: 100, splits: { development: 600, validation: 200, held_out: 200 } }): void {
  if (!contract || typeof contract !== "object" || Array.isArray(contract) || Object.keys(contract).sort().join() !== "count,families,splits" ||
    !Number.isSafeInteger(contract.count) || contract.count < 1 || contract.count > 10000 ||
    !Number.isSafeInteger(contract.families) || contract.families < 1 || contract.families > contract.count ||
    !contract.splits || typeof contract.splits !== "object" || Array.isArray(contract.splits) || Object.keys(contract.splits).sort().join() !== "development,held_out,validation" ||
    Object.values(contract.splits).some(n => !Number.isSafeInteger(n) || n < 0) || Object.values(contract.splits).reduce((a, b) => a + b, 0) !== contract.count) throw new Error("Invalid explicit corpus contract");
  if (cases.length !== contract.count || specs.length !== contract.count) throw new Error(`The frozen corpus must contain exactly ${contract.count} questions and grading specifications`);
  const ids = new Set<string>(), questions = new Set<string>(), families = new Map<string, string>();
  const specIds = new Set(specs.map(x => x.id));
  if (specIds.size !== contract.count) throw new Error("Duplicate scoring ID");
  const splits: Record<string, number> = {};
  for (const c of cases) {
    if (!/^[a-z0-9_.-]+$/.test(c.id) || ids.has(c.id) || !specIds.has(c.id)) throw new Error("Invalid/duplicate/missing case ID");
    ids.add(c.id);
    const signature = JSON.stringify([c.prompt, c.files, c.history]);
    if (questions.has(signature)) throw new Error(`Duplicate question: ${c.id}`);
    questions.add(signature);
    if (families.has(c.family) && families.get(c.family) !== c.split) throw new Error("Family leaked across splits");
    families.set(c.family, c.split); splits[c.split] = (splits[c.split] ?? 0) + 1;
    for (const [file, contents] of Object.entries(c.files)) {
      if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some(part => !part || part === ".." || part === "." || part === ".git" || part === ".mcoda") || Buffer.byteLength(contents) > 65536) throw new Error("Unsafe fixture path/size");
    }
    if (c.history.some(m => !["user", "assistant"].includes(m.role) || typeof m.content !== "string")) throw new Error("Unsafe fixture history");
  }
  if (families.size !== contract.families || Object.entries(contract.splits).some(([name, count]) => (splits[name] ?? 0) !== count)) throw new Error("Corpus partition contract failed");
}

export interface RubricReview {
  caseId: string; attemptId: string; outputSha256: string; reviewer: string;
  dimensions: Array<{ criterion: number; passed: boolean; evidence: string }>;
  criticalFailure: boolean; rationale: string;
}
/** Review is explicit and bound to the original output; model self-grading is not a pass. */
export function applyTrustReview(spec: TrustScoreSpec, grade: TrustGrade, review: RubricReview): TrustGrade {
  if (spec.kind !== "rubric" || grade.status !== "needs_review" || review.caseId !== spec.id || review.outputSha256 !== grade.outputSha256 || !review.reviewer.trim() || !review.rationale.trim()) throw new Error("Invalid review identity or output binding");
  const count = spec.criteria?.length ?? 0;
  if (review.dimensions.length !== count || new Set(review.dimensions.map(x => x.criterion)).size !== count || review.dimensions.some(x => !Number.isInteger(x.criterion) || x.criterion < 0 || x.criterion >= count || !x.evidence.trim() || typeof x.passed !== "boolean")) throw new Error("Incomplete rubric review");
  const passed = !review.criticalFailure && review.dimensions.every(x => x.passed);
  return { ...grade, passed, semanticPassed: passed, status: passed ? "passed" : "failed", failures: passed ? [] : [review.rationale] };
}
