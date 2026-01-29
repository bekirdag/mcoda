import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextRedactor } from "../ContextRedactor.js";

test("ContextRedactor loads ignore files and redacts secrets", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-redact-"));
  const ignorePath = path.join(tmpDir, ".codaliignore");
  writeFileSync(ignorePath, "secret.txt\n", "utf8");

  const redactor = new ContextRedactor({
    workspaceRoot: tmpDir,
    ignoreFilesFrom: [".codaliignore"],
    redactPatterns: ["SECRET[0-9]+"],
  });
  await redactor.loadIgnoreMatchers();

  assert.equal(redactor.shouldIgnore("secret.txt"), true);
  const redacted = redactor.redact("value=SECRET123");
  assert.equal(redacted.content.includes("<redacted>"), true);
  assert.equal(redacted.redactions, 1);
});
