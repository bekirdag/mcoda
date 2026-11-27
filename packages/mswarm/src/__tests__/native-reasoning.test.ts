import test from "node:test";
import assert from "node:assert/strict";
import { nativeReasoningRequest } from "../native-reasoning.js";

test("native reasoning preserves explicit disable and budgets without copying runner settings", () => {
  assert.deepEqual(nativeReasoningRequest({ reasoning_effort: "none", reasoning_budget_tokens: 0, model: "other", baseUrl: "https://other" }), { reasoning_effort: "none", reasoning_budget_tokens: 0 });
  assert.deepEqual(nativeReasoningRequest({}), {});
  for (const value of [-1, 1.5, 1_000_001, "1024", null, NaN]) assert.throws(() => nativeReasoningRequest({ reasoning_budget_tokens: value }), /Invalid/);
  for (const value of [true, null, "HIGH", "high\n", "", "x".repeat(33)]) assert.throws(() => nativeReasoningRequest({ reasoning_effort: value }), /Invalid/);
});
