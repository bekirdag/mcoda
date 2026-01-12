import test from "node:test";
import assert from "node:assert/strict";
import { computeAlpha, computeRunScore, updateEmaRating } from "../AgentRatingFormula.js";

test("computeRunScore rewards high quality with low penalties", () => {
  const score = computeRunScore({
    qualityScore: 10,
    totalCost: 0,
    durationSeconds: 0,
    iterations: 0,
  });
  assert.equal(score, 10);
});

test("computeRunScore penalizes low quality", () => {
  const score = computeRunScore({
    qualityScore: 0,
    totalCost: 0,
    durationSeconds: 0,
    iterations: 0,
  });
  assert.equal(score, 0);
});

test("updateEmaRating moves toward score using alpha", () => {
  const next = updateEmaRating(5, 9, 0.1);
  assert.equal(next, 5.4);
});

test("computeAlpha returns window-based smoothing factor", () => {
  const alpha = computeAlpha(50);
  assert.ok(alpha > 0 && alpha < 0.1);
});
