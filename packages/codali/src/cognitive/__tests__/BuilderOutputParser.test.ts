import test from "node:test";
import assert from "node:assert/strict";
import { parsePatchOutput } from "../BuilderOutputParser.js";

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
