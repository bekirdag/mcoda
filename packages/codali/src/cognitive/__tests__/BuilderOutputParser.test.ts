import test from "node:test";
import assert from "node:assert/strict";
import {
  FILES_ARRAY_EMPTY_ERROR,
  PATCHES_ARRAY_EMPTY_ERROR,
  parsePatchOutput,
} from "../BuilderOutputParser.js";

test("parsePatchOutput parses replace/create/delete", { concurrency: false }, () => {
  const payload = JSON.stringify({
    patches: [
      {
        action: "replace",
        file: "src/a.ts",
        search_block: "old",
        replace_block: "new",
      },
      {
        action: "create",
        file: "src/b.ts",
        content: "export const b = 1;",
      },
      {
        action: "delete",
        file: "src/c.ts",
      },
    ],
  });

  const parsed = parsePatchOutput(payload, "search_replace");
  assert.equal(parsed.patches.length, 3);
  assert.equal(parsed.patches[0].action, "replace");
  assert.equal(parsed.patches[1].action, "create");
  assert.equal(parsed.patches[2].action, "delete");
});

test("parsePatchOutput parses file_writes payload", { concurrency: false }, () => {
  const payload = JSON.stringify({
    files: [
      { path: "src/a.ts", content: "export const a = 1;" },
      { path: "src/b.ts", content: "export const b = 2;" },
    ],
    delete: ["src/old.ts"],
  });
  const parsed = parsePatchOutput(payload, "file_writes");
  assert.equal(parsed.patches.length, 3);
  assert.equal(parsed.patches[0].action, "create");
  assert.equal(parsed.patches[2].action, "delete");
});

test("parsePatchOutput rejects invalid payload", { concurrency: false }, () => {
  assert.throws(() => parsePatchOutput("{}", "search_replace"), /patches/);
  assert.throws(() => parsePatchOutput("{}", "file_writes"), /files/);
  assert.throws(() => parsePatchOutput("not-json", "search_replace"), /valid JSON/);
});

test("parsePatchOutput extracts JSON from fenced output", { concurrency: false }, () => {
  const payload = [
    "Here is the patch:",
    "```json",
    JSON.stringify({
      patches: [
        { action: "replace", file: "src/a.ts", search_block: "a", replace_block: "b" },
      ],
    }),
    "```",
  ].join("\n");
  const parsed = parsePatchOutput(payload, "search_replace");
  assert.equal(parsed.patches.length, 1);
  assert.equal(parsed.patches[0].action, "replace");
});

test("parsePatchOutput extracts JSON from mixed output", { concurrency: false }, () => {
  const payload = [
    "NOTE: apply changes below",
    JSON.stringify({
      files: [{ path: "src/a.ts", content: "export const a = 1;" }],
    }),
    "Thanks!",
  ].join("\n");
  const parsed = parsePatchOutput(payload, "file_writes");
  assert.equal(parsed.patches.length, 1);
  assert.equal(parsed.patches[0].action, "create");
});

test("parsePatchOutput rejects empty top-level arrays with explicit schema errors", { concurrency: false }, () => {
  assert.throws(
    () => parsePatchOutput(JSON.stringify({ patches: [] }), "search_replace"),
    new RegExp(PATCHES_ARRAY_EMPTY_ERROR, "i"),
  );
  assert.throws(
    () => parsePatchOutput(JSON.stringify({ files: [] }), "file_writes"),
    new RegExp(FILES_ARRAY_EMPTY_ERROR, "i"),
  );
});

test("parsePatchOutput rejects schema-echo payloads without concrete patch arrays", { concurrency: false }, () => {
  const schemaEcho = [
    "Use this schema:",
    "```json",
    JSON.stringify({ type: "object", properties: { patches: { type: "array" } } }),
    "```",
  ].join("\n");
  assert.throws(() => parsePatchOutput(schemaEcho, "search_replace"), /missing required 'patches' array/i);
});

test("parsePatchOutput reports deterministic errors for equivalent malformed payloads", { concurrency: false }, () => {
  const malformedA = "{";
  const malformedB = "not-json";
  const parse = (value: string): string => {
    try {
      parsePatchOutput(value, "search_replace");
      return "ok";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  assert.equal(parse(malformedA), "Patch output is not valid JSON");
  assert.equal(parse(malformedB), "Patch output is not valid JSON");
});
