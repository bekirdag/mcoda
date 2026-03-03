import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryWriteback } from "../MemoryWriteback.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";

class StubDocdexClient {
  memoryCalls: Array<{ text: string; metadata?: Record<string, unknown> }> = [];
  prefCalls: Array<{
    agentId: string;
    category: string;
    content: string;
    metadata?: Record<string, unknown>;
  }> = [];

  async memorySave(text: string, metadata?: Record<string, unknown>): Promise<void> {
    this.memoryCalls.push({ text, metadata });
  }

  async savePreference(
    agentId: string,
    category: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    this.prefCalls.push({ agentId, category, content, metadata });
  }
}

const createWorkspace = (): string => mkdtempSync(path.join(os.tmpdir(), "codali-memory-"));

test("MemoryWriteback writes lesson after max retries with governed metadata", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const workspace = createWorkspace();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient, {
    workspaceRoot: workspace,
    learning: { candidate_store_file: "learning-rules.json" },
  });

  const result = await writeback.persist({ failures: 3, maxRetries: 3, lesson: "do not remove helper exports" });
  assert.equal(result.outcomes.length, 1);
  assert.equal(result.outcomes[0]?.status, "accepted");
  assert.equal(result.outcomes[0]?.target, "repo_memory");
  assert.equal(stub.memoryCalls.length, 1);
  assert.equal(typeof stub.memoryCalls[0]?.metadata?.confidence_score, "number");
});

test("MemoryWriteback routes preferences to profile memory with metadata", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const workspace = createWorkspace();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient, {
    agentId: "default-agent",
    workspaceRoot: workspace,
    learning: { candidate_store_file: "learning-rules.json" },
  });

  const result = await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    preferences: [{
      category: "preference",
      content: "Prefer fetch for simple HTTP calls.",
      source: "request_directive_explicit_preference",
    }],
  });

  assert.equal(result.outcomes[0]?.status, "accepted");
  assert.equal(result.outcomes[0]?.target, "profile_memory");
  assert.equal(stub.prefCalls.length, 1);
  assert.equal(stub.prefCalls[0]?.agentId, "default-agent");
  assert.equal(stub.prefCalls[0]?.metadata?.lifecycle_state, "candidate");
});

test("MemoryWriteback suppresses duplicate rules by dedupe key", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const workspace = createWorkspace();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient, {
    workspaceRoot: workspace,
    learning: { candidate_store_file: "learning-rules.json" },
  });

  const first = await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    rules: [{ category: "constraint", content: "Do not use moment.js", source: "request_directive_explicit_constraint" }],
  });
  const second = await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    rules: [{ category: "constraint", content: "Do not use moment.js", source: "request_directive_explicit_constraint" }],
  });

  assert.equal(first.outcomes[0]?.status, "accepted");
  assert.equal(second.outcomes[0]?.status, "suppressed");
  assert.equal(second.outcomes[0]?.code, "dedupe_suppressed");
});

test("MemoryWriteback promotes candidates with explicit dedupe key", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const workspace = createWorkspace();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient, {
    workspaceRoot: workspace,
    learning: { candidate_store_file: "learning-rules.json" },
  });

  const accepted = await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    rules: [{ category: "constraint", content: "Do not use moment.js", source: "request_directive_explicit_constraint" }],
  });
  const dedupeKey = accepted.outcomes[0]?.dedupe_key;
  assert.ok(dedupeKey);

  const promoted = await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    promotions: [{ dedupe_key: dedupeKey! }],
  });

  assert.equal(promoted.outcomes[0]?.status, "promoted");
  assert.equal(promoted.outcomes[0]?.code, "candidate_promoted");
});

test("MemoryWriteback falls back to repo memory when profile write method is unsupported", {
  concurrency: false,
}, async () => {
  class UnsupportedPreferenceClient extends StubDocdexClient {
    override async savePreference(): Promise<void> {
      throw new Error("unknown method: docdex_save_preference");
    }
  }

  const stub = new UnsupportedPreferenceClient();
  const workspace = createWorkspace();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient, {
    workspaceRoot: workspace,
    learning: { candidate_store_file: "learning-rules.json" },
  });

  const result = await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    rules: [{ category: "constraint", content: "Do not use lodash", source: "request_directive_explicit_constraint" }],
  });

  assert.equal(result.outcomes[0]?.status, "accepted");
  assert.equal(stub.memoryCalls.length, 1);
  assert.match(stub.memoryCalls[0]?.text ?? "", /^\[profile:constraint\]/);
});
