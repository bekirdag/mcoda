import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTemporalContext,
  renderTemporalContext,
  resolveRelativeRange,
} from "../TemporalContext.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const DAY_MS = 86_400_000;

const daysBetween = (since: string, until: string): number =>
  Math.round((Date.parse(until) - Date.parse(since)) / DAY_MS);

test("\"last two weeks\" resolves to an absolute 14-day range", () => {
  const range = resolveRelativeRange("How is Bekir doing in the last two weeks?", NOW);
  assert.ok(range);
  assert.equal(range.days, 14);
  assert.equal(daysBetween(range.since, range.until), 14);
  assert.equal(range.until, NOW.toISOString());
});

test("digit quantities resolve", () => {
  const range = resolveRelativeRange("commits in the past 30 days", NOW);
  assert.equal(range?.days, 30);
});

test("months and quarters resolve", () => {
  assert.equal(resolveRelativeRange("last 3 months", NOW)?.days, 90);
  assert.equal(resolveRelativeRange("previous 2 quarters", NOW)?.days, 182);
});

test("fixed phrases without a quantity resolve", () => {
  assert.equal(resolveRelativeRange("what changed yesterday", NOW)?.days, 1);
  assert.equal(resolveRelativeRange("tickets from last month", NOW)?.days, 30);
});

test("a query with no time expression yields no range", () => {
  assert.equal(resolveRelativeRange("Where is the planner defined?", NOW), undefined);
});

test("an unparseable quantity is left unresolved rather than guessed", () => {
  // A wrong window is worse than no window: it looks authoritative.
  assert.equal(resolveRelativeRange("last umpteen weeks", NOW), undefined);
});

test("an absurd quantity is rejected", () => {
  assert.equal(resolveRelativeRange("last 99999 days", NOW), undefined);
});

test("the rendered context tells workers to use the absolute timestamps", () => {
  const rendered = renderTemporalContext(buildTemporalContext("last two weeks", NOW));
  const text = rendered.join("\n");
  assert.match(text, /Current time: 2026-08-04T12:00:00\.000Z/);
  assert.match(text, /Resolved time range for "last two weeks"/);
  assert.match(text, /Do not compute your own dates/);
});

test("with no range, the current time is stated but flagged as unusable as a filter", () => {
  const rendered = renderTemporalContext(buildTemporalContext("what is X?", NOW));
  assert.match(rendered[0] ?? "", /Current time:/);
  assert.match(rendered.join("\n"), /named no time period/i);
});

test("the same query resolves identically for a fixed now, so runs are reproducible", () => {
  const a = buildTemporalContext("last two weeks", NOW);
  const b = buildTemporalContext("last two weeks", NOW);
  assert.deepEqual(a, b);
});

test("with no range, the model is told not to use 'now' as a date filter", () => {
  // Observed: `list_commits since=<current time>` — a valid call that matches
  // nothing, because stating the current time invites using it as a start.
  const rendered = renderTemporalContext(buildTemporalContext("list my recent commits", NOW)).join("\n");
  assert.match(rendered, /named no time period/i);
  assert.match(rendered, /Omit date filters/i);
});
