import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PatchApplier } from "../PatchApplier.js";

const setupDir = () => mkdtempSync(path.join(os.tmpdir(), "codali-patch-"));

test("PatchApplier replaces exact and whitespace-normalized blocks", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const filePath = path.join(tmpDir, "a.ts");
  writeFileSync(filePath, "const a = 1;\nconst b = 2;\n", "utf8");

  const applier = new PatchApplier({ workspaceRoot: tmpDir });
  await applier.apply([
    {
      action: "replace",
      file: "a.ts",
      search_block: "const a = 1;",
      replace_block: "const a = 3;",
    },
  ]);
  const updated = readFileSync(filePath, "utf8");
  assert.ok(updated.includes("const a = 3;"));

  await applier.apply([
    {
      action: "replace",
      file: "a.ts",
      search_block: "const b=2;",
      replace_block: "const b = 4;",
    },
  ]);
  const updated2 = readFileSync(filePath, "utf8");
  assert.ok(updated2.includes("const b = 4;"));
});

test("PatchApplier creates and deletes files", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const applier = new PatchApplier({ workspaceRoot: tmpDir });
  await applier.apply([
    {
      action: "create",
      file: "src/new.ts",
      content: "export const ok = true;",
    },
  ]);
  assert.ok(existsSync(path.join(tmpDir, "src/new.ts")));

  await applier.apply([
    {
      action: "delete",
      file: "src/new.ts",
    },
  ]);
  assert.equal(existsSync(path.join(tmpDir, "src/new.ts")), false);
});

test("PatchApplier rejects ambiguous matches", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const filePath = path.join(tmpDir, "amb.ts");
  writeFileSync(filePath, "return true;\nreturn true;\n", "utf8");
  const applier = new PatchApplier({ workspaceRoot: tmpDir });
  await assert.rejects(
    () =>
      applier.apply([
        {
          action: "replace",
          file: "amb.ts",
          search_block: "return true;",
          replace_block: "return false;",
        },
      ]),
    /Ambiguous/,
  );
});

test("PatchApplier replaces multiline blocks with whitespace fallback exactly once", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const filePath = path.join(tmpDir, "complex.js");
  writeFileSync(
    filePath,
    [
      "function sample() {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const applier = new PatchApplier({ workspaceRoot: tmpDir });
  await applier.apply([
    {
      action: "replace",
      file: "complex.js",
      search_block: "function sample(){ const a=1; const b=2; return a+b; }",
      replace_block: "function sample() { const a = 1; const b = 2; return a + b + 1; }",
    },
  ]);

  const updated = readFileSync(filePath, "utf8");
  assert.ok(updated.includes("return a + b + 1;"));
  assert.equal((updated.match(/return a \+ b \+ 1;/g) ?? []).length, 1);
});
