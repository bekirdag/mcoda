import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import { ContextRedactor } from "../ContextRedactor.js";
import { ContextSummarizer } from "../ContextSummarizer.js";
import type { LocalContextConfig } from "../Types.js";

class StubProvider implements Provider {
  name = "stub";
  constructor(private response: ProviderResponse) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return this.response;
  }
}

class StubLogger {
  logPath = "";
  events: { type: string; data: Record<string, unknown> }[] = [];

  async log(type: string, data: Record<string, unknown>): Promise<void> {
    this.events.push({ type, data });
  }
}

const makeConfig = (overrides: Partial<LocalContextConfig> = {}): LocalContextConfig => ({
  enabled: true,
  storageDir: "codali/context",
  persistToolMessages: false,
  maxMessages: 200,
  maxBytesPerLane: 200_000,
  modelTokenLimits: {},
  summarize: {
    enabled: false,
    provider: "librarian",
    model: "gemma2:2b",
    targetTokens: 1200,
  },
  ...overrides,
});

test("ContextManager redacts before persistence", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-manager-"));
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const redactor = new ContextRedactor({
    workspaceRoot: tmpDir,
    ignoreFilesFrom: [],
    redactPatterns: ["SECRET[0-9]+"],
  });
  const manager = new ContextManager({
    config: makeConfig(),
    store,
    redactor,
  });

  const lane = await manager.getLane({ jobId: "job1", taskId: "task1", role: "architect" });
  await manager.append(lane.id, { role: "user", content: "token=SECRET123" });

  const snapshot = await store.loadLane(lane.id);
  assert.equal(snapshot.messageCount, 1);
  assert.equal(snapshot.messages[0].content.includes("<redacted>"), true);
});

test("ContextManager isolates lanes by role", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-manager-"));
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const manager = new ContextManager({
    config: makeConfig(),
    store,
  });

  const architect = await manager.getLane({ jobId: "job2", taskId: "task2", role: "architect" });
  await manager.append(architect.id, { role: "user", content: "architect note" });
  const builder = await manager.getLane({ jobId: "job2", taskId: "task2", role: "builder" });

  assert.equal(builder.messages.length, 0);
});

test("ContextManager ephemeral lanes do not persist", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-manager-"));
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const manager = new ContextManager({
    config: makeConfig(),
    store,
  });

  const lane = await manager.getLane({ jobId: "job3", taskId: "task3", role: "librarian", ephemeral: true });
  await manager.append(lane.id, { role: "user", content: "ephemeral" }, { persisted: false });

  const fresh = new ContextManager({
    config: makeConfig(),
    store,
  });
  const loaded = await fresh.getLane({ jobId: "job3", taskId: "task3", role: "librarian" });

  assert.equal(loaded.messages.length, 0);
});

test("ContextManager summarizes when over budget", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-manager-"));
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const provider = new StubProvider({ message: { role: "assistant", content: "Short summary" } });
  const summarizer = new ContextSummarizer(provider, { maxTokens: 64 });
  const manager = new ContextManager({
    config: makeConfig({
      summarize: { enabled: true, provider: "librarian", model: "gemma2:2b", targetTokens: 64 },
      modelTokenLimits: { tiny: 10 },
    }),
    store,
    summarizer,
    charPerToken: 1,
  });

  const lane = await manager.getLane({ jobId: "job4", taskId: "task4", role: "architect" });
  await manager.append(lane.id, { role: "user", content: "abcdefghij" });
  await manager.append(lane.id, { role: "assistant", content: "klmnopqrst" });

  const prepared = await manager.prepare(lane.id, { model: "tiny", systemPrompt: "sys", bundle: "bundle" });
  assert.equal(prepared[0].role, "system");
  assert.equal(prepared[0].content.includes("Context summary:"), true);
});

test("ContextManager logs lane updates and summaries", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-manager-"));
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const provider = new StubProvider({ message: { role: "assistant", content: "Short summary" } });
  const summarizer = new ContextSummarizer(provider, { maxTokens: 64 });
  const logger = new StubLogger();
  const manager = new ContextManager({
    config: makeConfig({
      summarize: { enabled: true, provider: "librarian", model: "gemma2:2b", targetTokens: 64 },
      modelTokenLimits: { tiny: 10 },
    }),
    store,
    summarizer,
    logger,
    charPerToken: 1,
  });

  const lane = await manager.getLane({ jobId: "job5", taskId: "task5", role: "architect" });
  await manager.append(lane.id, { role: "user", content: "abcdefghij" });
  await manager.append(lane.id, { role: "assistant", content: "klmnopqrst" });
  await manager.prepare(lane.id, { model: "tiny", systemPrompt: "sys", bundle: "bundle" });

  const types = logger.events.map((event) => event.type);
  assert.ok(types.includes("context_lane_update"));
  assert.ok(types.includes("context_lane_summarized"));
});

test("ContextManager logs lane trimmed when over maxMessages", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-manager-"));
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const logger = new StubLogger();
  const manager = new ContextManager({
    config: makeConfig({ maxMessages: 1 }),
    store,
    logger,
  });

  const lane = await manager.getLane({ jobId: "job6", taskId: "task6", role: "architect" });
  await manager.append(lane.id, { role: "user", content: "first" });
  await manager.append(lane.id, { role: "assistant", content: "second" });

  const types = logger.events.map((event) => event.type);
  assert.ok(types.includes("context_lane_trimmed"));
});
