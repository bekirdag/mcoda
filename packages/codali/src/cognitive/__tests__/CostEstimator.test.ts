import test from "node:test";
import assert from "node:assert/strict";
import { estimateCostFromChars, estimateCostFromUsage, resolvePricing } from "../CostEstimator.js";

test("resolvePricing prefers provider:model then model then provider", () => {
  const overrides = {
    "stub:model-a": { per1K: 0.01 },
    "model-a": { per1K: 0.02 },
    stub: { per1K: 0.03 },
    default: { per1K: 0.04 },
  };
  const resolved = resolvePricing(overrides, "stub", "model-a");
  assert.equal(resolved.source, "stub:model-a");
  assert.equal(resolved.pricing?.per1K, 0.01);
});

test("estimateCostFromChars uses char-per-token and pricing", () => {
  const estimate = estimateCostFromChars(4000, 4, { per1K: 0.01 }, "stub:model");
  assert.equal(estimate.estimatedInputTokens, 1000);
  assert.equal(estimate.estimatedOutputTokens, 250);
  assert.equal(estimate.estimatedTotalTokens, 1250);
  assert.ok(estimate.estimatedCost !== undefined);
  assert.ok(Math.abs(estimate.estimatedCost - 0.0125) < 1e-9);
});

test("estimateCostFromUsage uses input/output rates", () => {
  const cost = estimateCostFromUsage(
    { inputTokens: 500, outputTokens: 250 },
    { inputPer1K: 0.01, outputPer1K: 0.02 },
  );
  assert.ok(cost !== undefined);
  assert.ok(Math.abs(cost - (0.005 + 0.005)) < 1e-9);
});
