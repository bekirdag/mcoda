import test from "node:test";
import assert from "node:assert/strict";
import { parseComputedAnswer, renderComputedAnswer } from "../ComputedAnswer.js";

test("computed answers project actual tool values into JSON or templates without another model pass", () => {
  const spec = parseComputedAnswer({ tool: "decimal_calculate", args: { operation: "add", values: ["0.1", "0.2"] }, fields: { answer: { path: "result", as: "number" } } });
  const result = { ok: true, output: '{"result":"0.30"}' };
  assert.equal(renderComputedAnswer(spec, result, "", "json"), '{"answer":0.3}');
  assert.equal(renderComputedAnswer(spec, result, "The total is {{answer}}.", "text"), "The total is 0.3.");
  const table = parseComputedAnswer({ tool: "query_data", args: {}, fields: { answer: { path: "rows.0.0", as: "number" } } });
  assert.equal(renderComputedAnswer(table, { ok: true, output: "", data: { rows: [["36.50"]] } }, "", "json"), '{"answer":36.5}');
});
test("computed answers reject precision loss, missing fields, truncation and prototype traversal", () => {
  const spec = parseComputedAnswer({ tool: "query_data", args: {}, fields: { answer: { path: "result", as: "number" } } });
  for (const value of ["9007199254740993", "0.33333333333333333333333", "NaN", "Infinity", "1e9999"]) assert.throws(() => renderComputedAnswer(spec, { ok: true, output: "", data: { result: value } }, "", "json"), /precision/);
  assert.throws(() => renderComputedAnswer(spec, { ok: true, output: "{}" }, "", "json"), /no field/);
  assert.throws(() => renderComputedAnswer(spec, { ok: true, output: '{"result":3,"truncated":true}' }, "", "json"), /truncated/);
  assert.throws(() => parseComputedAnswer({ tool: "x", args: {}, fields: { answer: { path: "constructor.name" } } }), /selector/);
  assert.throws(() => renderComputedAnswer(spec, { ok: true, output: '{"result":3}' }, "An unchecked guess of 8.", "text"), /Every selected/);
  assert.throws(() => renderComputedAnswer(spec, { ok: false, output: "", error: { code: "tool_timeout", category: "timeout", retryable: false, message: "deadline" } }, "", "json"), /deadline/);
});
