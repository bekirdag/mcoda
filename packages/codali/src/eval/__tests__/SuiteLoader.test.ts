import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeSuiteDefinition,
  stableJsonStringify,
  SuiteValidationError,
} from "../SuiteSchema.js";
import { loadSuiteFromFile } from "../SuiteLoader.js";

test("loadSuiteFromFile parses and normalizes suite definitions", { concurrency: false }, async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "codali-eval-suite-"));
  const suitePath = path.join(tempDir, "suite.json");
  writeFileSync(
    suitePath,
    JSON.stringify({
      schemaVersion: 1,
      suiteId: "  smoke-suite  ",
      name: "Smoke",
      tasks: [
        {
          id: "task-1",
          inlineTask: "review request",
          command: "review",
          assertions: {
            expectSuccess: true,
          },
        },
        {
          id: "task-2",
          taskFile: "tasks/failure.txt",
          mode: "failure",
          assertions: {
            expectSuccess: false,
          },
        },
      ],
    }),
    "utf8",
  );

  const loaded = await loadSuiteFromFile(suitePath, tempDir);
  assert.equal(loaded.suite.suite_id, "smoke-suite");
  assert.equal(loaded.suite.name, "Smoke");
  assert.equal(loaded.suite.tasks.length, 2);
  assert.equal(loaded.suite.tasks[0]?.command, "review");
  assert.equal(loaded.suite.tasks[1]?.mode, "failure");
  assert.ok(loaded.suite_fingerprint.length > 10);
});

test("normalizeSuiteDefinition fails deterministically on invalid tasks", { concurrency: false }, () => {
  assert.throws(
    () =>
      normalizeSuiteDefinition({
        schema_version: 1,
        suite_id: "broken",
        tasks: [{ id: "task-1" }],
      }),
    (error) => {
      assert.ok(error instanceof SuiteValidationError);
      assert.ok(error.issues.some((issue) => issue.code === "missing_task_input"));
      return true;
    },
  );
});

test("normalizeSuiteDefinition produces equivalent normalized output for alias shapes", { concurrency: false }, () => {
  const snakeCase = normalizeSuiteDefinition({
    schema_version: 1,
    suite_id: "equivalent",
    tasks: [
      {
        id: "task-1",
        inline_task: "hello",
        assertions: {
          expect_success: true,
        },
      },
    ],
  });
  const camelCase = normalizeSuiteDefinition({
    schemaVersion: 1,
    suiteId: "equivalent",
    tasks: [
      {
        id: "task-1",
        inlineTask: "hello",
        assertions: {
          expectSuccess: true,
        },
      },
    ],
  });
  assert.equal(stableJsonStringify(snakeCase), stableJsonStringify(camelCase));
});
