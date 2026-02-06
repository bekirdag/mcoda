import test from "node:test";
import assert from "node:assert/strict";
import { ValidationRunner } from "../ValidationRunner.js";

test("ValidationRunner skips shell steps when shell validation is disabled", { concurrency: false }, async () => {
  const runner = new ValidationRunner({
    allowShell: false,
    shellAllowlist: [],
    workspaceRoot: process.cwd(),
  });

  const result = await runner.run(["npm test", "curl -sf http://localhost:3000/healthz"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
