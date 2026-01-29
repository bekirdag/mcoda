import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextAssembler } from "../ContextAssembler.js";
import { ContextManager } from "../ContextManager.js";
import { ContextStore } from "../ContextStore.js";
import type { DocdexClient } from "../../docdex/DocdexClient.js";
import type { Provider, ProviderRequest, ProviderResponse } from "../../providers/ProviderTypes.js";
import type { LocalContextConfig } from "../Types.js";

class FakeDocdexClient {
  getRepoId(): string | undefined {
    return undefined;
  }

  getRepoRoot(): string | undefined {
    return "/repo";
  }

  async initialize(): Promise<unknown> {
    return { repoId: "repo-id" };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async stats(): Promise<unknown> {
    return { last_updated_epoch_ms: 123, num_docs: 10 };
  }

  async files(): Promise<unknown> {
    return { results: [] };
  }

  async search(): Promise<unknown> {
    return { hits: [{ doc_id: "doc-1", path: "src/index.ts" }] };
  }

  async openSnippet(): Promise<unknown> {
    return "snippet-content";
  }

  async symbols(): Promise<unknown> {
    return { symbols: ["sym"] };
  }

  async ast(): Promise<unknown> {
    return { nodes: ["node"] };
  }

  async impactGraph(): Promise<unknown> {
    return { inbound: [], outbound: [] };
  }

  async impactDiagnostics(): Promise<unknown> {
    return { diagnostics: [] };
  }

  async memoryRecall(): Promise<unknown> {
    return { results: [{ content: "remember this" }] };
  }

  async getProfile(): Promise<unknown> {
    return { preferences: [{ content: "use async/await" }] };
  }
}

class StubProvider implements Provider {
  name = "stub";
  constructor(private response: ProviderResponse) {}

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return this.response;
  }
}

const makeLocalConfig = (overrides: Partial<LocalContextConfig> = {}): LocalContextConfig => ({
  enabled: true,
  storageDir: "codali/context",
  persistToolMessages: false,
  maxMessages: 200,
  maxBytesPerLane: 200_000,
  modelTokenLimits: {},
  summarize: { enabled: false, provider: "librarian", model: "gemma2:2b", targetTokens: 1200 },
  ...overrides,
});

test("ContextAssembler builds a complete context bundle", { concurrency: false }, async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  const client = new FakeDocdexClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, { maxQueries: 2, workspaceRoot: tmpDir, readStrategy: "fs" });
  const bundle = await assembler.assemble("Update src/index.ts formatting");

  assert.equal(bundle.request, "Update src/index.ts formatting");
  assert.ok(bundle.queries.length >= 1);
  assert.equal(bundle.snippets[0]?.content, "snippet-content");
  assert.equal(bundle.symbols[0]?.path, "src/index.ts");
  assert.equal(bundle.ast[0]?.path, "src/index.ts");
  assert.equal(bundle.index.last_updated_epoch_ms, 123);
  assert.equal(bundle.index.num_docs, 10);
  assert.ok(bundle.warnings.some((warning) => warning.startsWith("impact_graph_sparse")));
  assert.equal(bundle.impact_diagnostics.length, 1);
  assert.ok(bundle.selection?.focus.includes("src/index.ts"));
  assert.equal(bundle.preferences_detected.length, 0);
  assert.equal(bundle.memory[0]?.text, "remember this");
  assert.equal(bundle.profile[0]?.content, "use async/await");
});

test("ContextAssembler expands queries with provider when available", { concurrency: false }, async () => {
  class NoHitClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [] };
    }
  }
  const client = new NoHitClient() as unknown as DocdexClient;
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify({ queries: ["auth", "login"] }) },
  });
  const assembler = new ContextAssembler(client, { maxQueries: 2, queryProvider: provider });
  const bundle = await assembler.assemble("Update login flow");
  assert.ok(bundle.queries.includes("auth"));
});

test("ContextAssembler uses ephemeral lane for query expansion when context manager provided", { concurrency: false }, async () => {
  class NoHitClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [] };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  const client = new NoHitClient() as unknown as DocdexClient;
  const provider = new StubProvider({
    message: { role: "assistant", content: JSON.stringify({ queries: ["auth", "login"] }) },
  });
  const store = new ContextStore({ workspaceRoot: tmpDir, storageDir: "codali/context" });
  const contextManager = new ContextManager({ config: makeLocalConfig(), store });
  const assembler = new ContextAssembler(client, {
    maxQueries: 2,
    queryProvider: provider,
    contextManager,
    laneScope: { jobId: "job-q", taskId: "task-q" },
  });
  await assembler.assemble("Update login flow");
  const lane = await contextManager.getLane({
    jobId: "job-q",
    taskId: "task-q",
    role: "librarian",
    ephemeral: true,
  });
  assert.ok(lane.messages.length >= 2);
});

test("ContextAssembler warns when index is empty", { concurrency: false }, async () => {
  const client = {
    getRepoId() {
      return undefined;
    },
    getRepoRoot() {
      return "/repo";
    },
    async initialize() {
      return { repoId: "repo-id" };
    },
    async healthCheck() {
      return true;
    },
    async stats() {
      return { last_updated_epoch_ms: 0, num_docs: 0 };
    },
    async files() {
      return { results: [] };
    },
    async search() {
      return { hits: [] };
    },
    async openSnippet() {
      return "";
    },
    async symbols() {
      return {};
    },
    async ast() {
      return { nodes: [] };
    },
    async impactGraph() {
      return { inbound: [], outbound: [] };
    },
    async impactDiagnostics() {
      return { diagnostics: [] };
    },
    async memoryRecall() {
      return { results: [] };
    },
    async getProfile() {
      return { preferences: [] };
    },
  } as unknown as DocdexClient;

  const assembler = new ContextAssembler(client, { maxQueries: 1 });
  const bundle = await assembler.assemble("Check indexing");
  assert.ok(bundle.warnings.includes("docdex_index_empty"));
  assert.ok(bundle.warnings.includes("docdex_index_stale"));
});

test("ContextAssembler trims context to fit budget", { concurrency: false }, async () => {
  class BudgetClient extends FakeDocdexClient {
    async search(): Promise<unknown> {
      return { hits: [{ doc_id: "doc-1", path: "src/index.ts" }] };
    }
    async impactGraph(): Promise<unknown> {
      return { inbound: [], outbound: ["src/dep.ts"] };
    }
  }
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "codali-context-"));
  mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  writeFileSync(path.join(tmpDir, "src/index.ts"), "export const foo = 1;", "utf8");
  writeFileSync(path.join(tmpDir, "src/dep.ts"), "export const bar = 2;", "utf8");

  const client = new BudgetClient() as unknown as DocdexClient;
  const assembler = new ContextAssembler(client, {
    workspaceRoot: tmpDir,
    readStrategy: "fs",
    maxTotalBytes: 10,
    tokenBudget: 10,
    maxFiles: 2,
    focusMaxFileBytes: 100,
    peripheryMaxBytes: 100,
  });
  const bundle = await assembler.assemble("Update src/index.ts");
  const periphery = (bundle.files ?? []).filter((file) => file.role === "periphery");
  assert.equal(periphery.length, 0);
  assert.ok(bundle.warnings.includes("context_budget_pruned"));
});
