import test from "node:test";
import assert from "node:assert/strict";
import { checkAnswer, checkFigures, checkTargets, evaluateWithUnits, parseConflictClaims, parseFigureClaims, MAX_FIGURES } from "../FigureCheck.js";
import { applyAnswerEdits, endsInsideMarkup, parseAnswerEdits, structureLoss } from "../AnswerEdits.js";
import { editChangesProtected, editsToRevert, introducedFailures, protectedFigures } from "../AuditGuards.js";
import { rewriteDefect } from "../SessionController.js";
import { selectResearchEvidence, type ResearchPacket } from "../ResearchEvidence.js";

// Fresh variants written for the .43 audit fixes; none comes from a benchmark task.

test("figure expressions may carry units, which are converted before comparison", () => {
  assert.equal(evaluateWithUnits("64[MB] / 80[MB/s]", "ms"), 800);
  assert.equal(evaluateWithUnits("2[s] + 300[ms]", "ms"), 2300);
  assert.ok(Math.abs(evaluateWithUnits("120 * 250[B/s] * 1[day]", "GB") - 2.592) < 1e-9);
  assert.ok(Math.abs(evaluateWithUnits("2.592[GB/day] * 90[days]", "GB") - 233.28) < 1e-9);
  assert.ok(Math.abs(evaluateWithUnits("15[%] * 40[TB]", "TB") - 6) < 1e-9);
  assert.equal(evaluateWithUnits("1.5[Gbps] * 8[s]", "GB"), 1.5);
  assert.equal(evaluateWithUnits("12[cores] * 30[h]", "core-h"), 360);
});

test("an expression whose units do not agree is not evaluated, so it cannot flag a mismatch", () => {
  assert.throws(() => evaluateWithUnits("2[s] + 300[MB]", "s"), /units/);
  assert.throws(() => evaluateWithUnits("64[MB] / 80[MB/s]", "MB"), /units/);
  const [result] = checkFigures([{ claim: "flush takes 800 ms", expression: "64[MB] * 80[MB/s]", stated: 800, unit: "ms" }]);
  assert.equal(result.matches, true); assert.ok(result.error);
  // Mixed units stated correctly in brackets are a match, not the 1000x mismatch of a unitless expression.
  assert.equal(checkFigures([{ claim: "flush takes 800 ms", expression: "64[MB] / 80[MB/s]", stated: 800, unit: "ms" }])[0].matches, true);
});

test("a mismatch that looks like a unit slip or uses inputs the text never states is marked suspect", () => {
  const text = "Ingest is 1,200 sensors every 10 s at 250 B each, about 30 KB/s.";
  const [slip, foreign, real] = checkFigures([
    { claim: "about 30 KB/s", expression: "1200 / 10 * 250", stated: 30 },
    { claim: "about 30 KB/s", expression: "1200 / 17 * 250 / 1000", stated: 30 },
    { claim: "about 30 KB/s", expression: "1200 / 10 * 250 / 1000 * 2", stated: 30 },
  ], text);
  assert.equal(slip.matches, false); assert.equal(slip.suspect, "unit_slip");
  assert.equal(foreign.matches, false); assert.equal(foreign.suspect, "inputs_not_in_text");
  assert.equal(real.matches, false); assert.equal(real.suspect, undefined);
});

test("targets are judged by the calculator from the design's own figures", () => {
  const [stale, fast] = checkTargets([
    { requirement: "dashboard data no older than 30 s", relation: "<=", limit: 30, unit: "s", expression: "1[min] + 5[s]" },
    { requirement: "at least 100 writes per second", relation: ">=", limit: 100, expression: "4 * 40" },
  ]);
  assert.equal(stale.met, false); assert.equal(stale.achieved, 65);
  assert.equal(fast.met, true);
});

test("a conflict counts only when both statements occur in the draft", () => {
  const draft = "Readings are **batched** and flushed every 60 seconds.\nThe dashboard is never more than 30 seconds behind.";
  const reply = JSON.stringify({ conflicts: [
    { first: "flushed every 60 seconds", second: "never more than 30 seconds behind", why: "flush interval exceeds freshness" },
    { first: "flushed every 60 seconds", second: "uses a ring buffer of 5 minutes", why: "invented" },
  ] });
  assert.deepEqual(parseConflictClaims(reply, draft).map(item => item.second), ["never more than 30 seconds behind"]);
  const check = checkAnswer(JSON.stringify({ figures: [], targets: [], conflicts: [{ first: "batched and flushed every 60 seconds", second: "The dashboard is never more than 30 seconds behind", why: "x" }] }), draft, "");
  assert.equal(check.conflicts.length, 1, "markdown emphasis in the draft does not hide a copied statement");
});

test("the figure list is no longer cut at 40 entries", () => {
  const figures = Array.from({ length: 70 }, (_, index) => ({ claim: `figure ${index}`, expression: `${index}+1`, stated: index + 1 }));
  assert.equal(parseFigureClaims(JSON.stringify({ figures })).length, 70);
  assert.ok(MAX_FIGURES >= 70);
});

test("audit edits replace only the passages they name", () => {
  const draft = "## Sizing\nRetention needs about 233.28 GB.\nBatches are flushed every 60\nseconds.\n## Risks\nNone known.";
  const edits = parseAnswerEdits('```json\n{"edits":[{"find":"flushed every 60 seconds.","replace":"flushed every 10 seconds.","reason":"freshness"},{"find":"absent text","replace":"x"},{"find":"GB","replace":"TB"}]}\n```')!;
  const result = applyAnswerEdits(draft, edits);
  assert.match(result.text, /flushed every 10 seconds\./);
  assert.match(result.text, /## Risks\nNone known\.$/);
  assert.deepEqual(result.skipped.map(item => item.reason), ["not_found"]);
  assert.equal(parseAnswerEdits("A plain rewritten answer."), undefined);
  assert.deepEqual(applyAnswerEdits("a 60 b 60", [{ find: "60", replace: "10" }]).skipped.map(item => item.reason), ["ambiguous"]);
  assert.deepEqual(applyAnswerEdits(draft, edits.slice(0, 1), () => "vetoed").skipped.map(item => item.reason), ["vetoed"]);
});

const sections = ["Background", "Release history", "Current versions", "Support status", "Caveats"];
const researchDraft = sections.map((title, index) => `## ${title}\nSection ${index + 1} explains the ${title.toLowerCase()} in detail, citing [the vendor notes](https://vendor.example/notes/${index}). ${"It gives the dates, versions and the evidence for each statement. ".repeat(6)}`).join("\n\n");

test("a long rewrite that stops inside a link at an ordinary token count is cut off", () => {
  const cut = researchDraft.slice(0, Math.floor(researchDraft.length * 0.75)).replace(/\s*\S*$/u, "") + " see [archived list](https://web.archive";
  assert.equal(endsInsideMarkup(cut), true); assert.equal(endsInsideMarkup(researchDraft), false);
  const response = { message: { content: cut }, usage: { outputTokens: 3917 } };
  assert.equal(rewriteDefect(researchDraft, response, { minRatio: 0.6 }), undefined, "the old guards miss it: not short enough, not a round count");
  assert.equal(rewriteDefect(researchDraft, response, { minRatio: 0.6, prose: true }), "cut_off");
  const half = { message: { content: researchDraft.slice(0, researchDraft.indexOf("## Current versions")).trimEnd() } };
  assert.equal(rewriteDefect(researchDraft, half, { minRatio: 0.6, prose: true }), "shrank");
});

test("a rewrite that drops most sections or retrieved links loses structure", () => {
  const merged = researchDraft.replace(/^## (Release history|Current versions|Support status)\n/gmu, "");
  assert.equal(structureLoss(researchDraft, merged), "lost_sections");
  const unlinked = researchDraft.replace(/\[the vendor notes\]\([^)]*\)/gu, "the vendor notes");
  assert.equal(structureLoss(researchDraft, unlinked), "lost_links");
  assert.equal(structureLoss(researchDraft, unlinked, () => false), undefined, "dropping links that were never retrieved is not a loss");
  assert.equal(structureLoss(researchDraft, researchDraft), undefined);
});

test("confirmed figures are protected unless an input they use was flagged", () => {
  const draft = "Ingest is 2.592 GB per day, so 90 days need 233.28 GB; the archive is 1,400 GB in all.";
  const check = checkAnswer(JSON.stringify({ figures: [
    { claim: "2.592 GB per day", expression: "120 * 250[B/s] * 1[day]", stated: 2.592, unit: "GB" },
    { claim: "90 days need 233.28 GB", expression: "2.592[GB/day] * 90[days]", stated: 233.28, unit: "GB" },
    { claim: "archive 1,400 GB", expression: "233.28 * 5", stated: 1400 },
  ] }), draft, "1,200 sensors every 10 s, 250 B per reading, keep 90 days");
  const guarded = protectedFigures(check, draft);
  assert.deepEqual(guarded.map(figure => figure.stated), [2.592, 233.28], "1,400 is flagged (233.28 x 5 = 1,166.4), so it is not protected");
  assert.match(editChangesProtected({ find: "90 days need 233.28 GB", replace: "90 days need 466.56 GB" }, guarded)!, /confirmed_figure/);
  assert.equal(editChangesProtected({ find: "1,400 GB in all", replace: "1,166 GB in all" }, guarded), undefined);
  const after = checkAnswer(JSON.stringify({ figures: [{ claim: "archive 1,250 GB", expression: "233.28 * 5", stated: 1250 }] }), draft, "");
  const failures = introducedFailures(after, draft, check);
  assert.deepEqual(failures.values, [1250]);
  const edit = { find: "1,400 GB in all", replace: "1,250 GB in all" };
  assert.deepEqual(editsToRevert([edit, { find: "Ingest", replace: "Ingestion" }], failures, after), [edit]);
});

test("research evidence selection includes the passages of the pages the draft cites", () => {
  const filler: ResearchPacket[] = Array.from({ length: 30 }, (_, index) => ({ source: `https://news.example/${index}`, tool: "docdex_web_research", query: "ferry timetable winter",
    passage: `Northern crossing ferry timetable: winter sailings changes, bulletin ${index}. ${"Northern crossing ferry timetable winter sailings. ".repeat(8)}` }));
  const cited: ResearchPacket = { source: "https://transport.example.gov/decisions/crossing", tool: "browser_open",
    passage: "The board extended the present arrangement for a further three months pending pier repairs." };
  const draft = "The northern crossing keeps its sailings for a further three months ([transport board](https://www.transport.example.gov/decisions/crossing/)).";
  const selected = selectResearchEvidence([...filler, cited], "What changes to the ferry timetable this winter?", draft, 3000);
  assert.ok(selected.includes(cited));
});
