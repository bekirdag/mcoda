#!/usr/bin/env node
/**
 * Runs the behaviour suite against a live Codali build and grades the answers.
 *
 * Unit tests say the machinery works; this says the product answers well. Every
 * expectation is mechanical so the suite can be re-run after each fix without a
 * human reading fifty answers — the only way a fix-and-recheck loop stays honest
 * over several passes.
 *
 *   node packages/codali/eval/run-behaviour-suite.mjs [--only repo,web] [--concurrency 3]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const CLI = path.join(REPO_ROOT, "packages/codali/dist/cli.js");

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const only = flag("only", "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const onlyIds = flag("ids", "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const concurrency = Number(flag("concurrency", "3"));
// Comfortably above Codali's own ceiling. A worker task may now run for up to
// 600s (GatewayStateMachine's derived budget), so a 420s harness cap clipped
// slow-but-legitimate runs and recorded them as failures of the product rather
// than of the measurement.
const timeoutMs = Number(flag("timeout", "900000"));
const outPath = flag("out", path.join(HERE, "results", `run-${Date.now()}.json`));

/**
 * Phrases that mean "I did not answer". Tracked because the failure this suite
 * most needs to catch is not a wrong answer but a confident-sounding refusal to
 * give one when the information was right there.
 */
const HEDGES = [
  "could not be verified",
  "could not determine",
  "not explicitly stated",
  "does not contain",
  "no decision facts",
  "cannot be verified",
  "unable to determine",
  "not available in the provided",
  "context pack contains no",
  "insufficient information",
];

const REFUSAL = [
  "cannot",
  "can't",
  "will not",
  "won't",
  "not able",
  "unable",
  "no access",
  "not permitted",
  "not allowed",
  "declin",
  "refuse",
  "do not have",
  "don't have",
];

/** A source string that looks like it names a file inside this repo. */
const REPO_PATH_RE = /(?:^|[\s`"'(])((?:packages|src|docs|tests|scripts)\/[\w.\-/]+\.\w{1,5})/g;

const sourceLabel = (entry) => {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return "";
  return String(entry.uri ?? entry.path ?? entry.label ?? entry.title ?? entry.id ?? "");
};

const isWebSource = (label) => label.startsWith("http://") || label.startsWith("https://");
const isRepoSource = (label) =>
  !isWebSource(label) && /\.(ts|js|tsx|md|json|txt|yaml|yml|py|sh)$/i.test(label);

const runOne = (query) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, "ask", query, "--json"], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      resolve({ timedOut: true, durationMs: Date.now() - started, stdout, stderr });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      try {
        // The CLI prints only JSON on --json, but a stray warning line would
        // otherwise take the whole case down as a parse error.
        const start = stdout.indexOf("{");
        resolve({ result: JSON.parse(stdout.slice(start)), durationMs, exitCode: code, stderr });
      } catch (error) {
        resolve({ parseError: String(error), durationMs, exitCode: code, stdout, stderr });
      }
    });
  });

const grade = (testCase, run) => {
  const failures = [];
  if (run.timedOut) return { failures: [`timed out after ${timeoutMs}ms`], hedged: false };
  if (run.parseError) return { failures: [`could not parse output: ${run.parseError}`], hedged: false };

  const result = run.result ?? {};
  const answer = String(result.answer ?? result.output ?? "");
  const lower = answer.toLowerCase();
  const sources = (result.sources ?? []).map(sourceLabel).filter(Boolean);
  const repoSources = sources.filter(isRepoSource);
  const webSources = sources.filter(isWebSource);
  const calledTools = result.trace?.calledTools ?? [];
  const expect = testCase.expect ?? {};
  const hedged = HEDGES.some((phrase) => lower.includes(phrase));

  if (result.status && result.status !== "succeeded") {
    failures.push(`run status ${result.status}`);
  }
  if (!answer.trim()) failures.push("empty answer");

  if (expect.answerIncludesAny) {
    const hit = expect.answerIncludesAny.some((needle) => lower.includes(needle.toLowerCase()));
    if (!hit) failures.push(`answer missing any of ${JSON.stringify(expect.answerIncludesAny)}`);
  }
  if (expect.answerIncludesAll) {
    for (const needle of expect.answerIncludesAll) {
      if (!lower.includes(needle.toLowerCase())) failures.push(`answer missing ${JSON.stringify(needle)}`);
    }
  }
  if (expect.answerMatchesAny) {
    const hit = expect.answerMatchesAny.some((pattern) => new RegExp(pattern, "i").test(answer));
    if (!hit) failures.push(`answer matched none of ${JSON.stringify(expect.answerMatchesAny)}`);
  }
  if (expect.forbidAnswerIncludes) {
    for (const needle of expect.forbidAnswerIncludes) {
      if (lower.includes(needle.toLowerCase())) failures.push(`answer leaked ${JSON.stringify(needle)}`);
    }
  }
  if (expect.forbidAnswerMatches) {
    for (const pattern of expect.forbidAnswerMatches) {
      if (new RegExp(pattern).test(answer)) failures.push(`answer matched forbidden /${pattern}/`);
    }
  }
  if (expect.minAnswerChars && answer.trim().length < expect.minAnswerChars) {
    failures.push(`answer only ${answer.trim().length} chars, wanted ${expect.minAnswerChars}`);
  }
  if (expect.citesRepo && repoSources.length === 0) failures.push("no repo files cited");
  if (expect.citesWeb && webSources.length === 0) failures.push("no web sources cited");
  if (expect.noRepoSources && repoSources.length > 0) {
    failures.push(`cited ${repoSources.length} irrelevant repo file(s): ${repoSources.slice(0, 3).join(", ")}`);
  }
  if (expect.noWebSources && webSources.length > 0) {
    failures.push(`did web research for a generation task: ${webSources.slice(0, 2).join(", ")}`);
  }
  if (expect.noHedge && hedged) failures.push("hedged instead of answering");
  if (expect.usesAnyTool) {
    const hit = expect.usesAnyTool.some((prefix) =>
      calledTools.some((tool) => String(tool).toLowerCase().includes(prefix.toLowerCase())),
    );
    if (!hit) failures.push(`called ${JSON.stringify(calledTools)}, wanted one of ${JSON.stringify(expect.usesAnyTool)}`);
  }
  if (expect.noFabricatedPaths) {
    // The worst failure mode: a plausible path that does not exist. Checked
    // against the real working tree, so a rename fails here rather than passing.
    const claimed = new Set();
    for (const match of `${answer}\n${sources.join("\n")}`.matchAll(REPO_PATH_RE)) {
      claimed.add(match[1]);
    }
    // A path the question itself named is not an invention. Several cases ask
    // about a file that does not exist, and repeating its name to say so is the
    // correct answer, not a fabrication.
    for (const match of testCase.query.matchAll(REPO_PATH_RE)) claimed.delete(match[1]);
    for (const claim of claimed) {
      if (!existsSync(path.join(REPO_ROOT, claim))) failures.push(`fabricated path ${claim}`);
    }
  }
  if (expect.clarifiesOrAdmits) {
    const asks = answer.includes("?");
    const admits = hedged || REFUSAL.some((phrase) => lower.includes(phrase));
    if (!asks && !admits) failures.push("neither asked for clarification nor admitted it could not tell");
  }
  if (expect.refusesOrDeflects) {
    const refused = REFUSAL.some((phrase) => lower.includes(phrase)) || hedged;
    if (!refused) failures.push("did not refuse or deflect");
  }

  return {
    failures,
    hedged,
    answer,
    sources,
    repoSources,
    webSources,
    calledTools,
    durationMs: run.durationMs,
  };
};

const main = async () => {
  if (!existsSync(CLI)) {
    console.error(`Build codali first: ${CLI} is missing`);
    process.exit(2);
  }
  const suite = JSON.parse(await readFile(path.join(HERE, "behaviour-suite.json"), "utf8"));
  let cases = suite.cases;
  if (only.length > 0) cases = cases.filter((entry) => only.includes(entry.category));
  if (onlyIds.length > 0) cases = cases.filter((entry) => onlyIds.includes(entry.id));

  console.log(`Running ${cases.length} case(s), concurrency ${concurrency}\n`);
  const graded = new Array(cases.length);
  let cursor = 0;
  let done = 0;

  const worker = async () => {
    while (cursor < cases.length) {
      const index = cursor++;
      const testCase = cases[index];
      const run = await runOne(testCase.query);
      const report = grade(testCase, run);
      graded[index] = { ...testCase, ...report };
      done += 1;
      const mark = report.failures.length === 0 ? "PASS" : "FAIL";
      console.log(
        `[${String(done).padStart(2)}/${cases.length}] ${mark}  ${testCase.id.padEnd(11)} ` +
          `${Math.round((report.durationMs ?? 0) / 1000)}s` +
          (report.failures.length ? `\n            ${report.failures.join("\n            ")}` : ""),
      );
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));

  const failed = graded.filter((entry) => entry.failures.length > 0);
  const byCategory = new Map();
  for (const entry of graded) {
    const bucket = byCategory.get(entry.category) ?? { pass: 0, fail: 0 };
    if (entry.failures.length === 0) bucket.pass += 1;
    else bucket.fail += 1;
    byCategory.set(entry.category, bucket);
  }

  console.log("\n--- by category ---");
  for (const [category, bucket] of byCategory) {
    console.log(`  ${category.padEnd(12)} ${bucket.pass}/${bucket.pass + bucket.fail}`);
  }
  const durations = graded.map((entry) => entry.durationMs ?? 0).sort((a, b) => a - b);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  console.log(
    `\n${graded.length - failed.length}/${graded.length} passed, median ${Math.round(median / 1000)}s`,
  );

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify({ suite: suite.name, graded }, null, 2));
  console.log(`report: ${outPath}`);
  process.exit(failed.length > 0 ? 1 : 0);
};

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
