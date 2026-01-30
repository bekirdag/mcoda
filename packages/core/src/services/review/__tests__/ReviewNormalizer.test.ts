import test from "node:test";
import assert from "node:assert/strict";
import { normalizeReviewOutput } from "../ReviewNormalizer.js";

test("normalizeReviewOutput parses fenced JSON and preserves decision", () => {
  const raw = [
    "Some preamble text.",
    "```json",
    '{"decision":"approve","summary":"Looks good","findings":[]}',
    "```",
    "Trailing text.",
  ].join("\n");

  const normalized = normalizeReviewOutput(raw);
  assert.equal(normalized.parsedFromJson, true);
  assert.equal(normalized.usedFallback, false);
  assert.equal(normalized.result.decision, "approve");
  assert.equal(normalized.result.summary, "Looks good");
});

test("normalizeReviewOutput falls back to info_only for non-JSON", () => {
  const raw = "Looks fine to me. No structured JSON was provided.";
  const normalized = normalizeReviewOutput(raw);
  assert.equal(normalized.parsedFromJson, false);
  assert.equal(normalized.usedFallback, true);
  assert.equal(normalized.result.decision, "info_only");
  const summary = normalized.result.summary ?? "";
  assert.ok(summary.length > 0);
});
