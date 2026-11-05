import test from "node:test";
import assert from "node:assert/strict";
import { calendarCalculate, createCalendarTool } from "../CalendarTool.js";

test("calendar handles leap years, year boundaries and negative offsets without DST arithmetic", () => {
  for (const [date, days, expected] of [["2028-03-01", -1, "2028-02-29"], ["2029-09-03", -47, "2029-07-18"], ["0099-12-31", 1, "0100-01-01"], ["2000-02-28", 1, "2000-02-29"], ["1900-02-28", 1, "1900-03-01"], ["2027-03-13", 2, "2027-03-15"]] as const) {
    assert.deepEqual(calendarCalculate({ operation: "add_days", date, days }), { date: expected });
    assert.deepEqual(calendarCalculate({ operation: "difference_days", date, otherDate: expected }), { days });
  }
});
test("calendar rejects rollover dates, ambiguous operands and range overflow", () => {
  for (const date of ["2027-02-29", "2028-04-31", "0000-01-01", "2027-1-01", "2027-00-01", "not a date"]) assert.throws(() => calendarCalculate({ operation: "add_days", date, days: 0 }));
  for (const [date, days] of [["0001-01-01", -1], ["9999-12-31", 1], ["2027-01-01", 0.5], ["2027-01-01", Infinity]] as const) assert.throws(() => calendarCalculate({ operation: "add_days", date, days }));
  assert.throws(() => calendarCalculate({ operation: "add_days", date: "2027-01-01", days: 1, otherDate: "2027-01-02" }));
  assert.throws(() => calendarCalculate({ operation: "difference_days", date: "2027-01-01" }));
});
test("calendar is a cancellable read-only tool with structured evidence", async () => {
  const tool = createCalendarTool();
  assert.equal(tool.readOnly, true);
  const result = await tool.handler({ operation: "difference_days", date: "2028-02-28", otherDate: "2028-03-01" }, { workspaceRoot: "/unused" });
  assert.deepEqual(result.data, { days: 2, calendar: "proleptic Gregorian UTC" });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(tool.handler({ operation: "add_days", date: "2028-01-01", days: 1 }, { workspaceRoot: "/unused", signal: abort.signal }));
});
