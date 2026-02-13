import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunLogger } from "../RunLogger.js";

test("RunLogger writes JSONL entries", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-1");
  await logger.log("event", { ok: true });

  const content = readFileSync(logger.logPath, "utf8");
  assert.match(content, /"type":"event"/);
  assert.match(content, /"ok":true/);
});

test("RunLogger writes phase artifacts", { concurrency: false }, async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "codali-logs-"));
  const logger = new RunLogger(workspaceRoot, "logs", "run-2");
  const artifactPath = await logger.writePhaseArtifact("architect", "plan", {
    steps: ["step"],
  });

  assert.ok(existsSync(artifactPath));
  const content = readFileSync(artifactPath, "utf8");
  assert.match(content, /"steps"/);
});
