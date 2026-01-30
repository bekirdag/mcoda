import test from "node:test";
import assert from "node:assert/strict";
import { MemoryWriteback } from "../MemoryWriteback.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";

class StubDocdexClient {
  memoryCalls: string[] = [];
  prefCalls: Array<{ agentId: string; category: string; content: string }> = [];

  async memorySave(text: string): Promise<void> {
    this.memoryCalls.push(text);
  }

  async savePreference(agentId: string, category: string, content: string): Promise<void> {
    this.prefCalls.push({ agentId, category, content });
  }
}

test("MemoryWriteback writes lesson after maxRetries", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient);

  await writeback.persist({ failures: 1, maxRetries: 3, lesson: "do not use bcrypt" });
  assert.equal(stub.memoryCalls.length, 0);

  await writeback.persist({ failures: 3, maxRetries: 3, lesson: "do not use bcrypt" });
  assert.equal(stub.memoryCalls.length, 1);
});

test("MemoryWriteback writes preferences when provided", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient);

  await writeback.persist({
    failures: 0,
    maxRetries: 3,
    lesson: "ignore",
    preferences: [{ agentId: "agent-1", category: "constraint", content: "use date-fns" }],
  });

  assert.equal(stub.prefCalls.length, 1);
  assert.equal(stub.prefCalls[0]?.content, "use date-fns");
});

test("MemoryWriteback uses default agent id when missing", { concurrency: false }, async () => {
  const stub = new StubDocdexClient();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient, { agentId: "default-agent" });

  await writeback.persist({
    failures: 0,
    maxRetries: 1,
    lesson: "",
    preferences: [{ category: "preference", content: "use fetch" }],
  });

  assert.equal(stub.prefCalls[0]?.agentId, "default-agent");
});

test("MemoryWriteback ignores unsupported docdex preference writes", { concurrency: false }, async () => {
  class ThrowingDocdexClient extends StubDocdexClient {
    override async savePreference(): Promise<void> {
      throw new Error("unknown method: docdex_save_preference");
    }
  }

  const stub = new ThrowingDocdexClient();
  const writeback = new MemoryWriteback(stub as unknown as DocdexClient);

  await assert.doesNotReject(
    writeback.persist({
      failures: 0,
      maxRetries: 1,
      lesson: "",
      preferences: [{ category: "constraint", content: "use date-fns" }],
    }),
  );
});
