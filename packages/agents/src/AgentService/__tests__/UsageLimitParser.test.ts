import assert from "node:assert/strict";
import test from "node:test";
import { parseUsageLimitError } from "../UsageLimitParser.js";

test("parses retry-after relative durations", () => {
  const nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const parsed = parseUsageLimitError(
    new Error("AUTH_ERROR: usage_limit_reached. Retry after 2 hours 30 minutes."),
    nowMs,
  );
  assert.ok(parsed);
  assert.deepEqual(parsed?.windowTypes, ["other"]);
  assert.equal(parsed?.resetAt, "2026-03-02T12:30:00.000Z");
  assert.equal(parsed?.resetAtSource, "relative");
});

test("parses absolute reset timestamps", () => {
  const nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const parsed = parseUsageLimitError(
    new Error("AUTH_ERROR: rate limit reached; resets at 2026-03-03T00:00:00Z"),
    nowMs,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resetAt, "2026-03-03T00:00:00.000Z");
  assert.equal(parsed?.resetAtSource, "absolute");
});

test("infers known windows from message keywords", () => {
  const parsed = parseUsageLimitError(
    new Error("Too many requests. 5h window exhausted; daily and weekly quotas reached."),
    Date.parse("2026-03-02T10:00:00.000Z"),
  );
  assert.ok(parsed);
  assert.deepEqual((parsed?.windowTypes ?? []).sort(), ["daily", "rolling_5h", "weekly"]);
});

test("extracts text from nested error details", () => {
  const error = new Error("AUTH_ERROR: request failed");
  (error as any).details = {
    stderr: "HTTP 429",
    body: { message: "usage limit reached, try again in 45 minutes" },
  };
  const parsed = parseUsageLimitError(error, Date.parse("2026-03-02T10:00:00.000Z"));
  assert.ok(parsed);
  assert.equal(parsed?.resetAt, "2026-03-02T10:45:00.000Z");
  assert.equal(parsed?.resetAtSource, "relative");
});

test("does not double-count retry durations when message and raw text overlap", () => {
  const nowMs = Date.parse("2026-03-02T10:00:00.000Z");
  const parsed = parseUsageLimitError(
    new Error("AUTH_ERROR: rate limit reached, retry after 30 seconds"),
    nowMs,
  );
  assert.ok(parsed);
  assert.equal(parsed?.resetAt, "2026-03-02T10:00:30.000Z");
});

test("does not classify invalid key auth failures as usage limits", () => {
  const parsed = parseUsageLimitError(new Error("AUTH_ERROR: invalid api key provided"));
  assert.equal(parsed, null);
});
