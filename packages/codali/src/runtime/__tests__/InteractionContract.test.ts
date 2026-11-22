import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCodeBlockPresentation, parseOutputContract, requestDemandsCodeBlockOnly, requestDemandsJsonOnly, unconstrainedOutput, validateInteractionOutput } from "../InteractionContract.js";

test("only explicit JSON-only wording upgrades a request to a JSON reply", () => {
  for (const request of ["Return only JSON with exactly these five keys: a, b.", "Respond with JSON only.", "Output just valid JSON.", "Reply with only a JSON object? No: return only JSON."]) {
    assert.equal(requestDemandsJsonOnly(request), true, request);
  }
  for (const request of ["Explain what JSON is.", "Return a summary and include a JSON example.", "Only use JSON fields that exist. Answer in prose.", "Write a JSON parser in Python."]) {
    assert.equal(requestDemandsJsonOnly(request), false, request);
  }
});

test("contracts reject malformed, excessive and contradictory constraints without coercion", () => {
  const valid = unconstrainedOutput();
  for (const value of [null, [], {}, { ...valid, extra: true }, { ...valid, format: "yaml" },
    { ...valid, minWords: "3" }, { ...valid, minWords: -1 }, { ...valid, maxWords: 20001 },
    { ...valid, minWords: 5, maxWords: 4 }, { ...valid, requiredKeys: ["id"] },
    { ...valid, format: "json", requiredKeys: ["id", "id"] },
    { ...valid, format: "json", requiredKeys: [null] },
    { ...valid, format: "json", requiredKeys: ["x".repeat(129)] },
    { ...valid, format: "json", requiredKeys: Array.from({ length: 33 }, (_, i) => String(i)) }]) {
    assert.throws(() => parseOutputContract(value));
  }
  assert.deepEqual(parseOutputContract(valid), valid);
});

test("JSON validation requires exact syntax and own top-level keys while allowing requested arrays and scalars", () => {
  const contract = { ...unconstrainedOutput(), format: "json" as const, requiredKeys: ["city"] };
  for (const content of ['Tokyo', '```json\n{"city":"Tokyo"}\n```', 'Here: {"city":"Tokyo"}', '{"city":"Tokyo"} trailing', 'null', '[]', '{}']) {
    assert.ok(validateInteractionOutput(content, contract).length, content);
  }
  assert.deepEqual(validateInteractionOutput(' {"city":"Tokyo"}\n', contract), []);
  for (const content of ['[1,2]', 'true', '"hello"', 'null', '3']) assert.deepEqual(validateInteractionOutput(content, { ...contract, requiredKeys: [] }), []);
  const prototypeKey = { ...contract, requiredKeys: ["constructor"] };
  assert.ok(validateInteractionOutput('{}', prototypeKey).length);
  assert.deepEqual(validateInteractionOutput('{"constructor":"literal user data"}', prototypeKey), []);
  assert.deepEqual(validateInteractionOutput('{"__proto__":{"polluted":true}}', { ...contract, requiredKeys: ["__proto__"] }), []);
  assert.equal(Object.prototype.hasOwnProperty.call({}, "polluted"), false);
});

test("explicit word bounds use whitespace-separated words and do not imply factual validation", () => {
  const contract = { ...unconstrainedOutput(), minWords: 3, maxWords: 3 };
  assert.deepEqual(validateInteractionOutput("  one\n two\tthree  ", contract), []);
  assert.match(validateInteractionOutput("one two", contract).join(), /minimum is 3/);
  assert.match(validateInteractionOutput("one two three four", contract).join(), /maximum is 3/);
  assert.ok(validateInteractionOutput("  ", unconstrainedOutput()).length);
  assert.deepEqual(validateInteractionOutput('{"answer":999}', { ...unconstrainedOutput(), format: "json", requiredKeys: ["answer"] }), []);
});

test("only explicit one-code-block-no-prose wording asks for a bare code block", () => {
  for (const request of ["Do not mutate inputs. Return exactly one fenced python code block, all imports included, no prose. Use available tools to verify your answer.", "Reply with only one code block and nothing else.", "Return exactly one fenced code block. No explanation."]) {
    assert.equal(requestDemandsCodeBlockOnly(request), true, request);
  }
  for (const request of ["Return exactly one fenced python code block, then explain the design.", "Show the code and explain it.", "Return only JSON, no prose."]) {
    assert.equal(requestDemandsCodeBlockOnly(request), false, request);
  }
});

test("prose around the single code block is dropped and the block is kept byte for byte", () => {
  const block = "```python\nimport math\n\ndef f(x):\n    return math.floor(x)\n```";
  assert.equal(normalizeCodeBlockPresentation(`The exact final version below was re-executed in the sandbox (25 tests OK).\n\n${block}`), block);
  assert.equal(normalizeCodeBlockPresentation(`${block}\n\nHow it works / design notes\n\n- Parsing is hand-written.`), block);
  assert.equal(normalizeCodeBlockPresentation(block), block);
  const two = `${block}\n\nAlternative:\n\n${block}`;
  assert.equal(normalizeCodeBlockPresentation(two), two);
  const inner = "Note\n\n```python\ndoc = \"\"\"\n```\n\"\"\"\n```";
  assert.equal(normalizeCodeBlockPresentation(inner), inner);
});

test("a runtime note goes inside a single code block as a comment in its language", async () => {
  const { noteInsideCodeBlock } = await import("../InteractionContract.js");
  const note = "\n\nRuntime check: this final code was run against the session's last test file and 4 of 17 tests failed; treat it as not passing.";
  const python = "```python\ndef f(x):\n    return x + 1\n```";
  const placed = noteInsideCodeBlock(python, note)!;
  assert.equal(placed, "```python\ndef f(x):\n    return x + 1\n\n# Runtime check: this final code was run against the session's last test file and 4 of 17 tests failed; treat it as not passing.\n```");
  // Still exactly one fenced block and nothing outside it.
  assert.equal((placed.match(/```/g) ?? []).length, 2); assert.ok(placed.startsWith("```python") && placed.endsWith("```"));
  assert.match(noteInsideCodeBlock("```ts\nexport const a = 1;\n```", note)!, /\n\n\/\/ Runtime check: [^\n]*\n```$/);
  assert.match(noteInsideCodeBlock("```sql\nSELECT 1;\n```", note)!, /\n\n-- Runtime check: /);
  // No known line comment (or no language): the caller keeps the note after the block.
  assert.equal(noteInsideCodeBlock("```\nplain\n```", note), undefined);
  assert.equal(noteInsideCodeBlock("```html\n<p>x</p>\n```", note), undefined);
  assert.equal(noteInsideCodeBlock("no block here", note), undefined);
});
