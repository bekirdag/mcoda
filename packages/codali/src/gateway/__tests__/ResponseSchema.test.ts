import assert from "node:assert/strict";
import test from "node:test";
import {
  extractJsonPayload,
  validateResponseAgainstSchema,
} from "../ResponseSchema.js";

const schema = {
  type: "object",
  required: ["title", "score"],
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    score: { type: "number" },
    tags: { type: "array", items: { type: "string" } },
  },
};

test("no schema means the raw answer passes through unchanged", () => {
  const result = validateResponseAgainstSchema("just prose", undefined);
  assert.equal(result.ok, true);
  assert.equal(result.value, "just prose");
});

test("a conforming JSON response validates and is returned parsed", () => {
  const result = validateResponseAgainstSchema(
    '{"title":"Report","score":9}',
    schema,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { title: "Report", score: 9 });
});

test("a missing required property is reported with its path", () => {
  const result = validateResponseAgainstSchema('{"title":"Report"}', schema);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations, [
    { path: "$.score", message: "required property is missing" },
  ]);
});

test("a wrong property type is reported rather than silently accepted", () => {
  const result = validateResponseAgainstSchema(
    '{"title":"Report","score":"high"}',
    schema,
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.path, "$.score");
  assert.match(result.violations[0]?.message ?? "", /expected number/);
});

test("an unexpected property is rejected when additionalProperties is false", () => {
  const result = validateResponseAgainstSchema(
    '{"title":"Report","score":9,"extra":true}',
    schema,
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.path, "$.extra");
});

test("nested array item types are validated", () => {
  const result = validateResponseAgainstSchema(
    '{"title":"Report","score":9,"tags":["a",2]}',
    schema,
  );
  assert.equal(result.ok, false);
  assert.equal(result.violations[0]?.path, "$.tags[1]");
});

test("unparseable output is a violation, not a crash", () => {
  const result = validateResponseAgainstSchema("not json at all", schema);
  assert.equal(result.ok, false);
  assert.match(result.violations[0]?.message ?? "", /not parseable/);
});

test("an integer satisfies a number schema and vice versa when whole", () => {
  assert.equal(
    validateResponseAgainstSchema('{"title":"a","score":3}', schema).ok,
    true,
  );
  const intSchema = { type: "object", properties: { n: { type: "integer" } } };
  assert.equal(validateResponseAgainstSchema('{"n":3.0}', intSchema).ok, true);
  assert.equal(validateResponseAgainstSchema('{"n":3.5}', intSchema).ok, false);
});

test("JSON wrapped in a fenced block is recovered", () => {
  const payload = extractJsonPayload('```json\n{"a":1}\n```');
  assert.deepEqual(payload, { a: 1 });
});

test("JSON wrapped in prose is recovered", () => {
  const payload = extractJsonPayload('Here you go:\n{"a":1}\nHope that helps.');
  assert.deepEqual(payload, { a: 1 });
});

test("enum values are enforced", () => {
  const enumSchema = {
    type: "object",
    properties: { status: { enum: ["open", "closed"] } },
  };
  assert.equal(validateResponseAgainstSchema('{"status":"open"}', enumSchema).ok, true);
  assert.equal(validateResponseAgainstSchema('{"status":"maybe"}', enumSchema).ok, false);
});
