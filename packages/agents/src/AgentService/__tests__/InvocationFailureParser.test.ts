import assert from "node:assert/strict";
import test from "node:test";
import { parseInvocationFailure } from "../InvocationFailureParser.js";

test("classifies generic AUTH_ERROR failures as technical issues", () => {
  const parsed = parseInvocationFailure(
    new Error("AUTH_ERROR: codex CLI failed (exit 1): no output"),
    Date.parse("2026-03-03T10:00:00.000Z"),
  );
  assert.ok(parsed);
  assert.equal(parsed?.kind, "technical_issue");
});

test("does not classify invalid-key auth failures as retryable", () => {
  const parsed = parseInvocationFailure(new Error("AUTH_ERROR: invalid api key"), Date.now());
  assert.equal(parsed, null);
});

test("classifies explicit rate-limit failures as usage limits", () => {
  const parsed = parseInvocationFailure(
    new Error("AUTH_ERROR: usage limit reached, retry after 10 minutes"),
    Date.parse("2026-03-03T10:00:00.000Z"),
  );
  assert.ok(parsed);
  assert.equal(parsed?.kind, "usage_limit");
});
