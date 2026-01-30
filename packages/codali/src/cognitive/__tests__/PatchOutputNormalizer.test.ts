import test from "node:test";
import assert from "node:assert/strict";
import { normalizePatchOutput } from "../PatchOutputNormalizer.js";

test("normalizePatchOutput strips code fences", () => {
  const raw = "```json\n{ \"patches\": [] }\n```";
  assert.equal(normalizePatchOutput(raw), '{ "patches": [] }');
});

test("normalizePatchOutput strips JSON prefix", () => {
  const raw = "JSON: { \"files\": [] }";
  assert.equal(normalizePatchOutput(raw), '{ "files": [] }');
});

test("normalizePatchOutput extracts embedded JSON", () => {
  const raw = "Here you go:\n{ \"patches\": [{\"action\":\"delete\",\"file\":\"a\"}] }\nThanks";
  assert.equal(
    normalizePatchOutput(raw),
    '{ "patches": [{"action":"delete","file":"a"}] }',
  );
});

test("normalizePatchOutput returns undefined when no JSON present", () => {
  const raw = "No structured output here.";
  assert.equal(normalizePatchOutput(raw), undefined);
});
