import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GoldenSetStore } from "../GoldenSetStore.js";

test("GoldenSetStore appends, bounds, and loads entries", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-golden-"));
  const store = new GoldenSetStore({ workspaceRoot: tmpDir, maxEntries: 2 });
  try {
    await store.append({
      intent: "Add health endpoint",
      plan_summary: "Implement GET /healthz",
      touched_files: ["src/server.ts"],
      qa_notes: "pass",
    });
    await store.append({
      intent: "Add auth middleware",
      plan_summary: "Wire middleware into API routes",
      touched_files: ["src/middleware/auth.ts", "src/server.ts"],
      review_notes: "changes requested",
    });
    await store.append({
      intent: "Rotate key",
      plan_summary: "Use AKIAAAAAAAAAAAAAAAAA and Bearer abcdefghijklmnop",
      touched_files: ["src/security.ts"],
    });

    const entries = await store.load();
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.intent, "Add auth middleware");
    assert.equal(entries[1]?.intent, "Rotate key");
    assert.ok(entries[1]?.plan_summary.includes("[REDACTED_AWS_KEY]"));
    assert.ok(entries[1]?.plan_summary.includes("Bearer [REDACTED]"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("GoldenSetStore returns ranked examples", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-golden-rank-"));
  const store = new GoldenSetStore({ workspaceRoot: tmpDir, maxEntries: 5 });
  try {
    await store.append({
      intent: "Create health endpoint",
      plan_summary: "Add GET /healthz route",
      touched_files: ["src/server.ts"],
      qa_notes: "pass",
    });
    await store.append({
      intent: "Implement markdown renderer",
      plan_summary: "Render markdown safely",
      touched_files: ["src/render.ts"],
      qa_notes: "pass",
    });

    const examples = await store.findExamples("create health route", 2);
    assert.equal(examples.length, 2);
    assert.equal(examples[0]?.intent, "Create health endpoint");
    assert.ok(examples[0]?.patch.includes("plan=Add GET /healthz route"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
