import test from "node:test";
import assert from "node:assert/strict";
import { estimateBudget, estimateTokens, resolveModelTokenLimit } from "../ContextBudget.js";

test("estimateTokens uses charPerToken heuristic", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd", 2), 2);
  assert.equal(estimateTokens("abcdef", 3), 2);
});

test("estimateBudget sums system, bundle, and history", () => {
  const estimate = estimateBudget({
    systemPrompt: "system prompt",
    bundle: "bundle",
    history: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ],
    charPerToken: 2,
  });

  assert.equal(estimate.systemTokens > 0, true);
  assert.equal(estimate.bundleTokens > 0, true);
  assert.equal(estimate.historyTokens > 0, true);
  assert.equal(estimate.totalTokens, estimate.systemTokens + estimate.bundleTokens + estimate.historyTokens);
});

test("resolveModelTokenLimit honors overrides and fallback", () => {
  const overrides = { llama3: 8192, "deepseek-coder": 128000 };
  assert.equal(resolveModelTokenLimit("llama3:instruct", overrides, 4096), 8192);
  assert.equal(resolveModelTokenLimit("deepseek-coder:33b", overrides, 4096), 128000);
  assert.equal(resolveModelTokenLimit("unknown", overrides, 4096), 4096);
});
