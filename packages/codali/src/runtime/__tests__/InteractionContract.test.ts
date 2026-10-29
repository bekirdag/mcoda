import test from "node:test";
import assert from "node:assert/strict";
import { parseOutputContract, unconstrainedOutput, validateInteractionOutput } from "../InteractionContract.js";

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
