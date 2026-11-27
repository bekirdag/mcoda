import test from "node:test";
import assert from "node:assert/strict";
import { createTextTool } from "../TextTool.js";
const tool = createTextTool();
const context = { workspaceRoot: "/unused" };
test("Unicode sorting compares code points, preserves normalization and leaves inputs unchanged", async () => {
  const values = ["\u{10000}", "é", "e\u0301", "\uE000", "😀", "A", "", "Ab", "A"];
  const before = [...values];
  const result = await tool.handler({ operation: "sort_codepoints", values }, context);
  assert.deepEqual(result.data, { values: ["", "A", "A", "Ab", "e\u0301", "é", "\uE000", "\u{10000}", "😀"] });
  assert.deepEqual(values, before);
});
test("deduplication and normalization are separate explicit operations", async () => {
  assert.deepEqual((await tool.handler({ operation: "unique", values: ["é", "e\u0301", "é"] }, context)).data, { values: ["é", "e\u0301"] });
  assert.deepEqual((await tool.handler({ operation: "normalize", values: ["e\u0301"], form: "NFC" }, context)).data, { values: ["é"] });
  for (const args of [{ operation: "normalize", values: ["a"] }, { operation: "sort_codepoints", values: ["a"], form: "NFC" },
    { operation: "unique", values: Array(1001).fill("") }, { operation: "sort_codepoints", values: Array(10).fill("x".repeat(4096)) }]) {
    await assert.rejects(tool.handler(args, context));
  }
  await assert.rejects(tool.handler({ operation: "unique", values: [] }, { ...context, signal: AbortSignal.abort() }));
});
