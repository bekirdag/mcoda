import test from "node:test";
import assert from "node:assert/strict";
import { answerValues, backedByExecutedCode, backingOf, decideReview, keyedValues, numericProvenance, requestNeedsComputation, type ExecutedResult } from "../NumericProvenance.js";

const code = (seq: number, text: string): ExecutedResult => ({ seq, tool: "run_code", kind: "code", text });
const calc = (seq: number, text: string): ExecutedResult => ({ seq, tool: "calculate", kind: "calculation", text });

test("delivered values are checked against executed runs: invented values and a superseded rerun are flagged", () => {
  // Fresh variant: an inventory simulation run in full, then rerun in a reduced
  // form that drops the backorder rule; the answer takes the rerun's count and adds
  // a fill rate that no run printed.
  const results = [code(1, "stockouts = 14\nholding cost = 382.5\n"), code(2, "stockouts = 11\nholding cost = 382.5\n")];
  const report = numericProvenance('{"stockouts": 11, "holdingCost": 382.5, "fillRate": 0.9137}', "Simulate 30 days of an (s, S) inventory policy with s = 4, S = 12 and demand 1, 3, 0, 2 ...", results);
  assert.deepEqual(report.unbacked.map(item => item.key), ["fillRate"]);
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].key, "stockouts");
  assert.deepEqual(report.conflicts[0].runs.map(run => run.value), [14, 11]);
  // Backed by the full run, and named runs agreeing: nothing to reconcile.
  const clean = numericProvenance('{"stockouts": 14, "holdingCost": 382.5}', "", [results[0], code(3, "stockouts: 14")]);
  assert.equal(clean.unbacked.length + clean.conflicts.length, 0);
});

test("legitimately derived values count as backed: rounding, percent, unit factors and fractions", () => {
  const results = [code(1, "utilisation 0.875\nhours 0.625\nrate 2.3456497"), calc(2, '{"status":"sat","model":{"y":"65/4"}}')];
  for (const [token, backed] of [["87.5", true], ["37.5", true], ["0.88", true], ["2.3456", true], ["2.3457", false], ["2.3460", false], ["16.25", true], ["16.3", true], ["16.4", false]] as const) {
    assert.equal(backingOf({ token, value: Number(token) }, results) !== undefined, backed, token);
  }
  // A restated input backs a value only at the precision the request states it.
  assert.ok(backingOf({ token: "2", value: 2 }, [], "knots at x = 0, 2 and 5"));
  assert.equal(backingOf({ token: "2.000000", value: 2 }, [], "knots at x = 0, 2 and 5"), undefined);
});

test("answer values keep the precision the answer states and the field they belong to", () => {
  const json = answerValues('```json\n{"pH": {"start": 2.8910, "end": 9.1}, "volumes": [18.5524, 25]}\n```');
  assert.equal(json.json, true);
  assert.deepEqual(json.values.map(item => [item.path, item.token]), [["pH.start", "2.8910"], ["pH.end", "9.1"], ["volumes[0]", "18.5524"], ["volumes[1]", "25"]]);
  const prose = answerValues("The tank drains in 37.5 minutes; mean wait: 4.25 s for 12 pumps.", "There are 12 pumps.");
  assert.deepEqual(prose.values.map(item => item.token), ["37.5", "4.25"]);
  assert.equal(prose.values[1].key, "mean wait");
  assert.deepEqual([...keyedValues('[{"index":0,"actual":"{\\"meanWait\\":4.25}"}]')].find(([key]) => key === "meanwait"), ["meanwait", 4.25]);
});

test("values printed by executed code are protected from a tool-less review; unexecuted ones stay reviewable", () => {
  // Fresh variant: a pendulum period computed by code to 2.3480408 s, asked to 4 dp.
  const results = [code(1, "period 2.3480408\nfrequency 0.4258870"), calc(2, '{"result":6.283185307179586}')];
  assert.equal(backedByExecutedCode('{"period": 2.3480, "frequency": 0.4259}', "", results), true);
  for (const revised of ['{"period": 2.3481, "frequency": 0.4259}', '{"period": 2.3479, "frequency": 0.4259}']) {
    const review = decideReview('{"period": 2.3480, "frequency": 0.4259}', revised, "", results);
    assert.equal(review.verdict, "keep"); assert.deepEqual(review.protectedFields.map(item => item.field), ["period"]);
  }
  // The review's correction of an unexecuted value is merged; the executed value is restored.
  const merged = decideReview('{"period": 2.3480, "maxSpeed": 1.9}', '{"period": 2.3481, "maxSpeed": 1.87}', "", results);
  assert.equal(merged.verdict, "merge");
  assert.deepEqual(JSON.parse(merged.answer), { period: 2.348, maxSpeed: 1.87 });
  assert.match(merged.answer, /"period":2\.3480\b/);
  // A review that moves a value onto another executed result is accepted.
  assert.equal(decideReview('{"period": 2.3480}', '{"period": 6.2832}', "", results).verdict, "accept");
});

test("a calculated value the review contests is a dispute for an executed check, not a vote", () => {
  // Fresh variant: an M/M/2/4 help line whose draft used an Erlang-B style sum
  // through the calculator; the review proposes the finite-buffer value instead.
  const results = [calc(1, '{"result":0.0623,"values":{"pBlock":0.0623,"util":0.7032}}')];
  const review = decideReview('{"blocking": 0.0623, "utilisation": 0.7032}', '{"blocking": 0.0891, "utilisation": 0.6834}', "", results);
  assert.equal(review.verdict, "keep");
  assert.deepEqual(review.disputes.map(item => [item.field, item.drafted, item.revised]), [["blocking", "0.0623", "0.0891"], ["utilisation", "0.7032", "0.6834"]]);
  assert.equal(review.protectedFields.length, 0);
});

test("a request that needs computing is recognised; one that forbids tools or states little is not", () => {
  assert.equal(requestNeedsComputation("An LRU cache holds 3 pages. The reference string is 4, 7, 1, 4, 9, 7, 2. Count the hits, misses and evictions."), true);
  assert.equal(requestNeedsComputation("Without using any tools, estimate 3, 4, 5 and 6 combined."), false);
  assert.equal(requestNeedsComputation("What is 2 + 3?"), false);
  assert.equal(requestNeedsComputation("Summarise the meeting of 3 May with 4 people in 2 lines and 5 bullets."), false);
});

test("chance matches, receipt envelopes and lower-precision reviews are not support", () => {
  // Fresh variants for the review findings. Whole numbers match only themselves:
  // 25 is not 0.25 x 100 and 6 is not 0.1 x 60.
  const rates = [code(1, "share 0.25\nrate 0.1\nratio 0.875")];
  assert.equal(backingOf({ token: "25", value: 25 }, rates), undefined);
  assert.equal(backingOf({ token: "6", value: 6 }, rates), undefined);
  assert.ok(backingOf({ token: "87.5", value: 87.5 }, rates), "a stated decimal may still be a percent");
  // A deterministic receipt's timing, hashes and library version are not values.
  const receipt = calc(1, JSON.stringify({ result: "4.2", precision: 50, library: "decimal.js", version: "10.6.0", elapsedMs: 2876, inputSha256: "9f12a07c55e3", isolation: "offline" }));
  assert.ok(backingOf({ token: "4.2", value: 4.2 }, [receipt]));
  for (const token of ["2876", "50", "10.6", "12"]) assert.equal(backingOf({ token, value: Number(token) }, [receipt]), undefined, token);
  // "Backed by executed code" admits no unit factors: 2.346 is not 0.0391 x 60.
  assert.equal(backedByExecutedCode('{"x": 2.346}', "", [code(1, "rate 0.0391")]), false);
  // A review is judged at the draft's precision: 2.3480 -> 2 is a change, and a review value
  // matched only through a unit factor does not outweigh code output.
  const period = [code(1, "period 2.3480408"), calc(2, '{"result":0.0391}')];
  for (const revised of ['{"period": 2}', '{"period": 2.346}']) {
    const review = decideReview('{"period": 2.3480}', revised, "", period);
    assert.equal(review.verdict, "keep", revised); assert.deepEqual(review.protectedFields.map(item => item.field), ["period"]);
  }
});

test("ordinary chat with versions and dates is not a computation, and labels are not values", () => {
  assert.equal(requestNeedsComputation("Should we move from HTTP 2 to 3, and from TLS 1.2 or 1.3? What do you mean by 0-RTT, and what did the 2024 RFC determine?"), false);
  assert.equal(requestNeedsComputation("Python 3.12 or 3.13 on Ubuntu 24.04: which do you expect to be faster to count on?"), false);
  assert.equal(requestNeedsComputation("A coin lands heads with p = 0.3, 0.5, 0.7 or 0.9. Give the expected number of tosses until two heads in a row."), true);
  const prose = answerValues("In the 3rd quarter of 2024, on 2024-05-01 at 10:30, TLS 1.3 and HTTP/2 cut handshakes (v2.4.1); mean latency: 42.5 ms.");
  assert.deepEqual(prose.values.map(item => item.token), ["42.5"]);
});
