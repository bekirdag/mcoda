import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestUsage } from "../RequestUsage.js";

const id = "ac03a5c6-3f12-4cc8-9e2a-00290f790ab5";
const row = () => ({ id: "shi_one", status: "success", operation: "chat.completions", usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } });
const payload = () => ({ schema_version: 1, client_request_id: id, truncated: false, invocations: [row()] });

test("request receipts sum distinct terminal attempts, including known failed-attempt usage", () => {
  const input = payload(); input.invocations.push({ ...row(), id: "shi_two", status: "failed" });
  assert.deepEqual(parseRequestUsage(id, input), { requestId: id, complete: true, invocationIds: ["shi_one", "shi_two"], usage: { inputTokens: 20, outputTokens: 14, totalTokens: 34 } });
});

for (const kind of ["active", "truncated", "absent", "negative", "inconsistent", "unsafe"] as const) {
  test(`request accounting remains unresolved for ${kind}`, () => {
    const input = payload();
    if (kind === "active") input.invocations[0].status = "started";
    if (kind === "truncated") input.truncated = true;
    if (kind === "absent") Object.assign(input.invocations[0].usage, { total_tokens: null });
    if (kind === "negative") input.invocations[0].usage.prompt_tokens = -1;
    if (kind === "inconsistent") input.invocations[0].usage.total_tokens = 2;
    if (kind === "unsafe") input.invocations[0].usage.total_tokens = Number.MAX_SAFE_INTEGER + 1;
    const result = parseRequestUsage(id, input); assert.equal(result.complete, false); assert.equal(result.usage, undefined);
  });
}

test("mismatched identity, duplicate attempts, wrong operations and unknown schemas are rejected", () => {
  const duplicate = payload(); duplicate.invocations.push(row());
  const wrongOperation = payload(); wrongOperation.invocations[0].operation = "embeddings";
  for (const input of [{ ...payload(), client_request_id: "another" }, { ...payload(), schema_version: 2 }, duplicate, wrongOperation, { ...payload(), invocations: [] }]) {
    assert.throws(() => parseRequestUsage(id, input), /Invalid request usage/);
  }
});
