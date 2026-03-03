import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PatchApplier, PatchPolicyError } from "../PatchApplier.js";

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
  const applier = new PatchApplier({
    workspaceRoot: tmpDir,
    policy: { allowDestructiveOperations: true },
  });
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

test("PatchApplier blocks delete actions by default policy", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const filePath = path.join(tmpDir, "src/blocked.ts");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "export const blocked = true;\n", "utf8");
  const applier = new PatchApplier({ workspaceRoot: tmpDir });
  await assert.rejects(
    () =>
      applier.apply([
        {
          action: "delete",
          file: "src/blocked.ts",
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof PatchPolicyError);
      assert.equal(error.metadata.reason_code, "destructive_operation_blocked");
      return true;
    },
  );
});

test("PatchApplier blocks read-only and out-of-scope targets", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const readonlyPath = path.join(tmpDir, "docs/sds/spec.md");
  const allowedPath = path.join(tmpDir, "src/allowed.ts");
  mkdirSync(path.dirname(readonlyPath), { recursive: true });
  mkdirSync(path.dirname(allowedPath), { recursive: true });
  writeFileSync(readonlyPath, "v1\n", "utf8");
  writeFileSync(allowedPath, "const v = 1;\n", "utf8");
  const applier = new PatchApplier({
    workspaceRoot: tmpDir,
    policy: {
      allowWritePaths: ["src/allowed.ts"],
      readOnlyPaths: ["docs/sds"],
      allowDestructiveOperations: true,
    },
  });
  await assert.rejects(
    () =>
      applier.apply([
        {
          action: "replace",
          file: "docs/sds/spec.md",
          search_block: "v1",
          replace_block: "v2",
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof PatchPolicyError);
      assert.equal(error.metadata.reason_code, "patch_read_only_path");
      return true;
    },
  );
  await assert.rejects(
    () =>
      applier.apply([
        {
          action: "replace",
          file: "src/other.ts",
          search_block: "a",
          replace_block: "b",
        },
      ]),
    (error: unknown) => {
      assert.ok(error instanceof PatchPolicyError);
      assert.equal(error.metadata.reason_code, "patch_outside_allowed_scope");
      return true;
    },
  );
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

test("PatchApplier rollback restores pre-apply state for replace/create sequences", { concurrency: false }, async () => {
  const tmpDir = setupDir();
  const filePath = path.join(tmpDir, "src/state.ts");
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "export const state = 1;\n", "utf8");

  const applier = new PatchApplier({ workspaceRoot: tmpDir });
  const patches = [
    {
      action: "replace" as const,
      file: "src/state.ts",
      search_block: "export const state = 1;",
      replace_block: "export const state = 2;",
    },
    {
      action: "create" as const,
      file: "src/new.ts",
      content: "export const fresh = true;\n",
    },
  ];

  const rollbackPlan = await applier.createRollback(patches);
  await applier.apply(patches);
  assert.ok(existsSync(path.join(tmpDir, "src/new.ts")));
  assert.match(readFileSync(filePath, "utf8"), /state = 2/);

  await applier.rollback(rollbackPlan);
  assert.equal(existsSync(path.join(tmpDir, "src/new.ts")), false);
  assert.match(readFileSync(filePath, "utf8"), /state = 1/);
});
