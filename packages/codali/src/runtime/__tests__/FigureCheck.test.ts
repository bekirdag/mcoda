import test from "node:test";
import assert from "node:assert/strict";
import { checkFigures, figureMatches, parseFigureClaims } from "../FigureCheck.js";

test("a stated figure that its own expression contradicts is a mismatch", () => {
  // Cycle 5 design 34: 2 TB/day for 3.5 days retained is 7 TB, not 1 PB.
  const claims = parseFigureClaims('```json\n{"figures":[{"claim":"hot tier holds 1 PB","expression":"2 * 3.5","stated":1000},{"claim":"14 fragments","expression":"10+4","stated":"14"}]}\n```');
  const [hot, fragments] = checkFigures(claims);
  assert.equal(hot.computed, 7); assert.equal(hot.matches, false);
  assert.equal(fragments.matches, true);
});

test("rounding in the stated value and small differences are not mismatches", () => {
  assert.ok(figureMatches(33.3, 100 / 3)); assert.ok(figureMatches(1.4, 1.4166)); assert.ok(figureMatches(0, 0));
  assert.ok(!figureMatches(36, 33.6)); assert.ok(!figureMatches(1.3, 1.4));
});

test("unparseable output and bad expressions never produce a false mismatch", () => {
  assert.deepEqual(parseFigureClaims("not json"), []);
  assert.deepEqual(parseFigureClaims('{"figures":[{"claim":1,"expression":"2","stated":2}]}'), []);
  const [result] = checkFigures([{ claim: "x", expression: "60 PB / 50 MB", stated: 1 }]);
  assert.equal(result.matches, true); assert.ok(result.error);
  assert.equal(checkFigures([{ claim: "objects", expression: "60,000,000 / 50", stated: 1200000 }])[0].matches, true);
});
